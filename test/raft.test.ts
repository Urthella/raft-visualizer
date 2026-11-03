import assert from "node:assert/strict";
import { test } from "node:test";
import { randomFault } from "../src/chaos.ts";
import { FIGURE_8 } from "../src/figure8.ts";
import { Checker, runChecked } from "../src/invariants.ts";
import { type Bugs, NO_BUGS, Simulation } from "../src/raft.ts";

function electLeader(sim: Simulation, checker = new Checker()) {
  for (let i = 0; i < 2000 && !sim.leader(); i++) {
    sim.tick();
    checker.check(sim);
  }
  const leader = sim.leader();
  assert.ok(leader, "a leader should get elected");
  return leader;
}

/** A random run: crashes, partitions and writes, all from the seed. */
function chaos(seed: number, bugs: Partial<Bugs> = {}, ticks = 4000) {
  const sim = new Simulation({ seed, bugs: { ...NO_BUGS, ...bugs } });
  const checker = new Checker();
  let written = 0;
  while (sim.time < ticks) {
    runChecked(sim, checker, sim.randomInt(5, 60));
    randomFault(sim, `v${++written}`);
  }
  return { sim, checker };
}

test("the same seed gives the same run", () => {
  const a = chaos(7, {}, 1500).sim;
  const b = chaos(7, {}, 1500).sim;
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.nodes.map((n) => n.log), b.nodes.map((n) => n.log));
});

test("a leader gets elected, and a write commits on every node", () => {
  const sim = new Simulation({ seed: 1 });
  const checker = new Checker();
  const leader = electLeader(sim, checker);
  assert.equal(sim.propose(leader.id, "x"), true);
  runChecked(sim, checker, 100);
  for (const n of sim.nodes) assert.deepEqual(n.applied, ["x"], `node ${n.id}`);
  assert.deepEqual(checker.violations, []);
});

test("only a leader accepts a write", () => {
  const sim = new Simulation({ seed: 1 });
  const leader = electLeader(sim);
  const other = sim.nodes.find((n) => n.id !== leader.id)!;
  assert.equal(sim.propose(other.id, "x"), false);
});

test("a minority can't commit, and the majority moves on without it", () => {
  const sim = new Simulation({ seed: 3 });
  const checker = new Checker();
  const old = electLeader(sim, checker);
  sim.isolate(old.id);
  sim.propose(old.id, "lost");
  runChecked(sim, checker, 300);
  assert.equal(old.commitIndex, 0, "one node isn't a majority");
  const fresh = sim.nodes.find((n) => n.id !== old.id && n.role === "leader");
  assert.ok(fresh, "the others should elect a leader");
  assert.ok(fresh.term > old.term);
  sim.propose(fresh.id, "kept");
  runChecked(sim, checker, 100);
  sim.heal();
  runChecked(sim, checker, 200);
  assert.equal(old.role, "follower", "the old leader should step down when it hears the newer term");
  assert.deepEqual(old.applied, ["kept"], "its uncommitted entry should be gone");
  assert.deepEqual(checker.violations, []);
});

test("a restarted node gets its committed data back", () => {
  const sim = new Simulation({ seed: 5 });
  const checker = new Checker();
  const leader = electLeader(sim, checker);
  sim.propose(leader.id, "x");
  runChecked(sim, checker, 100);
  const follower = sim.nodes.find((n) => n.id !== leader.id)!;
  sim.crash(follower.id);
  assert.deepEqual(follower.applied, []);
  sim.propose(leader.id, "y");
  runChecked(sim, checker, 100);
  sim.restart(follower.id);
  runChecked(sim, checker, 100);
  assert.deepEqual(follower.applied, ["x", "y"]);
  assert.deepEqual(checker.violations, []);
});

test("every invariant holds through crashes and partitions, across seeds", () => {
  let commits = 0;
  let leaders = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const { sim, checker } = chaos(seed);
    assert.deepEqual(checker.violations, [], `seed ${seed}`);
    commits += checker.committedEntries().size;
    leaders += sim.events.filter((e) => e.text.startsWith("became leader")).length;
  }
  // Passing means nothing if the runs didn't do anything.
  assert.ok(commits > 300, `only ${commits} commits`);
  assert.ok(leaders > 300, `only ${leaders} leaders`);
});

test("after the faults stop, every node catches up to the same data", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { sim, checker } = chaos(seed, {}, 2000);
    sim.heal();
    for (const n of sim.nodes) sim.restart(n.id);
    runChecked(sim, checker, 400);
    const leader = sim.leader();
    assert.ok(leader, `seed ${seed}: no leader after healing`);
    sim.propose(leader.id, "final");
    runChecked(sim, checker, 400);
    for (const n of sim.nodes) {
      assert.deepEqual(n.applied, leader.applied, `seed ${seed}, node ${n.id}`);
      assert.equal(n.applied.at(-1), "final", `seed ${seed}, node ${n.id}`);
    }
    assert.deepEqual(checker.violations, [], `seed ${seed}`);
  }
});

function figure8(bugs: Partial<Bugs> = {}) {
  const sim = new Simulation({ seed: 1, autoElections: false, bugs: { ...NO_BUGS, ...bugs } });
  const checker = new Checker();
  return { sim, checker };
}

test("Figure 8: the correct rule doesn't commit the old entry, so nothing is lost", () => {
  const { sim, checker } = figure8();
  for (const step of FIGURE_8.slice(0, 4)) step.run(sim, checker);
  const s1 = sim.node(1);
  assert.equal(s1.role, "leader", "node 1 should lead in step (c)");
  assert.equal(s1.log[1].value, "b");
  const holders = sim.nodes.filter((n) => n.log[1]?.value === "b").map((n) => n.id);
  assert.ok(holders.length >= 3, `"b" should be on a majority, it's on ${holders}`);
  assert.equal(s1.commitIndex, 0, `with nothing from its own term, the restarted leader can't commit "b"`);

  FIGURE_8[4].run(sim, checker);
  const s5 = sim.node(5);
  assert.equal(s5.role, "leader", "node 5 should lead in step (d)");
  assert.deepEqual(s5.applied, ["a", "c", "d"]);
  assert.deepEqual(checker.violations, []);
});

test("Figure 8: with the old-term bug, committed data gets overwritten and the checker says so", () => {
  const { sim, checker } = figure8({ commitOldTerms: true });
  for (const step of FIGURE_8.slice(0, 4)) step.run(sim, checker);
  assert.equal(sim.node(1).commitIndex, 2, `the bug should commit "b" in step (c)`);
  assert.deepEqual(checker.violations, []);

  FIGURE_8[4].run(sim, checker);
  assert.ok(checker.firstOf("State Machine Safety"), JSON.stringify(checker.violations));
  assert.ok(checker.firstOf("Leader Completeness"), JSON.stringify(checker.violations));
});

test("Figure 8: if node 1 commits something from its own term first, node 5 can't win", () => {
  const { sim, checker } = figure8();
  for (const step of FIGURE_8.slice(0, 4)) step.run(sim, checker);
  sim.heal();
  sim.propose(1, "e");
  for (let i = 0; i < 40; i++) {
    sim.tick();
    checker.check(sim);
  }
  assert.equal(sim.node(1).commitIndex, 3, "a majority has the new entry, which commits everything before it");
  sim.crash(1);
  sim.restart(5);
  for (let i = 0; i < 4; i++) {
    sim.timeoutNow(5);
    for (let t = 0; t < 30; t++) {
      sim.tick();
      checker.check(sim);
    }
  }
  assert.notEqual(sim.node(5).role, "leader", "node 5's log is behind, so it can't get a majority");
  assert.deepEqual(checker.violations, []);
});

// A bug the checker can't catch means the green lights in the UI don't mean anything.
function findsViolation(bugs: Partial<Bugs>, seeds: number): string | undefined {
  for (let seed = 1; seed <= seeds; seed++) {
    const { checker } = chaos(seed, bugs);
    if (checker.violations.length > 0) return checker.violations[0].invariant;
  }
  return undefined;
}

test("forgetting a vote on restart lets two nodes lead the same term, and the checker says so", () => {
  const scripted = (bugs: Partial<Bugs>) => {
    const sim = new Simulation({ nodes: 3, seed: 1, autoElections: false, bugs: { ...NO_BUGS, ...bugs } });
    const checker = new Checker();
    sim.cut(1, 3); // node 3 must not hear about node 1's term
    sim.timeoutNow(1); // nodes 1 and 2 elect node 1 in term 1
    runChecked(sim, checker, 30);
    assert.equal(sim.node(1).role, "leader");
    sim.cut(1, 2); // and now node 1 can't reach node 2 either
    sim.crash(2);
    sim.restart(2);
    sim.timeoutNow(3); // term 1 as well, asking node 2 for the vote it already gave
    runChecked(sim, checker, 30);
    return { sim, checker };
  };
  assert.deepEqual(scripted({}).checker.violations, []);
  assert.notEqual(scripted({}).sim.node(3).role, "leader");
  assert.equal(scripted({ forgetVoteOnRestart: true }).sim.node(3).role, "leader");
  assert.ok(scripted({ forgetVoteOnRestart: true }).checker.firstOf("Election Safety"));
});

test("voting without the log check gets caught by random runs", () => {
  assert.ok(findsViolation({ skipVoteLogCheck: true }, 100));
});

test("the checker reports two leaders in one term", () => {
  const sim = new Simulation({ seed: 1 });
  const checker = new Checker();
  sim.nodes[0].role = "leader";
  sim.nodes[0].term = 3;
  checker.check(sim);
  sim.nodes[0].role = "follower";
  sim.nodes[1].role = "leader";
  sim.nodes[1].term = 3;
  checker.check(sim);
  assert.ok(checker.firstOf("Election Safety"));
});

test("the checker reports a leader changing its own log", () => {
  const sim = new Simulation({ seed: 1 });
  const checker = new Checker();
  const n = sim.nodes[0];
  n.role = "leader";
  n.term = 1;
  n.log = [{ term: 1, value: "a" }];
  checker.check(sim);
  n.log = [];
  checker.check(sim);
  assert.ok(checker.firstOf("Leader Append-Only"));
});

test("the checker reports logs that match at an index but differ before it", () => {
  const sim = new Simulation({ seed: 1 });
  const checker = new Checker();
  sim.nodes[0].log = [{ term: 1, value: "a" }, { term: 2, value: "b" }];
  sim.nodes[1].log = [{ term: 1, value: "x" }, { term: 2, value: "b" }];
  checker.check(sim);
  assert.ok(checker.firstOf("Log Matching"));
});

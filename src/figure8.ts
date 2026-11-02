// Figure 8 from the Raft paper, as steps a person can walk through. An entry from an old term sits on a
// majority, and a later leader can still overwrite it. So a leader may only count replicas to commit
// entries from its own term. Switch on Bugs.commitOldTerms to see what goes wrong otherwise.

import type { Checker } from "./invariants.ts";
import type { Simulation } from "./raft.ts";

export interface Step {
  title: string;
  explain: string;
  run(sim: Simulation, checker: Checker): void;
}

const S1 = 1;
const S2 = 2;
const S3 = 3;
const S4 = 4;
const S5 = 5;

/** Leaves enough time for replication to finish, checking invariants along the way. */
function settle(sim: Simulation, checker: Checker): void {
  for (let i = 0; i < 120; i++) {
    sim.tick();
    checker.check(sim);
  }
}

/** Starts elections on this node until it wins a new term. The first try can lose to a higher term. */
function elect(sim: Simulation, checker: Checker, id: number): void {
  for (let attempt = 0; attempt < 4; attempt++) {
    sim.timeoutNow(id);
    settle(sim, checker);
    if (sim.node(id).role === "leader") return;
  }
}

export const FIGURE_8: Step[] = [
  {
    title: "Everyone agrees on one entry",
    explain: "Node 1 leads and replicates entry “a” to everyone, and it commits.",
    run(sim, checker) {
      elect(sim, checker, S1);
      sim.propose(S1, "a");
      settle(sim, checker);
    },
  },
  {
    title: "(a) Node 1 replicates “b” to one node",
    explain: "A new term starts. Cut off from the others, node 1 gets its new entry “b” only as far as node 2.",
    run(sim, checker) {
      elect(sim, checker, S1);
      sim.partition([S1, S2], [S3, S4, S5]);
      sim.propose(S1, "b");
      settle(sim, checker);
    },
  },
  {
    title: "(b) Node 5 wins with votes from 3 and 4",
    explain: "Node 1 crashes. Node 5 is elected in a later term, and appends a different entry “c” at the same index.",
    run(sim, checker) {
      sim.crash(S1);
      sim.heal();
      sim.partition([S2], [S3, S4, S5]);
      elect(sim, checker, S5);
      sim.isolate(S5);
      sim.propose(S5, "c");
      settle(sim, checker);
    },
  },
  {
    title: "(c) Node 1 returns and “b” reaches a majority",
    explain:
      "Node 5 crashes, and node 1 comes back and wins. It copies “b” to node 3, so “b” is on 3 of 5 nodes. It looks committed, but it's from an old term.",
    run(sim, checker) {
      sim.crash(S5);
      sim.heal();
      sim.restart(S1);
      sim.isolate(S4);
      elect(sim, checker, S1);
      settle(sim, checker);
    },
  },
  {
    title: "(d) Node 5 returns and overwrites “b”",
    explain:
      "Node 1 crashes. Node 5's last entry has a newer term than “b”, so nodes 2, 3 and 4 vote for it, and it replaces “b” everywhere. If “b” was counted as committed, committed data is now gone.",
    run(sim, checker) {
      sim.crash(S1);
      sim.heal();
      sim.restart(S5);
      elect(sim, checker, S5);
      sim.propose(S5, "d");
      settle(sim, checker);
    },
  },
];

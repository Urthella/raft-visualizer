// Checks the five safety properties from Figure 3 of the Raft paper after every tick.

import type { Entry, Simulation } from "./raft.ts";

export const INVARIANTS = {
  "Election Safety": "At most one leader can be elected in a given term.",
  "Leader Append-Only": "A leader never overwrites or deletes entries in its log.",
  "Log Matching": "If two logs have an entry with the same index and term, they're identical up to it.",
  "Leader Completeness": "An entry committed in one term is in the logs of all leaders of later terms.",
  "State Machine Safety": "No two nodes apply different entries at the same index.",
} as const;

export type InvariantName = keyof typeof INVARIANTS;

export interface Violation {
  invariant: InvariantName;
  time: number;
  detail: string;
}

export class Checker {
  violations: Violation[] = [];
  private leaderOfTerm = new Map<number, number>();
  private committed = new Map<number, Entry & { at: number }>();
  private leaderLogs = new Map<number, { term: number; log: Entry[] }>();
  private reported = new Set<string>();

  private report(invariant: InvariantName, time: number, detail: string): void {
    if (this.reported.has(detail)) return;
    this.reported.add(detail);
    this.violations.push({ invariant, time, detail });
  }

  firstOf(invariant: InvariantName): Violation | undefined {
    return this.violations.find((v) => v.invariant === invariant);
  }

  /** Every entry known to be committed, by index. */
  committedEntries(): Map<number, Entry> {
    return this.committed;
  }

  check(sim: Simulation): void {
    const up = sim.nodes.filter((n) => n.up);

    for (const n of sim.nodes) {
      if (!n.up || n.role !== "leader") {
        this.leaderLogs.delete(n.id);
        continue;
      }
      const seen = this.leaderOfTerm.get(n.term);
      if (seen !== undefined && seen !== n.id) {
        this.report("Election Safety", sim.time, `Nodes ${seen} and ${n.id} both led term ${n.term}.`);
      }
      this.leaderOfTerm.set(n.term, n.id);

      const before = this.leaderLogs.get(n.id);
      if (before && before.term === n.term) {
        before.log.forEach((entry, i) => {
          const now = n.log[i];
          if (!now || now.term !== entry.term || now.value !== entry.value) {
            this.report("Leader Append-Only", sim.time, `Leader ${n.id} changed its entry at index ${i + 1} in term ${n.term}.`);
          }
        });
      }
      this.leaderLogs.set(n.id, { term: n.term, log: [...n.log] });
    }

    for (const [i, a] of sim.nodes.entries()) {
      for (const b of sim.nodes.slice(i + 1)) {
        const shared = Math.min(a.log.length, b.log.length);
        let last = 0;
        for (let k = shared; k > 0; k--) {
          if (a.log[k - 1].term === b.log[k - 1].term) {
            last = k;
            break;
          }
        }
        for (let k = 0; k < last; k++) {
          if (a.log[k].term !== b.log[k].term || a.log[k].value !== b.log[k].value) {
            this.report("Log Matching", sim.time, `Nodes ${a.id} and ${b.id} match at index ${last} but differ at index ${k + 1}.`);
            break;
          }
        }
      }
    }

    for (const n of up) {
      for (let index = 1; index <= n.commitIndex; index++) {
        const entry = n.log[index - 1];
        if (!entry) {
          this.report("State Machine Safety", sim.time, `Node ${n.id} lost committed index ${index} from its log.`);
          continue;
        }
        const known = this.committed.get(index);
        if (!known) {
          this.committed.set(index, { ...entry, at: sim.time });
        } else if (known.term !== entry.term || known.value !== entry.value) {
          this.report(
            "State Machine Safety",
            sim.time,
            `Index ${index} was committed as "${known.value}", but node ${n.id} applied "${entry.value}".`,
          );
        }
      }
    }

    for (const n of up) {
      if (n.role !== "leader") continue;
      for (const [index, entry] of this.committed) {
        if (entry.at >= n.leaderSince) continue;
        const own = n.log[index - 1];
        if (!own || own.term !== entry.term || own.value !== entry.value) {
          this.report(
            "Leader Completeness",
            sim.time,
            `Leader ${n.id} of term ${n.term} is missing committed entry "${entry.value}" at index ${index}.`,
          );
        }
      }
    }
  }
}

/** Runs the simulation and checks it after every tick. */
export function runChecked(sim: Simulation, checker: Checker, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    sim.tick();
    checker.check(sim);
  }
}

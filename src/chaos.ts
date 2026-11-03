// One random disturbance: a client write, and maybe a crash or a network change. It draws from the
// simulation's own seeded stream, so a seed replays the same faults.

import type { Simulation } from "./raft.ts";

export function randomFault(sim: Simulation, value: string): void {
  const leader = sim.leader();
  if (leader) sim.propose(leader.id, value);
  const total = sim.nodes.length;
  switch (sim.randomInt(0, 9)) {
    case 0: {
      const down = sim.nodes.filter((n) => !n.up).length;
      if (down < Math.floor((total - 1) / 2)) sim.crash(sim.randomInt(1, total));
      break;
    }
    case 1:
      if (leader) sim.crash(leader.id);
      break;
    case 2:
      for (const n of sim.nodes) sim.restart(n.id);
      break;
    case 3:
      if (leader) sim.isolate(leader.id);
      break;
    case 4: {
      const a = sim.randomInt(1, total);
      const b = (a % total) + 1;
      const rest = sim.nodes.map((n) => n.id).filter((id) => id !== a && id !== b);
      sim.partition([a, b], rest);
      break;
    }
    case 5:
    case 6:
      sim.heal();
      break;
    default:
  }
}

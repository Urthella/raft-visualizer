// A deterministic Raft simulator. Time moves in ticks and all randomness comes from a seed, so a run
// can be replayed. It follows Figure 2 of the Raft paper, without membership changes or snapshots.

export type Role = "follower" | "candidate" | "leader";

export interface Entry {
  term: number;
  value: string;
}

/** Bugs you can switch on, to watch the invariant checker catch them. */
export interface Bugs {
  /** Count replicas to commit entries from earlier terms: the mistake in Figure 8 of the paper. */
  commitOldTerms: boolean;
  /** Lose the vote on restart, so a node can vote twice in one term. */
  forgetVoteOnRestart: boolean;
  /** Grant votes without checking that the candidate's log is up to date. */
  skipVoteLogCheck: boolean;
}

export const NO_BUGS: Bugs = { commitOldTerms: false, forgetVoteOnRestart: false, skipVoteLogCheck: false };

export interface Options {
  nodes: number;
  seed: number;
  latency: [number, number];
  election: [number, number];
  heartbeat: number;
  /** Off for scripted scenarios, where only timeoutNow starts an election. */
  autoElections: boolean;
  bugs: Bugs;
}

export const DEFAULTS: Options = {
  nodes: 5,
  seed: 1,
  latency: [2, 5],
  election: [30, 60],
  heartbeat: 10,
  autoElections: true,
  bugs: NO_BUGS,
};

export interface RaftNode {
  id: number;
  up: boolean;
  role: Role;
  // Persistent: these survive a crash.
  term: number;
  votedFor: number | null;
  log: Entry[]; // index 1 in Raft is log[0] here
  // Volatile.
  commitIndex: number;
  applied: string[];
  votes: Set<number>;
  nextIndex: Map<number, number>;
  matchIndex: Map<number, number>;
  electionDeadline: number;
  heartbeatDeadline: number;
  leaderSince: number;
}

interface RequestVote {
  type: "RequestVote";
  term: number;
  lastLogIndex: number;
  lastLogTerm: number;
}
interface VoteReply {
  type: "VoteReply";
  term: number;
  granted: boolean;
}
interface AppendEntries {
  type: "AppendEntries";
  term: number;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: Entry[];
  leaderCommit: number;
}
interface AppendReply {
  type: "AppendReply";
  term: number;
  success: boolean;
  matchIndex: number;
}
export type Payload = RequestVote | VoteReply | AppendEntries | AppendReply;
export type Message = Payload & { from: number; to: number; sentAt: number; deliverAt: number };

export interface SimEvent {
  time: number;
  node: number;
  text: string;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Simulation {
  readonly options: Options;
  readonly nodes: RaftNode[] = [];
  time = 0;
  messages: Message[] = [];
  events: SimEvent[] = [];
  private rng: () => number;
  private cuts = new Set<string>();

  constructor(options: Partial<Options> = {}) {
    this.options = { ...DEFAULTS, ...options, bugs: { ...NO_BUGS, ...options.bugs } };
    this.rng = mulberry32(this.options.seed);
    for (let id = 1; id <= this.options.nodes; id++) {
      const node: RaftNode = {
        id,
        up: true,
        role: "follower",
        term: 0,
        votedFor: null,
        log: [],
        commitIndex: 0,
        applied: [],
        votes: new Set(),
        nextIndex: new Map(),
        matchIndex: new Map(),
        electionDeadline: 0,
        heartbeatDeadline: 0,
        leaderSince: 0,
      };
      this.resetElectionTimer(node);
      this.nodes.push(node);
    }
  }

  node(id: number): RaftNode {
    return this.nodes[id - 1];
  }

  /** The up leader with the highest term. During a partition an old leader can still believe it leads. */
  leader(): RaftNode | undefined {
    return this.nodes.filter((n) => n.up && n.role === "leader").sort((a, b) => b.term - a.term)[0];
  }

  private majority(): number {
    return Math.floor(this.nodes.length / 2) + 1;
  }

  private random(min: number, max: number): number {
    return min + Math.floor(this.rng() * (max - min + 1));
  }

  /** A number for scripts and fuzzers, from the same seeded stream as everything else. */
  randomInt(min: number, max: number): number {
    return this.random(min, max);
  }

  private log(node: RaftNode, text: string): void {
    this.events.push({ time: this.time, node: node.id, text });
    if (this.events.length > 500) this.events.shift();
  }

  private resetElectionTimer(node: RaftNode): void {
    const [min, max] = this.options.election;
    node.electionDeadline = this.time + this.random(min, max);
  }

  private key(a: number, b: number): string {
    return `${a}>${b}`;
  }

  isCut(from: number, to: number): boolean {
    return this.cuts.has(this.key(from, to));
  }

  /** Stops messages between two nodes, in both directions, including those already on their way. */
  cut(a: number, b: number): void {
    this.cuts.add(this.key(a, b));
    this.cuts.add(this.key(b, a));
  }

  /** Cuts a node off from all the others. */
  isolate(id: number): void {
    for (const n of this.nodes) if (n.id !== id) this.cut(id, n.id);
  }

  /** Cuts every link between the two groups. */
  partition(a: number[], b: number[]): void {
    for (const x of a) for (const y of b) this.cut(x, y);
  }

  heal(): void {
    this.cuts.clear();
  }

  crash(id: number): void {
    const n = this.node(id);
    if (!n.up) return;
    n.up = false;
    n.role = "follower";
    n.commitIndex = 0;
    n.applied = [];
    n.votes = new Set();
    this.log(n, "crashed");
  }

  restart(id: number): void {
    const n = this.node(id);
    if (n.up) return;
    n.up = true;
    if (this.options.bugs.forgetVoteOnRestart) n.votedFor = null;
    this.resetElectionTimer(n);
    this.log(n, "restarted with its term, vote and log");
  }

  /** A client write. Only a leader accepts it, and it isn't safe until it commits. */
  propose(id: number, value: string): boolean {
    const n = this.node(id);
    if (!n.up || n.role !== "leader") return false;
    n.log.push({ term: n.term, value });
    n.matchIndex.set(n.id, n.log.length);
    this.log(n, `appended "${value}" at index ${n.log.length}`);
    this.broadcastAppend(n);
    this.advanceCommit(n);
    return true;
  }

  /** Starts an election on this node now. */
  timeoutNow(id: number): void {
    const n = this.node(id);
    if (n.up) this.startElection(n);
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.tick();
  }

  /** Runs until nothing is in flight, for scripted scenarios with no timers running. */
  settle(limit = 200): void {
    for (let i = 0; i < limit && this.messages.length > 0; i++) this.tick();
  }

  tick(): void {
    this.time++;
    const due: Message[] = [];
    this.messages = this.messages.filter((m) => {
      if (m.deliverAt > this.time) return true;
      due.push(m);
      return false;
    });
    for (const m of due) {
      const to = this.node(m.to);
      if (to.up && !this.isCut(m.from, m.to)) this.receive(to, m);
    }
    for (const n of this.nodes) {
      if (!n.up) continue;
      if (n.role === "leader") {
        if (this.time >= n.heartbeatDeadline) this.broadcastAppend(n);
      } else if (this.options.autoElections && this.time >= n.electionDeadline) {
        this.startElection(n);
      }
    }
  }

  private send(from: RaftNode, to: number, payload: Payload): void {
    if (this.isCut(from.id, to)) return;
    const [min, max] = this.options.latency;
    this.messages.push({ ...payload, from: from.id, to, sentAt: this.time, deliverAt: this.time + this.random(min, max) });
  }

  private lastLogTerm(n: RaftNode): number {
    return n.log.length === 0 ? 0 : n.log[n.log.length - 1].term;
  }

  private startElection(n: RaftNode): void {
    n.role = "candidate";
    n.term++;
    n.votedFor = n.id;
    n.votes = new Set([n.id]);
    this.resetElectionTimer(n);
    this.log(n, `started an election for term ${n.term}`);
    for (const peer of this.nodes) {
      if (peer.id === n.id) continue;
      this.send(n, peer.id, { type: "RequestVote", term: n.term, lastLogIndex: n.log.length, lastLogTerm: this.lastLogTerm(n) });
    }
    if (n.votes.size >= this.majority()) this.becomeLeader(n);
  }

  private becomeLeader(n: RaftNode): void {
    n.role = "leader";
    n.leaderSince = this.time;
    n.nextIndex = new Map(this.nodes.map((p) => [p.id, n.log.length + 1]));
    n.matchIndex = new Map(this.nodes.map((p) => [p.id, p.id === n.id ? n.log.length : 0]));
    this.log(n, `became leader of term ${n.term}`);
    this.broadcastAppend(n);
  }

  private stepDown(n: RaftNode, term: number): void {
    if (term > n.term) {
      n.term = term;
      n.votedFor = null;
    }
    if (n.role !== "follower") this.log(n, `stepped down in term ${n.term}`);
    n.role = "follower";
    n.votes = new Set();
    this.resetElectionTimer(n);
  }

  private broadcastAppend(n: RaftNode): void {
    n.heartbeatDeadline = this.time + this.options.heartbeat;
    for (const peer of this.nodes) if (peer.id !== n.id) this.sendAppend(n, peer.id);
  }

  private sendAppend(n: RaftNode, to: number): void {
    const next = n.nextIndex.get(to) ?? n.log.length + 1;
    const prevLogIndex = next - 1;
    this.send(n, to, {
      type: "AppendEntries",
      term: n.term,
      prevLogIndex,
      prevLogTerm: prevLogIndex === 0 ? 0 : n.log[prevLogIndex - 1].term,
      entries: n.log.slice(next - 1, next + 4),
      leaderCommit: n.commitIndex,
    });
  }

  private receive(n: RaftNode, m: Message): void {
    if (m.term > n.term) this.stepDown(n, m.term);
    switch (m.type) {
      case "RequestVote":
        return this.onRequestVote(n, m);
      case "VoteReply":
        return this.onVoteReply(n, m);
      case "AppendEntries":
        return this.onAppendEntries(n, m);
      case "AppendReply":
        return this.onAppendReply(n, m);
    }
  }

  private onRequestVote(n: RaftNode, m: RequestVote & { from: number }): void {
    const ownLast = this.lastLogTerm(n);
    const upToDate = m.lastLogTerm > ownLast || (m.lastLogTerm === ownLast && m.lastLogIndex >= n.log.length);
    const free = n.votedFor === null || n.votedFor === m.from;
    const granted = m.term === n.term && free && (upToDate || this.options.bugs.skipVoteLogCheck);
    if (granted) {
      n.votedFor = m.from;
      this.resetElectionTimer(n);
      this.log(n, `voted for ${m.from} in term ${n.term}`);
    }
    this.send(n, m.from, { type: "VoteReply", term: n.term, granted });
  }

  private onVoteReply(n: RaftNode, m: VoteReply & { from: number }): void {
    if (n.role !== "candidate" || m.term !== n.term || !m.granted) return;
    n.votes.add(m.from);
    if (n.votes.size >= this.majority()) this.becomeLeader(n);
  }

  private onAppendEntries(n: RaftNode, m: AppendEntries & { from: number }): void {
    if (m.term < n.term) {
      this.send(n, m.from, { type: "AppendReply", term: n.term, success: false, matchIndex: 0 });
      return;
    }
    if (n.role !== "follower") this.stepDown(n, m.term);
    this.resetElectionTimer(n);
    const matches = m.prevLogIndex === 0 || (m.prevLogIndex <= n.log.length && n.log[m.prevLogIndex - 1].term === m.prevLogTerm);
    if (!matches) {
      this.send(n, m.from, { type: "AppendReply", term: n.term, success: false, matchIndex: 0 });
      return;
    }
    m.entries.forEach((entry, i) => {
      const index = m.prevLogIndex + i + 1;
      const existing = n.log[index - 1];
      if (existing && existing.term !== entry.term) {
        // A conflict: this entry and everything after it can't have been committed by this leader.
        this.log(n, `truncated its log from index ${index}`);
        n.log.length = index - 1;
      }
      if (index > n.log.length) n.log.push(entry);
    });
    const lastNew = m.prevLogIndex + m.entries.length;
    if (m.leaderCommit > n.commitIndex) this.setCommit(n, Math.min(m.leaderCommit, lastNew));
    this.send(n, m.from, { type: "AppendReply", term: n.term, success: true, matchIndex: lastNew });
  }

  private onAppendReply(n: RaftNode, m: AppendReply & { from: number }): void {
    if (n.role !== "leader" || m.term !== n.term) return;
    if (m.success) {
      const match = Math.max(n.matchIndex.get(m.from) ?? 0, m.matchIndex);
      n.matchIndex.set(m.from, match);
      n.nextIndex.set(m.from, match + 1);
      this.advanceCommit(n);
    } else {
      n.nextIndex.set(m.from, Math.max(1, (n.nextIndex.get(m.from) ?? 1) - 1));
      this.sendAppend(n, m.from);
    }
  }

  private advanceCommit(n: RaftNode): void {
    for (let index = n.log.length; index > n.commitIndex; index--) {
      // The commit rule from section 5.4.2: replicas are only counted for entries from this term.
      if (n.log[index - 1].term !== n.term && !this.options.bugs.commitOldTerms) break;
      const replicas = this.nodes.filter((p) => (n.matchIndex.get(p.id) ?? 0) >= index).length;
      if (replicas >= this.majority()) {
        this.setCommit(n, index);
        break;
      }
    }
  }

  private setCommit(n: RaftNode, index: number): void {
    if (index <= n.commitIndex) return;
    n.commitIndex = index;
    while (n.applied.length < Math.min(n.commitIndex, n.log.length)) n.applied.push(n.log[n.applied.length].value);
    this.log(n, `committed through index ${index}`);
  }
}

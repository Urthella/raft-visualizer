import { randomFault } from "./chaos.ts";
import { FIGURE_8 } from "./figure8.ts";
import { Checker, INVARIANTS, type InvariantName } from "./invariants.ts";
import { type Bugs, type Message, NO_BUGS, type RaftNode, Simulation } from "./raft.ts";

const SVG = "http://www.w3.org/2000/svg";
const CENTER = 200;
const RADIUS = 145;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function position(id: number, total: number): [number, number] {
  const angle = -Math.PI / 2 + ((id - 1) * 2 * Math.PI) / total;
  return [CENTER + RADIUS * Math.cos(angle), CENTER + RADIUS * Math.sin(angle)];
}

const bugs: Bugs = { ...NO_BUGS };
let sim: Simulation;
let checker: Checker;
let playing = !matchMedia("(prefers-reduced-motion: reduce)").matches;
let written = 0;
let figureStep = -1;
let nextFault = 0;
let seed = Math.max(1, Number(new URLSearchParams(location.search).get("seed")) || 1);
let carry = 0;
let lastFrame = 0;

function restart(options: { autoElections: boolean }): void {
  sim = new Simulation({ seed, bugs, autoElections: options.autoElections });
  checker = new Checker();
  written = 0;
  nextFault = 0;
  buildRing();
}

function exitFigure8(): void {
  figureStep = -1;
  $("figure8-next").toggleAttribute("disabled", true);
  $("figure8-title").textContent = "";
  $("figure8-explain").textContent = "";
}

function tick(): void {
  sim.tick();
  checker.check(sim);
  if (($("faults") as HTMLInputElement).checked && sim.time >= nextFault) {
    randomFault(sim, `x${++written}`);
    nextFault = sim.time + sim.randomInt(5, 60);
  }
}

// The ring: links and nodes are built once per run and updated each frame.

const nodeEls = new Map<number, { group: SVGElement; term: SVGElement; timer: SVGElement }>();
const linkEls = new Map<string, SVGElement>();
let messageLayer: SVGElement;

function buildRing(): void {
  const ring = $("ring") as unknown as SVGElement;
  ring.replaceChildren();
  nodeEls.clear();
  linkEls.clear();
  const total = sim.nodes.length;
  for (let a = 1; a <= total; a++) {
    for (let b = a + 1; b <= total; b++) {
      const [x1, y1] = position(a, total);
      const [x2, y2] = position(b, total);
      const line = svg("line", { class: "link", x1, y1, x2, y2 });
      ring.append(line);
      linkEls.set(`${a}-${b}`, line);
    }
  }
  messageLayer = svg("g", {});
  ring.append(messageLayer);
  for (const n of sim.nodes) {
    const [x, y] = position(n.id, total);
    const group = svg("g", { class: "node", role: "button", tabindex: 0, transform: `translate(${x} ${y})` });
    const timer = svg("circle", { class: "timer", r: 37, transform: "rotate(-90)", pathLength: 100 });
    const body = svg("circle", { class: "body", r: 32 });
    const label = svg("text", { y: -2 });
    label.textContent = `S${n.id}`;
    const term = svg("text", { class: "small", y: 14 });
    group.append(timer, body, label, term);
    const toggle = () => {
      const current = sim.node(n.id);
      if (current.up) sim.crash(n.id);
      else sim.restart(n.id);
      render();
    };
    group.addEventListener("click", toggle);
    group.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    ring.append(group);
    nodeEls.set(n.id, { group, term, timer });
  }
}

function messageClass(m: Message): string {
  if (m.type === "RequestVote") return "msg vote";
  if (m.type === "VoteReply" || m.type === "AppendReply") return "msg reply";
  return "msg";
}

function renderRing(): void {
  const total = sim.nodes.length;
  for (let a = 1; a <= total; a++) {
    for (let b = a + 1; b <= total; b++) {
      linkEls.get(`${a}-${b}`)?.setAttribute("class", sim.isCut(a, b) ? "link cut" : "link");
    }
  }
  for (const n of sim.nodes) {
    const el = nodeEls.get(n.id);
    if (!el) continue;
    const state = n.up ? n.role : "down";
    el.group.setAttribute("class", `node ${state}`);
    el.group.setAttribute("aria-label", `Node ${n.id}, ${state}, term ${n.term}. ${n.up ? "Crash" : "Restart"} it.`);
    el.term.textContent = n.up ? `term ${n.term}` : "down";
    // The arc shows how long until this node starts an election.
    const [, max] = sim.options.election;
    const left = n.up && n.role !== "leader" && sim.options.autoElections ? Math.max(0, n.electionDeadline - sim.time) : 0;
    el.timer.setAttribute("stroke-dasharray", `${Math.min(100, (left / max) * 100)} 100`);
  }
  messageLayer.replaceChildren();
  for (const m of sim.messages) {
    if (sim.isCut(m.from, m.to)) continue;
    const [x1, y1] = position(m.from, total);
    const [x2, y2] = position(m.to, total);
    const t = Math.min(1, (sim.time + carry - m.sentAt) / Math.max(1, m.deliverAt - m.sentAt));
    const r = m.type === "AppendEntries" && m.entries.length > 0 ? 7 : 4;
    messageLayer.append(svg("circle", { class: messageClass(m), r, cx: x1 + (x2 - x1) * t, cy: y1 + (y2 - y1) * t }));
  }
}

function renderInvariants(): void {
  const list = $("invariants");
  list.replaceChildren();
  for (const name of Object.keys(INVARIANTS) as InvariantName[]) {
    const violation = checker.firstOf(name);
    const li = document.createElement("li");
    li.className = violation ? "broken" : "ok";
    const title = document.createElement("span");
    title.className = "name";
    title.textContent = name;
    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = violation ? `Tick ${violation.time}: ${violation.detail}` : INVARIANTS[name];
    li.append(title, detail);
    list.append(li);
  }
}

function renderLogs(): void {
  const table = $("logs");
  const longest = Math.max(1, ...sim.nodes.map((n) => n.log.length));
  const shown = Math.min(longest, 40);
  const first = longest - shown; // long runs show the newest entries
  table.replaceChildren();
  const head = document.createElement("tr");
  head.append(document.createElement("th"));
  for (let i = 0; i < shown; i++) {
    const th = document.createElement("th");
    th.textContent = String(first + i + 1);
    th.scope = "col";
    head.append(th);
  }
  table.append(head);
  for (const n of sim.nodes) table.append(logRow(n, first, shown));
}

function logRow(n: RaftNode, first: number, shown: number): HTMLTableRowElement {
  const row = document.createElement("tr");
  if (!n.up) row.className = "down";
  const th = document.createElement("th");
  th.textContent = `S${n.id}`;
  th.scope = "row";
  row.append(th);
  for (let i = 0; i < shown; i++) {
    const index = first + i;
    const cell = document.createElement("td");
    const entry = n.log[index];
    if (entry) {
      cell.className = `t${entry.term % 6}${index < n.commitIndex ? " committed" : ""}`;
      cell.textContent = entry.value;
      const term = document.createElement("small");
      term.textContent = `t${entry.term}`;
      cell.append(term);
    }
    row.append(cell);
  }
  return row;
}

function renderEvents(): void {
  const list = $("events");
  list.replaceChildren();
  for (const e of sim.events.slice(-10).reverse()) {
    const li = document.createElement("li");
    const who = document.createElement("b");
    who.textContent = `S${e.node}`;
    li.append(`${e.time}: `, who, ` ${e.text}`);
    list.append(li);
  }
}

function render(): void {
  renderRing();
  renderLogs();
  renderInvariants();
  renderEvents();
  $("time").textContent = String(sim.time);
  const leader = sim.leader();
  $("leader").textContent = leader ? `S${leader.id}` : "none";
  $("term").textContent = String(Math.max(...sim.nodes.map((n) => n.term)));
  $("play").textContent = playing ? "Pause" : "Play";
}

function frame(now: number): void {
  const elapsed = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  if (playing) {
    carry += elapsed * Number(($("speed") as HTMLInputElement).value);
    while (carry >= 1) {
      tick();
      carry -= 1;
    }
    render();
  }
  requestAnimationFrame(frame);
}

$("play").addEventListener("click", () => {
  playing = !playing;
  render();
});

$("step").addEventListener("click", () => {
  playing = false;
  tick();
  render();
});

$("write").addEventListener("click", () => {
  const leader = sim.leader();
  if (leader) sim.propose(leader.id, `x${++written}`);
  render();
});

$("isolate").addEventListener("click", () => {
  const leader = sim.leader();
  if (leader) sim.isolate(leader.id);
  render();
});

$("heal").addEventListener("click", () => {
  sim.heal();
  render();
});

for (const box of document.querySelectorAll<HTMLInputElement>("input[data-bug]")) {
  box.addEventListener("change", () => {
    bugs[box.dataset.bug as keyof Bugs] = box.checked;
    exitFigure8();
    restart({ autoElections: true });
    playing = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    render();
  });
}

$("rerun").addEventListener("click", () => {
  seed = Math.max(1, Number(($("seed") as HTMLInputElement).value) || 1);
  history.replaceState(null, "", `?seed=${seed}`);
  exitFigure8();
  restart({ autoElections: true });
  render();
});

$("figure8-start").addEventListener("click", () => {
  playing = false;
  ($("faults") as HTMLInputElement).checked = false;
  restart({ autoElections: false });
  figureStep = 0;
  $("figure8-next").removeAttribute("disabled");
  $("figure8-title").textContent = "Ready";
  $("figure8-explain").textContent = "Timers are off, so elections only happen when the script says. Select “Next step”.";
  render();
});

$("figure8-next").addEventListener("click", () => {
  const step = FIGURE_8[figureStep];
  if (!step) return;
  step.run(sim, checker);
  $("figure8-title").textContent = `Step ${figureStep + 1} of ${FIGURE_8.length}: ${step.title}`;
  $("figure8-explain").textContent = step.explain;
  figureStep++;
  if (figureStep >= FIGURE_8.length) {
    $("figure8-next").toggleAttribute("disabled", true);
    const lost = checker.violations.length > 0;
    $("figure8-explain").textContent += lost
      ? " That's the bug: the checker flagged the overwritten entry above."
      : " No entry that counted as committed was lost, because “b” was never counted.";
  }
  render();
});

($("seed") as HTMLInputElement).value = String(seed);
restart({ autoElections: true });
render();
requestAnimationFrame((now) => {
  lastFrame = now;
  frame(now);
});

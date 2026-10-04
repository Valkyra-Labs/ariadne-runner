/*
  Timing of the engine in Node, on the built package (dist). Prints a
  Markdown table for docs/MEASUREMENTS.md.

  Each sample times a batch of calls and divides by the batch size; the table
  gives the best and the median sample of SAMPLES. Delays between events are
  not waited for (time scale 0, or a sleep that resolves at once): the
  figures are the engine's computing cost, not the pacing of a demo run.

    pnpm bench
*/

import { execSync } from "node:child_process";
import os from "node:os";
import {
  createAgentHandler,
  encodeDecisions,
  encodePlanPayload,
  generatePlan,
  generateScenario,
  resolvePlan,
  runPlan,
} from "../dist/index.js";

const SAMPLES = 30;

/* Results are folded into a sink that is printed, so no call can be elided */
let sink = 0;
const keep = (value) => {
  sink =
    (sink + (Array.isArray(value) ? value.length : typeof value === "string" ? value.length : 1)) |
    0;
};

function sample(batch, fn) {
  const times = [];
  for (let s = 0; s < SAMPLES; s++) {
    const start = performance.now();
    for (let i = 0; i < batch; i++) keep(fn());
    times.push((performance.now() - start) / batch);
  }
  times.sort((a, b) => a - b);
  return { best: times[0], median: times[Math.floor(times.length / 2)] };
}

async function sampleAsync(batch, fn) {
  const times = [];
  for (let s = 0; s < SAMPLES; s++) {
    const start = performance.now();
    for (let i = 0; i < batch; i++) keep(await fn());
    times.push((performance.now() - start) / batch);
  }
  times.sort((a, b) => a - b);
  return { best: times[0], median: times[Math.floor(times.length / 2)] };
}

/* Replays a run and returns its items; answers pauses from the given log */
function replay(steps, decisions) {
  const items = [];
  for (const item of runPlan({
    steps,
    autonomy: "high_only",
    decisions,
    undoWindowSec: null,
    timeScale: 0,
    now: () => 0,
  })) {
    items.push(item);
  }
  return items;
}

/* The decision log of a full run: confirm, allow and retry at every pause */
function fullLog(steps) {
  const log = [];
  for (;;) {
    const items = replay(steps, log);
    const last = items.at(-1);
    if (last.kind !== "pause") return { log, events: items.filter((i) => i.kind === "event") };
    const command = ["confirm", "allow", "retry"].find((c) => last.accepts.includes(c));
    const lastId = items.filter((i) => i.kind === "event").at(-1).id;
    log.push({ command, stepId: last.stepId, afterEventId: lastId });
  }
}

const plan = resolvePlan({
  seed: 7,
  autonomy: "high_only",
  steps: generatePlan(7).map((s) => ({ id: s.id, askFirst: false })),
});
if (!plan.ok) throw new Error(plan.error);
const { log, events } = fullLog(plan.steps);

/* Every segment of a session: the run replayed once per decision, plus one */
function wholeSession() {
  let events = 0;
  for (let i = 0; i <= log.length; i++) events += replay(plan.steps, log.slice(0, i)).length;
  return events;
}

const handler = createAgentHandler({ sleep: async () => {}, now: () => 0 });
const payload = encodePlanPayload({
  seed: 7,
  autonomy: "high_only",
  steps: plan.steps.map((s) => ({ id: s.id, askFirst: false })),
});
const fullUrl = `https://app.test/api/agent?plan=${payload}&decisions=${encodeDecisions(log)}`;
const sseText = await handler(new Request(fullUrl)).text();

/* Warm-up so the JIT has seen every path */
for (let i = 0; i < 2000; i++) generateScenario(i);
for (let i = 0; i < 200; i++) wholeSession();
for (let i = 0; i < 200; i++) await handler(new Request(fullUrl)).text();

const rows = [
  ["generateScenario(7): plan of 12 steps", sample(1000, () => generateScenario(7).steps)],
  [
    `replay of the complete run (${log.length} decisions, ${events.length} events)`,
    sample(200, () => replay(plan.steps, log)),
  ],
  [`every segment of one session (${log.length + 1} replays)`, sample(50, wholeSession)],
  [
    `handleAgentRequest in Node: complete run, Request to SSE text (${sseText.length} bytes)`,
    await sampleAsync(50, () => handler(new Request(fullUrl)).text()),
  ],
];

const commit = execSync("git rev-parse --short HEAD").toString().trim();
const dirty = execSync("git status --porcelain --untracked-files=no").toString().trim() !== "";
const fmt = (ms) => (ms < 1 ? `${(ms * 1000).toFixed(1)} us` : `${ms.toFixed(3)} ms`);

console.log(`commit ${commit}${dirty ? " (working tree modified)" : ""}`);
console.log(`node ${process.version}, ${os.cpus()[0].model}, ${os.platform()} ${os.release()}`);
console.log(`samples per row: ${SAMPLES}, sink ${sink}\n`);
console.log("| measure | best | median |");
console.log("|---|---|---|");
for (const [name, r] of rows) console.log(`| ${name} | ${fmt(r.best)} | ${fmt(r.median)} |`);

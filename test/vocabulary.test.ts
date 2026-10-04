/*
  The engine emits no human language. A string value anywhere in an emitted
  event, a waiting notice, a plan step, a conflict, a session log or an error
  response counts as clean when it is one of these:

    - a code: an exact member of ALL_CODES (src/codes.ts), the closed list of
      lowercase ASCII identifiers the engine is allowed to emit;
    - a step id of the plan being run (s1 .. s12);
    - a string without any letter (\p{L}): numbers, ISO dates such as
      2026-09-30, clock times such as 10:00:12.

  Anything else with a letter in it, in any script, fails: a sentence, a
  capitalised word, a code with a space or a typo, a lowercase word that is
  not in the vocabulary. Object keys are field names fixed by the types and
  are not checked; values are.
*/

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createActor, SimulatedClock } from "xstate";
import { describe, expect, it } from "vitest";
import {
  ALL_CODES,
  AUTONOMIES,
  createAgentHandler,
  encodeDecisions,
  encodePlanPayload,
  exportLog,
  findConflicts,
  generatePlan,
  generateScenario,
  planMachine,
  type Autonomy,
  type Command,
  type Decision,
  type RunEvent,
} from "../src/index.js";
import { decide, payloadFor, run, runToEnd } from "./helpers.js";
import { parseEventStream } from "./sse-parse.js";

const LETTER = /\p{L}/u;
const CODE_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/* Paths of every string value that is not a code, a step id or letter-free */
function violations(value: unknown, stepIds: ReadonlySet<string>, path = "$"): string[] {
  if (typeof value === "string") {
    if (!LETTER.test(value) || ALL_CODES.has(value) || stepIds.has(value)) return [];
    return [`${path} = ${JSON.stringify(value)}`];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => violations(v, stepIds, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => violations(v, stepIds, `${path}.${k}`));
  }
  return [];
}

const STEP_IDS: ReadonlySet<string> = new Set(generatePlan(7).map((s) => s.id));

describe("the checker itself", () => {
  it("accepts codes, step ids, numbers, dates and clock times", () => {
    expect(
      violations(
        {
          type: "step.finished",
          stepId: "s12",
          reason: "stopped_by_user",
          date: "2026-09-30",
          time: "10:00:12",
          n: 3,
          b: true,
          none: null,
          list: ["tax_id", "subject"],
        },
        STEP_IDS,
      ),
    ).toEqual([]);
  });

  it("rejects prose in any script and anything that only looks like a code", () => {
    const samples = [
      "Заявка №1043 проверена",
      "Request 1043 checked",
      "Timeout",
      "stopped by user",
      "stopped_by_usr",
      "hello",
      "s13",
      "تم التحقق",
      "Step.finished",
    ];
    for (const s of samples) {
      expect(violations({ field: s }, STEP_IDS), s).toEqual([`$.field = ${JSON.stringify(s)}`]);
    }
  });

  it("finds a string nested deep in arrays and objects", () => {
    expect(violations({ a: [{ b: { c: ["ok", 1] } }] }, STEP_IDS)).toEqual([
      '$.a[0].b.c[0] = "ok"',
    ]);
  });
});

describe("vocabulary", () => {
  it("every code is a lowercase ASCII identifier", () => {
    for (const code of ALL_CODES) expect(code, code).toMatch(CODE_SHAPE);
  });

  it("the engine source contains no character outside ASCII", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(join(import.meta.dirname, "..", "src"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const index = text.search(/[^\x00-\x7f]/);
      expect(index, `${file} at ${index}`).toBe(-1);
    }
  });
});

/* Every event of every run below: many seeds, every autonomy, every branch */
function collectRuns(): { events: RunEvent[]; notices: unknown[] } {
  const events: RunEvent[] = [];
  const notices: unknown[] = [];
  const preferences: readonly (readonly Command[])[] = [
    ["confirm", "allow", "retry"],
    ["confirm", "deny", "skip"],
    ["skip", "deny"],
    ["stop"],
  ];
  for (let seed = 1; seed <= 40; seed++) {
    for (const autonomy of AUTONOMIES as readonly Autonomy[]) {
      const askFirst = seed % 2 === 0 ? ["s1", "s2", "s6"] : [];
      const payload = payloadFor(undefined, autonomy, askFirst, seed);
      for (const prefer of preferences) {
        const { segment, log } = runToEnd(payload, prefer);
        events.push(...segment.events.map((e) => e.event));
        /* Every intermediate pause as well */
        for (let i = 0; i < log.length; i++) {
          const partial = run(payload, log.slice(0, i));
          if (partial.pause) notices.push(partial.pause);
        }
      }
    }
  }
  /* A stop taken while a step runs, at every point of a short plan */
  const payload = payloadFor(["s1", "s2", "s6"]);
  for (let after = 1; after < 20; after++) {
    events.push(...run(payload, [decide("stop", null, after)]).events.map((e) => e.event));
  }
  return { events, notices };
}

describe("emitted data has no human language", () => {
  it("run events and waiting notices over 40 seeds, every autonomy and branch", () => {
    const { events, notices } = collectRuns();
    const types = new Set(events.map((e) => e.type));
    /* The sweep reaches every event kind, so the check covers all of them */
    expect([...types].sort()).toEqual(
      [
        "plan.started",
        "step.started",
        "step.deviation",
        "step.deviated",
        "step.awaiting",
        "step.running",
        "step.progress",
        "step.finished",
        "step.skipped",
        "step.error",
        "plan.finished",
        "plan.stopped",
      ].sort(),
    );
    const reasons = new Set(events.flatMap((e) => (e.type === "step.skipped" ? [e.reason] : [])));
    expect([...reasons].sort()).toEqual(
      ["skipped_after_error", "skipped_by_user", "stopped_by_user"].sort(),
    );
    expect(violations(events, STEP_IDS)).toEqual([]);
    expect(violations(notices, STEP_IDS)).toEqual([]);
  });

  it("plans, scenarios and conflicts", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const plan = generatePlan(seed);
      expect(violations(plan, STEP_IDS)).toEqual([]);
      expect(violations(generateScenario(seed), STEP_IDS)).toEqual([]);
      expect(violations(findConflicts(plan), STEP_IDS)).toEqual([]);
    }
  });

  it("the plan machine's session log and its export", () => {
    const clock = new SimulatedClock();
    const actor = createActor(planMachine, { input: { seed: 7 }, clock }).start();
    actor.send({ type: "APPROVE", sessionId: "x", at: 1 });
    const { segment, log } = runToEnd(payloadFor());
    let at = 10;
    let decided = 0;
    for (const { id, event } of segment.events) {
      actor.send({ type: "RUN_EVENT", event, at: (at += 10) });
      /* Replay the user's decisions at the points they were taken */
      while (decided < log.length && log[decided]!.afterEventId === id) {
        const d: Decision = log[decided]!;
        if (d.stepId) {
          const command = d.command as Exclude<Command, "stop">;
          actor.send({ type: "DECIDE", stepId: d.stepId, command, at: (at += 1) });
        }
        decided += 1;
      }
    }
    actor.send({ type: "UNDO", stepId: "s1", at: (at += 1) });
    actor.send({ type: "UNDO", stepId: "s3", at: (at += 1) });
    const ctx = actor.getSnapshot().context;
    expect(actor.getSnapshot().value).toBe("finished");
    expect(ctx.undos).toBe(2);
    expect(new Set(ctx.log.map((l) => l.kind))).toEqual(
      new Set(["approved", "event", "decision", "undo"]),
    );
    expect(violations(ctx.log, STEP_IDS)).toEqual([]);
    const exported = exportLog(ctx.log, { seed: 7, autonomy: ctx.autonomy, total: 12 });
    expect(violations(exported, STEP_IDS)).toEqual([]);
  });

  it("the event stream and the error responses of the Service Worker handler", async () => {
    const handler = createAgentHandler({ sleep: async () => {}, now: () => 1000 });
    const payload = payloadFor();
    const { log } = runToEnd(payload);
    const base = `https://app.test/api/agent?plan=${encodePlanPayload(payload)}`;
    for (let i = 0; i <= log.length; i++) {
      const url = `${base}&decisions=${encodeDecisions(log.slice(0, i))}&drop=${i % 2}`;
      const text = await handler(new Request(url))!.text();
      for (const frame of parseEventStream(text)) {
        expect(violations([frame.id, frame.event], STEP_IDS)).toEqual([]);
        if (frame.data !== "") {
          expect(violations(JSON.parse(frame.data), STEP_IDS)).toEqual([]);
        }
      }
    }
    const bad = [
      "https://app.test/api/agent",
      "https://app.test/api/agent?plan=x",
      `${base}&decisions=nope`,
      `https://app.test/api/agent?plan=${encodePlanPayload({ seed: 7, autonomy: "ask_all", steps: [{ id: "zz", askFirst: false }] })}`,
    ];
    for (const url of bad) {
      const response = handler(new Request(url))!;
      expect(response.status).toBe(400);
      expect(violations(await response.json(), new Set(["zz"]))).toEqual([]);
    }
  });
});

import { describe, expect, it } from "vitest";
import { createActor, SimulatedClock } from "xstate";
import {
  generatePlan,
  stepMachine,
  stepStatusOf,
  type Autonomy,
  type PlanStep,
  type StepError,
  type StepResult,
} from "../src/index.js";

const plan = generatePlan(7);
const lowStep = plan.find((s) => s.risk === "low")!;
const highStep = plan.find((s) => s.risk === "high")!;
const mediumStep = plan.find((s) => s.risk === "medium")!;
const deviationStep = plan.find((s) => s.deviation)!;
const TIMEOUT: StepError = { code: "service_timeout", service: "contracts", timeoutSec: 5 };

function resultFor(step: PlanStep, undoWindowSec: number | null = step.undoWindowSec): StepResult {
  return {
    summary: step.summary,
    objects: step.objects,
    undo: step.undo,
    undoWindowSec,
  };
}

function start(step: PlanStep, autonomy: Autonomy = "high_only", clock = new SimulatedClock()) {
  const actor = createActor(stepMachine, { input: { step, autonomy }, clock }).start();
  return { actor, clock };
}

describe("step machine: consent rule", () => {
  it("low-risk step runs without confirmation at default autonomy", () => {
    const { actor } = start(lowStep);
    actor.send({ type: "START", at: 1000 });
    expect(actor.getSnapshot().value).toBe("running");
    expect(actor.getSnapshot().context.askedUser).toBe(false);
  });

  it("high-risk step never runs without explicit confirmation at default autonomy", () => {
    const { actor } = start(highStep);
    actor.send({ type: "START", at: 1000 });
    expect(actor.getSnapshot().value).toBe("awaitingConfirmation");
    expect(stepStatusOf(actor.getSnapshot().value)).toBe("awaiting");
    /* Server events that would move it forward are ignored while waiting */
    actor.send({ type: "PROGRESS", percent: 50, phase: "composing_letter" });
    actor.send({ type: "FINISHED", at: 2000, result: resultFor(highStep) });
    expect(actor.getSnapshot().value).toBe("awaitingConfirmation");
    actor.send({ type: "CONFIRM", at: 3000 });
    expect(actor.getSnapshot().value).toBe("running");
  });

  it("the high-risk floor holds even at 'ask nothing'", () => {
    const { actor } = start(highStep, "ask_none");
    actor.send({ type: "START", at: 1000 });
    expect(actor.getSnapshot().value).toBe("awaitingConfirmation");
  });

  it("'ask nothing' ignores the per-step flag for medium risk", () => {
    const { actor } = start({ ...mediumStep, askFirst: true }, "ask_none");
    actor.send({ type: "START", at: 1000 });
    expect(actor.getSnapshot().value).toBe("running");
  });

  it("'high only' honors the per-step flag", () => {
    const { actor } = start({ ...mediumStep, askFirst: true }, "high_only");
    actor.send({ type: "START", at: 1000 });
    expect(actor.getSnapshot().value).toBe("awaitingConfirmation");
  });

  it("'ask all' pauses a low-risk step", () => {
    const { actor } = start(lowStep, "ask_all");
    actor.send({ type: "START", at: 1000 });
    expect(actor.getSnapshot().value).toBe("awaitingConfirmation");
  });

  it("skip from confirmation leads to skipped", () => {
    const { actor } = start(highStep);
    actor.send({ type: "START", at: 1000 });
    actor.send({ type: "SKIP", at: 1500 });
    expect(actor.getSnapshot().value).toBe("skipped");
    expect(actor.getSnapshot().context.skipReason).toBe("skipped_by_user");
    expect(stepStatusOf(actor.getSnapshot().value)).toBe("skipped");
  });
});

describe("step machine: errors and deviations", () => {
  it("error offers retry that increments the attempt", () => {
    const { actor } = start(mediumStep);
    actor.send({ type: "START", at: 1000 });
    actor.send({ type: "FAILED", error: TIMEOUT, attempt: 1 });
    expect(actor.getSnapshot().value).toBe("error");
    expect(actor.getSnapshot().context.error).toEqual(TIMEOUT);
    actor.send({ type: "RETRY", at: 1200 });
    expect(actor.getSnapshot().value).toBe("running");
    expect(actor.getSnapshot().context.attempt).toBe(2);
    expect(actor.getSnapshot().context.error).toBeNull();
  });

  it("error can be skipped", () => {
    const { actor } = start(mediumStep);
    actor.send({ type: "START", at: 1000 });
    actor.send({ type: "FAILED", error: TIMEOUT, attempt: 1 });
    actor.send({ type: "SKIP", at: 1200 });
    expect(actor.getSnapshot().value).toBe("skipped");
    expect(actor.getSnapshot().context.skipReason).toBe("skipped_after_error");
  });

  it("allowed deviation lowers the risk and runs without a second pause", () => {
    const { actor } = start(deviationStep);
    actor.send({ type: "START", at: 1000 });
    expect(actor.getSnapshot().value).toBe("awaitingConfirmation");
    actor.send({ type: "DEVIATION", deviation: deviationStep.deviation! });
    expect(actor.getSnapshot().value).toBe("awaitingDeviation");
    actor.send({ type: "ALLOW", at: 1100 });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("running");
    expect(snap.context.step.risk).toBe("low");
    expect(snap.context.step.type).toBe("check");
    expect(snap.context.deviationAllowed).toBe(true);
  });

  it("denied deviation keeps the original high-risk step waiting for confirmation", () => {
    const { actor } = start(deviationStep);
    actor.send({ type: "START", at: 1000 });
    actor.send({ type: "DEVIATION", deviation: deviationStep.deviation! });
    actor.send({ type: "DENY", at: 1100 });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("awaitingConfirmation");
    expect(snap.context.step.risk).toBe("high");
    expect(snap.context.deviationAllowed).toBe(false);
  });
});

describe("step machine: undo window", () => {
  it("finite window: undo works before expiry and is refused after", () => {
    const { actor, clock } = start(highStep);
    actor.send({ type: "START", at: 1000 });
    actor.send({ type: "CONFIRM", at: 1100 });
    actor.send({ type: "FINISHED", at: 2000, result: resultFor(highStep, 60) });
    expect(actor.getSnapshot().matches({ done: "undoable" })).toBe(true);
    expect(actor.getSnapshot().context.undoDeadline).toBe(62_000);
    expect(actor.getSnapshot().can({ type: "UNDO", at: 3000 })).toBe(true);

    clock.increment(59_000);
    expect(actor.getSnapshot().matches({ done: "undoable" })).toBe(true);
    clock.increment(1_000);
    expect(actor.getSnapshot().matches({ done: "irreversible" })).toBe(true);
    expect(actor.getSnapshot().can({ type: "UNDO", at: 70_000 })).toBe(false);
    actor.send({ type: "UNDO", at: 70_000 });
    expect(stepStatusOf(actor.getSnapshot().value)).toBe("done");
  });

  it("undo inside the window leads to undone with the timestamp", () => {
    const { actor, clock } = start(highStep);
    actor.send({ type: "START", at: 1000 });
    actor.send({ type: "CONFIRM", at: 1100 });
    actor.send({ type: "FINISHED", at: 2000, result: resultFor(highStep, 60) });
    clock.increment(10_000);
    actor.send({ type: "UNDO", at: 12_000 });
    expect(actor.getSnapshot().value).toBe("undone");
    expect(actor.getSnapshot().context.undoneAt).toBe(12_000);
    expect(stepStatusOf(actor.getSnapshot().value)).toBe("undone");
  });

  it("no window: internal changes stay undoable indefinitely", () => {
    const { actor, clock } = start(mediumStep);
    actor.send({ type: "START", at: 1000 });
    actor.send({ type: "FINISHED", at: 2000, result: resultFor(mediumStep, null) });
    expect(actor.getSnapshot().matches({ done: "permanent" })).toBe(true);
    clock.increment(10 * 60 * 1000);
    expect(actor.getSnapshot().can({ type: "UNDO", at: 700_000 })).toBe(true);
  });
});

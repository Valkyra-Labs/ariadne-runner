import { describe, expect, it } from "vitest";
import { createActor, SimulatedClock } from "xstate";
import {
  canDecide,
  generatePlan,
  planMachine,
  stepStatusOf,
  toStepEvent,
  type PlanStep,
  type RunEvent,
  type StepResult,
} from "../src/index.js";

function resultFor(step: PlanStep): StepResult {
  return {
    summary: step.summary,
    objects: step.objects,
    undo: step.undo,
    undoWindowSec: step.undoWindowSec,
  };
}

function boot() {
  const clock = new SimulatedClock();
  const actor = createActor(planMachine, { input: { seed: 7 }, clock }).start();
  return { actor, clock };
}

function server(actor: ReturnType<typeof boot>["actor"], event: RunEvent, at: number) {
  actor.send({ type: "RUN_EVENT", event, at });
}

describe("plan machine: draft editing", () => {
  it("starts as a draft with the generated plan", () => {
    const { actor } = boot();
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("draft");
    expect(snap.context.steps).toHaveLength(12);
    expect(snap.context.autonomy).toBe("high_only");
  });

  it("removes, moves and flags steps", () => {
    const { actor } = boot();
    const [first, second] = generatePlan(7);
    actor.send({ type: "REMOVE_STEP", id: first!.id });
    expect(actor.getSnapshot().context.steps.map((s) => s.id)).not.toContain(first!.id);
    expect(actor.getSnapshot().context.steps[0]!.id).toBe(second!.id);

    actor.send({ type: "MOVE_STEP", id: second!.id, direction: "down" });
    expect(actor.getSnapshot().context.steps[1]!.id).toBe(second!.id);
    actor.send({ type: "MOVE_STEP", id: second!.id, direction: "up" });
    expect(actor.getSnapshot().context.steps[0]!.id).toBe(second!.id);
    /* Moving the first step up is a no-op */
    actor.send({ type: "MOVE_STEP", id: second!.id, direction: "up" });
    expect(actor.getSnapshot().context.steps[0]!.id).toBe(second!.id);

    actor.send({ type: "REORDER", from: 0, to: 3 });
    expect(actor.getSnapshot().context.steps[3]!.id).toBe(second!.id);

    actor.send({ type: "SET_ASK_FIRST", id: second!.id, askFirst: true });
    expect(actor.getSnapshot().context.steps.find((s) => s.id === second!.id)?.askFirst).toBe(true);
  });

  it("an empty plan cannot be approved and can be restored", () => {
    const { actor } = boot();
    for (const s of generatePlan(7)) actor.send({ type: "REMOVE_STEP", id: s.id });
    expect(actor.getSnapshot().context.steps).toHaveLength(0);
    actor.send({ type: "APPROVE", sessionId: "x", at: 1 });
    expect(actor.getSnapshot().value).toBe("draft");
    actor.send({ type: "RESTORE" });
    expect(actor.getSnapshot().context.steps).toHaveLength(12);
  });
});

describe("plan machine: execution", () => {
  it("approve spawns step actors in plan order, then runs and finishes", () => {
    const { actor } = boot();
    const plan = generatePlan(7);
    actor.send({ type: "REMOVE_STEP", id: plan[0]!.id });
    actor.send({ type: "APPROVE", sessionId: "sess", at: 100 });
    let snap = actor.getSnapshot();
    expect(snap.value).toBe("approved");
    expect(snap.context.order).toEqual(plan.slice(1).map((s) => s.id));
    expect(Object.keys(snap.context.stepRefs)).toHaveLength(11);
    expect(snap.context.stepRefs[plan[0]!.id]).toBeUndefined();

    server(actor, { type: "plan.started", at: 100, total: 11 }, 110);
    expect(actor.getSnapshot().value).toBe("running");

    const step = plan[1]!;
    server(
      actor,
      { type: "step.started", stepId: step.id, at: 120, requiresConfirmation: false },
      120,
    );
    const ref = actor.getSnapshot().context.stepRefs[step.id]!;
    expect(stepStatusOf(ref.getSnapshot().value)).toBe("running");
    server(
      actor,
      { type: "step.progress", stepId: step.id, percent: 40, phase: "preparing_amendment" },
      130,
    );
    expect(ref.getSnapshot().context.progress).toBe(40);
    expect(ref.getSnapshot().context.phase).toBe("preparing_amendment");
    server(
      actor,
      { type: "step.finished", stepId: step.id, at: 140, result: resultFor(step) },
      140,
    );
    expect(stepStatusOf(ref.getSnapshot().value)).toBe("done");

    server(actor, { type: "plan.finished", at: 200 }, 200);
    snap = actor.getSnapshot();
    expect(snap.value).toBe("finished");
    expect(snap.context.startedAt).toBe(110);
    expect(snap.context.finishedAt).toBe(200);
    expect(
      snap.context.log.some((l) => l.kind === "event" && l.event.type === "step.finished"),
    ).toBe(true);
    /* Progress is shown live but not logged */
    expect(
      snap.context.log.some((l) => l.kind === "event" && l.event.type === "step.progress"),
    ).toBe(false);
    expect(snap.context.log[0]).toEqual({
      at: 100,
      kind: "approved",
      total: 11,
      autonomy: "high_only",
      confirmations: plan.slice(1).filter((s) => s.risk === "high").length,
    });
  });

  it("stop is honored after the current step, not in the middle of it", () => {
    const { actor } = boot();
    const plan = generatePlan(7);
    actor.send({ type: "APPROVE", sessionId: "sess", at: 100 });
    server(actor, { type: "plan.started", at: 100, total: 12 }, 110);
    const step = plan[0]!;
    server(
      actor,
      { type: "step.started", stepId: step.id, at: 120, requiresConfirmation: false },
      120,
    );

    actor.send({ type: "STOP", at: 130 });
    expect(actor.getSnapshot().value).toBe("running");
    expect(actor.getSnapshot().context.stopRequested).toBe(true);
    expect(actor.getSnapshot().context.log.at(-1)).toEqual({ at: 130, kind: "stop_requested" });

    /* The current step still finishes */
    server(
      actor,
      { type: "step.finished", stepId: step.id, at: 140, result: resultFor(step) },
      140,
    );
    const ref = actor.getSnapshot().context.stepRefs[step.id]!;
    expect(stepStatusOf(ref.getSnapshot().value)).toBe("done");

    /* A new step may not start after the stop request */
    const next = plan[1]!;
    server(
      actor,
      { type: "step.started", stepId: next.id, at: 150, requiresConfirmation: false },
      150,
    );
    expect(stepStatusOf(actor.getSnapshot().context.stepRefs[next.id]!.getSnapshot().value)).toBe(
      "waiting",
    );

    server(actor, { type: "plan.stopped", at: 160, afterStepId: step.id }, 160);
    expect(actor.getSnapshot().value).toBe("stopped");
    expect(actor.getSnapshot().context.stoppedAfter).toBe(step.id);
  });

  it("once the run has stopped, no step still reads as waiting to run", () => {
    const { actor } = boot();
    const plan = generatePlan(7);
    actor.send({ type: "APPROVE", sessionId: "sess", at: 100 });
    server(actor, { type: "plan.started", at: 100, total: 12 }, 110);
    const first = plan[0]!;
    server(
      actor,
      { type: "step.started", stepId: first.id, at: 120, requiresConfirmation: false },
      120,
    );
    actor.send({ type: "STOP", at: 130 });
    server(
      actor,
      { type: "step.finished", stepId: first.id, at: 140, result: resultFor(first) },
      140,
    );
    const logged = actor.getSnapshot().context.log.length;
    server(actor, { type: "plan.stopped", at: 160, afterStepId: first.id }, 160);

    const steps = actor.getSnapshot().context.stepRefs;
    expect(stepStatusOf(steps[first.id]!.getSnapshot().value)).toBe("done");
    for (const step of plan.slice(1)) {
      const snapshot = steps[step.id]!.getSnapshot();
      expect(stepStatusOf(snapshot.value)).toBe("skipped");
      expect(snapshot.context.skipReason).toBe("stopped_by_user");
    }
    /* The log holds what the stream sent, and nothing the page inferred */
    expect(actor.getSnapshot().context.log).toHaveLength(logged + 1);
  });

  it("decisions are forwarded and counted; undo respects the window", () => {
    const { actor, clock } = boot();
    const plan = generatePlan(7);
    const high = plan.find((s) => s.risk === "high")!;
    actor.send({ type: "APPROVE", sessionId: "sess", at: 100 });
    server(actor, { type: "plan.started", at: 100, total: 12 }, 110);
    server(
      actor,
      { type: "step.started", stepId: high.id, at: 120, requiresConfirmation: true },
      120,
    );
    server(actor, { type: "step.awaiting", stepId: high.id, draft: high.draft }, 121);
    const ref = actor.getSnapshot().context.stepRefs[high.id]!;
    expect(stepStatusOf(ref.getSnapshot().value)).toBe("awaiting");
    expect(actor.getSnapshot().context.askedStepIds).toEqual([high.id]);

    actor.send({ type: "DECIDE", stepId: high.id, command: "confirm", at: 130 });
    expect(stepStatusOf(ref.getSnapshot().value)).toBe("running");
    server(
      actor,
      { type: "step.finished", stepId: high.id, at: 140, result: resultFor(high) },
      140,
    );
    server(actor, { type: "plan.finished", at: 200 }, 200);

    actor.send({ type: "UNDO", stepId: high.id, at: 300 });
    expect(stepStatusOf(ref.getSnapshot().value)).toBe("undone");
    expect(actor.getSnapshot().context.undos).toBe(1);
    expect(actor.getSnapshot().context.log.at(-1)).toEqual({
      at: 300,
      kind: "undo",
      stepId: high.id,
      undo: high.undo,
    });
    expect(actor.getSnapshot().context.log).toContainEqual({
      at: 130,
      kind: "decision",
      stepId: high.id,
      command: "confirm",
    });

    /* A second undo of the same step is refused by the guard */
    actor.send({ type: "UNDO", stepId: high.id, at: 400 });
    expect(actor.getSnapshot().context.undos).toBe(1);
    clock.increment(1);
  });

  it("a decision the step has moved past is refused", () => {
    const { actor } = boot();
    const high = generatePlan(7).find((s) => s.risk === "high")!;
    actor.send({ type: "APPROVE", sessionId: "sess", at: 100 });
    server(actor, { type: "plan.started", at: 100, total: 12 }, 110);
    server(
      actor,
      { type: "step.started", stepId: high.id, at: 120, requiresConfirmation: true },
      120,
    );
    server(actor, { type: "step.awaiting", stepId: high.id, draft: high.draft }, 121);
    const ref = actor.getSnapshot().context.stepRefs[high.id]!;

    expect(canDecide(ref, "confirm", 130)).toBe(true);
    expect(canDecide(ref, "retry", 130)).toBe(false);
    actor.send({ type: "DECIDE", stepId: high.id, command: "confirm", at: 130 });
    /* The step is running now, so a repeated confirmation is not a decision */
    expect(canDecide(ref, "confirm", 131)).toBe(false);
  });

  it("reset returns to a fresh draft", () => {
    const { actor } = boot();
    actor.send({ type: "APPROVE", sessionId: "sess", at: 100 });
    server(actor, { type: "plan.started", at: 100, total: 12 }, 110);
    server(actor, { type: "plan.finished", at: 200 }, 200);
    actor.send({ type: "RESET", at: 300 });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("draft");
    expect(snap.context.sessionId).toBeNull();
    expect(Object.keys(snap.context.stepRefs)).toHaveLength(0);
    expect(snap.context.steps).toHaveLength(12);
  });
});

describe("toStepEvent", () => {
  it("maps server events and ignores plan-level ones", () => {
    expect(toStepEvent({ type: "plan.finished", at: 1 }, 1)).toBeNull();
    expect(
      toStepEvent({ type: "step.started", stepId: "s1", at: 1, requiresConfirmation: true }, 5),
    ).toEqual({
      type: "START",
      at: 5,
    });
    const error = { code: "service_timeout", service: "contracts", timeoutSec: 5 } as const;
    expect(toStepEvent({ type: "step.error", stepId: "s1", error, attempt: 1 }, 5)).toEqual({
      type: "FAILED",
      error,
      attempt: 1,
    });
  });
});

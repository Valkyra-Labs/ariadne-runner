import { describe, expect, it } from "vitest";
import {
  decodeDecisions,
  decodePlanPayload,
  encodeDecisions,
  encodePlanPayload,
  generateScenario,
  parseStreamOptions,
  resolvePlan,
  type Decision,
} from "../src/index.js";
import { decide, find, payloadFor, run } from "./helpers.js";

describe("plan resolution", () => {
  it("rejects unknown steps and empty plans", () => {
    expect(resolvePlan({ seed: 7, autonomy: "high_only", steps: [] })).toEqual({
      ok: false,
      error: "empty_plan",
    });
    expect(
      resolvePlan({ seed: 7, autonomy: "high_only", steps: [{ id: "zz", askFirst: false }] }),
    ).toEqual({ ok: false, error: "unknown_step", stepId: "zz" });
    expect(resolvePlan(payloadFor(["s1"])).ok).toBe(true);
  });
});

describe("runner: one segment per decision", () => {
  it("runs a low-risk step without pausing and finishes", () => {
    const segment = run(payloadFor(["s1"]));
    expect(segment.types).toEqual([
      "plan.started",
      "step.started",
      "step.running",
      "step.progress",
      "step.progress",
      "step.finished",
      "plan.finished",
    ]);
    expect(segment.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(segment.pause).toBeNull();
    const phases = segment.events.flatMap((e) =>
      e.event.type === "step.progress" ? [[e.event.percent, e.event.phase]] : [],
    );
    expect(phases).toEqual([
      [30, "matching_registry"],
      [65, "reviewing_supplier_history"],
    ]);
  });

  it("a high-risk step stops the segment at the confirmation and runs nothing", () => {
    const segment = run(payloadFor(["s3"]));
    expect(segment.types).toEqual(["plan.started", "step.started", "step.awaiting"]);
    expect(segment.pause).toEqual({ stepId: "s3", accepts: ["confirm", "skip"] });
    expect(find(segment, "step.awaiting").draft.kind).toBe("email");
  });

  it("the confirmation in the log lets the same replay go through with the undo window", () => {
    const paused = run(payloadFor(["s3"]));
    const segment = run(payloadFor(["s3"]), [decide("confirm", "s3", paused.lastId)], 2);
    expect(segment.types).toContain("step.finished");
    const finished = find(segment, "step.finished");
    expect(finished.result.undoWindowSec).toBe(2);
    expect(finished.result.undo.code).toBe("recall_letter");
    expect(finished.result.summary.code).toBe("documents_requested");
    expect(segment.types.at(-1)).toBe("plan.finished");
    /* The replayed prefix keeps the ids the application already has */
    expect(segment.events.slice(0, paused.events.length)).toEqual(paused.events);
  });

  it("a confirmation for another step never unlocks a high-risk step", () => {
    const segment = run(payloadFor(["s3"]), [decide("confirm", "s5", 3)]);
    expect(segment.types).not.toContain("step.running");
    expect(segment.pause).toEqual({ stepId: "s3", accepts: ["confirm", "skip"] });
  });

  it("a command the point does not accept is not taken", () => {
    const segment = run(payloadFor(["s3"]), [decide("retry", "s3", 3)]);
    expect(segment.types).not.toContain("step.running");
    expect(segment.pause?.stepId).toBe("s3");
  });

  it("skipping from the confirmation marks the step skipped", () => {
    const segment = run(payloadFor(["s3"]), [decide("skip", "s3", 3)]);
    expect(find(segment, "step.skipped").reason).toBe("skipped_by_user");
    expect(segment.types.at(-1)).toBe("plan.finished");
  });

  it("the scheduled error offers retry and succeeds on the second attempt", () => {
    const { errorStepId } = generateScenario(7);
    const paused = run(payloadFor([errorStepId]));
    expect(paused.pause).toEqual({ stepId: errorStepId, accepts: ["retry", "skip", "stop"] });
    const error = find(paused, "step.error");
    expect(error.attempt).toBe(1);
    expect(error.error).toEqual({ code: "service_timeout", service: "contracts", timeoutSec: 5 });

    const segment = run(payloadFor([errorStepId]), [decide("retry", errorStepId, paused.lastId)]);
    expect(segment.types.filter((t) => t === "step.running")).toHaveLength(2);
    expect(segment.types).toContain("step.finished");
    expect(segment.types.at(-1)).toBe("plan.finished");
  });

  it("skipping from the error box marks the step skipped after the error", () => {
    const { errorStepId } = generateScenario(7);
    const paused = run(payloadFor([errorStepId]));
    const segment = run(payloadFor([errorStepId]), [decide("skip", errorStepId, paused.lastId)]);
    expect(find(segment, "step.skipped").reason).toBe("skipped_after_error");
    expect(segment.types.at(-1)).toBe("plan.finished");
  });

  it("allowed deviation lowers the risk and skips the confirmation pause", () => {
    const { deviationStepId } = generateScenario(7);
    const paused = run(payloadFor([deviationStepId]));
    expect(paused.pause).toEqual({ stepId: deviationStepId, accepts: ["allow", "deny"] });
    expect(find(paused, "step.deviation").deviation).toMatchObject({
      reason: "fresh_documents_in_archive",
      proposal: "check_by_archive",
      newType: "check",
      newRisk: "low",
    });

    const segment = run(payloadFor([deviationStepId]), [
      decide("allow", deviationStepId, paused.lastId),
    ]);
    expect(segment.types).toContain("step.deviated");
    expect(segment.types).not.toContain("step.awaiting");
    const deviated = find(segment, "step.deviated");
    expect(deviated.risk).toBe("low");
    expect(deviated.deviatedTo).toBe("check_by_archive");
    expect(find(segment, "step.finished").result.summary.code).toBe("request_checked_by_archive");
    expect(segment.types.at(-1)).toBe("plan.finished");
  });

  it("denied deviation falls back to the confirmation pause", () => {
    const { deviationStepId } = generateScenario(7);
    const denied = run(payloadFor([deviationStepId]), [decide("deny", deviationStepId, 3)]);
    expect(denied.pause).toEqual({ stepId: deviationStepId, accepts: ["confirm", "skip"] });

    const segment = run(payloadFor([deviationStepId]), [
      decide("deny", deviationStepId, 3),
      decide("confirm", deviationStepId, denied.lastId),
    ]);
    expect(segment.types.at(-1)).toBe("plan.finished");
  });

  it("stop at a pause skips the waiting step and stops the plan", () => {
    const payload = payloadFor(["s1", "s3", "s6"]);
    const paused = run(payload);
    const segment = run(payload, [decide("stop", null, paused.lastId)]);
    const stopped = find(segment, "plan.stopped");
    expect(stopped.afterStepId).toBe("s1");
    expect(segment.types.filter((t) => t === "step.finished")).toHaveLength(1);
    expect(find(segment, "step.skipped").reason).toBe("stopped_by_user");
  });

  it("stop at a deviation skips the step and stops the plan", () => {
    const { deviationStepId } = generateScenario(7);
    const paused = run(payloadFor([deviationStepId]));
    const segment = run(payloadFor([deviationStepId]), [decide("stop", null, paused.lastId)]);
    expect(find(segment, "step.skipped").reason).toBe("stopped_by_user");
    expect(find(segment, "plan.stopped").afterStepId).toBeNull();
  });

  it("stop taken while a step ran ends the plan after that step, not inside it", () => {
    const payload = payloadFor(["s1", "s2"]);
    const full = run(payload);
    const startedS2 = full.events.find((e) => e.event.type === "step.started" && e.id > 2)!;
    const segment = run(payload, [decide("stop", null, startedS2.id + 1)]);
    expect(find(segment, "plan.stopped").afterStepId).toBe("s2");
    expect(segment.types.filter((t) => t === "step.finished")).toHaveLength(2);
  });

  it("stop before the first step stops the plan with nothing done", () => {
    const segment = run(payloadFor(["s1", "s2"]), [decide("stop", null, 1)]);
    expect(segment.types).toEqual(["plan.started", "plan.stopped"]);
    expect(find(segment, "plan.stopped").afterStepId).toBeNull();
  });

  it("stop from the error box skips the failed step", () => {
    const { errorStepId } = generateScenario(7);
    const paused = run(payloadFor([errorStepId]));
    const segment = run(payloadFor([errorStepId]), [decide("stop", null, paused.lastId)]);
    expect(find(segment, "step.skipped").reason).toBe("stopped_by_user");
    expect(find(segment, "plan.stopped").afterStepId).toBeNull();
  });

  it("ask_all pauses even a low-risk step; ask_none keeps the high-risk floor", () => {
    const all = run(payloadFor(["s1"], "ask_all"));
    expect(all.pause).toEqual({ stepId: "s1", accepts: ["confirm", "skip"] });

    const none = run(payloadFor(["s1", "s3"], "ask_none", ["s1"]));
    expect(none.pause?.stepId).toBe("s3");
    expect(none.types.filter((t) => t === "step.awaiting")).toHaveLength(1);
  });

  it("a step flagged ask first pauses under the default autonomy", () => {
    const flagged = run(payloadFor(["s1"], "high_only", ["s1"]));
    expect(flagged.pause?.stepId).toBe("s1");
  });

  it("the whole plan replays to the same ids for the same decision log", () => {
    const payload = payloadFor();
    const log: Decision[] = [];
    let guard = 0;
    let segment = run(payload, log);
    while (segment.pause && guard < 40) {
      guard += 1;
      const accepts = segment.pause.accepts;
      const command = accepts.includes("confirm") ? "confirm" : accepts[0]!;
      log.push(decide(command, segment.pause.stepId, segment.lastId));
      const next = run(payload, log);
      /* Everything the application already had keeps its id and its content */
      expect(next.events.slice(0, segment.events.length)).toEqual(segment.events);
      segment = next;
    }
    expect(segment.types.at(-1)).toBe("plan.finished");
    expect(segment.types.filter((t) => t === "step.finished")).toHaveLength(12);
  });
});

describe("protocol helpers", () => {
  it("encodes and decodes the plan payload", () => {
    const payload = payloadFor(["s1", "s3"]);
    expect(decodePlanPayload(encodePlanPayload(payload))).toEqual(payload);
    expect(decodePlanPayload("not-base64-json")).toBeNull();
  });

  it("encodes and decodes the decision log", () => {
    const log = [decide("confirm", "s3", 14), decide("retry", "s4", 21), decide("stop", null, 33)];
    const text = encodeDecisions(log);
    expect(text).toBe("confirm-s3-14.retry-s4-21.stop--33");
    expect(decodeDecisions(text)).toEqual(log);
    expect(decodeDecisions(null)).toEqual([]);
    expect(decodeDecisions("")).toEqual([]);
    expect(decodeDecisions("confirm-s3")).toBeNull();
    expect(decodeDecisions("erase-s3-1")).toBeNull();
    expect(decodeDecisions("stop-s3-1")).toBeNull();
    expect(decodeDecisions("confirm--1")).toBeNull();
    expect(decodeDecisions("confirm-s3-x")).toBeNull();
    expect(decodeDecisions("confirm-s3--2")).toBeNull();
  });

  it("keeps a full twelve step run inside a short URL", () => {
    const params = new URLSearchParams({
      plan: encodePlanPayload(payloadFor()),
      decisions: encodeDecisions([
        decide("confirm", "s3", 14),
        decide("retry", "s4", 21),
        decide("confirm", "s5", 30),
        decide("allow", "s7", 41),
        decide("confirm", "s9", 55),
        decide("confirm", "s11", 70),
        decide("confirm", "s12", 82),
      ]),
    });
    expect(params.toString().length).toBeLessThan(1024);
  });

  it("parses the stream options", () => {
    expect(parseStreamOptions(new URLSearchParams("speed=fast&drop=1&undoWindow=2"))).toEqual({
      speed: "fast",
      drop: true,
      undoWindowSec: 2,
    });
    expect(parseStreamOptions(new URLSearchParams("undoWindow=abc"))).toEqual({
      speed: "normal",
      drop: false,
      undoWindowSec: null,
    });
  });
});

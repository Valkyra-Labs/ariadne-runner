/*
  Deterministic replay of one approved plan.

  The runner is a pure generator over (plan, autonomy, decision log). The same
  inputs always produce the same events with the same ids, which is what makes
  the transport stateless: an application that reconnects sends the plan and
  the log it already has, the runner replays the run and the transport drops
  the events the application has already seen.

  The runner never waits. When it reaches a point that needs a decision the log
  does not contain, it yields a "pause" and returns: the transport closes the
  segment there. A decision is only accepted at the exact point it belongs to,
  so no log can make a high-risk step run without its own confirmation.
*/

import type { ActionType, Autonomy, Command, ProgressPhase } from "./codes.js";
import type { Decision, PlanPayload, RunEvent } from "./protocol.js";
import {
  applyDeviation,
  generateScenario,
  requiresConfirmation,
  type PlanStep,
} from "./scenario.js";

export type RunItem =
  | { kind: "delay"; ms: number }
  | { kind: "event"; id: number; event: RunEvent }
  | { kind: "pause"; stepId: string; accepts: readonly Command[] };

export type RunInput = {
  steps: readonly PlanStep[];
  autonomy: Autonomy;
  decisions: readonly Decision[];
  /* Overrides finite undo windows, in seconds */
  undoWindowSec: number | null;
  /* Multiplies every delay; 0 makes the run instant (unit tests) */
  timeScale: number;
  now?: () => number;
};

/* Number of frames after which a first segment with drop=1 is closed */
export const DROP_AFTER_FRAMES = 6;

export type ResolveResult =
  | { ok: true; steps: PlanStep[]; autonomy: Autonomy }
  | { ok: false; error: "empty_plan" | "too_many_steps" }
  | { ok: false; error: "unknown_step"; stepId: string };

/* Turns the payload from the application into the steps of the scenario */
export function resolvePlan(payload: PlanPayload): ResolveResult {
  const scenario = generateScenario(payload.seed);
  const byId = new Map(scenario.steps.map((s) => [s.id, s]));
  if (payload.steps.length === 0) return { ok: false, error: "empty_plan" };
  if (payload.steps.length > scenario.steps.length) return { ok: false, error: "too_many_steps" };
  const steps: PlanStep[] = [];
  for (const s of payload.steps) {
    const known = byId.get(s.id);
    if (!known) return { ok: false, error: "unknown_step", stepId: s.id };
    steps.push({ ...known, askFirst: s.askFirst });
  }
  return { ok: true, steps, autonomy: payload.autonomy };
}

/* The two progress phases each action type reports, at 30% and 65% */
export const PROGRESS_PHASES_BY_TYPE: Record<ActionType, readonly [ProgressPhase, ProgressPhase]> =
  {
    check: ["matching_registry", "reviewing_supplier_history"],
    extend: ["preparing_amendment", "recording_new_term"],
    reject_duplicate: ["changing_request_status", "notifying_supplier"],
    request_documents: ["composing_letter", "sending_letter"],
  };

export const DEVIATION_ACCEPTS: readonly Command[] = ["allow", "deny"];
export const CONFIRM_ACCEPTS: readonly Command[] = ["confirm", "skip"];
export const ERROR_ACCEPTS: readonly Command[] = ["retry", "skip", "stop"];

export function* runPlan(input: RunInput): Generator<RunItem> {
  const now = input.now ?? Date.now;
  const { autonomy, decisions, steps } = input;
  let id = 0;
  let cursor = 0;

  function* delay(ms: number): Generator<RunItem> {
    const scaled = Math.round(ms * input.timeScale);
    if (scaled > 0) yield { kind: "delay", ms: scaled };
  }

  function* emit(event: RunEvent): Generator<RunItem> {
    id += 1;
    yield { kind: "event", id, event };
  }

  /*
    The decision for the point the run has reached, or null when the log ends
    here. A stop is taken wherever it is found: the application can only
    append it after every decision that came before it.
  */
  function take(stepId: string, accepts: readonly Command[]): Command | null {
    const decision = decisions[cursor];
    if (!decision) return null;
    if (decision.command === "stop") {
      cursor += 1;
      return "stop";
    }
    if (decision.stepId !== stepId) return null;
    if (!accepts.includes(decision.command)) return null;
    cursor += 1;
    return decision.command;
  }

  /* A stop taken while a step was running only ends the plan after that step */
  function stopReached(): boolean {
    const decision = decisions[cursor];
    return decision?.command === "stop" && decision.afterEventId <= id;
  }

  yield* emit({ type: "plan.started", at: now(), total: steps.length });

  let lastDone: string | null = null;
  let stopped = false;

  for (const planned of steps) {
    if (stopReached()) {
      cursor += 1;
      stopped = true;
      break;
    }

    let step = planned;
    const stepId = step.id;
    yield* emit({
      type: "step.started",
      stepId,
      at: now(),
      requiresConfirmation: requiresConfirmation(step, autonomy),
    });
    yield* delay(150);

    if (step.deviation) {
      yield* emit({ type: "step.deviation", stepId, deviation: step.deviation });
      const decision = take(stepId, DEVIATION_ACCEPTS);
      if (decision === null) {
        yield { kind: "pause", stepId, accepts: DEVIATION_ACCEPTS };
        return;
      }
      if (decision === "stop") {
        yield* emit({ type: "step.skipped", stepId, reason: "stopped_by_user" });
        stopped = true;
        break;
      }
      if (decision === "allow") {
        const proposal = step.deviation.proposal;
        step = { ...applyDeviation(step), askFirst: step.askFirst };
        yield* emit({
          type: "step.deviated",
          stepId,
          deviatedTo: proposal,
          actionType: step.type,
          risk: step.risk,
          requiresConfirmation: requiresConfirmation(step, autonomy),
        });
      }
    }

    if (requiresConfirmation(step, autonomy)) {
      yield* emit({ type: "step.awaiting", stepId, draft: step.draft });
      const decision = take(stepId, CONFIRM_ACCEPTS);
      if (decision === null) {
        yield { kind: "pause", stepId, accepts: CONFIRM_ACCEPTS };
        return;
      }
      if (decision === "stop") {
        yield* emit({ type: "step.skipped", stepId, reason: "stopped_by_user" });
        stopped = true;
        break;
      }
      if (decision === "skip") {
        yield* emit({ type: "step.skipped", stepId, reason: "skipped_by_user" });
        continue;
      }
    }

    let attempt = 1;
    let stopNow = false;
    for (;;) {
      yield* emit({ type: "step.running", stepId, attempt });
      const phases = PROGRESS_PHASES_BY_TYPE[step.type];
      yield* delay(step.durationMs * 0.3);
      yield* emit({ type: "step.progress", stepId, percent: 30, phase: phases[0] });
      yield* delay(step.durationMs * 0.35);
      yield* emit({ type: "step.progress", stepId, percent: 65, phase: phases[1] });

      if (step.error && attempt === 1) {
        yield* emit({ type: "step.error", stepId, error: step.error, attempt });
        const decision = take(stepId, ERROR_ACCEPTS);
        if (decision === null) {
          yield { kind: "pause", stepId, accepts: ERROR_ACCEPTS };
          return;
        }
        if (decision === "retry") {
          attempt += 1;
          continue;
        }
        if (decision === "skip") {
          yield* emit({ type: "step.skipped", stepId, reason: "skipped_after_error" });
          break;
        }
        yield* emit({ type: "step.skipped", stepId, reason: "stopped_by_user" });
        stopNow = true;
        break;
      }

      yield* delay(step.durationMs * 0.35);
      const undoWindowSec =
        step.undoWindowSec === null ? null : (input.undoWindowSec ?? step.undoWindowSec);
      yield* emit({
        type: "step.finished",
        stepId,
        at: now(),
        result: {
          summary: step.summary,
          objects: step.objects,
          undo: step.undo,
          undoWindowSec,
        },
      });
      lastDone = stepId;
      break;
    }

    if (stopNow) {
      stopped = true;
      break;
    }
  }

  /* A stop taken during the last step still ends the plan as stopped */
  if (!stopped && stopReached()) {
    cursor += 1;
    stopped = true;
  }

  if (stopped) {
    yield* emit({ type: "plan.stopped", at: now(), afterStepId: lastDone });
  } else {
    yield* emit({ type: "plan.finished", at: now() });
  }
}

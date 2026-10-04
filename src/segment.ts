/*
  One segment of a run, independent of the transport.

  A segment is what one request answers: the run replayed from the plan and the
  decision log, the events after "after", and an end at the first decision the
  log does not contain (a waiting notice) or at the end of the plan. Both the
  Service Worker transport (sse.ts) and the in-process transport
  (in-process.ts) are thin encoders over this generator, so they cannot drift
  apart.
*/

import type { Autonomy, RequestError } from "./codes.js";
import {
  decodeDecisions,
  decodePlanPayload,
  parseStreamOptions,
  type Decision,
  type RunEvent,
  type StreamOptions,
  type WaitingNotice,
} from "./protocol.js";
import { DROP_AFTER_FRAMES, resolvePlan, runPlan } from "./runner.js";
import type { PlanStep } from "./scenario.js";

/* A parsed and resolved request for one segment */
export type SegmentRequest = {
  steps: PlanStep[];
  autonomy: Autonomy;
  decisions: Decision[];
  options: StreamOptions;
  /* Id of the last event the application already has; 0 for none */
  after: number;
};

export type SegmentRequestResult =
  { ok: true; request: SegmentRequest } | { ok: false; error: RequestError; stepId?: string };

/* A reconnect carries Last-Event-ID; a new segment uses the "after" parameter */
export function readAfter(lastEventId: string | null, params: URLSearchParams): number {
  const header = Number(lastEventId);
  if (lastEventId !== null && Number.isInteger(header) && header > 0) return header;
  const param = Number(params.get("after"));
  return Number.isInteger(param) && param > 0 ? param : 0;
}

/* Parses the query of a segment request and resolves the plan against the scenario */
export function parseSegmentRequest(
  params: URLSearchParams,
  lastEventId: string | null = null,
): SegmentRequestResult {
  const planText = params.get("plan");
  if (!planText) return { ok: false, error: "missing_plan" };
  const payload = decodePlanPayload(planText);
  if (!payload) return { ok: false, error: "invalid_plan" };
  const decisions = decodeDecisions(params.get("decisions"));
  if (!decisions) return { ok: false, error: "invalid_decisions" };
  const plan = resolvePlan(payload);
  if (!plan.ok) {
    return plan.error === "unknown_step"
      ? { ok: false, error: plan.error, stepId: plan.stepId }
      : { ok: false, error: plan.error };
  }
  return {
    ok: true,
    request: {
      steps: plan.steps,
      autonomy: plan.autonomy,
      decisions,
      options: parseStreamOptions(params),
      after: readAfter(lastEventId, params),
    },
  };
}

export type SegmentItem =
  | { kind: "delay"; ms: number }
  | { kind: "event"; id: number; event: RunEvent }
  | { kind: "waiting"; notice: WaitingNotice };

export type SegmentOptions = {
  now?: () => number;
  /* Overrides the time scale implied by the speed option (1, or 0.2 for fast) */
  timeScale?: number;
};

/* Time scale of a segment: fast runs at a fifth of the base durations */
export function timeScaleFor(options: StreamOptions): number {
  return options.speed === "fast" ? 0.2 : 1;
}

/*
  The items of one segment, in order. Events the application already has are
  replayed without their delays and not yielded; the segment ends after a
  waiting notice, after the last event of the plan, or, for a first segment
  with the drop option, after DROP_AFTER_FRAMES events.
*/
export function* segment(
  request: SegmentRequest,
  options: SegmentOptions = {},
): Generator<SegmentItem> {
  const run = runPlan({
    steps: request.steps,
    autonomy: request.autonomy,
    decisions: request.decisions,
    undoWindowSec: request.options.undoWindowSec,
    timeScale: options.timeScale ?? timeScaleFor(request.options),
    ...(options.now ? { now: options.now } : {}),
  });
  const { after } = request;
  /* Ids are sequential, so the next one is known before it is produced */
  let nextId = 1;
  let frames = 0;
  for (const item of run) {
    if (item.kind === "delay") {
      if (nextId > after) yield { kind: "delay", ms: item.ms };
      continue;
    }
    if (item.kind === "pause") {
      yield { kind: "waiting", notice: { stepId: item.stepId, accepts: item.accepts } };
      return;
    }
    nextId = item.id + 1;
    if (item.id <= after) continue;
    yield { kind: "event", id: item.id, event: item.event };
    frames += 1;
    /* Demo of a lost connection: the first segment stops mid-plan once */
    if (request.options.drop && after === 0 && frames >= DROP_AFTER_FRAMES) return;
  }
}

/* Resolves after ms, or at once when the signal aborts */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

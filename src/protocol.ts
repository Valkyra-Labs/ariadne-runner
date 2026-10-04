/*
  Wire protocol between an application and the run.

  GET <agent path>?plan=<base64url JSON of PlanPayload>[&decisions=<log>]
      [&speed=fast][&drop=1][&undoWindow=<sec>][&after=<eventId>]
    Returns text/event-stream.

  Every request is one short segment of the run. The application owns the
  approved plan and the ordered decision log; the handler rebuilds the run from
  them, replays it deterministically, sends the events after "after" (or the
  Last-Event-ID header) and closes as soon as it reaches a decision it has not
  been given, or the end of the plan. It never waits for anything, so no
  request depends on state written by another one.

  When the stream stops on a decision, the last frame is a "stream.waiting"
  event naming the step and the commands it accepts. The application appends
  the user decision to its log and opens the next segment with a larger
  "after". A dropped connection resumes through the same mechanism, with the
  event id the application last saw.

  Every field of every event is a code, a number, a boolean, an ISO date or a
  step id; see codes.ts.
*/

import {
  AUTONOMIES,
  COMMANDS,
  type ActionType,
  type Autonomy,
  type Command,
  type DeviationProposalCode,
  type ProgressPhase,
  type Risk,
  type SkipReason,
  type Speed,
} from "./codes.js";
import type {
  AffectedObject,
  Deviation,
  Draft,
  StepError,
  Summary,
  UndoEffect,
} from "./scenario.js";

export type PlanPayloadStep = { id: string; askFirst: boolean };

export type PlanPayload = {
  seed: number;
  autonomy: Autonomy;
  steps: PlanPayloadStep[];
};

/*
  One user decision. "stop" belongs to the whole plan, not to a step, so it
  carries the id of the last event the application had seen when the user
  pressed it: that is what places it on the timeline of the replay.
*/
export type Decision = { command: Command; stepId: string | null; afterEventId: number };

export type WaitingNotice = { stepId: string; accepts: readonly Command[] };

export type StepResult = {
  summary: Summary;
  objects: AffectedObject[];
  undo: UndoEffect;
  undoWindowSec: number | null;
};

export type RunEvent =
  | { type: "plan.started"; at: number; total: number }
  | { type: "step.started"; stepId: string; at: number; requiresConfirmation: boolean }
  | { type: "step.deviation"; stepId: string; deviation: Deviation }
  | {
      type: "step.deviated";
      stepId: string;
      deviatedTo: DeviationProposalCode;
      actionType: ActionType;
      risk: Risk;
      requiresConfirmation: boolean;
    }
  | { type: "step.awaiting"; stepId: string; draft: Draft }
  | { type: "step.running"; stepId: string; attempt: number }
  | { type: "step.progress"; stepId: string; percent: number; phase: ProgressPhase }
  | { type: "step.finished"; stepId: string; at: number; result: StepResult }
  | { type: "step.skipped"; stepId: string; reason: SkipReason }
  | { type: "step.error"; stepId: string; error: StepError; attempt: number }
  | { type: "plan.finished"; at: number }
  | { type: "plan.stopped"; at: number; afterStepId: string | null };

export type StreamOptions = {
  speed: Speed;
  /* Close the first segment early once, to demonstrate reconnection */
  drop: boolean;
  /* Overrides finite undo windows, in seconds */
  undoWindowSec: number | null;
};

/* base64url helpers; atob and btoa exist in browsers, workers and Node 16+ */
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodePlanPayload(payload: PlanPayload): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

export function isAutonomy(value: unknown): value is Autonomy {
  return typeof value === "string" && (AUTONOMIES as readonly string[]).includes(value);
}

/* Returns null when the payload is malformed */
export function decodePlanPayload(text: string): PlanPayload | null {
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(text)));
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.seed !== "number" || !Number.isFinite(r.seed)) return null;
    if (!isAutonomy(r.autonomy)) return null;
    if (!Array.isArray(r.steps)) return null;
    const steps: PlanPayloadStep[] = [];
    const seen = new Set<string>();
    for (const s of r.steps as unknown[]) {
      if (!s || typeof s !== "object") return null;
      const step = s as Record<string, unknown>;
      if (typeof step.id !== "string" || seen.has(step.id)) return null;
      seen.add(step.id);
      steps.push({ id: step.id, askFirst: step.askFirst === true });
    }
    return { seed: r.seed, autonomy: r.autonomy, steps };
  } catch {
    return null;
  }
}

/* Enough for two decisions per step of the longest plan plus a stop */
const MAX_DECISIONS = 64;
const MAX_EVENT_ID = 100_000;
const STEP_ID = /^[a-z][a-z0-9]{0,7}$/;

/*
  The decision log as one query parameter: "confirm-s3-14.retry-s4-21.stop--33".
  Fields are command, step id (empty for stop) and the event id the decision
  was taken after. The whole log of a twelve step plan stays under 200 bytes,
  which keeps the URL far below any limit and keeps the log readable in the
  network panel.
*/
export function encodeDecisions(list: readonly Decision[]): string {
  return list.map((d) => `${d.command}-${d.stepId ?? ""}-${d.afterEventId}`).join(".");
}

/* Returns null when the log is malformed, an empty list when there is none */
export function decodeDecisions(text: string | null): Decision[] | null {
  if (text === null || text === "") return [];
  const out: Decision[] = [];
  for (const chunk of text.split(".")) {
    if (chunk === "") continue;
    if (out.length >= MAX_DECISIONS) return null;
    const parts = chunk.split("-");
    if (parts.length !== 3) return null;
    const [command, stepId, after] = parts as [string, string, string];
    if (!(COMMANDS as readonly string[]).includes(command)) return null;
    if (stepId !== "" && !STEP_ID.test(stepId)) return null;
    if (command === "stop" ? stepId !== "" : stepId === "") return null;
    const afterEventId = Number(after);
    if (!Number.isInteger(afterEventId) || afterEventId < 0 || afterEventId > MAX_EVENT_ID)
      return null;
    out.push({
      command: command as Command,
      stepId: stepId === "" ? null : stepId,
      afterEventId,
    });
  }
  return out;
}

export function parseStreamOptions(params: URLSearchParams): StreamOptions {
  const undoRaw = params.get("undoWindow");
  const undo = undoRaw === null ? NaN : Number(undoRaw);
  return {
    speed: params.get("speed") === "fast" ? "fast" : "normal",
    drop: params.get("drop") === "1",
    undoWindowSec: Number.isFinite(undo) && undo > 0 ? Math.min(undo, 3600) : null,
  };
}

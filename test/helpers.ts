import {
  generatePlan,
  resolvePlan,
  runPlan,
  type Autonomy,
  type Command,
  type Decision,
  type PlanPayload,
  type RunEvent,
  type RunInput,
} from "../src/index.js";

export type Segment = {
  events: { id: number; event: RunEvent }[];
  types: RunEvent["type"][];
  pause: { stepId: string; accepts: readonly Command[] } | null;
  lastId: number;
};

export function payloadFor(
  ids?: string[],
  autonomy: Autonomy = "high_only",
  askFirst: string[] = [],
  seed = 7,
): PlanPayload {
  return {
    seed,
    autonomy,
    steps: generatePlan(seed)
      .filter((s) => !ids || ids.includes(s.id))
      .map((s) => ({ id: s.id, askFirst: askFirst.includes(s.id) })),
  };
}

/* Drives the generator the way a transport does, without the delays */
export function run(
  payload: PlanPayload,
  decisions: Decision[] = [],
  undoWindowSec: number | null = null,
): Segment {
  const plan = resolvePlan(payload);
  if (!plan.ok) throw new Error(plan.error);
  const input: RunInput = {
    steps: plan.steps,
    autonomy: plan.autonomy,
    decisions,
    undoWindowSec,
    timeScale: 0,
    now: () => 1000,
  };
  const events: Segment["events"] = [];
  let pause: Segment["pause"] = null;
  for (const item of runPlan(input)) {
    if (item.kind === "event") events.push({ id: item.id, event: item.event });
    if (item.kind === "pause") pause = { stepId: item.stepId, accepts: item.accepts };
  }
  return {
    events,
    types: events.map((e) => e.event.type),
    pause,
    lastId: events.at(-1)?.id ?? 0,
  };
}

export function decide(command: Command, stepId: string | null, afterEventId: number): Decision {
  return { command, stepId, afterEventId };
}

export function find<T extends RunEvent["type"]>(
  segment: Segment,
  type: T,
): Extract<RunEvent, { type: T }> {
  const found = segment.events.find((e) => e.event.type === type);
  if (!found) throw new Error(`no ${type} in segment`);
  return found.event as Extract<RunEvent, { type: T }>;
}

/*
  Runs a whole plan to its end, answering every pause with the first command
  of a preference list the pause accepts. Returns the final segment and the
  decision log that produced it.
*/
export function runToEnd(
  payload: PlanPayload,
  prefer: readonly Command[] = ["confirm", "allow", "retry"],
): { segment: Segment; log: Decision[] } {
  const log: Decision[] = [];
  let segment = run(payload, log);
  let guard = 0;
  while (segment.pause && guard < 60) {
    guard += 1;
    const accepts = segment.pause.accepts;
    const command = prefer.find((c) => accepts.includes(c)) ?? accepts[0]!;
    log.push(decide(command, command === "stop" ? null : segment.pause.stepId, segment.lastId));
    segment = run(payload, log);
  }
  return { segment, log };
}

/*
  Plan machine: draft -> approved -> running -> finished | stopped.

  In "draft" the user edits the step list. "approved" spawns one step actor per
  step and waits for the stream to report plan.started. In "running" run
  events are routed to the step actors, user decisions are forwarded to them
  and everything is appended to the exportable log. When the run stops, the
  steps it never reached are skipped with the stop as their reason. Undo
  stays available in finished and stopped, because the undo window outlives
  the run.

  The log is structured: each entry is a code with its parameters, never a
  sentence, so the application renders it in the reader's language.
*/

import { assign, enqueueActions, setup, type ActorRefFrom } from "xstate";
import type { Autonomy, Command } from "../codes.js";
import type { RunEvent } from "../protocol.js";
import { stepMachine, type StepEvent } from "./step.machine.js";
import {
  DEFAULT_AUTONOMY,
  DEFAULT_SEED,
  generatePlan,
  requiresConfirmation,
  type PlanStep,
  type UndoEffect,
} from "../scenario.js";

export type StepActorRef = ActorRefFrom<typeof stepMachine>;

export type Decidable = Exclude<Command, "stop">;

export type LogEntry =
  /* The plan was approved: step count, autonomy and how many steps will ask */
  | { at: number; kind: "approved"; total: number; autonomy: Autonomy; confirmations: number }
  /* A run event, as received; progress events are not logged */
  | { at: number; kind: "event"; event: RunEvent }
  | { at: number; kind: "decision"; stepId: string; command: Decidable }
  | { at: number; kind: "stop_requested" }
  /* A finished step was undone; undo is what it rolled back */
  | { at: number; kind: "undo"; stepId: string; undo: UndoEffect | null };

export type PlanContext = {
  seed: number;
  steps: PlanStep[];
  autonomy: Autonomy;
  /* Execution order, fixed at approval */
  order: string[];
  stepRefs: Record<string, StepActorRef>;
  sessionId: string | null;
  approvedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  stopRequested: boolean;
  stoppedAfter: string | null;
  log: LogEntry[];
  /* Steps that asked the user for a decision (confirmation or deviation) */
  askedStepIds: string[];
  undos: number;
};

export type PlanInput = { seed?: number; autonomy?: Autonomy };

export type PlanEvent =
  | { type: "REMOVE_STEP"; id: string }
  | { type: "MOVE_STEP"; id: string; direction: "up" | "down" }
  | { type: "REORDER"; from: number; to: number }
  | { type: "SET_ASK_FIRST"; id: string; askFirst: boolean }
  | { type: "SET_AUTONOMY"; autonomy: Autonomy }
  | { type: "REGENERATE"; seed: number }
  | { type: "RESTORE" }
  | { type: "APPROVE"; sessionId: string; at: number }
  | { type: "RUN_EVENT"; event: RunEvent; at: number }
  | { type: "DECIDE"; stepId: string; command: Decidable; at: number }
  | { type: "STOP"; at: number }
  | { type: "UNDO"; stepId: string; at: number }
  | { type: "RESET"; at: number };

function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item as T);
  return out;
}

/* Converts a run event into the event the step actor understands */
export function toStepEvent(ev: RunEvent, at: number): StepEvent | null {
  switch (ev.type) {
    case "step.started":
      return { type: "START", at };
    case "step.deviation":
      return { type: "DEVIATION", deviation: ev.deviation };
    case "step.awaiting":
      return { type: "AWAITING", draft: ev.draft };
    case "step.running":
      return { type: "RUNNING", attempt: ev.attempt };
    case "step.progress":
      return { type: "PROGRESS", percent: ev.percent, phase: ev.phase };
    case "step.finished":
      return { type: "FINISHED", at, result: ev.result };
    case "step.skipped":
      return { type: "SKIPPED", reason: ev.reason, at };
    case "step.error":
      return { type: "FAILED", error: ev.error, attempt: ev.attempt };
    default:
      return null;
  }
}

const DECISION_EVENT: Record<Decidable, "CONFIRM" | "SKIP" | "RETRY" | "ALLOW" | "DENY"> = {
  confirm: "CONFIRM",
  skip: "SKIP",
  retry: "RETRY",
  allow: "ALLOW",
  deny: "DENY",
};

/*
  Whether the step is still at the point this decision answers. The decision
  log is what the server replays, so a decision that the step has moved past
  must never reach it: it would shift every later decision by one.
*/
export function canDecide(ref: StepActorRef, command: Decidable, at: number): boolean {
  return ref.getSnapshot().can({ type: DECISION_EVENT[command], at });
}

export const planMachine = setup({
  types: {
    context: {} as PlanContext,
    events: {} as PlanEvent,
    input: {} as PlanInput,
  },
  actors: { step: stepMachine },
  guards: {
    hasSteps: ({ context }) => context.steps.length > 0,
    notStopping: ({ context }) => !context.stopRequested,
    canUndo: ({ context, event }) => {
      if (event.type !== "UNDO") return false;
      const ref = context.stepRefs[event.stepId];
      return ref ? ref.getSnapshot().can({ type: "UNDO", at: event.at }) : false;
    },
  },
  actions: {
    spawnSteps: assign(({ context, spawn }) => {
      const stepRefs: Record<string, StepActorRef> = {};
      for (const step of context.steps) {
        stepRefs[step.id] = spawn("step", {
          id: step.id,
          input: { step, autonomy: context.autonomy },
        });
      }
      return { stepRefs, order: context.steps.map((s) => s.id) };
    }),
    stopSteps: enqueueActions(({ context, enqueue }) => {
      for (const ref of Object.values(context.stepRefs)) enqueue.stopChild(ref);
    }),
    resetRun: assign(({ context }) => ({
      steps: generatePlan(context.seed),
      order: [],
      stepRefs: {},
      sessionId: null,
      approvedAt: null,
      startedAt: null,
      finishedAt: null,
      stopRequested: false,
      stoppedAfter: null,
      log: [],
      askedStepIds: [],
      undos: 0,
    })),
    routeRunEvent: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "RUN_EVENT") return;
      const ev = event.event;
      const log: LogEntry[] =
        ev.type === "step.progress"
          ? context.log
          : [...context.log, { at: event.at, kind: "event", event: ev }];
      const asked =
        (ev.type === "step.awaiting" || ev.type === "step.deviation") &&
        !context.askedStepIds.includes(ev.stepId)
          ? [...context.askedStepIds, ev.stepId]
          : context.askedStepIds;
      enqueue.assign({ log, askedStepIds: asked });
      if ("stepId" in ev) {
        const ref = context.stepRefs[ev.stepId];
        const stepEvent = toStepEvent(ev, event.at);
        if (ref && stepEvent) enqueue.sendTo(ref, stepEvent);
      }
      if (ev.type === "plan.started") enqueue.assign({ startedAt: event.at });
      if (ev.type === "plan.finished") enqueue.assign({ finishedAt: event.at });
      if (ev.type === "plan.stopped") {
        enqueue.assign({ finishedAt: event.at, stoppedAfter: ev.afterStepId });
        /* A step the run never reached will not run now: it is skipped
           because the run was stopped, as the step that waited at a
           decision is. The stream sends no event for these, so the log
           does not record one either. */
        for (const id of context.order) {
          const ref = context.stepRefs[id];
          if (ref?.getSnapshot().matches("waiting"))
            enqueue.sendTo(ref, { type: "SKIPPED", reason: "stopped_by_user", at: event.at });
        }
      }
    }),
    routeDecision: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "DECIDE") return;
      const ref = context.stepRefs[event.stepId];
      if (!ref) return;
      enqueue.sendTo(ref, { type: DECISION_EVENT[event.command], at: event.at });
      enqueue.assign({
        log: [
          ...context.log,
          { at: event.at, kind: "decision", stepId: event.stepId, command: event.command },
        ],
      });
    }),
    routeUndo: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "UNDO") return;
      const ref = context.stepRefs[event.stepId];
      if (!ref) return;
      const undo = ref.getSnapshot().context.result?.undo ?? null;
      enqueue.sendTo(ref, { type: "UNDO", at: event.at });
      enqueue.assign({
        undos: context.undos + 1,
        log: [...context.log, { at: event.at, kind: "undo", stepId: event.stepId, undo }],
      });
    }),
  },
}).createMachine({
  id: "plan",
  context: ({ input }) => ({
    seed: input.seed ?? DEFAULT_SEED,
    steps: generatePlan(input.seed ?? DEFAULT_SEED),
    autonomy: input.autonomy ?? DEFAULT_AUTONOMY,
    order: [],
    stepRefs: {},
    sessionId: null,
    approvedAt: null,
    startedAt: null,
    finishedAt: null,
    stopRequested: false,
    stoppedAfter: null,
    log: [],
    askedStepIds: [],
    undos: 0,
  }),
  initial: "draft",
  states: {
    draft: {
      on: {
        REMOVE_STEP: {
          actions: assign({
            steps: ({ context, event }) => context.steps.filter((s) => s.id !== event.id),
          }),
        },
        MOVE_STEP: {
          actions: assign({
            steps: ({ context, event }) => {
              const from = context.steps.findIndex((s) => s.id === event.id);
              const to = event.direction === "up" ? from - 1 : from + 1;
              return moveItem(context.steps, from, to);
            },
          }),
        },
        REORDER: {
          actions: assign({
            steps: ({ context, event }) => moveItem(context.steps, event.from, event.to),
          }),
        },
        SET_ASK_FIRST: {
          actions: assign({
            steps: ({ context, event }) =>
              context.steps.map((s) =>
                s.id === event.id ? { ...s, askFirst: event.askFirst } : s,
              ),
          }),
        },
        SET_AUTONOMY: {
          actions: assign({ autonomy: ({ event }) => event.autonomy }),
        },
        REGENERATE: {
          actions: assign({
            seed: ({ event }) => event.seed,
            steps: ({ event }) => generatePlan(event.seed),
          }),
        },
        RESTORE: {
          actions: assign({ steps: ({ context }) => generatePlan(context.seed) }),
        },
        APPROVE: {
          guard: "hasSteps",
          target: "approved",
          actions: [
            assign({
              sessionId: ({ event }) => event.sessionId,
              approvedAt: ({ event }) => event.at,
              log: ({ context, event }): LogEntry[] => [
                {
                  at: event.at,
                  kind: "approved",
                  total: context.steps.length,
                  autonomy: context.autonomy,
                  confirmations: context.steps.filter((s) =>
                    requiresConfirmation(s, context.autonomy),
                  ).length,
                },
              ],
            }),
            "spawnSteps",
          ],
        },
      },
    },
    approved: {
      on: {
        RUN_EVENT: [
          {
            guard: ({ event }) => event.event.type === "plan.started",
            target: "running",
            actions: "routeRunEvent",
          },
          { actions: "routeRunEvent" },
        ],
        RESET: { target: "draft", actions: ["stopSteps", "resetRun"] },
      },
    },
    running: {
      on: {
        RUN_EVENT: [
          {
            guard: ({ event }) => event.event.type === "plan.finished",
            target: "finished",
            actions: "routeRunEvent",
          },
          {
            guard: ({ event }) => event.event.type === "plan.stopped",
            target: "stopped",
            actions: "routeRunEvent",
          },
          {
            /* After a stop request no new step may start */
            guard: ({ context, event }) =>
              !(context.stopRequested && event.event.type === "step.started"),
            actions: "routeRunEvent",
          },
        ],
        DECIDE: { actions: "routeDecision" },
        STOP: {
          guard: "notStopping",
          actions: assign({
            stopRequested: true,
            log: ({ context, event }): LogEntry[] => [
              ...context.log,
              { at: event.at, kind: "stop_requested" },
            ],
          }),
        },
        UNDO: { guard: "canUndo", actions: "routeUndo" },
      },
    },
    finished: {
      on: {
        UNDO: { guard: "canUndo", actions: "routeUndo" },
        RESET: { target: "draft", actions: ["stopSteps", "resetRun"] },
      },
    },
    stopped: {
      on: {
        UNDO: { guard: "canUndo", actions: "routeUndo" },
        RESET: { target: "draft", actions: ["stopSteps", "resetRun"] },
      },
    },
  },
});

export type PlanStateValue = "draft" | "approved" | "running" | "finished" | "stopped";

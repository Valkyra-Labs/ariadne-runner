/*
  Step machine: one actor per plan step during execution.

    waiting -> running -> done -> undone
            -> awaitingConfirmation -> running | skipped
            -> awaitingDeviation -> awaitingConfirmation | running
    running -> error -> running (retry) | skipped

  "done" has three sub-states: undoable (finite window, timer running),
  permanent (no window: an internal change can always be reverted) and
  irreversible (the window has expired). The consent rule lives in the
  "needsConfirmation" guard: a high-risk step never enters "running" from
  "waiting" directly, whatever the autonomy level.
*/

import { assign, setup } from "xstate";
import type { Autonomy, ProgressPhase, SkipReason, StepStatus } from "../codes.js";
import type { StepResult } from "../protocol.js";
import {
  applyDeviation,
  requiresConfirmation,
  type Deviation,
  type Draft,
  type PlanStep,
  type StepError,
} from "../scenario.js";

export type StepEvent =
  | { type: "START"; at: number }
  | { type: "DEVIATION"; deviation: Deviation }
  | { type: "ALLOW"; at: number }
  | { type: "DENY"; at: number }
  | { type: "AWAITING"; draft: Draft }
  | { type: "CONFIRM"; at: number }
  | { type: "SKIP"; at: number }
  | { type: "RUNNING"; attempt: number }
  | { type: "PROGRESS"; percent: number; phase: ProgressPhase }
  | { type: "FINISHED"; at: number; result: StepResult }
  | { type: "FAILED"; error: StepError; attempt: number }
  | { type: "RETRY"; at: number }
  | { type: "SKIPPED"; reason: SkipReason; at: number }
  | { type: "UNDO"; at: number };

export type StepContext = {
  /* Effective step: changes when a deviation is allowed */
  step: PlanStep;
  original: PlanStep;
  autonomy: Autonomy;
  attempt: number;
  progress: number;
  phase: ProgressPhase | null;
  draft: Draft | null;
  deviation: Deviation | null;
  deviationAllowed: boolean | null;
  error: StepError | null;
  result: StepResult | null;
  startedAt: number | null;
  finishedAt: number | null;
  /* Timestamp after which the step becomes irreversible; null means no window */
  undoDeadline: number | null;
  undoneAt: number | null;
  skipReason: SkipReason | null;
  /* True once the step has asked the user for anything */
  askedUser: boolean;
};

export type StepInput = { step: PlanStep; autonomy: Autonomy };

export const stepMachine = setup({
  types: {
    context: {} as StepContext,
    events: {} as StepEvent,
    input: {} as StepInput,
  },
  guards: {
    needsConfirmation: ({ context }) => requiresConfirmation(context.step, context.autonomy),
    hasUndoWindow: ({ context }) => context.undoDeadline !== null,
  },
  delays: {
    undoWindow: ({ context }) =>
      context.undoDeadline === null || context.finishedAt === null
        ? 0
        : Math.max(0, context.undoDeadline - context.finishedAt),
  },
  actions: {
    markAsked: assign({ askedUser: true }),
    resetProgress: assign({ progress: 0, phase: null, error: null }),
    acceptDeviation: assign(({ context }) => ({
      step: { ...applyDeviation(context.step), askFirst: context.step.askFirst },
      deviationAllowed: true,
    })),
  },
}).createMachine({
  id: "step",
  context: ({ input }) => ({
    step: input.step,
    original: input.step,
    autonomy: input.autonomy,
    attempt: 1,
    progress: 0,
    phase: null,
    draft: null,
    deviation: null,
    deviationAllowed: null,
    error: null,
    result: null,
    startedAt: null,
    finishedAt: null,
    undoDeadline: null,
    undoneAt: null,
    skipReason: null,
    askedUser: false,
  }),
  initial: "waiting",
  states: {
    waiting: {
      on: {
        START: [
          {
            guard: "needsConfirmation",
            target: "awaitingConfirmation",
            actions: assign({ startedAt: ({ event }) => event.at }),
          },
          { target: "running", actions: assign({ startedAt: ({ event }) => event.at }) },
        ],
        SKIPPED: {
          target: "skipped",
          actions: assign({ skipReason: ({ event }) => event.reason }),
        },
      },
    },
    awaitingConfirmation: {
      entry: "markAsked",
      on: {
        AWAITING: { actions: assign({ draft: ({ event }) => event.draft }) },
        DEVIATION: {
          target: "awaitingDeviation",
          actions: assign({ deviation: ({ event }) => event.deviation }),
        },
        CONFIRM: { target: "running" },
        SKIP: { target: "skipped", actions: assign({ skipReason: "skipped_by_user" }) },
        SKIPPED: {
          target: "skipped",
          actions: assign({ skipReason: ({ event }) => event.reason }),
        },
      },
    },
    awaitingDeviation: {
      entry: "markAsked",
      on: {
        ALLOW: [
          {
            guard: ({ context }) =>
              requiresConfirmation(
                { ...applyDeviation(context.step), askFirst: context.step.askFirst },
                context.autonomy,
              ),
            target: "awaitingConfirmation",
            actions: "acceptDeviation",
          },
          { target: "running", actions: "acceptDeviation" },
        ],
        DENY: [
          {
            guard: "needsConfirmation",
            target: "awaitingConfirmation",
            actions: assign({ deviationAllowed: false }),
          },
          { target: "running", actions: assign({ deviationAllowed: false }) },
        ],
        SKIPPED: {
          target: "skipped",
          actions: assign({ skipReason: ({ event }) => event.reason }),
        },
      },
    },
    running: {
      entry: "resetProgress",
      on: {
        DEVIATION: {
          target: "awaitingDeviation",
          actions: assign({ deviation: ({ event }) => event.deviation }),
        },
        AWAITING: {
          target: "awaitingConfirmation",
          actions: assign({ draft: ({ event }) => event.draft }),
        },
        RUNNING: { actions: assign({ attempt: ({ event }) => event.attempt }) },
        PROGRESS: {
          actions: assign({
            progress: ({ event }) => event.percent,
            phase: ({ event }) => event.phase,
          }),
        },
        FINISHED: {
          target: "done",
          actions: assign({
            progress: 100,
            result: ({ event }) => event.result,
            finishedAt: ({ event }) => event.at,
            undoDeadline: ({ event }) =>
              event.result.undoWindowSec === null
                ? null
                : event.at + event.result.undoWindowSec * 1000,
          }),
        },
        FAILED: {
          target: "error",
          actions: assign({
            error: ({ event }) => event.error,
            attempt: ({ event }) => event.attempt,
          }),
        },
        SKIPPED: {
          target: "skipped",
          actions: assign({ skipReason: ({ event }) => event.reason }),
        },
      },
    },
    error: {
      entry: "markAsked",
      on: {
        RETRY: {
          target: "running",
          actions: assign({ attempt: ({ context }) => context.attempt + 1 }),
        },
        SKIP: { target: "skipped", actions: assign({ skipReason: "skipped_after_error" }) },
        SKIPPED: {
          target: "skipped",
          actions: assign({ skipReason: ({ event }) => event.reason }),
        },
      },
    },
    done: {
      initial: "deciding",
      states: {
        deciding: {
          always: [{ guard: "hasUndoWindow", target: "undoable" }, { target: "permanent" }],
        },
        undoable: {
          after: { undoWindow: "irreversible" },
          on: { UNDO: "#step.undone" },
        },
        permanent: {
          on: { UNDO: "#step.undone" },
        },
        irreversible: {},
      },
    },
    undone: {
      entry: assign({ undoneAt: ({ event }) => (event.type === "UNDO" ? event.at : null) }),
    },
    skipped: {},
  },
});

/* Maps machine states to the seven timeline statuses */
export function stepStatusOf(value: unknown): StepStatus {
  const v = typeof value === "string" ? value : Object.keys(value as object)[0];
  switch (v) {
    case "waiting":
      return "waiting";
    case "running":
      return "running";
    case "awaitingConfirmation":
    case "awaitingDeviation":
      return "awaiting";
    case "done":
      return "done";
    case "skipped":
      return "skipped";
    case "undone":
      return "undone";
    case "error":
      return "error";
    default:
      return "waiting";
  }
}

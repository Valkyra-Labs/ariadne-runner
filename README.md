# ariadne-runner

[![CI](https://github.com/Valkyra-Labs/ariadne-runner/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Valkyra-Labs/ariadne-runner/actions/workflows/ci.yml)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-blue.svg)](#license)
[![Tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/Valkyra-Labs/ariadne-runner/badges/tests.json)](https://github.com/Valkyra-Labs/ariadne-runner/actions/workflows/ci.yml)

The tests badge is published by CI from each green run on `main`: tests
passed in `pnpm test` (Vitest, `test/`) on Linux, Node 22.

The deterministic engine of an agent run that a person can stop, in
TypeScript.

An agent proposes a plan of steps. The person edits it, picks an
autonomy level and approves it; the run then streams step by step.
Risky steps wait for a confirmation with a draft of what they will do,
a failed step offers a retry, the agent can ask to leave the plan, the
person can stop the run after the current step, and finished steps can
be undone, some at any time and some only within a time window.
ariadne-runner holds the rules of all of that and nothing else: no
model, no server and no interface. The plan is a seeded script
(procurement: twelve incoming supplier requests), so every run is
reproducible.

The engine emits no human language. Every event is codes and
parameters (supplier index, request and contract numbers, ISO dates,
risk, confidence, affected objects before and after), so an application
renders it in English, Russian, Arabic or anything else. A test fails
if any string with a letter in it that is not a known code reaches an
event, a plan, the session log or the stream.

Status: early. One scripted scenario, behaviour ported from an earlier
server-side version with its tests (87 tests). Measured in Node on an
Apple M4 Pro: a plan generates in about 1 us, a complete run replays
in about 9 us, and the Service Worker handler encodes a complete run as
an event stream in about 0.1 ms; method and stamps in
[docs/MEASUREMENTS.md](docs/MEASUREMENTS.md). Not measured in a browser
yet.

## How a run works

- **Plan.** `generatePlan(seed)` gives twelve steps, one per supplier
  request. Each step has an action (`check`, `extend`,
  `reject_duplicate`, `request_documents`), a risk derived from it
  (`low`, `medium`, `high`, `high`), a confidence, a draft, the objects
  it changes and its undo window (`null` for internal changes, 60 s for
  outgoing letters and notifications). One step fails once with a
  service timeout, one asks to deviate (check against archived
  documents instead of sending a letter), and two steps conflict
  (extending and rejecting the same request; `findConflicts`).
- **Consent rule.** `requiresConfirmation(step, autonomy)`: high risk
  always asks, at every autonomy level. Below that, `ask_all` asks for
  everything, `high_only` asks for steps flagged `askFirst`, `ask_none`
  ignores the flags.
- **Replay.** `runPlan` is a pure generator over the plan, the autonomy
  and the ordered decision log. It stops at the first decision the log
  does not hold. The same inputs give the same events with the same
  ids, so a transport never keeps a session: it replays the run and
  skips the events the page already has. A decision is taken only at
  the exact point it answers, so no log makes a high-risk step run
  without its own confirmation.
- **Machines.** `planMachine` and `stepMachine` (XState 5) are the
  page's side: draft editing, one actor per step, decisions, stop after
  the current step (the steps the run never reached are then skipped
  with `stopped_by_user`, so none reads as still waiting), and undo
  windows that outlive the run (`undoable`, `permanent`, `irreversible`).

## Event model

Each event has a `type` and a sequential `id` on the wire. Every string
field is a code from `src/codes.ts`, a step id or an ISO date.

| type | fields |
|---|---|
| `plan.started` | `at`, `total` |
| `step.started` | `stepId`, `at`, `requiresConfirmation` |
| `step.deviation` | `stepId`, `deviation`: `reason`, `archiveRequest`, `archiveUploaded`, `proposal`, `newType`, `newRisk` |
| `step.deviated` | `stepId`, `deviatedTo`, `actionType`, `risk`, `requiresConfirmation` |
| `step.awaiting` | `stepId`, `draft` |
| `step.running` | `stepId`, `attempt` |
| `step.progress` | `stepId`, `percent`, `phase` |
| `step.finished` | `stepId`, `at`, `result`: `summary`, `objects`, `undo`, `undoWindowSec` |
| `step.skipped` | `stepId`, `reason`: `skipped_by_user`, `skipped_after_error`, `stopped_by_user` |
| `step.error` | `stepId`, `error`: `code`, `service`, `timeoutSec`; `attempt` |
| `plan.finished` | `at` |
| `plan.stopped` | `at`, `afterStepId` |

A segment that needs a decision ends with a `stream.waiting` frame
(`stepId`, `accepts`: the commands the point takes) that has no id.

The structured parts:

- `draft`: `kind` (`email`, `decision`, `change`) and `template`, with
  the parameters of that template: `check_request` (supplier, request,
  externalEffects), `extend_contract` (supplier, contract,
  extendMonths, validUntilBefore, validUntilAfter, termsChanged),
  `reject_duplicate` (supplier, request, duplicateOf, duplicateOfDate,
  matchedFields, notifySupplier), `request_documents` (supplier as the
  recipient, request, documents with maxAgeDays, dueDate),
  `check_by_archive` (supplier, request, archiveRequest,
  archiveUploaded, sendsLetter).
- `objects`: `request` (`before.status`, `after.status`), `contract`
  (`before.validUntil`, `after.validUntil`) and `letter` (supplier,
  request, `not_sent` to `sent`).
- `summary`: `request_checked`, `contract_extended`,
  `request_rejected_duplicate`, `documents_requested`,
  `request_checked_by_archive`, each with its numbers.
- `undo`: `unmark_checked`, `restore_contract_term`, `return_to_queue`,
  `recall_letter`, `unmark_checked_by_archive`, each with its numbers.
- `phase`: two per action, for example `composing_letter` and
  `sending_letter`.

Suppliers are indexes from 0 to `SUPPLIER_COUNT - 1`; their names and
addresses belong to the application, like every label and sentence.

## API

```ts
import {
  generatePlan, requiresConfirmation, findConflicts, applyDeviation,
  resolvePlan, runPlan,
  encodePlanPayload, encodeDecisions,
  planMachine, stepMachine, canDecide, stepStatusOf,
  connectInProcess, exportLog,
  ALL_CODES, RUN_EVENT_TYPES, COMMANDS,
} from "ariadne-runner";
import { handleAgentRequest, createAgentHandler } from "ariadne-runner/sse";
```

- Scenario: `generateScenario(seed)`, `generatePlan(seed)`,
  `requiresConfirmation`, `findConflicts`, `applyDeviation`,
  `RISK_BY_TYPE`, `TASK`.
- Run: `resolvePlan(payload)`, `runPlan(input)` (items: `event`,
  `delay`, `pause`).
- Protocol: `encodePlanPayload` / `decodePlanPayload`,
  `encodeDecisions` / `decodeDecisions` (`confirm-s3-14.stop--33`),
  `parseStreamOptions`.
- Transports: `handleAgentRequest(request): Response | null`,
  `createAgentHandler({ match, sleep, now, timeScale })`,
  `connectInProcess(query, { lastEventId, signal }, options)`.
- Machines: `planMachine` (events `APPROVE`, `RUN_EVENT`, `DECIDE`,
  `STOP`, `UNDO`, `RESET` and the draft edits), `stepMachine`,
  `canDecide`, `stepStatusOf`, `toStepEvent`.
- Log: the plan machine's `context.log` entries (`approved`, `event`,
  `decision`, `stop_requested`, `undo`) and `exportLog(entries, header)`.
- Vocabulary: one exported list per kind of code (`ACTION_TYPES`,
  `RISKS`, `PROGRESS_PHASES`, `SKIP_REASONS`, `SUMMARY_CODES`, ...) and
  their union `ALL_CODES`, so a label table can be typed as
  `Record<SkipReason, string>` and checked for completeness.

## Wiring the Service Worker

The query shape is `GET .../api/agent?plan=<base64url JSON>` with
optional `decisions`, `after`, `speed=fast`, `drop=1` and
`undoWindow=<seconds>`. The handler answers same-origin requests whose
path ends with `/api/agent` (or whatever `match` accepts) and returns
`null` for the rest.

```ts
// sw.ts, bundled by the application
import { handleAgentRequest } from "ariadne-runner/sse";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const response = handleAgentRequest(event.request);
  if (response) event.respondWith(response);
});
```

On the page, after the worker controls it:

```ts
const params = new URLSearchParams({ plan: encodePlanPayload({ seed, autonomy, steps }) });
if (log.length > 0) params.set("decisions", encodeDecisions(log));
if (lastEventId > 0) params.set("after", String(lastEventId));
const source = new EventSource(`api/agent?${params}`);
for (const type of RUN_EVENT_TYPES) {
  source.addEventListener(type, (e) => {
    lastEventId = Number(e.lastEventId);
    plan.send({ type: "RUN_EVENT", event: JSON.parse(e.data), at: Date.now() });
  });
}
source.addEventListener("stream.waiting", () => source.close());
```

The page owns the approved plan and the decision log. When the person
decides, it sends the decision to the plan machine at once (check it
with `canDecide` first, so a stale click never enters the log), appends
`{ command, stepId, afterEventId: lastEventId }` to the log and opens
the next segment. Close the source on `stream.waiting`,
`plan.finished` and `plan.stopped`; any other end of the stream is a
dropped connection, and EventSource reconnects by itself with
Last-Event-ID, which the handler resumes from.

A page that is not yet controlled by the worker (the first load before
`clients.claim()` completes) sends the request to the network, so wait
for `navigator.serviceWorker.controller` before opening the stream.

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm bench   # timings for docs/MEASUREMENTS.md
```

## License

MIT OR Apache-2.0, at your option.

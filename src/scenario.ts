/*
  Deterministic scenario of the agent run. Nothing here depends on the clock or
  on randomness outside the seeded generator, so the same seed gives the same
  plan wherever it is generated (a page, a Service Worker, a test).

  Domain: procurement. Twelve incoming supplier requests, one step per request.
  Suppliers are indexes (0 .. SUPPLIER_COUNT - 1); their names and addresses
  belong to the application, as does every sentence about a step.
*/

import type {
  ActionType,
  Autonomy,
  ConflictReason,
  DeviationProposalCode,
  DeviationReason,
  DocumentCode,
  ErrorCode,
  LetterStatus,
  MatchField,
  RequestStatus,
  Risk,
  Service,
  TaskCode,
} from "./codes.js";

export const DEFAULT_SEED = 7;
export const DEFAULT_AUTONOMY: Autonomy = "high_only";
/* Undo window for outgoing letters and notifications, in seconds (demo value) */
export const DEFAULT_UNDO_WINDOW_SEC = 60;
/* Number of distinct suppliers a scenario refers to */
export const SUPPLIER_COUNT = 11;

/* ISO 8601 calendar date, for example 2026-09-30 */
export type IsoDate = string;

export type RequestObject = {
  kind: "request";
  request: number;
  before: { status: RequestStatus };
  after: { status: RequestStatus };
};

export type ContractObject = {
  kind: "contract";
  contract: number;
  /* Last day of the contract term */
  before: { validUntil: IsoDate };
  after: { validUntil: IsoDate };
};

export type LetterObject = {
  kind: "letter";
  supplier: number;
  request: number;
  before: { status: LetterStatus };
  after: { status: LetterStatus };
};

/* An object a step changes, with its state before and after the step */
export type AffectedObject = RequestObject | ContractObject | LetterObject;

/* Identity of an affected object, without its states */
export type ObjectRef =
  | { kind: "request"; request: number }
  | { kind: "contract"; contract: number }
  | { kind: "letter"; supplier: number; request: number };

export type DocumentRequirement = {
  document: DocumentCode;
  /* Maximum age of the document in days; null when any age is accepted */
  maxAgeDays: number | null;
};

/* What the user sees before a step runs */
export type Draft =
  | {
      kind: "change";
      template: "check_request";
      supplier: number;
      request: number;
      /* Whether the step does anything outside the organisation */
      externalEffects: boolean;
    }
  | {
      kind: "change";
      template: "extend_contract";
      supplier: number;
      contract: number;
      extendMonths: number;
      validUntilBefore: IsoDate;
      validUntilAfter: IsoDate;
      termsChanged: boolean;
    }
  | {
      kind: "decision";
      template: "reject_duplicate";
      supplier: number;
      request: number;
      duplicateOf: number;
      duplicateOfDate: IsoDate;
      matchedFields: MatchField[];
      notifySupplier: boolean;
    }
  | {
      kind: "email";
      template: "request_documents";
      /* Recipient: the supplier's index */
      supplier: number;
      request: number;
      documents: DocumentRequirement[];
      dueDate: IsoDate;
    }
  | {
      kind: "change";
      template: "check_by_archive";
      supplier: number;
      request: number;
      archiveRequest: number;
      archiveUploaded: IsoDate;
      sendsLetter: boolean;
    };

/* What a finished step reports */
export type Summary =
  | { code: "request_checked"; request: number; registryMatch: boolean }
  | { code: "contract_extended"; contract: number; validUntil: IsoDate; request: number }
  | {
      code: "request_rejected_duplicate";
      request: number;
      duplicateOf: number;
      supplierNotified: boolean;
    }
  | { code: "documents_requested"; supplier: number; request: number }
  | { code: "request_checked_by_archive"; request: number; letterSent: boolean };

/* What undoing a finished step rolls back */
export type UndoEffect =
  | { code: "unmark_checked"; request: number }
  | { code: "restore_contract_term"; contract: number; validUntil: IsoDate; request: number }
  | { code: "return_to_queue"; request: number; noticeRecalled: boolean }
  | { code: "recall_letter"; supplier: number; request: number }
  | { code: "unmark_checked_by_archive"; request: number };

export type StepError = { code: ErrorCode; service: Service; timeoutSec: number };

/* A proposal to leave the plan, which the user allows or denies */
export type Deviation = {
  reason: DeviationReason;
  /* The earlier request whose documents are already in the archive */
  archiveRequest: number;
  archiveUploaded: IsoDate;
  proposal: DeviationProposalCode;
  newType: ActionType;
  newRisk: Risk;
};

export type ScenarioStep = {
  id: string;
  type: ActionType;
  supplier: number;
  request: number;
  /* Contract number for steps that change a contract, otherwise null */
  contract: number | null;
  risk: Risk;
  /* 0..1, two decimals */
  confidence: number;
  objects: AffectedObject[];
  draft: Draft;
  summary: Summary;
  undo: UndoEffect;
  /* null means no window: the change is internal and can always be reverted */
  undoWindowSec: number | null;
  /* Base execution time in ms at normal speed */
  durationMs: number;
  deviation?: Deviation;
  /* Set once a deviation has been applied: which proposal the step now follows */
  deviatedTo?: DeviationProposalCode;
  /* Fails on the first attempt with this error */
  error?: StepError;
};

export type Scenario = {
  seed: number;
  steps: ScenarioStep[];
  errorStepId: string;
  deviationStepId: string;
};

export type PlanStep = ScenarioStep & { askFirst: boolean };

/* The task the scenario represents: triage twelve incoming supplier requests */
export const TASK: { code: TaskCode; requests: number } = {
  code: "triage_supplier_requests",
  requests: 12,
};

/* Small deterministic PRNG (mulberry32) */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Structural plan: supplier index and the action for that request */
type Blueprint = { supplier: number; type: ActionType };

const BLUEPRINT: readonly Blueprint[] = [
  { supplier: 0, type: "check" },
  { supplier: 1, type: "extend" },
  { supplier: 2, type: "request_documents" },
  { supplier: 3, type: "extend" },
  { supplier: 4, type: "reject_duplicate" },
  { supplier: 5, type: "check" },
  { supplier: 6, type: "request_documents" },
  { supplier: 7, type: "extend" },
  { supplier: 8, type: "reject_duplicate" },
  { supplier: 9, type: "extend" },
  { supplier: 9, type: "reject_duplicate" },
  { supplier: 10, type: "request_documents" },
];

/* Fixed positions of the scripted events (0-based indexes into BLUEPRINT) */
const ERROR_INDEX = 3;
const DEVIATION_INDEX = 6;
const CONFLICT_PAIR: readonly [number, number] = [9, 10];

/* Fixed calendar of the scenario */
const CONTRACT_END = "2026-09-30";
const CONTRACT_END_EXTENDED = "2027-09-30";
const EXTEND_MONTHS = 12;
const DUPLICATE_OF_DATE = "2026-08-21";
const DOCUMENTS_DUE = "2026-09-12";
const ARCHIVE_UPLOADED = "2026-08-28";
const MATCHED_FIELDS: readonly MatchField[] = ["tax_id", "subject", "amount"];
const REQUIRED_DOCUMENTS: readonly DocumentRequirement[] = [
  { document: "registry_extract", maxAgeDays: 30 },
  { document: "company_card", maxAgeDays: null },
  { document: "license_copy", maxAgeDays: null },
];
const CONTRACT_SERVICE_TIMEOUT: StepError = {
  code: "service_timeout",
  service: "contracts",
  timeoutSec: 5,
};

export const RISK_BY_TYPE: Record<ActionType, Risk> = {
  check: "low",
  extend: "medium",
  reject_duplicate: "high",
  request_documents: "high",
};

const CONFIDENCE_RANGE: Record<ActionType, [number, number]> = {
  check: [0.86, 0.97],
  extend: [0.8, 0.93],
  reject_duplicate: [0.62, 0.9],
  request_documents: [0.7, 0.85],
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function requestObject(request: number, after: RequestStatus): RequestObject {
  return {
    kind: "request",
    request,
    before: { status: "under_review" },
    after: { status: after },
  };
}

export function generateScenario(seed: number = DEFAULT_SEED): Scenario {
  const rng = createRng(seed);
  const firstRequest = 1041 + Math.floor(rng() * 40) * 10;
  const contractBase = 180 + Math.floor(rng() * 60);
  const duplicateOf = firstRequest - 3 - Math.floor(rng() * 6);

  const steps: ScenarioStep[] = BLUEPRINT.map((bp, i): ScenarioStep => {
    const supplier = bp.supplier;
    const requestNo = firstRequest + i;
    /* The conflicting pair shares one request */
    const request = i === CONFLICT_PAIR[1] ? firstRequest + CONFLICT_PAIR[0] : requestNo;
    const contractNo = contractBase + i * 7;
    const [lo, hi] = CONFIDENCE_RANGE[bp.type];
    const confidence = round2(lo + rng() * (hi - lo));
    const durationMs = 300 + Math.floor(rng() * 600);
    const id = `s${i + 1}`;
    const base = { id, supplier, request, confidence, durationMs };

    switch (bp.type) {
      case "check":
        return {
          ...base,
          type: "check",
          contract: null,
          risk: RISK_BY_TYPE.check,
          objects: [requestObject(request, "checked")],
          draft: {
            kind: "change",
            template: "check_request",
            supplier,
            request,
            externalEffects: false,
          },
          summary: { code: "request_checked", request, registryMatch: true },
          undo: { code: "unmark_checked", request },
          undoWindowSec: null,
        };
      case "extend":
        return {
          ...base,
          type: "extend",
          contract: contractNo,
          risk: RISK_BY_TYPE.extend,
          objects: [
            {
              kind: "contract",
              contract: contractNo,
              before: { validUntil: CONTRACT_END },
              after: { validUntil: CONTRACT_END_EXTENDED },
            },
            requestObject(request, "approved"),
          ],
          draft: {
            kind: "change",
            template: "extend_contract",
            supplier,
            contract: contractNo,
            extendMonths: EXTEND_MONTHS,
            validUntilBefore: CONTRACT_END,
            validUntilAfter: CONTRACT_END_EXTENDED,
            termsChanged: false,
          },
          summary: {
            code: "contract_extended",
            contract: contractNo,
            validUntil: CONTRACT_END_EXTENDED,
            request,
          },
          undo: {
            code: "restore_contract_term",
            contract: contractNo,
            validUntil: CONTRACT_END,
            request,
          },
          undoWindowSec: null,
          ...(i === ERROR_INDEX ? { error: CONTRACT_SERVICE_TIMEOUT } : {}),
        };
      case "reject_duplicate":
        return {
          ...base,
          type: "reject_duplicate",
          contract: null,
          risk: RISK_BY_TYPE.reject_duplicate,
          objects: [requestObject(request, "rejected_duplicate")],
          draft: {
            kind: "decision",
            template: "reject_duplicate",
            supplier,
            request,
            duplicateOf,
            duplicateOfDate: DUPLICATE_OF_DATE,
            matchedFields: [...MATCHED_FIELDS],
            notifySupplier: true,
          },
          summary: {
            code: "request_rejected_duplicate",
            request,
            duplicateOf,
            supplierNotified: true,
          },
          undo: { code: "return_to_queue", request, noticeRecalled: true },
          undoWindowSec: DEFAULT_UNDO_WINDOW_SEC,
        };
      case "request_documents":
        return {
          ...base,
          type: "request_documents",
          contract: null,
          risk: RISK_BY_TYPE.request_documents,
          objects: [
            requestObject(request, "documents_requested"),
            {
              kind: "letter",
              supplier,
              request,
              before: { status: "not_sent" },
              after: { status: "sent" },
            },
          ],
          draft: {
            kind: "email",
            template: "request_documents",
            supplier,
            request,
            documents: REQUIRED_DOCUMENTS.map((d) => ({ ...d })),
            dueDate: DOCUMENTS_DUE,
          },
          summary: { code: "documents_requested", supplier, request },
          undo: { code: "recall_letter", supplier, request },
          undoWindowSec: DEFAULT_UNDO_WINDOW_SEC,
          ...(i === DEVIATION_INDEX
            ? {
                deviation: {
                  reason: "fresh_documents_in_archive",
                  archiveRequest: requestNo - 7,
                  archiveUploaded: ARCHIVE_UPLOADED,
                  proposal: "check_by_archive",
                  newType: "check",
                  newRisk: "low",
                } satisfies Deviation,
              }
            : {}),
        };
    }
  });

  return {
    seed,
    steps,
    errorStepId: steps[ERROR_INDEX]!.id,
    deviationStepId: steps[DEVIATION_INDEX]!.id,
  };
}

export function generatePlan(seed: number = DEFAULT_SEED): PlanStep[] {
  return generateScenario(seed).steps.map((s) => ({ ...s, askFirst: false }));
}

/*
  The consent rule. High risk always pauses: this is a floor that no autonomy
  level can lower. "ask_none" ignores per-step flags, "high_only" honors them.
*/
export function requiresConfirmation(
  step: { risk: Risk; askFirst: boolean },
  autonomy: Autonomy,
): boolean {
  if (step.risk === "high") return true;
  if (autonomy === "ask_all") return true;
  if (autonomy === "high_only") return step.askFirst;
  return false;
}

/* The identity of an affected object, without its states */
export function objectRef(o: AffectedObject): ObjectRef {
  switch (o.kind) {
    case "request":
      return { kind: "request", request: o.request };
    case "contract":
      return { kind: "contract", contract: o.contract };
    case "letter":
      return { kind: "letter", supplier: o.supplier, request: o.request };
  }
}

/* Whether two affected objects are the same object */
export function sameObject(a: AffectedObject, b: AffectedObject): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "request":
      return a.request === (b as RequestObject).request;
    case "contract":
      return a.contract === (b as ContractObject).contract;
    case "letter": {
      const l = b as LetterObject;
      return a.supplier === l.supplier && a.request === l.request;
    }
  }
}

export type Conflict = { a: string; b: string; object: ObjectRef; reason: ConflictReason };

/* Two steps conflict when one extends and another rejects the same request */
export function findConflicts(steps: readonly PlanStep[]): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < steps.length; i++) {
    for (let j = i + 1; j < steps.length; j++) {
      const a = steps[i]!;
      const b = steps[j]!;
      const opposite =
        (a.type === "extend" && b.type === "reject_duplicate") ||
        (a.type === "reject_duplicate" && b.type === "extend");
      if (!opposite) continue;
      const shared = a.objects.find((o) => b.objects.some((p) => sameObject(o, p)));
      if (!shared) continue;
      out.push({
        a: a.id,
        b: b.id,
        object: objectRef(shared),
        reason: "extend_and_reject_duplicate",
      });
    }
  }
  return out;
}

/* Applies an allowed deviation to a step */
export function applyDeviation(step: ScenarioStep): ScenarioStep {
  const d = step.deviation;
  if (!d) return step;
  return {
    ...step,
    type: d.newType,
    risk: d.newRisk,
    objects: [requestObject(step.request, "checked_by_archive")],
    draft: {
      kind: "change",
      template: "check_by_archive",
      supplier: step.supplier,
      request: step.request,
      archiveRequest: d.archiveRequest,
      archiveUploaded: d.archiveUploaded,
      sendsLetter: false,
    },
    summary: { code: "request_checked_by_archive", request: step.request, letterSent: false },
    undo: { code: "unmark_checked_by_archive", request: step.request },
    undoWindowSec: null,
    deviation: undefined,
    deviatedTo: d.proposal,
  };
}

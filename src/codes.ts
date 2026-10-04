/*
  Every code the engine emits, in one place.

  The engine carries no human language. Anything an application shows to a
  person is rendered by the application from a code in one of the lists below
  and from numeric or date parameters next to it. The lists are the closed
  vocabulary: a string with a letter in it that appears in an emitted event,
  a plan step or an exported log is either one of these codes or a step id
  (`s1` .. `s12`). The vocabulary test in test/vocabulary.test.ts checks that.

  Dates are ISO 8601 calendar dates (`2026-09-30`) and contain no letters.
*/

/* What a step does to a supplier request */
export const ACTION_TYPES = ["check", "extend", "reject_duplicate", "request_documents"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];

/* How much the user lets the agent do without asking */
export const AUTONOMIES = ["ask_all", "high_only", "ask_none"] as const;
export type Autonomy = (typeof AUTONOMIES)[number];

/* User decisions the run accepts */
export const COMMANDS = ["confirm", "skip", "retry", "allow", "deny", "stop"] as const;
export type Command = (typeof COMMANDS)[number];

/* Events of a run, in the order they can first appear */
export const RUN_EVENT_TYPES = [
  "plan.started",
  "step.started",
  "step.deviation",
  "step.deviated",
  "step.awaiting",
  "step.running",
  "step.progress",
  "step.finished",
  "step.skipped",
  "step.error",
  "plan.finished",
  "plan.stopped",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/* Transport frame that ends a segment which needs a decision */
export const WAITING_EVENT = "stream.waiting";

/* Objects a step changes */
export const OBJECT_KINDS = ["request", "contract", "letter"] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

export const REQUEST_STATUSES = [
  "under_review",
  "checked",
  "checked_by_archive",
  "approved",
  "rejected_duplicate",
  "documents_requested",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const LETTER_STATUSES = ["not_sent", "sent"] as const;
export type LetterStatus = (typeof LETTER_STATUSES)[number];

/* What a step shows the user before it runs */
export const DRAFT_KINDS = ["email", "decision", "change"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export const DRAFT_TEMPLATES = [
  "check_request",
  "extend_contract",
  "reject_duplicate",
  "request_documents",
  "check_by_archive",
] as const;
export type DraftTemplate = (typeof DRAFT_TEMPLATES)[number];

/* Documents a supplier can be asked for */
export const DOCUMENTS = ["registry_extract", "company_card", "license_copy"] as const;
export type DocumentCode = (typeof DOCUMENTS)[number];

/* Fields compared to call a request a duplicate of an earlier one */
export const MATCH_FIELDS = ["tax_id", "subject", "amount"] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

/* What a finished step reports */
export const SUMMARY_CODES = [
  "request_checked",
  "contract_extended",
  "request_rejected_duplicate",
  "documents_requested",
  "request_checked_by_archive",
] as const;
export type SummaryCode = (typeof SUMMARY_CODES)[number];

/* What undoing a finished step rolls back */
export const UNDO_CODES = [
  "unmark_checked",
  "restore_contract_term",
  "return_to_queue",
  "recall_letter",
  "unmark_checked_by_archive",
] as const;
export type UndoCode = (typeof UNDO_CODES)[number];

/* Failures a step can report */
export const ERROR_CODES = ["service_timeout"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const SERVICES = ["contracts"] as const;
export type Service = (typeof SERVICES)[number];

/* Progress phases, two per action type */
export const PROGRESS_PHASES = [
  "matching_registry",
  "reviewing_supplier_history",
  "preparing_amendment",
  "recording_new_term",
  "changing_request_status",
  "notifying_supplier",
  "composing_letter",
  "sending_letter",
] as const;
export type ProgressPhase = (typeof PROGRESS_PHASES)[number];

export const SKIP_REASONS = ["skipped_by_user", "skipped_after_error", "stopped_by_user"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/* Why the agent asks to leave the plan, and what it proposes instead */
export const DEVIATION_REASONS = ["fresh_documents_in_archive"] as const;
export type DeviationReason = (typeof DEVIATION_REASONS)[number];

export const DEVIATION_PROPOSALS = ["check_by_archive"] as const;
export type DeviationProposalCode = (typeof DEVIATION_PROPOSALS)[number];

export const CONFLICT_REASONS = ["extend_and_reject_duplicate"] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];

/* The task the scenario represents */
export const TASK_CODES = ["triage_supplier_requests"] as const;
export type TaskCode = (typeof TASK_CODES)[number];

/* Entries of the plan machine's session log */
export const LOG_KINDS = ["approved", "event", "decision", "stop_requested", "undo"] as const;
export type LogKind = (typeof LOG_KINDS)[number];

/* The seven statuses a timeline shows for a step */
export const STEP_STATUSES = [
  "waiting",
  "running",
  "done",
  "awaiting",
  "skipped",
  "undone",
  "error",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/* Speeds of a streamed run */
export const SPEEDS = ["normal", "fast"] as const;
export type Speed = (typeof SPEEDS)[number];

/* Errors of plan resolution and of the request handler */
export const REQUEST_ERRORS = [
  "missing_plan",
  "invalid_plan",
  "invalid_decisions",
  "empty_plan",
  "too_many_steps",
  "unknown_step",
  "method_not_allowed",
] as const;
export type RequestError = (typeof REQUEST_ERRORS)[number];

/* Identifiers of the exported session log */
export const EXPORT_FORMAT = "ariadne_runner.session_log";

/* The engine is a scripted scenario; the export says so */
export const AGENT_KINDS = ["scripted"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/* The union of every list above, for membership checks */
export const ALL_CODES: ReadonlySet<string> = new Set<string>([
  ...ACTION_TYPES,
  ...RISKS,
  ...AUTONOMIES,
  ...COMMANDS,
  ...RUN_EVENT_TYPES,
  WAITING_EVENT,
  ...OBJECT_KINDS,
  ...REQUEST_STATUSES,
  ...LETTER_STATUSES,
  ...DRAFT_KINDS,
  ...DRAFT_TEMPLATES,
  ...DOCUMENTS,
  ...MATCH_FIELDS,
  ...SUMMARY_CODES,
  ...UNDO_CODES,
  ...ERROR_CODES,
  ...SERVICES,
  ...PROGRESS_PHASES,
  ...SKIP_REASONS,
  ...DEVIATION_REASONS,
  ...DEVIATION_PROPOSALS,
  ...CONFLICT_REASONS,
  ...TASK_CODES,
  ...LOG_KINDS,
  ...STEP_STATUSES,
  ...SPEEDS,
  ...REQUEST_ERRORS,
  EXPORT_FORMAT,
  ...AGENT_KINDS,
]);

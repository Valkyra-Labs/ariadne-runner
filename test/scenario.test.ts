import { describe, expect, it } from "vitest";
import {
  applyDeviation,
  findConflicts,
  generatePlan,
  generateScenario,
  requiresConfirmation,
  RISK_BY_TYPE,
  SUPPLIER_COUNT,
  type Autonomy,
} from "../src/index.js";

const AUTONOMIES: readonly Autonomy[] = ["ask_all", "high_only", "ask_none"];

describe("scenario generation", () => {
  it("is deterministic for a seed and different for another", () => {
    expect(generateScenario(7)).toEqual(generateScenario(7));
    const a = generateScenario(7).steps[0]!;
    const b = generateScenario(9).steps[0]!;
    expect([a.request, a.confidence]).not.toEqual([b.request, b.confidence]);
  });

  it("builds twelve steps with risk derived from the action type", () => {
    const scenario = generateScenario(7);
    expect(scenario.steps).toHaveLength(12);
    for (const step of scenario.steps) {
      expect(step.risk).toBe(RISK_BY_TYPE[step.type]);
      expect(step.confidence).toBeGreaterThan(0.5);
      expect(step.confidence).toBeLessThanOrEqual(1);
      expect(step.objects.length).toBeGreaterThan(0);
      expect(step.supplier).toBeGreaterThanOrEqual(0);
      expect(step.supplier).toBeLessThan(SUPPLIER_COUNT);
    }
  });

  it("schedules exactly one failure and one request to deviate", () => {
    const scenario = generateScenario(7);
    expect(scenario.steps.filter((s) => s.error)).toHaveLength(1);
    expect(scenario.steps.filter((s) => s.deviation)).toHaveLength(1);
    expect(scenario.steps.find((s) => s.error)!.id).toBe(scenario.errorStepId);
    expect(scenario.steps.find((s) => s.deviation)!.id).toBe(scenario.deviationStepId);
  });

  it("gives outgoing actions a finite undo window and internal ones none", () => {
    for (const step of generateScenario(7).steps) {
      if (step.type === "reject_duplicate" || step.type === "request_documents") {
        expect(step.undoWindowSec).toBeGreaterThan(0);
      } else {
        expect(step.undoWindowSec).toBeNull();
      }
    }
  });

  it("describes each step with codes and parameters that agree with each other", () => {
    for (const step of generateScenario(7).steps) {
      expect(step.draft.supplier).toBe(step.supplier);
      const request = step.objects.find((o) => o.kind === "request");
      expect(request).toMatchObject({ request: step.request, before: { status: "under_review" } });
      switch (step.type) {
        case "check":
          expect(step.draft.template).toBe("check_request");
          expect(step.summary).toEqual({
            code: "request_checked",
            request: step.request,
            registryMatch: true,
          });
          expect(step.undo).toEqual({ code: "unmark_checked", request: step.request });
          expect(step.contract).toBeNull();
          break;
        case "extend":
          expect(step.draft).toMatchObject({
            template: "extend_contract",
            contract: step.contract,
            extendMonths: 12,
            validUntilBefore: "2026-09-30",
            validUntilAfter: "2027-09-30",
          });
          expect(step.objects[0]).toEqual({
            kind: "contract",
            contract: step.contract,
            before: { validUntil: "2026-09-30" },
            after: { validUntil: "2027-09-30" },
          });
          expect(step.summary).toMatchObject({
            code: "contract_extended",
            contract: step.contract,
          });
          expect(step.undo).toMatchObject({
            code: "restore_contract_term",
            validUntil: "2026-09-30",
          });
          break;
        case "reject_duplicate":
          expect(step.draft).toMatchObject({
            kind: "decision",
            template: "reject_duplicate",
            matchedFields: ["tax_id", "subject", "amount"],
            notifySupplier: true,
          });
          expect(step.summary).toMatchObject({ code: "request_rejected_duplicate" });
          expect(step.undo).toEqual({
            code: "return_to_queue",
            request: step.request,
            noticeRecalled: true,
          });
          break;
        case "request_documents":
          expect(step.draft).toMatchObject({
            kind: "email",
            template: "request_documents",
            dueDate: "2026-09-12",
          });
          expect(step.objects[1]).toEqual({
            kind: "letter",
            supplier: step.supplier,
            request: step.request,
            before: { status: "not_sent" },
            after: { status: "sent" },
          });
          expect(step.undo).toEqual({
            code: "recall_letter",
            supplier: step.supplier,
            request: step.request,
          });
          break;
      }
    }
  });
});

describe("findConflicts", () => {
  it("finds the scripted pair and nothing else", () => {
    const plan = generatePlan(7);
    const conflicts = findConflicts(plan);
    expect(conflicts).toHaveLength(1);
    const [conflict] = conflicts;
    expect(conflict!.a).toBe("s10");
    expect(conflict!.b).toBe("s11");
    expect(conflict!.reason).toBe("extend_and_reject_duplicate");
    expect(conflict!.object).toEqual({ kind: "request", request: plan[9]!.request });
    expect(plan[10]!.request).toBe(plan[9]!.request);
  });

  it("goes quiet once one of the two steps is removed", () => {
    const plan = generatePlan(7).filter((s) => s.id !== "s11");
    expect(findConflicts(plan)).toEqual([]);
    expect(findConflicts([])).toEqual([]);
  });
});

describe("requiresConfirmation", () => {
  it("keeps the high-risk floor at every autonomy level", () => {
    for (const autonomy of AUTONOMIES) {
      expect(requiresConfirmation({ risk: "high", askFirst: false }, autonomy)).toBe(true);
    }
  });

  it("follows the level for lower risk", () => {
    expect(requiresConfirmation({ risk: "low", askFirst: false }, "ask_all")).toBe(true);
    expect(requiresConfirmation({ risk: "low", askFirst: false }, "high_only")).toBe(false);
    expect(requiresConfirmation({ risk: "medium", askFirst: true }, "high_only")).toBe(true);
    expect(requiresConfirmation({ risk: "medium", askFirst: true }, "ask_none")).toBe(false);
  });
});

describe("applyDeviation", () => {
  it("replaces the step with the lower-risk one and drops the undo window", () => {
    const original = generatePlan(7).find((s) => s.deviation)!;
    expect(original.risk).toBe("high");
    const deviated = applyDeviation(original);
    expect(deviated.risk).toBe("low");
    expect(deviated.type).toBe("check");
    expect(deviated.undoWindowSec).toBeNull();
    expect(deviated.deviation).toBeUndefined();
    expect(deviated.deviatedTo).toBe("check_by_archive");
    expect(deviated.summary).toEqual({
      code: "request_checked_by_archive",
      request: original.request,
      letterSent: false,
    });
    expect(deviated.draft).toMatchObject({
      template: "check_by_archive",
      archiveRequest: original.deviation!.archiveRequest,
      sendsLetter: false,
    });
  });

  it("leaves a step without a proposal untouched", () => {
    const plain = generatePlan(7).find((s) => !s.deviation)!;
    expect(applyDeviation(plain)).toBe(plain);
  });
});

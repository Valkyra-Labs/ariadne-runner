import { describe, expect, it } from "vitest";
import { clockShort, clockTime, countdown, exportLog, type LogEntry } from "../src/index.js";

/* A fixed local time: the helpers format in the viewer's zone by design */
function at(h: number, m: number, s: number): number {
  const d = new Date(2026, 8, 5, h, m, s, 0);
  return d.getTime();
}

describe("clock helpers", () => {
  it("pads hours, minutes and seconds", () => {
    expect(clockTime(at(9, 5, 3))).toBe("09:05:03");
    expect(clockShort(at(14, 32, 59))).toBe("14:32");
  });

  it("counts down in m:ss and never goes negative", () => {
    expect(countdown(60_000)).toBe("1:00");
    expect(countdown(45_400)).toBe("0:46");
    expect(countdown(0)).toBe("0:00");
    expect(countdown(-5_000)).toBe("0:00");
  });
});

describe("exportLog", () => {
  const header = { seed: 7, autonomy: "high_only" as const, total: 12 };

  it("puts the honest header first and stamps every entry", () => {
    const entries: LogEntry[] = [
      { at: at(10, 0, 0), kind: "approved", total: 12, autonomy: "high_only", confirmations: 6 },
      { at: at(10, 0, 12), kind: "event", event: { type: "plan.finished", at: at(10, 0, 12) } },
    ];
    const out = exportLog(entries, header);
    expect(out).toMatchObject({
      format: "ariadne_runner.session_log",
      version: 1,
      task: { code: "triage_supplier_requests", requests: 12 },
      agent: "scripted",
      seed: 7,
      autonomy: "high_only",
      total: 12,
      started: true,
    });
    expect(out.entries.map((e) => [e.time, e.kind])).toEqual([
      ["10:00:00", "approved"],
      ["10:00:12", "event"],
    ]);
    expect(out.entries[1]).toEqual({ ...entries[1], time: "10:00:12" });
    /* The export survives JSON unchanged */
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("says so when there is nothing to export yet", () => {
    const out = exportLog([], header);
    expect(out.started).toBe(false);
    expect(out.entries).toEqual([]);
  });
});

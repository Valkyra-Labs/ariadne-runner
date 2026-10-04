/*
  Structured export of the session log plus the clock helpers a timeline
  needs. The export is data (JSON-ready), not text: the application writes it
  out in the reader's language. Clock strings contain digits and colons only.
*/

import { EXPORT_FORMAT, type AgentKind, type Autonomy, type TaskCode } from "./codes.js";
import type { LogEntry } from "./machines/plan.machine.js";
import { TASK } from "./scenario.js";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/* Local HH:MM:SS of a timestamp, used for log lines */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* Local HH:MM of a timestamp, used for the time a step becomes irreversible */
export function clockShort(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* Remaining time as m:ss, never negative */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

export type LogHeader = { seed: number; autonomy: Autonomy; total: number };

export type ExportedEntry = LogEntry & { time: string };

export type SessionExport = {
  format: typeof EXPORT_FORMAT;
  version: 1;
  task: { code: TaskCode; requests: number };
  /* The run is a seeded script; no model produces it */
  agent: AgentKind;
  seed: number;
  autonomy: Autonomy;
  total: number;
  /* False while the plan has not been run: there are no entries yet */
  started: boolean;
  /* Every entry keeps its timestamp and gains its local clock time */
  entries: ExportedEntry[];
};

export function exportLog(entries: readonly LogEntry[], header: LogHeader): SessionExport {
  return {
    format: EXPORT_FORMAT,
    version: 1,
    task: { ...TASK },
    agent: "scripted",
    seed: header.seed,
    autonomy: header.autonomy,
    total: header.total,
    started: entries.length > 0,
    entries: entries.map((e) => ({ ...e, time: clockTime(e.at) })),
  };
}

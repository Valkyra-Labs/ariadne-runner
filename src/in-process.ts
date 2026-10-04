/*
  In-process transport: the same segments as the Service Worker handler,
  delivered as an async iterable of decoded items instead of an event stream.
  Meant for tests and for hosts that run the engine in the same thread as the
  interface. Delays are honoured through the sleep function, which tests can
  replace with one that resolves at once.
*/

import type { RequestError } from "./codes.js";
import type { RunEvent, WaitingNotice } from "./protocol.js";
import { abortableSleep, parseSegmentRequest, segment, type SegmentOptions } from "./segment.js";

export type StreamItem =
  { kind: "event"; id: number; event: RunEvent } | { kind: "waiting"; notice: WaitingNotice };

export type InProcessOptions = SegmentOptions & {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type ConnectInit = {
  /* What an EventSource reconnect would send as Last-Event-ID */
  lastEventId?: number | null;
  signal?: AbortSignal;
};

export type ConnectResult =
  | { ok: true; items: AsyncGenerator<StreamItem> }
  | { ok: false; error: RequestError; stepId?: string };

/* Opens one segment for a query string or URLSearchParams of the agent protocol */
export function connectInProcess(
  query: URLSearchParams | string,
  init: ConnectInit = {},
  options: InProcessOptions = {},
): ConnectResult {
  const params = typeof query === "string" ? new URLSearchParams(query) : query;
  const lastEventId =
    init.lastEventId === undefined || init.lastEventId === null ? null : String(init.lastEventId);
  const parsed = parseSegmentRequest(params, lastEventId);
  if (!parsed.ok) {
    return parsed.stepId === undefined
      ? { ok: false, error: parsed.error }
      : { ok: false, error: parsed.error, stepId: parsed.stepId };
  }
  const sleep = options.sleep ?? abortableSleep;
  const signal = init.signal;
  const request = parsed.request;

  async function* items(): AsyncGenerator<StreamItem> {
    for (const item of segment(request, options)) {
      if (signal?.aborted) return;
      if (item.kind === "delay") {
        await sleep(item.ms, signal);
        continue;
      }
      yield item;
    }
  }

  return { ok: true, items: items() };
}

/*
  Server-sent events without a server.

  handleAgentRequest answers the run's query shape (see protocol.ts) from
  inside a Service Worker fetch handler: it returns a text/event-stream
  Response for a GET to the agent path and null for any other request, so the
  worker can fall through to the network. Every frame of an event carries its
  id, so the browser's EventSource reconnect sends Last-Event-ID and the next
  segment resumes after it.

  One request streams one segment and ends: at the end of the plan or at the
  first decision the application has not made yet. Nothing is kept between
  requests, so it does not matter whether the worker was restarted in between.
*/

import { WAITING_EVENT, type RequestError } from "./codes.js";
import type { RunEvent, WaitingNotice } from "./protocol.js";
import { abortableSleep, parseSegmentRequest, segment, type SegmentOptions } from "./segment.js";

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/* Reconnection delay announced to EventSource, in ms */
export const RETRY_MS = 700;

/* Default agent path: any same-origin GET whose path ends with this */
export const AGENT_PATH = "/api/agent";

/* Encodes one event as an SSE frame */
export function encodeFrame(id: number, event: RunEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/* The last frame of a segment that stopped on a decision; it has no id */
export function encodeWaitingFrame(notice: WaitingNotice): string {
  return `event: ${WAITING_EVENT}\ndata: ${JSON.stringify(notice)}\n\n`;
}

export function encodeRetryFrame(ms: number = RETRY_MS): string {
  return `retry: ${ms}\n\n`;
}

export type AgentHandlerOptions = SegmentOptions & {
  /* Which requests the handler answers; the default is AGENT_PATH, same origin */
  match?: (url: URL) => boolean;
  /* Replaces the timer used for delays between events (tests) */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function defaultMatch(url: URL): boolean {
  if (!url.pathname.endsWith(AGENT_PATH)) return false;
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  return origin === undefined || url.origin === origin;
}

function jsonError(status: number, error: RequestError, stepId?: string): Response {
  const body = stepId === undefined ? { ok: false, error } : { ok: false, error, stepId };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/* Builds a handler; handleAgentRequest is the one with default options */
export function createAgentHandler(
  options: AgentHandlerOptions = {},
): (request: Request) => Response | null {
  const match = options.match ?? defaultMatch;
  const sleep = options.sleep ?? abortableSleep;

  return (request: Request): Response | null => {
    const url = new URL(request.url);
    if (!match(url)) return null;
    if (request.method !== "GET") return jsonError(405, "method_not_allowed");

    const parsed = parseSegmentRequest(url.searchParams, request.headers.get("last-event-id"));
    if (!parsed.ok) return jsonError(400, parsed.error, parsed.stepId);

    const items = segment(parsed.request, options);
    const encoder = new TextEncoder();
    /* Aborted when the request is aborted or the reader cancels the stream */
    const local = new AbortController();
    const abort = () => local.abort();
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    const signal = local.signal;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const live = () => !signal.aborted;
        const send = (text: string) => {
          if (live()) controller.enqueue(encoder.encode(text));
        };
        try {
          send(encodeRetryFrame());
          for (const item of items) {
            if (!live()) break;
            if (item.kind === "delay") {
              await sleep(item.ms, signal);
              continue;
            }
            if (item.kind === "waiting") {
              send(encodeWaitingFrame(item.notice));
              break;
            }
            send(encodeFrame(item.id, item.event));
          }
        } catch {
          /* The client went away: nothing to clean up, there is no session */
        }
        request.signal.removeEventListener("abort", abort);
        try {
          controller.close();
        } catch {
          /* Already closed by the client */
        }
      },
      cancel() {
        abort();
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  };
}

const defaultHandler = createAgentHandler();

/*
  The Service Worker entry point:

    self.addEventListener("fetch", (event) => {
      const response = handleAgentRequest(event.request);
      if (response) event.respondWith(response);
    });
*/
export function handleAgentRequest(request: Request): Response | null {
  return defaultHandler(request);
}

import { describe, expect, it } from "vitest";
import {
  createAgentHandler,
  DROP_AFTER_FRAMES,
  encodeDecisions,
  encodePlanPayload,
  handleAgentRequest,
  RETRY_MS,
  WAITING_EVENT,
  type Decision,
  type PlanPayload,
  type RunEvent,
} from "../src/index.js";
import { payloadFor, run, runToEnd } from "./helpers.js";
import { parseEventStream, type SseFrame } from "./sse-parse.js";

const ORIGIN = "https://app.test";
const instant = createAgentHandler({ sleep: async () => {}, now: () => 1000 });

function url(payload: PlanPayload, decisions: Decision[] = [], extra = ""): string {
  const d = decisions.length > 0 ? `&decisions=${encodeDecisions(decisions)}` : "";
  return `${ORIGIN}/api/agent?plan=${encodePlanPayload(payload)}${d}${extra}`;
}

async function frames(response: Response | null): Promise<SseFrame[]> {
  if (!response) throw new Error("handler declined the request");
  return parseEventStream(await response.text());
}

function eventsOf(list: SseFrame[]): { id: number; event: RunEvent }[] {
  return list
    .filter((f) => f.id !== null)
    .map((f) => ({ id: Number(f.id), event: JSON.parse(f.data) as RunEvent }));
}

describe("handleAgentRequest: routing and errors", () => {
  it("declines requests that are not for the agent path", () => {
    expect(handleAgentRequest(new Request(`${ORIGIN}/index.html`))).toBeNull();
    expect(handleAgentRequest(new Request(`${ORIGIN}/api/agents`))).toBeNull();
    const custom = createAgentHandler({ match: (u) => u.pathname === "/run" });
    expect(custom(new Request(url(payloadFor(["s1"]))))).toBeNull();
    expect(custom(new Request(`${ORIGIN}/run?plan=x`))?.status).toBe(400);
  });

  it("answers bad queries with a JSON error code", async () => {
    const missing = handleAgentRequest(new Request(`${ORIGIN}/api/agent`))!;
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ ok: false, error: "missing_plan" });
    const unknown = handleAgentRequest(
      new Request(url({ seed: 7, autonomy: "high_only", steps: [{ id: "s99", askFirst: false }] })),
    )!;
    expect(await unknown.json()).toEqual({ ok: false, error: "unknown_step", stepId: "s99" });
    const post = handleAgentRequest(new Request(url(payloadFor(["s1"])), { method: "POST" }))!;
    expect(post.status).toBe(405);
    expect(await post.json()).toEqual({ ok: false, error: "method_not_allowed" });
  });

  it("serves the agent path under a base path too", async () => {
    const response = instant(
      new Request(`${ORIGIN}/demo/api/agent?plan=${encodePlanPayload(payloadFor(["s1"]))}`),
    );
    expect(response?.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  });
});

describe("handleAgentRequest: the event stream", () => {
  it("streams a segment as SSE frames with ids, matching the runner event for event", async () => {
    const response = instant(new Request(url(payloadFor(["s1"]))))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    const list = await frames(response);
    expect(list[0]).toEqual({ id: null, event: null, data: "", retry: RETRY_MS });
    const events = eventsOf(list);
    expect(events).toEqual(run(payloadFor(["s1"])).events);
    for (const f of list.slice(1)) expect(f.event).toBe(JSON.parse(f.data).type);
  });

  it("ends a segment on a decision with a waiting frame that has no id", async () => {
    const list = await frames(instant(new Request(url(payloadFor(["s1", "s3"])))));
    const last = list.at(-1)!;
    expect(last.event).toBe(WAITING_EVENT);
    expect(last.id).toBeNull();
    expect(JSON.parse(last.data)).toEqual({ stepId: "s3", accepts: ["confirm", "skip"] });
    expect(eventsOf(list).at(-1)!.event.type).toBe("step.awaiting");
  });

  it("drives a whole plan segment by segment, as a page would", async () => {
    const payload = payloadFor();
    const received: { id: number; event: RunEvent }[] = [];
    const log: Decision[] = [];
    let segments = 0;
    for (;;) {
      segments += 1;
      const after = received.at(-1)?.id ?? 0;
      const list = await frames(instant(new Request(url(payload, log, `&after=${after}`))));
      received.push(...eventsOf(list));
      const last = list.at(-1)!;
      if (last.event !== WAITING_EVENT) break;
      const notice = JSON.parse(last.data) as { stepId: string; accepts: string[] };
      const command = (["confirm", "allow", "retry"] as const).find((c) =>
        notice.accepts.includes(c),
      )!;
      log.push({ command, stepId: notice.stepId, afterEventId: received.at(-1)!.id });
    }
    /* No event twice, none missing, and the same run the generator produces */
    expect(received.map((e) => e.id)).toEqual(received.map((_, i) => i + 1));
    expect(received).toEqual(runToEnd(payload).segment.events);
    expect(received.at(-1)!.event.type).toBe("plan.finished");
    expect(segments).toBe(log.length + 1);
  });

  it("a dropped first segment resumes with Last-Event-ID, with nothing lost or repeated", async () => {
    const payload = payloadFor(["s1", "s2"]);
    const address = url(payload, [], "&drop=1");
    const first = eventsOf(await frames(instant(new Request(address))));
    expect(first).toHaveLength(DROP_AFTER_FRAMES);
    const lastSeen = first.at(-1)!.id;

    /* EventSource reconnects to the same URL and adds the header */
    const second = eventsOf(
      await frames(
        instant(new Request(address, { headers: { "Last-Event-ID": String(lastSeen) } })),
      ),
    );
    expect(second[0]!.id).toBe(lastSeen + 1);
    expect([...first, ...second]).toEqual(run(payload).events);
    expect(second.at(-1)!.event.type).toBe("plan.finished");
  });

  it("a connection the client cancels mid-run resumes with Last-Event-ID", async () => {
    /* Delays wait until the test releases them, so the run can be cut in the middle */
    const waiting: (() => void)[] = [];
    const handler = createAgentHandler({
      now: () => 1000,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          waiting.push(resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    });
    const payload = payloadFor(["s1", "s2"]);
    const response = handler(new Request(url(payload)))!;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let seen: { id: number; event: RunEvent }[] = [];
    while (seen.length < 4) {
      while (waiting.length > 0) waiting.shift()!();
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended early");
      text += decoder.decode(value, { stream: true });
      seen = eventsOf(parseEventStream(text.slice(0, text.lastIndexOf("\n\n") + 2)));
    }
    await reader.cancel();
    const lastSeen = seen.at(-1)!.id;

    const resumed = handler(
      new Request(url(payload), { headers: { "last-event-id": String(lastSeen) } }),
    )!;
    const body = resumed.text();
    /* Release the delays of the resumed segment as they come */
    const pump = setInterval(() => {
      while (waiting.length > 0) waiting.shift()!();
    }, 1);
    const rest = eventsOf(parseEventStream(await body));
    clearInterval(pump);
    expect(rest[0]!.id).toBe(lastSeen + 1);
    expect([...seen, ...rest]).toEqual(run(payload).events);
  });

  it("an aborted request closes the stream without writing more", async () => {
    const controller = new AbortController();
    const handler = createAgentHandler({ now: () => 1000 });
    const response = handler(
      new Request(url(payloadFor(["s1", "s2"])), { signal: controller.signal }),
    )!;
    controller.abort();
    const list = parseEventStream(await response.text());
    expect(eventsOf(list).length).toBeLessThan(run(payloadFor(["s1", "s2"])).events.length);
  });

  it("Last-Event-ID takes precedence over the after parameter", async () => {
    const payload = payloadFor(["s1"]);
    const list = await frames(
      instant(new Request(url(payload, [], "&after=2"), { headers: { "Last-Event-ID": "5" } })),
    );
    expect(eventsOf(list).map((e) => e.id)).toEqual([6, 7]);
  });

  it("runs on real timers at fast speed through the exported handler", async () => {
    const started = performance.now();
    const list = await frames(
      handleAgentRequest(new Request(url(payloadFor(["s1"]), [], "&speed=fast"))),
    );
    const elapsed = performance.now() - started;
    expect(
      eventsOf(list)
        .map((e) => e.event.type)
        .at(-1),
    ).toBe("plan.finished");
    /* s1 waits 150 ms plus its duration, scaled by 0.2: at least 30 ms */
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });
});

import { describe, expect, it } from "vitest";
import {
  connectInProcess,
  createAgentHandler,
  encodeDecisions,
  encodePlanPayload,
  type Decision,
  type PlanPayload,
  type StreamItem,
} from "../src/index.js";
import { decide, payloadFor, run } from "./helpers.js";
import { parseEventStream } from "./sse-parse.js";

const options = { sleep: async () => {}, now: () => 1000 };

function query(payload: PlanPayload, decisions: Decision[] = [], extra = ""): string {
  const d = decisions.length > 0 ? `&decisions=${encodeDecisions(decisions)}` : "";
  return `plan=${encodePlanPayload(payload)}${d}${extra}`;
}

async function collect(items: AsyncGenerator<StreamItem>): Promise<StreamItem[]> {
  const out: StreamItem[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe("in-process transport", () => {
  it("yields the same segment as the Service Worker handler", async () => {
    const payload = payloadFor(["s1", "s3"]);
    const connection = connectInProcess(query(payload), {}, options);
    if (!connection.ok) throw new Error(connection.error);
    const items = await collect(connection.items);

    const response = createAgentHandler(options)(
      new Request(`https://app.test/api/agent?${query(payload)}`),
    )!;
    const frames = parseEventStream(await response.text()).filter((f) => f.data !== "");
    expect(items.map((i) => (i.kind === "event" ? i.event : i.notice))).toEqual(
      frames.map((f) => JSON.parse(f.data)),
    );
    expect(items.at(-1)).toEqual({
      kind: "waiting",
      notice: { stepId: "s3", accepts: ["confirm", "skip"] },
    });
  });

  it("resumes after lastEventId and takes decisions from the query", async () => {
    const payload = payloadFor(["s3"]);
    const connection = connectInProcess(
      query(payload, [decide("confirm", "s3", 3)]),
      { lastEventId: 3 },
      options,
    );
    if (!connection.ok) throw new Error(connection.error);
    const items = await collect(connection.items);
    const full = run(payload, [decide("confirm", "s3", 3)]).events;
    expect(items).toEqual(full.slice(3).map((e) => ({ kind: "event", ...e })));
  });

  it("reports a bad query as an error code", () => {
    expect(connectInProcess("decisions=x", {}, options)).toEqual({
      ok: false,
      error: "missing_plan",
    });
    expect(connectInProcess(query(payloadFor(["s1"]), [], "&decisions=nope"))).toEqual({
      ok: false,
      error: "invalid_decisions",
    });
  });

  it("stops yielding once the signal aborts", async () => {
    const controller = new AbortController();
    const connection = connectInProcess(
      query(payloadFor(["s1", "s2"])),
      { signal: controller.signal },
      options,
    );
    if (!connection.ok) throw new Error(connection.error);
    const out: StreamItem[] = [];
    for await (const item of connection.items) {
      out.push(item);
      if (out.length === 3) controller.abort();
    }
    expect(out).toHaveLength(3);
  });

  it("applies the drop option to a first segment only", async () => {
    const payload = payloadFor(["s1", "s2"]);
    const first = connectInProcess(query(payload, [], "&drop=1"), {}, options);
    const again = connectInProcess(query(payload, [], "&drop=1"), { lastEventId: 6 }, options);
    if (!first.ok || !again.ok) throw new Error("bad query");
    const a = await collect(first.items);
    const b = await collect(again.items);
    expect(a).toHaveLength(6);
    expect([...a, ...b]).toEqual(run(payload).events.map((e) => ({ kind: "event", ...e })));
  });
});

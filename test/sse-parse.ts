/* Minimal text/event-stream parser, enough for the frames the engine writes */
/* event is null when the frame names none (EventSource would call it "message") */
export type SseFrame = {
  id: string | null;
  event: string | null;
  data: string;
  retry: number | null;
};

export function parseEventStream(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (block.trim() === "") continue;
    const frame: SseFrame = { id: null, event: null, data: "", retry: null };
    const data: string[] = [];
    for (const line of block.split("\n")) {
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "id") frame.id = value;
      else if (field === "event") frame.event = value;
      else if (field === "data") data.push(value);
      else if (field === "retry") frame.retry = Number(value);
      else throw new Error(`unexpected field ${field}`);
    }
    frame.data = data.join("\n");
    frames.push(frame);
  }
  return frames;
}

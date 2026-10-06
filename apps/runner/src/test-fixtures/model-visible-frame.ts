/** Narrow public Responses frame reader for controlled local test decoders.
 * No access to stored questions, Source, checkpoints or acceptance expectations. */
export function modelVisibleUserText(body: unknown): string {
  if (!body || typeof body !== "object" || !("input" in body) || !Array.isArray(body.input))
    throw new Error("TEST_MODEL_VISIBLE_RESPONSES_FRAME_REQUIRED");
  return body.input.filter(item => item?.role === "user").map(item => {
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) return item.content.map((part: unknown) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
    throw new Error("TEST_MODEL_VISIBLE_USER_TEXT_REQUIRED");
  }).join("\n");
}

export function modelVisibleJsonLine<T>(body: unknown, label: string): T {
  const lines = modelVisibleUserText(body).split("\n").filter(line => line.startsWith(`${label}: `));
  if (lines.length !== 1) throw new Error(`TEST_MODEL_VISIBLE_EXACT_FRAME_REQUIRED:${label}`);
  return JSON.parse(lines[0]!.slice(label.length + 2)) as T;
}

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildReadWorkloadPrompt, READ_WORKLOAD_SYSTEM_PROMPT, type ReadWorkloadPromptInput } from "./read-workload-prompt.js";

// Frozen from the actual predecessor baseQuestion array at the pin recorded in
// b62-read-prompt-extraction/PREDECESSOR.json. These are serialization snapshots,
// not native confirmations or evidence of permission to read any Source data.
const cases = JSON.parse(fs.readFileSync(new URL("./test-fixtures/read-workload-prompt-golden.json", import.meta.url), "utf8")) as Array<{
  name: string; input: ReadWorkloadPromptInput; question: string; system: string;
}>;
describe("Read prompt extraction byte parity", () => {
  it.each(cases)("preserves exact predecessor bytes for $name", ({ input, question, system }) => {
    const before = structuredClone(input);
    expect(buildReadWorkloadPrompt(input)).toBe(question);
    expect(READ_WORKLOAD_SYSTEM_PROMPT).toBe(system);
    expect(input).toEqual(before);
  });
});

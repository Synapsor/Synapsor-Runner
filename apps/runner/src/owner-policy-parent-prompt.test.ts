import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOwnerPolicyParentPrompt, buildOwnerPolicyParentCorrectionPrompt,
  OWNER_POLICY_PARENT_SYSTEM_PROMPT, type OwnerPolicyParentPromptInput } from "./owner-policy-parent-prompt.js";

// Frozen from exact 9f8fe16f source expressions before extraction. Synthetic
// serialization fixtures only: no Source reads, provider calls or authority.
const cases = JSON.parse(fs.readFileSync(new URL("./test-fixtures/owner-policy-parent-prompt-golden.json", import.meta.url), "utf8")) as Array<{
  name: string; input: OwnerPolicyParentPromptInput; issue: string; question: string; system: string; correction: string;
}>;
describe("operator parent prompt extraction byte parity", () => {
  it.each(cases)("preserves initial, system and bounded correction bytes for $name", ({ input, issue, question, system, correction }) => {
    const before = structuredClone(input);
    expect(buildOwnerPolicyParentPrompt(input)).toBe(question);
    expect(OWNER_POLICY_PARENT_SYSTEM_PROMPT).toBe(system);
    expect(buildOwnerPolicyParentCorrectionPrompt({ baseQuestion: question, issue })).toBe(correction);
    expect(input).toEqual(before);
  });
});

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildModelPrincipalScopePrompt, buildModelPrincipalScopeCorrectionPrompt,
  MODEL_PRINCIPAL_SCOPE_SYSTEM_PROMPT, type ModelPrincipalScopePromptInput } from "./model-principal-scope-prompt.js";

// Frozen from exact 9f8fe16f source expressions before extraction. Synthetic
// serialization fixtures only: no Source reads, provider calls or authority.
const cases = JSON.parse(fs.readFileSync(new URL("./test-fixtures/model-principal-scope-prompt-golden.json", import.meta.url), "utf8")) as Array<{
  name: string; input: ModelPrincipalScopePromptInput; issue: string; question: string; system: string; correction: string;
}>;
describe("principal scope prompt extraction byte parity", () => {
  it.each(cases)("preserves initial, system and bounded correction bytes for $name", ({ input, issue, question, system, correction }) => {
    const before = structuredClone(input);
    expect(buildModelPrincipalScopePrompt(input)).toBe(question);
    expect(MODEL_PRINCIPAL_SCOPE_SYSTEM_PROMPT).toBe(system);
    expect(buildModelPrincipalScopeCorrectionPrompt({ question, issue })).toBe(correction);
    expect(input).toEqual(before);
  });
});

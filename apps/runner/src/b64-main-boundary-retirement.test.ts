import fs from "node:fs";
import { describe, expect, it } from "vitest";

// Source ownership guards, not substitutes for public setup/Resume acceptance.
const source = fs.readFileSync(new URL("./boundary-commands.ts", import.meta.url), "utf8");
describe("Main typed boundary ownership", () => {
  it("does not treat a business answer word as a recovery command", () => {
    expect(source.includes('answer?.trim().toLowerCase() === "retry"')).toBe(false);
  });
  it("uses typed resources, complete analyzed plans and nonsemantic review formatting", () => {
    for (const retired of ["jobExplicitlyNamesResource", "boundaryIntentTokens", 'entry.description.startsWith("Review the exact fields required to ")', 'Client integration still unverified|Next|Sequence|Still needed', 'Before activation|UNMET REQUEST|Privacy decision', 'line.startsWith("Run: ")'])
      expect(source.includes(retired)).toBe(false);
  });
  it("does not reconstruct activation semantics from formatted business lines", () => {
    expect(source.includes('business[0]!.replace(/^Change: /u')).toBe(false);
    expect(source.includes('line.startsWith("Completion:")')).toBe(false);
  });
  it("never classifies raw business answers as explanation questions", () => {
    expect(source.includes("isBoundaryAuthoringExplanationQuestion")).toBe(false);
  });
  it("routes generated coverage repairs only by their typed provenance", () => {
    expect(source.includes('pendingActionRevision.instruction.startsWith(')).toBe(false);
  });
  it("uses typed field roles and review status rather than rendered notes", () => {
    expect(source.includes('note?.startsWith("REVIEW:")')).toBe(false);
    expect(source.includes('label === "record identity"')).toBe(false);
  });
  it("uses inspected enum values rather than parsing evidence narration", () => {
    expect(source.includes('field.evidence.find((item) => item.startsWith("database enum values:"))')).toBe(false);
  });
});

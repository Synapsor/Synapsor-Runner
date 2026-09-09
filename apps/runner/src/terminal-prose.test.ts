import { describe, expect, it } from "vitest";
import { createTerminalProseReflow, reflowTerminalProse } from "./terminal-prose.js";

describe("terminal prose reflow", () => {
  const cases = [
    ["Wrapped business text\ncontinues on the available terminal line.", "Wrapped business text continues on the available terminal line."],
    ["First sentence.\nWhat should change?", "First sentence. What should change?"],
    ["First paragraph.\n\nSecond paragraph.", "First paragraph.\n\nSecond paragraph."],
    ["Summary:\nA separate decision.", "Summary:\nA separate decision."],
    ["Summary.\n- Read customer data\n- Request a change", "Summary.\n- Read customer data\n- Request a change"],
    ["Summary.\n1. Read review\n2. Action review", "Summary.\n1. Read review\n2. Action review"],
    ["Summary.\n# Decision\nRead only.", "Summary.\n# Decision\nRead only."],
    ["Summary.\n**Read** the reviewed\n`amount` only.", "Summary. **Read** the reviewed `amount` only."],
    ["Summary.\nField | Visibility\n--- | ---\nid | Runner only", "Summary.\nField | Visibility\n--- | ---\nid | Runner only"],
    ["Summary.\n| Field | Visibility |\n| --- | --- |", "Summary.\n| Field | Visibility |\n| --- | --- |"],
    ["Summary.\n```sql\nSELECT amount\n  FROM refunds;\n```\nNext decision.", "Summary.\n```sql\nSELECT amount\n  FROM refunds;\n```\nNext decision."],
    ["Summary.\n~~~text\nfirst code line\nsecond code line\n~~~\nNext decision.", "Summary.\n~~~text\nfirst code line\nsecond code line\n~~~\nNext decision."],
    ["Summary.\n    first code line\n    second code line", "Summary.\n    first code line\n    second code line"],
    ["Summary.\nScope: customer\nStatus: disabled", "Summary.\nScope: customer\nStatus: disabled"],
    ["Which scope?\nCandidate 1: direct\nCandidate 2: reviewed path\nAnswer with its name.", "Which scope?\nCandidate 1: direct\nCandidate 2: reviewed path\nAnswer with its name."],
    ["Explicit break.  \nKeep this line.", "Explicit break.  \nKeep this line."],
    ["Explicit break.\\\nKeep this line.", "Explicit break.\\\nKeep this line."],
    ["Summary.\n> Quoted rule\n> Second quoted line", "Summary.\n> Quoted rule\n> Second quoted line"],
    ["Summary.\n\n", "Summary.\n\n"],
    ["", ""],
  ] as const;
  it.each(cases)("preserves layout meaning: %s", (source, expected) => {
    expect(reflowTerminalProse(source)).toBe(expected);
    for (const size of [1, 3, 12]) {
      const output: string[] = [];
      const stream = createTerminalProseReflow((text) => output.push(text));
      for (let at = 0; at < source.length; at += size) stream.push(source.slice(at, at + size));
      stream.finish();
      expect(output.join(""), `stream chunks of ${size}`).toBe(expected);
    }
  });

  it("emits ordinary prose before completion and keeps source text unchanged", () => {
    const output: string[] = [];
    const stream = createTerminalProseReflow((text) => output.push(text));
    const source = "This is the first sentence.";
    stream.push(source);
    expect(output.join("")).toBe(source);
    stream.push("\nThis is a continuation.");
    stream.finish();
    expect(output.join("")).toBe(`${source} This is a continuation.`);
    expect(source).toBe("This is the first sentence.");
  });
});

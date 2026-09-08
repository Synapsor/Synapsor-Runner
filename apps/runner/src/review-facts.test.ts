import { describe, expect, it } from "vitest";
import { renderReviewFacts } from "./review-facts.js";

const rows: ReadonlyArray<readonly [string, string]> = [
  ["Who", "Authenticated customer account"],
  ["Can read", "Plans, offers, invoices, services, usage, and support records"],
  ["This approval", "Submit reviewed proposals only; database execution remains disabled"],
  ["Still needed", "Verified writer, execution consent, a running worker, and an identity-tested client"],
  ["Status", "First line explains the current authority.\nSecond line records the remaining prerequisite."],
];

function visibleWidth(line: string): number {
  return Array.from(line.replace(/\u001b\[[0-9;]*m/gu, "")).length;
}

describe("review facts terminal presentation", () => {
  it("renders a complete readable stacked table at 52 columns, including multiline values", () => {
    const lines = renderReviewFacts(rows, 52);

    expect(lines).toContain("Who:");
    expect(lines).toContain("Status:");
    expect(lines).toContain("  First line explains the current authority.");
    expect(lines).toContain("  Second line records the remaining prerequisite.");
    expect(lines.every((line) => visibleWidth(line) <= 52)).toBe(true);
    expect(lines.join("\n")).not.toContain("?");
  });

  it.each([80, 120])("aligns labels and wraps long or multiline values at %i columns", (width) => {
    const lines = renderReviewFacts(rows, width);
    const labelWidth = "This approval".length;

    expect(lines[0]).toBe(`${"Who".padEnd(labelWidth)}  Authenticated customer account`);
    expect(lines).toContain(`${"Status".padEnd(labelWidth)}  First line explains the current authority.`);
    expect(lines).toContain(`${" ".repeat(labelWidth + 2)}Second line records the remaining prerequisite.`);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("\n")).not.toContain("?");
  });
});

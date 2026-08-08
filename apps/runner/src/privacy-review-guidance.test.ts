import { describe, expect, it } from "vitest";
import { cliPrivacyReviewInstructions } from "./privacy-review-guidance.js";

describe("CLI privacy review guidance", () => {
  it("states that Privacy applies to the highlighted table and explains both confirmations", () => {
    const guidance = cliPrivacyReviewInstructions({
      boundary: "reviewed_staging",
      resource: "public.invoices",
    });

    expect(guidance).toContain("select reviewed_staging and press Enter");
    expect(guidance).toContain("Highlight public.invoices; do not open its columns");
    expect(guidance).toContain("Press P (Privacy) for the highlighted table");
    expect(guidance).toContain("minimum group size from 1 through 5");
    expect(guidance).toContain("Save this privacy change? [Y/n]");
    expect(guidance).toContain("/access stays open after activation");
    expect(guidance).toContain("Q/Escape");
    expect(guidance).toContain("press C later from the boundary screen");
  });

  it("names 1 when complementary totals require suppression to be off", () => {
    const guidance = cliPrivacyReviewInstructions({
      boundary: "reviewed_staging",
      resource: "public.invoices",
      requireSuppressionOff: true,
    });

    expect(guidance).toContain("Enter 1 to turn small-group suppression off");
  });
});

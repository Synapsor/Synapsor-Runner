import { describe, expect, it } from "vitest";
import { tokenizeSynapsorDsl, workbenchSyntaxScript } from "./workbench-syntax.js";

describe("Workbench syntax highlighting", () => {
  it("classifies DSL keywords separately from user-defined names without changing text", () => {
    const source = [
      "CREATE CAPABILITY billing.propose_credit",
      "DESCRIPTION 'Review <script>alert(1)</script> safely'",
      "BOUND amount_cents 0..2500",
      "-- reviewer-visible comment",
      "END",
      "",
    ].join("\n");
    const tokens = tokenizeSynapsorDsl(source);

    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(tokens).toContainEqual({ kind: "keyword", text: "CREATE" });
    expect(tokens).toContainEqual({ kind: "keyword", text: "CAPABILITY" });
    expect(tokens).toContainEqual({ kind: "identifier", text: "billing" });
    expect(tokens).toContainEqual({ kind: "identifier", text: "propose_credit" });
    expect(tokens).toContainEqual({ kind: "number", text: "2500" });
    expect(tokens).toContainEqual({
      kind: "string",
      text: "'Review <script>alert(1)</script> safely'",
    });
    expect(tokens).toContainEqual({ kind: "comment", text: "-- reviewer-visible comment" });
  });

  it("ships a local DOM renderer that reconstructs source with text nodes", () => {
    const script = workbenchSyntaxScript();

    expect(script).toContain("document.createTextNode");
    expect(script).toContain("span.textContent=token.text");
    expect(script).toContain("if(code.textContent!==source)");
    expect(script).not.toMatch(/https?:\/\//);
    expect(script).not.toContain("span.innerHTML");
  });
});

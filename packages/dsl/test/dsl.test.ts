import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentDslError, compileAgentDsl, parseAgentDsl, validateAgentDsl } from "../src/index.js";
import { validateContract } from "@synapsor/spec";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("@synapsor/dsl", () => {
  it("parses context, read/proposal capabilities, and workflow", () => {
    const source = fs.readFileSync(path.join(packageRoot, "examples/billing-late-fee.synapsor"), "utf8");
    const ast = parseAgentDsl(source);
    expect(ast.contexts).toHaveLength(1);
    expect(ast.capabilities.map((capability) => capability.name)).toEqual([
      "billing.inspect_invoice",
      "billing.propose_late_fee_waiver",
    ]);
    expect(ast.workflows.map((workflow) => workflow.name)).toEqual(["billing.late_fee_review"]);
  });

  it("compiles to valid @synapsor/spec JSON", () => {
    const source = fs.readFileSync(path.join(packageRoot, "examples/billing-late-fee.synapsor"), "utf8");
    const contract = compileAgentDsl(source);
    const result = validateContract(contract);
    expect(result.errors).toEqual([]);
    expect(contract.capabilities[1]?.proposal?.patch).toMatchObject({
      late_fee_cents: { fixed: 0 },
      waiver_reason: { from_arg: "waiver_reason" },
    });
  });

  it("keeps kept-out fields out of visible fields", () => {
    const source = fs.readFileSync(path.join(packageRoot, "examples/billing-late-fee.synapsor"), "utf8");
    const contract = compileAgentDsl(source);
    expect(contract.capabilities[0]?.visible_fields).not.toContain("card_token");
    expect(contract.capabilities[0]?.kept_out_fields).toContain("card_token");
  });

  it("returns validation errors with line and column", () => {
    const result = validateAgentDsl("CREATE CAPABILITY billing.inspect_invoice\nROOT EXTERNAL app.invoices AS invoice\nEND\n");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({
      line: 2,
      column: 1,
      code: "UNSUPPORTED_PREVIEW_SYNTAX",
    });
  });

  it("throws AgentDslError for unsupported syntax", () => {
    expect(() => compileAgentDsl("CREATE AGENT WORKFLOW billing.flow\nAUTO MERGE\nEND\n")).toThrow(AgentDslError);
  });
});

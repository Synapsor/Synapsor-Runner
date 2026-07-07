import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentDslError, compileAgentDsl, compileAgentDslWithWarnings, parseAgentDsl, validateAgentDsl } from "../src/index.js";
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

  it("compiles reviewed model-facing metadata and patch guards", () => {
    const contract = compileAgentDsl(`
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY support.propose_plan_credit
  DESCRIPTION 'Propose a support credit for a verified outage impact.'
  RETURNS HINT 'Returns the proposal id and requested credit; DB unchanged.'
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.accounts
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP account_id BY id
  ARG account_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Account id.'
  ARG amount_cents NUMBER REQUIRED MIN 1 MAX 2500 DESCRIPTION 'Credit amount in cents.'
  ARG reason TEXT REQUIRED MAX LENGTH 500 DESCRIPTION 'Cite ticket and outage ids.'
  ARG next_status STRING REQUIRED MAX LENGTH 64 DESCRIPTION 'Reviewed account status.'
  ALLOW READ id, tenant_id, credit_requested_cents, credit_reason, status, updated_at
  REQUIRE EVIDENCE
  MAX ROWS 1
  PROPOSE ACTION grant_plan_credit
  ALLOW WRITE credit_requested_cents, credit_reason, status
  PATCH credit_requested_cents = ARG amount_cents
  PATCH credit_reason = ARG reason
  PATCH status = ARG next_status
  BOUND credit_requested_cents 1..2500
  TRANSITION status ALLOW pending -> approved|rejected
  APPROVAL ROLE local_reviewer
  WRITEBACK APP HANDLER EXECUTOR billing_app_handler
END
`);

    const capability = contract.capabilities[0];
    expect(capability?.description).toContain("support credit");
    expect(capability?.returns_hint).toContain("DB unchanged");
    expect(capability?.args.account_id).toMatchObject({ description: "Account id.", max_length: 128 });
    expect(capability?.args.amount_cents).toMatchObject({ description: "Credit amount in cents.", minimum: 1, maximum: 2500 });
    expect(capability?.args.reason).toMatchObject({ description: "Cite ticket and outage ids.", max_length: 500 });
    expect(capability?.proposal?.numeric_bounds).toEqual({ credit_requested_cents: { minimum: 1, maximum: 2500 } });
    expect(capability?.proposal?.transition_guards).toEqual({ status: { allowed: { pending: ["approved", "rejected"] } } });
    expect(capability?.proposal?.writeback).toEqual({ executor: "billing_app_handler", mode: "app_handler" });
  });

  it("warns instead of silently weakening proposal metadata", () => {
    const source = `
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  TENANT BINDING tenant_id
END

CREATE CAPABILITY support.propose_plan_credit
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.accounts
  PRIMARY KEY id
  TENANT KEY tenant_id
  LOOKUP account_id BY id
  ARG account_id STRING REQUIRED MAX LENGTH 128
  ARG amount_cents NUMBER REQUIRED
  ALLOW READ id, tenant_id, credit_requested_cents, updated_at
  PROPOSE ACTION grant_plan_credit
  ALLOW WRITE credit_requested_cents
  PATCH credit_requested_cents = ARG amount_cents
  WRITEBACK NONE
END
`;
    const result = compileAgentDslWithWarnings(source);
    expect(result.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "DESCRIPTION_RECOMMENDED",
      "RETURNS_HINT_RECOMMENDED",
      "NUMERIC_PATCH_BOUND_RECOMMENDED",
    ]));

    const validation = validateAgentDsl(source);
    expect(validation.ok).toBe(true);
    expect(validation.warnings.map((warning) => warning.code)).toContain("NUMERIC_PATCH_BOUND_RECOMMENDED");
  });

  it("rejects numeric bounds on non-number args", () => {
    expect(() => compileAgentDsl(`
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  TENANT BINDING tenant_id
END

CREATE CAPABILITY support.inspect_account
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.accounts
  PRIMARY KEY id
  TENANT KEY tenant_id
  LOOKUP account_id BY id
  ARG account_id STRING REQUIRED MIN 1
  ALLOW READ id, tenant_id
END
`)).toThrow(/MIN is only valid for NUMBER/);
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

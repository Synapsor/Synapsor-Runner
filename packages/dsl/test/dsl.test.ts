import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentDslError, compileAgentDsl, compileAgentDslWithWarnings, formatAgentDsl, parseAgentDsl, validateAgentDsl } from "../src/index.js";
import { validateContract } from "@synapsor/spec";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");

describe("@synapsor/dsl", () => {
  it("rejects LOOKUP columns that differ from the declared primary key", () => {
    const invalid = fs.readFileSync(path.join(packageRoot, "fixtures/invalid/non-primary-lookup.synapsor.sql"), "utf8");
    const result = validateAgentDsl(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "LOOKUP_COLUMN_UNSUPPORTED",
        message: expect.stringContaining("PRIMARY KEY id"),
      }),
    ]));
    expect(() => compileAgentDsl(invalid)).toThrow(AgentDslError);
  });

  it("parses context, read/proposal capabilities, and workflow", () => {
    const source = fs.readFileSync(path.join(packageRoot, "examples/billing-late-fee.synapsor.sql"), "utf8");
    const ast = parseAgentDsl(source);
    expect(ast.contexts).toHaveLength(1);
    expect(ast.capabilities.map((capability) => capability.name)).toEqual([
      "billing.inspect_invoice",
      "billing.propose_late_fee_waiver",
    ]);
    expect(ast.workflows.map((workflow) => workflow.name)).toEqual(["billing.late_fee_review"]);
  });

  it("compiles to valid @synapsor/spec JSON", () => {
    const source = fs.readFileSync(path.join(packageRoot, "examples/billing-late-fee.synapsor.sql"), "utf8");
    const contract = compileAgentDsl(source);
    const result = validateContract(contract);
    expect(result.errors).toEqual([]);
    expect(contract.capabilities[1]?.proposal?.patch).toMatchObject({
      late_fee_cents: { fixed: 0 },
      waiver_reason: { from_arg: "waiver_reason" },
    });
  });

  it("keeps kept-out fields out of visible fields", () => {
    const source = fs.readFileSync(path.join(packageRoot, "examples/billing-late-fee.synapsor.sql"), "utf8");
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

  it("compiles AUTO APPROVE WHEN into an approval policy", () => {
    const contract = compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN plan_credit_cents <= 2500
  WRITEBACK DIRECT SQL
`));

    const capability = contract.capabilities[0];
    expect(capability?.proposal?.approval).toEqual({
      mode: "policy",
      required_role: "support_reviewer",
      policy: "support_propose_plan_credit_auto_approval",
    });
    expect(contract.policies).toEqual([
      {
        name: "support_propose_plan_credit_auto_approval",
        kind: "approval",
        mode: "green",
        rules: [{ field: "plan_credit_cents", max: 2500 }],
      },
    ]);
    expect(validateContract(contract).errors).toEqual([]);
  });

  it("compiles small-team approval quorum into the canonical contract", () => {
    const contract = compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  REQUIRE 2 APPROVALS
  WRITEBACK DIRECT SQL
`));

    expect(contract.capabilities[0]?.proposal?.approval).toEqual({
      mode: "human",
      required_role: "support_reviewer",
      required_approvals: 2,
    });
    expect(validateContract(contract).errors).toEqual([]);
    expect(() => compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  REQUIRE 11 APPROVALS
  WRITEBACK DIRECT SQL
`))).toThrow(/INVALID_REQUIRED_APPROVALS/);
  });

  it("compiles daily aggregate auto-approval limits into the canonical policy", () => {
    const contract = compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN plan_credit_cents <= 2500
  LIMIT 20 PER DAY
  LIMIT TOTAL 100000 PER DAY
  WRITEBACK DIRECT SQL
`));

    expect(contract.policies?.[0]).toMatchObject({
      name: "support_propose_plan_credit_auto_approval",
      limits: [
        { kind: "count", max: 20, period: "day", scope: "tenant_policy" },
        { kind: "total", field: "plan_credit_cents", max: 100000, period: "day", scope: "tenant_policy" },
      ],
    });
    expect(validateContract(contract).errors).toEqual([]);
  });

  it("supports per-object daily limits and rejects ambiguous or misplaced limits", () => {
    const contract = compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN plan_credit_cents <= 2500
  LIMIT 3 PER OBJECT DAY
  LIMIT TOTAL 5000 PER OBJECT DAY
  WRITEBACK DIRECT SQL
`));
    expect(contract.policies?.[0]?.limits).toEqual([
      { kind: "count", max: 3, period: "day", scope: "tenant_policy_object" },
      { kind: "total", field: "plan_credit_cents", max: 5000, period: "day", scope: "tenant_policy_object" },
    ]);

    expect(() => compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  LIMIT 20 PER DAY
  AUTO APPROVE WHEN plan_credit_cents <= 2500
  WRITEBACK DIRECT SQL
`))).toThrow(/AUTO_APPROVAL_LIMIT_POLICY_REQUIRED/);
    expect(() => compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN plan_credit_cents <= 2500
  LIMIT TOTAL nope PER DAY
  WRITEBACK DIRECT SQL
`))).toThrow(/AUTO_APPROVAL_LIMIT_UNSUPPORTED/);
  });

  it("compiles explicit UPDATE version advancement", () => {
    const contract = compileAgentDsl(planCreditSource(`
  PROPOSE ACTION grant_plan_credit UPDATE
  ALLOW WRITE plan_credit_cents, credit_reason
  PATCH plan_credit_cents = ARG credit_cents
  PATCH credit_reason = ARG reason
  BOUND plan_credit_cents 1..50000
  ADVANCE VERSION updated_at USING DATABASE GENERATED
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
`, true));

    expect(contract.capabilities[0]?.proposal?.operation).toEqual({
      kind: "update",
      version_advance: { column: "updated_at", strategy: "database_generated" },
    });
  });

  it("compiles guarded INSERT deduplication and guarded DELETE", () => {
    const insert = compileAgentDsl(crudSource(`
  PROPOSE ACTION create_credit INSERT
  DEDUP KEY tenant_id = TRUSTED TENANT, request_id = PROPOSAL ID
  ALLOW WRITE amount_cents, reason
  PATCH amount_cents = ARG amount_cents
  PATCH reason = ARG reason
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
`));
    expect(insert.capabilities[0]?.proposal?.operation).toEqual({
      kind: "insert",
      deduplication: {
        components: [
          { column: "tenant_id", source: "trusted_tenant" },
          { column: "request_id", source: "proposal_id" },
        ],
      },
    });

    const deletion = compileAgentDsl(crudSource(`
  PROPOSE ACTION delete_credit DELETE
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
`));
    expect(deletion.capabilities[0]?.proposal).toMatchObject({
      operation: { kind: "delete" },
      allowed_fields: [],
      patch: {},
    });
  });

  it("compiles REVERSIBLE into reviewed inverse authority", () => {
    const contract = compileAgentDsl(crudSource(`
  PROPOSE ACTION adjust_credit UPDATE
  ALLOW WRITE amount_cents, reason
  PATCH amount_cents = ARG amount_cents
  PATCH reason = ARG reason
  ADVANCE VERSION updated_at USING INTEGER INCREMENT
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
  REVERSIBLE
`));

    expect(contract.capabilities[0]?.proposal?.reversibility).toEqual({ mode: "reviewed_inverse" });
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects REVERSIBLE when writeback, approval, or version guards are weaker", () => {
    expect(() => compileAgentDsl(crudSource(`
  PROPOSE ACTION adjust_credit UPDATE
  ALLOW WRITE amount_cents
  PATCH amount_cents = ARG amount_cents
  ADVANCE VERSION updated_at USING DATABASE GENERATED
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
  REVERSIBLE
`))).toThrow(/REVERSIBILITY_INTEGER_VERSION_REQUIRED/);
    expect(() => compileAgentDsl(crudSource(`
  PROPOSE ACTION adjust_credit UPDATE
  ALLOW WRITE amount_cents
  PATCH amount_cents = ARG amount_cents
  ADVANCE VERSION updated_at USING INTEGER INCREMENT
  APPROVAL ROLE support_reviewer
  WRITEBACK APP HANDLER EXECUTOR app_handler
  REVERSIBLE
`))).toThrow(/REVERSIBILITY_DIRECT_SQL_REQUIRED/);
  });

  it("rejects unsafe INSERT and DELETE operation syntax", () => {
    expect(() => compileAgentDsl(crudSource(`
  PROPOSE ACTION create_credit INSERT
  ALLOW WRITE amount_cents
  PATCH amount_cents = ARG amount_cents
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
`))).toThrow(/INSERT_DEDUP_KEY_REQUIRED/);
    expect(() => compileAgentDsl(crudSource(`
  PROPOSE ACTION delete_credit DELETE
  ALLOW WRITE reason
  PATCH reason = ARG reason
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
`))).toThrow(/DELETE_PATCH_FORBIDDEN/);
  });

  it("compiles fixed bounded-set UPDATE and exact-review batch INSERT", () => {
    const update = compileAgentDsl(crudSource(`
  PROPOSE ACTION close_overdue UPDATE SET
  SELECT WHERE status = 'overdue'
  MAX ROWS 10
  MAX TOTAL balance_cents BEFORE 50000
  ALLOW WRITE status
  PATCH status = 'closed'
  ADVANCE VERSION updated_at USING INTEGER INCREMENT
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
`));
    expect(update.capabilities[0]?.proposal?.operation).toMatchObject({
      kind: "update",
      cardinality: "set",
      selection: { all: [{ column: "status", operator: "eq", value: "overdue" }] },
      max_rows: 10,
      aggregate_bounds: [{ column: "balance_cents", measure: "before", maximum: 50000 }],
    });

    const batch = compileAgentDsl(`
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END
CREATE CAPABILITY support.create_credits
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.account_credits
  PRIMARY KEY id
  TENANT KEY tenant_id
  ARG items ROWS MAX 10 REQUIRED
  ITEM FIELD items.id STRING REQUIRED MAX LENGTH 128
  ITEM FIELD items.external_id STRING REQUIRED MAX LENGTH 128
  ITEM FIELD items.amount_cents NUMBER REQUIRED MIN 1 MAX 2500
  ITEM FIELD items.reason STRING REQUIRED MAX LENGTH 500
  ALLOW READ id, tenant_id, external_id, amount_cents, reason, version
  KEEP OUT internal_note
  REQUIRE EVIDENCE
  PROPOSE ACTION create_credits INSERT SET
  BATCH ITEMS FROM ARG items
  MAX ROWS 10
  MAX TOTAL amount_cents AFTER 25000
  DEDUP KEY tenant_id = TRUSTED TENANT, id = ITEM id, external_id = ITEM external_id
  ALLOW WRITE amount_cents, reason
  PATCH amount_cents = ITEM amount_cents
  PATCH reason = ITEM reason
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
END
`);
    expect(batch.capabilities[0]?.args.items).toMatchObject({ type: "object_array", max_items: 10 });
    expect(batch.capabilities[0]?.proposal?.operation).toMatchObject({
      kind: "insert",
      cardinality: "set",
      batch: { items_from_arg: "items" },
      deduplication: { components: expect.arrayContaining([{ column: "external_id", source: "item_field", item_field: "external_id" }]) },
    });
    expect(batch.capabilities[0]?.proposal?.patch).toEqual({ amount_cents: { from_item: "amount_cents" }, reason: { from_item: "reason" } });
  });

  it("compiles every reviewed SELECT WHERE equality term instead of swallowing AND into a value", () => {
    const contract = compileAgentDsl(boundedSetSelectionSource("risk_level = 'high' AND case_status = 'active'"));
    expect(contract.capabilities[0]?.proposal?.operation?.selection).toEqual({
      all: [
        { column: "risk_level", operator: "eq", value: "high" },
        { column: "case_status", operator: "eq", value: "active" },
      ],
    });
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
  });

  it("preserves term order and supported mixed literal types", () => {
    const contract = compileAgentDsl(boundedSetSelectionSource("risk_level = 'high' AND severity = 7 AND readmit_risk_score = 7.5 AND escalated = TRUE AND needs_review = FALSE AND archived_at = NULL"));
    expect(contract.capabilities[0]?.proposal?.operation?.selection?.all).toEqual([
      { column: "risk_level", operator: "eq", value: "high" },
      { column: "severity", operator: "eq", value: 7 },
      { column: "readmit_risk_score", operator: "eq", value: 7.5 },
      { column: "escalated", operator: "eq", value: true },
      { column: "needs_review", operator: "eq", value: false },
      { column: "archived_at", operator: "eq", value: null },
    ]);
  });

  it("compiles three equality terms in their reviewed order", () => {
    const contract = compileAgentDsl(boundedSetSelectionSource("risk_level = 'high' AND case_status = 'active' AND escalated = TRUE"));
    expect(contract.capabilities[0]?.proposal?.operation?.selection?.all).toEqual([
      { column: "risk_level", operator: "eq", value: "high" },
      { column: "case_status", operator: "eq", value: "active" },
      { column: "escalated", operator: "eq", value: true },
    ]);
  });

  it.each([
    ["description = 'salt AND pepper'", "salt AND pepper"],
    ["description = 'candy and spice'", "candy and spice"],
    ["description = 'O''Brien AND active'", "O''Brien AND active"],
  ])("keeps AND inside the quoted literal in %s", (selection, expected) => {
    const contract = compileAgentDsl(boundedSetSelectionSource(selection));
    expect(contract.capabilities[0]?.proposal?.operation?.selection?.all).toEqual([
      { column: "description", operator: "eq", value: expected },
    ]);
  });

  it("accepts legal whitespace and case-insensitive AND separators", () => {
    const contract = compileAgentDsl(boundedSetSelectionSource("risk_level='high'   aNd   case_status = 'active'"));
    expect(contract.capabilities[0]?.proposal?.operation?.selection?.all).toEqual([
      { column: "risk_level", operator: "eq", value: "high" },
      { column: "case_status", operator: "eq", value: "active" },
    ]);
  });

  it("keeps multi-term semantics stable across formatting and equivalent whitespace", () => {
    const source = boundedSetSelectionSource("risk_level = 'high' AND case_status = 'active'");
    const compact = boundedSetSelectionSource("risk_level='high' aNd case_status='active'");
    const expected = compileAgentDsl(source);
    const formatted = compileAgentDsl(formatAgentDsl(source));
    const compacted = compileAgentDsl(compact);
    const digest = (contract: unknown) => crypto.createHash("sha256").update(JSON.stringify(contract)).digest("hex");
    expect(formatted).toEqual(expected);
    expect(compacted).toEqual(expected);
    expect(digest(formatted)).toBe(digest(expected));
    expect(digest(compacted)).toBe(digest(expected));
  });

  it.each([
    ["risk_level = 'high' AND", "SELECT_WHERE_SYNTAX"],
    ["AND risk_level = 'high'", "SELECT_WHERE_SYNTAX"],
    ["risk_level = 'high' AND AND case_status = 'active'", "SELECT_WHERE_SYNTAX"],
    ["risk_level = 'high", "SELECT_WHERE_UNTERMINATED_STRING"],
    ["= 'high'", "SELECT_WHERE_SYNTAX"],
    ["risk_level 'high'", "SELECT_WHERE_SYNTAX"],
    ["risk_level =", "SELECT_WHERE_SYNTAX"],
    ["risk_level = 'high' OR case_status = 'active'", "SELECT_WHERE_UNSUPPORTED"],
    ["(risk_level = 'high')", "SELECT_WHERE_UNSUPPORTED"],
    ["risk_level != 'high'", "SELECT_WHERE_UNSUPPORTED"],
    ["severity >= 7", "SELECT_WHERE_UNSUPPORTED"],
    ["risk_level = 'high' trailing", "SELECT_WHERE_UNSUPPORTED"],
  ])("rejects malformed or unsupported SELECT WHERE clause: %s", (selection, code) => {
    const result = validateAgentDsl(boundedSetSelectionSource(selection));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ code, line: 20 });
    expect(result.errors[0]?.column).toBeGreaterThan(1);
    expect(() => compileAgentDsl(boundedSetSelectionSource(selection))).toThrow(AgentDslError);
  });

  it("rejects more fixed terms than the canonical bounded-set ceiling", () => {
    const selection = Array.from({ length: 9 }, (_, index) => `term_${index + 1} = ${index + 1}`).join(" AND ");
    const result = validateAgentDsl(boundedSetSelectionSource(selection));
    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "SELECT_WHERE_TERM_COUNT", line: 20 })],
    });
  });

  it("rejects bounded sets without fixed selection, value cap, or human approval", () => {
    expect(() => compileAgentDsl(crudSource(`
  PROPOSE ACTION close_overdue UPDATE SET
  MAX ROWS 10
  ALLOW WRITE status
  PATCH status = 'closed'
  ADVANCE VERSION updated_at USING DATABASE GENERATED
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
`))).toThrow(/SET_AGGREGATE_BOUND_REQUIRED/);
    expect(() => compileAgentDsl(crudSource(`
  PROPOSE ACTION close_overdue UPDATE SET
  SELECT WHERE status = 'overdue'
  MAX ROWS 10
  MAX TOTAL balance_cents BEFORE 50000
  ALLOW WRITE status
  PATCH status = 'closed'
  ADVANCE VERSION version USING INTEGER INCREMENT
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN status <= 1
  WRITEBACK DIRECT SQL
`))).toThrow();
  });

  it("rejects AUTO APPROVE WHEN before APPROVAL ROLE", () => {
    expect(() => compileAgentDsl(planCreditSource(`
  AUTO APPROVE WHEN plan_credit_cents <= 2500
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
`))).toThrow(/AUTO_APPROVE_APPROVAL_ROLE_REQUIRED/);
  });

  it("rejects unsupported AUTO APPROVE comparisons and non-integer values", () => {
    expect(() => compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN plan_credit_cents < 2500
  WRITEBACK DIRECT SQL
`))).toThrow(/AUTO_APPROVE_UNSUPPORTED/);
    expect(() => compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN plan_credit_cents <= -1
  WRITEBACK DIRECT SQL
`))).toThrow(/AUTO_APPROVE_MAX_INVALID/);
    expect(() => compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN plan_credit_cents <= 25.5
  WRITEBACK DIRECT SQL
`))).toThrow(/AUTO_APPROVE_MAX_INVALID/);
  });

  it("rejects AUTO APPROVE WHEN fields that are missing, non-numeric, duplicated, or above bounds", () => {
    expect(() => compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN missing_field <= 2500
  WRITEBACK DIRECT SQL
`))).toThrow(/AUTO_APPROVE_FIELD_NOT_PATCHED/);
    expect(() => compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN credit_reason <= 2500
  WRITEBACK DIRECT SQL
`))).toThrow(/AUTO_APPROVE_FIELD_NOT_NUMERIC/);
    expect(() => compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN plan_credit_cents <= 2500
  AUTO APPROVE WHEN plan_credit_cents <= 1000
  WRITEBACK DIRECT SQL
`))).toThrow(/AUTO_APPROVE_DUPLICATE_FIELD/);
    expect(() => compileAgentDsl(planCreditSource(`
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN plan_credit_cents <= 50001
  WRITEBACK DIRECT SQL
`))).toThrow(/AUTO_APPROVE_MAX_EXCEEDS_BOUND/);
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

  it("compiles typed ENUM arguments in deterministic reviewed order", () => {
    const contract = compileAgentDsl(enumArgumentSource([
      "ARG risk_level STRING ENUM('low', 'medium', 'high') REQUIRED",
      "ARG retry_count NUMBER ENUM(0, 1, 2) REQUIRED",
      "ARG notify BOOLEAN ENUM(TRUE, FALSE) REQUIRED",
    ].join("\n  ")));
    expect(contract.capabilities[0]?.args).toMatchObject({
      risk_level: { type: "string", enum: ["low", "medium", "high"] },
      retry_count: { type: "number", enum: [0, 1, 2] },
      notify: { type: "boolean", enum: [true, false] },
    });
  });

  it("rejects empty, duplicate, mixed, null, and incompatible ENUM values", () => {
    expect(() => compileAgentDsl(enumArgumentSource("ARG risk_level STRING ENUM() REQUIRED"))).toThrow(/ARG_ENUM_EMPTY/);
    expect(() => compileAgentDsl(enumArgumentSource("ARG risk_level NUMBER ENUM(1, 1.0) REQUIRED"))).toThrow(/ARG_ENUM_DUPLICATE_VALUE/);
    expect(() => compileAgentDsl(enumArgumentSource("ARG risk_level STRING ENUM('low', 2) REQUIRED"))).toThrow(/ARG_ENUM_TYPE_MISMATCH/);
    expect(() => compileAgentDsl(enumArgumentSource("ARG risk_level STRING ENUM(NULL) REQUIRED"))).toThrow(/ARG_ENUM_NULL_UNSUPPORTED/);
    expect(() => compileAgentDsl(enumArgumentSource("ARG risk_level BOOLEAN ENUM('true') REQUIRED"))).toThrow(/ARG_ENUM_TYPE_MISMATCH/);
  });

  it("compiles bounded aggregate reads with fixed selection and no row-facing arguments", () => {
    const contract = compileAgentDsl(aggregateReadSource("AGGREGATE READ SUM balance_cents", "SELECT WHERE status = 'overdue' AND region = 'west'"));
    expect(contract.capabilities[0]).toMatchObject({
      kind: "aggregate_read",
      args: {},
      visible_fields: [],
      aggregate: {
        function: "sum",
        column: "balance_cents",
        minimum_group_size: 5,
        selection: { all: [
          { column: "status", operator: "eq", value: "overdue" },
          { column: "region", operator: "eq", value: "west" },
        ] },
      },
    });
    expect(validateContract(contract).errors).toEqual([]);
  });

  it("rejects aggregate reads without suppression or with model-controlled predicates", () => {
    expect(() => compileAgentDsl(aggregateReadSource("AGGREGATE READ COUNT ROWS", "", false))).toThrow(/AGGREGATE_MINIMUM_GROUP_SIZE_REQUIRED/);
    expect(() => compileAgentDsl(aggregateReadSource("AGGREGATE READ AVG balance_cents", "ARG minimum NUMBER REQUIRED MIN 0"))).toThrow(/AGGREGATE_MODEL_ARGS_FORBIDDEN/);
  });

  it("throws AgentDslError for unsupported syntax", () => {
    expect(() => compileAgentDsl("CREATE AGENT WORKFLOW billing.flow\nAUTO MERGE\nEND\n")).toThrow(AgentDslError);
  });

  it("keeps the support-plan-credit example JSON in sync with its DSL source", () => {
    const source = fs.readFileSync(path.join(repoRoot, "examples/support-plan-credit/contract.synapsor.sql"), "utf8");
    const committed = JSON.parse(fs.readFileSync(path.join(repoRoot, "examples/support-plan-credit/synapsor.contract.json"), "utf8"));
    const result = compileAgentDslWithWarnings(source);
    expect(result.warnings).toEqual([]);
    expect(result.contract).toEqual(committed);
    expect(validateContract(result.contract).errors).toEqual([]);
  });
});

function planCreditSource(proposalTail: string, replaceProposal = false): string {
  return `
CREATE AGENT CONTEXT support_agent_context
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY support.propose_plan_credit
  DESCRIPTION 'Propose a bounded plan credit.'
  RETURNS HINT 'Returns proposal id; DB unchanged.'
  USING CONTEXT support_agent_context
  SOURCE local_postgres
  ON public.customers
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP customer_id BY id
  ARG customer_id STRING REQUIRED MAX LENGTH 128
  ARG credit_cents NUMBER REQUIRED MIN 1 MAX 50000
  ARG reason TEXT REQUIRED MAX LENGTH 500
  ALLOW READ id, tenant_id, plan_credit_cents, credit_reason, updated_at
  REQUIRE EVIDENCE
  MAX ROWS 1
${replaceProposal ? "" : `  PROPOSE ACTION grant_plan_credit
  ALLOW WRITE plan_credit_cents, credit_reason
  PATCH plan_credit_cents = ARG credit_cents
  PATCH credit_reason = ARG reason
  BOUND plan_credit_cents 1..50000`}
${proposalTail.trimEnd()}
END
`;
}

function enumArgumentSource(argumentsSource: string): string {
  return `
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  TENANT BINDING tenant_id
END

CREATE CAPABILITY support.inspect_risk
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.accounts
  PRIMARY KEY id
  TENANT KEY tenant_id
  LOOKUP account_id BY id
  ARG account_id STRING REQUIRED MAX LENGTH 128
  ${argumentsSource}
  ALLOW READ id, tenant_id, risk_level
  KEEP OUT private_notes
  REQUIRE EVIDENCE
END
`;
}

function aggregateReadSource(aggregateClause: string, extraClause: string, includeMinimum = true): string {
  return `
CREATE AGENT CONTEXT finance_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY billing.aggregate_overdue
  DESCRIPTION 'Return one suppressed aggregate over a reviewer-fixed tenant set.'
  RETURNS HINT 'Returns one aggregate scalar or a suppression result; never member rows.'
  USING CONTEXT finance_operator
  SOURCE local_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  ${aggregateClause}
  ${extraClause}
  ${includeMinimum ? "MIN GROUP SIZE 5" : ""}
  KEEP OUT customer_email, private_notes
  REQUIRE EVIDENCE
END
`;
}

function crudSource(proposalBody: string): string {
  return `
CREATE AGENT CONTEXT support_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY support.mutate_credit
  USING CONTEXT support_operator
  SOURCE local_postgres
  ON public.credits
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP credit_id BY id
  ARG credit_id STRING REQUIRED MAX LENGTH 128
  ARG amount_cents NUMBER REQUIRED MIN 1 MAX 50000
  ARG reason TEXT REQUIRED MAX LENGTH 500
  ALLOW READ id, tenant_id, amount_cents, reason, status, balance_cents, updated_at
  REQUIRE EVIDENCE
  MAX ROWS 1
${proposalBody.trimEnd()}
END
`;
}

function boundedSetSelectionSource(selection: string): string {
  return `
CREATE AGENT CONTEXT health_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY health.flag_cases
  USING CONTEXT health_operator
  SOURCE local_postgres
  ON public.cases
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD version
  ARG reason STRING REQUIRED MAX LENGTH 128
  ALLOW READ id, tenant_id, risk_level, case_status, description, severity, readmit_risk_score, escalated, needs_review, archived_at, version
  REQUIRE EVIDENCE
  PROPOSE ACTION flag UPDATE SET
  SELECT WHERE ${selection}
  MAX ROWS 25
  MAX TOTAL readmit_risk_score BEFORE 1000
  ALLOW WRITE needs_review
  PATCH needs_review = TRUE
  ADVANCE VERSION version USING INTEGER INCREMENT
  APPROVAL ROLE health_reviewer
  WRITEBACK DIRECT SQL
END
`;
}

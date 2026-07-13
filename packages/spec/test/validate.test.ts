import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertValidContract, normalizeContract, validateContract } from "../src/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, relativePath), "utf8"));
}

describe("@synapsor/spec validation", () => {
  it("accepts checked-in examples", () => {
    for (const file of fs.readdirSync(path.join(packageRoot, "examples")).filter((name) => name.endsWith(".json"))) {
      const result = validateContract(readJson(`examples/${file}`));
      expect(result.errors, file).toEqual([]);
      expect(result.ok, file).toBe(true);
    }
  });

  it("loads checked-in JSON Schema files", () => {
    for (const file of fs.readdirSync(path.join(packageRoot, "schemas")).filter((name) => name.endsWith(".json"))) {
      const schema = readJson(`schemas/${file}`);
      expect(schema, file).toMatchObject({ $schema: expect.any(String) });
    }
  });

  it("accepts valid fixtures", () => {
    const result = validateContract(readJson("fixtures/valid/basic-read.contract.json"));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects model-controlled tenant args", () => {
    const result = validateContract(readJson("fixtures/invalid/model-controlled-tenant.contract.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("MODEL_CONTROLLED_TRUST_ARG");
  });

  it("rejects kept-out fields that are also visible", () => {
    const result = validateContract(readJson("fixtures/invalid/kept-out-visible.contract.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("KEPT_OUT_FIELD_VISIBLE");
  });

  it("normalizes deterministically", () => {
    const input = readJson("examples/guarded-writeback.contract.json");
    const first = normalizeContract(input);
    const second = normalizeContract(JSON.parse(JSON.stringify(first)));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("throws useful assertion errors", () => {
    expect(() => assertValidContract({})).toThrow(/UNSUPPORTED_SPEC_VERSION/);
  });

  it("validates conformance contracts", () => {
    const conformanceRoot = path.join(packageRoot, "fixtures/conformance");
    for (const fixture of fs.readdirSync(conformanceRoot)) {
      const contractPath = path.join(conformanceRoot, fixture, "contract.json");
      if (!fs.existsSync(contractPath)) continue;
      const result = validateContract(JSON.parse(fs.readFileSync(contractPath, "utf8")));
      expect(result.errors, fixture).toEqual([]);
      expect(result.ok, fixture).toBe(true);
    }
  });

  it("accepts and normalizes portable proposal safety fields", () => {
    const normalized = normalizeContract(readJson("fixtures/conformance/numeric-bounds/contract.json"));
    const capability = normalized.capabilities.find((item) => item.name === "support.propose_plan_credit");

    expect(capability?.returns_hint).toContain("DB unchanged");
    expect(capability?.args.amount_cents).toMatchObject({
      description: "Credit amount in cents.",
      minimum: 1,
      maximum: 1000000,
    });
    expect(capability?.args.reason).toMatchObject({
      description: "Business reason for the credit.",
      max_length: 500,
    });
    expect(capability?.proposal?.numeric_bounds).toEqual({
      credit_requested_cents: { minimum: 1, maximum: 2500 },
    });
  });

  it("still rejects unknown core fields", () => {
    const contract = readJson("fixtures/conformance/numeric-bounds/contract.json") as Record<string, unknown>;
    const capabilities = contract.capabilities as Array<Record<string, unknown>>;
    capabilities[0].unexpected_core_field = true;

    const result = validateContract(contract);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("UNKNOWN_CORE_FIELD");
  });

  it("keeps omitted operation semantics backward-compatible with UPDATE", () => {
    const contract = readJson("examples/guarded-writeback.contract.json") as Record<string, any>;
    expect(contract.capabilities[1].proposal.operation).toBeUndefined();
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
  });

  it("accepts guarded INSERT with source-enforced proposal deduplication", () => {
    const contract = writeContract();
    const proposal = contract.capabilities[1].proposal;
    proposal.action = "billing.create_credit";
    proposal.operation = {
      kind: "insert",
      deduplication: {
        components: [
          { column: "tenant_id", source: "trusted_tenant" },
          { column: "request_id", source: "proposal_id" },
        ],
      },
    };
    proposal.allowed_fields = ["amount_cents", "reason"];
    proposal.patch = { amount_cents: { fixed: 500 }, reason: { from_arg: "waiver_reason" } };
    delete proposal.conflict_guard;

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects INSERT without proposal-specific source deduplication", () => {
    const contract = writeContract();
    const proposal = contract.capabilities[1].proposal;
    proposal.operation = {
      kind: "insert",
      deduplication: { components: [{ column: "tenant_id", source: "trusted_tenant" }] },
    };

    const codes = validateContract(contract).errors.map((error) => error.code);
    expect(codes).toContain("PROPOSAL_DEDUPLICATION_REQUIRED");
  });

  it("accepts guarded DELETE without a patch and rejects weak DELETE guards", () => {
    const contract = writeContract();
    const proposal = contract.capabilities[1].proposal;
    proposal.action = "billing.delete_credit";
    proposal.operation = { kind: "delete" };
    proposal.allowed_fields = [];
    proposal.patch = {};

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });

    proposal.conflict_guard = { weak_guard_ack: true };
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("DELETE_CONFLICT_GUARD_REQUIRED");
  });

  it("rejects policy auto-approval for direct hard DELETE", () => {
    const contract = writeContract();
    const proposal = contract.capabilities[1].proposal;
    proposal.action = "billing.delete_credit";
    proposal.operation = { kind: "delete" };
    proposal.allowed_fields = [];
    proposal.patch = {};
    proposal.approval = { mode: "policy", role: "support_lead", policy: "low_risk_waiver" };

    expect(validateContract(contract).errors.map((error) => error.code)).toContain("HARD_DELETE_HUMAN_APPROVAL_REQUIRED");
  });

  it("validates UPDATE version advancement against its conflict guard", () => {
    const contract = writeContract();
    const proposal = contract.capabilities[1].proposal;
    proposal.operation = {
      kind: "update",
      version_advance: { column: "updated_at", strategy: "database_generated" },
    };
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });

    proposal.operation.version_advance.column = "other_version";
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("VERSION_ADVANCE_GUARD_MISMATCH");
  });

  it("accepts reviewed reversible UPDATE and rejects weakened compensation authority", () => {
    const contract = writeContract();
    const capability = contract.capabilities[1];
    capability.subject.conflict_key = "version";
    capability.visible_fields = [...capability.visible_fields.filter((field: string) => field !== "updated_at"), "version"];
    capability.proposal.conflict_guard = { column: "version" };
    capability.proposal.operation = { kind: "update", version_advance: { column: "version", strategy: "integer_increment" } };
    capability.proposal.reversibility = { mode: "reviewed_inverse" };

    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });

    capability.proposal.approval = { mode: "policy", policy: "small_credit" };
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("REVERSIBILITY_HUMAN_APPROVAL_REQUIRED");
    capability.proposal.approval = { mode: "human", required_role: "reviewer" };
    capability.proposal.writeback = { mode: "app_handler", executor: "billing_handler" };
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("REVERSIBILITY_DIRECT_SQL_REQUIRED");
  });

  it("requires deterministic primary-key authority for reversible INSERT", () => {
    const contract = writeContract();
    const capability = contract.capabilities[1];
    capability.proposal.action = "billing.create_credit";
    capability.proposal.allowed_fields = ["late_fee_cents", "waiver_reason"];
    capability.proposal.conflict_guard = undefined;
    capability.proposal.operation = {
      kind: "insert",
      deduplication: { components: [
        { column: "tenant_id", source: "trusted_tenant" },
        { column: "request_id", source: "proposal_id" },
      ] },
    };
    capability.proposal.reversibility = { mode: "reviewed_inverse" };

    expect(validateContract(contract).errors.map((error) => error.code)).toContain("REVERSIBILITY_PRIMARY_KEY_DEDUP_REQUIRED");
    capability.proposal.operation.deduplication.components.push({ column: "id", source: "proposal_id" });
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
  });

  it("accepts policy-based auto-approval contracts", () => {
    const result = validateContract(readJson("fixtures/conformance/auto-approval/contract.json"));

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts bounded approval quorum and rejects unsafe quorum values", () => {
    const contract = readJson("fixtures/conformance/manual-approval/contract.json") as Record<string, any>;
    contract.capabilities[0].proposal.approval.required_approvals = 2;
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });

    contract.capabilities[0].proposal.approval.required_approvals = 0;
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("INVALID_REQUIRED_APPROVALS");
    contract.capabilities[0].proposal.approval.required_approvals = 11;
    expect(validateContract(contract).errors.map((error) => error.code)).toContain("INVALID_REQUIRED_APPROVALS");
  });

  it("accepts reviewed aggregate auto-approval limits", () => {
    const contract = cloneAutoApprovalContract();
    (contract.policies as Array<Record<string, unknown>>)[0]!.limits = [
      { kind: "count", max: 20, period: "day", scope: "tenant_policy" },
      { kind: "total", field: "plan_credit_cents", max: 100000, period: "day", scope: "tenant_policy" },
    ];

    const result = validateContract(contract);

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects malformed aggregate auto-approval limits", () => {
    const contract = cloneAutoApprovalContract();
    (contract.policies as Array<Record<string, unknown>>)[0]!.limits = [
      { kind: "total", max: 100000, period: "week" },
      { kind: "count", field: "credit_requested_cents", max: -1, period: "day" },
    ];

    const result = validateContract(contract);
    const codes = result.errors.map((error) => error.code);

    expect(result.ok).toBe(false);
    expect(codes).toContain("APPROVAL_POLICY_TOTAL_FIELD_REQUIRED");
    expect(codes).toContain("INVALID_APPROVAL_POLICY_LIMIT_PERIOD");
    expect(codes).toContain("APPROVAL_POLICY_COUNT_FIELD_FORBIDDEN");
    expect(codes).toContain("INVALID_APPROVAL_POLICY_LIMIT_MAX");
  });

  it("rejects policy approval without a matching approval policy", () => {
    const contract = cloneAutoApprovalContract();
    delete ((contract.capabilities as Array<any>)[0].proposal.approval as Record<string, unknown>).policy;

    const missing = validateContract(contract);
    expect(missing.ok).toBe(false);
    expect(missing.errors.map((error) => error.code)).toContain("APPROVAL_POLICY_REQUIRED");

    ((contract.capabilities as Array<any>)[0].proposal.approval as Record<string, unknown>).policy = "missing_policy";
    const unknown = validateContract(contract);
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.map((error) => error.code)).toContain("UNKNOWN_APPROVAL_POLICY");
  });

  it("rejects policy approval references to non-approval policies", () => {
    const contract = cloneAutoApprovalContract();
    ((contract.policies as Array<any>)[0] as Record<string, unknown>).kind = "settlement";

    const result = validateContract(contract);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("APPROVAL_POLICY_KIND_REQUIRED");
  });

  it("rejects approval.policy unless approval.mode is policy", () => {
    const contract = cloneAutoApprovalContract();
    ((contract.capabilities as Array<any>)[0].proposal.approval as Record<string, unknown>).mode = "human";

    const result = validateContract(contract);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("APPROVAL_POLICY_MODE_REQUIRED");
  });

  it("rejects approval policy rule fields that are not numeric proposal fields", () => {
    const contract = cloneAutoApprovalContract();
    ((contract.policies as Array<any>)[0].rules as Array<Record<string, unknown>>)[0].field = "credit_reason";

    const result = validateContract(contract);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("APPROVAL_POLICY_FIELD_NOT_NUMERIC");
  });

  it("rejects approval policy max above numeric bounds", () => {
    const contract = cloneAutoApprovalContract();
    ((contract.policies as Array<any>)[0].rules as Array<Record<string, unknown>>)[0].max = 50001;

    const result = validateContract(contract);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("APPROVAL_POLICY_MAX_EXCEEDS_BOUND");
  });
});

function cloneAutoApprovalContract(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(readJson("fixtures/conformance/auto-approval/contract.json"))) as Record<string, unknown>;
}

function writeContract(): Record<string, any> {
  const contract = readJson("examples/guarded-writeback.contract.json") as Record<string, any>;
  contract.capabilities[1].subject = {
    schema: "public",
    table: "credits",
    primary_key: "id",
    tenant_key: "tenant_id",
    conflict_key: "updated_at",
  };
  return contract;
}

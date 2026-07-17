import { describe, expect, it } from "vitest";
import type { ArgumentSpec, CapabilitySpec, SynapsorContract } from "@synapsor/spec";
import {
  analyzeCapabilitySurface,
  CAPABILITY_SURFACE_DENSITY_REVIEW_THRESHOLD,
} from "./capability-surface-lint.js";

describe("capability surface fitness lint", () => {
  it("flags only high-signal un-enumerated query-style string arguments", () => {
    const generic = capability("billing.inspect_invoice", {
      filter: { type: "string", required: false, max_length: 200 },
      reason: { type: "string", required: false },
      query_mode: { type: "string", required: false },
    });
    const constrained = capability("billing.inspect_customer", {
      query: { type: "string", required: false, enum: ["active", "overdue"] },
    });
    const nested = capability("billing.inspect_payment", {
      requests: {
        type: "object_array",
        max_items: 2,
        fields: { where: { type: "string", required: false } },
      },
    });
    const result = analyzeCapabilitySurface(contract([generic, constrained, nested]));
    const findings = result.findings.filter((finding) => finding.code === "SURFACE_GENERIC_ARGUMENT");
    expect(findings.map((finding) => finding.details.argument)).toEqual(["filter", "where"]);
    expect(findings.map((finding) => finding.path)).toEqual([
      '$.capabilities[name="billing.inspect_invoice"].args.filter',
      '$.capabilities[name="billing.inspect_payment"].args.requests.fields.where',
    ]);
  });

  it("warns once only after the documented per-target density threshold", () => {
    const atThreshold = contract(Array.from(
      { length: CAPABILITY_SURFACE_DENSITY_REVIEW_THRESHOLD },
      (_, index) => capability(`billing.inspect_invoice_${index + 1}`),
    ));
    expect(analyzeCapabilitySurface(atThreshold).findings).not.toContainEqual(expect.objectContaining({ code: "SURFACE_TARGET_DENSITY" }));

    const aboveThreshold = contract([
      ...atThreshold.capabilities,
      capability(`billing.inspect_invoice_${CAPABILITY_SURFACE_DENSITY_REVIEW_THRESHOLD + 1}`),
    ]);
    const result = analyzeCapabilitySurface(aboveThreshold);
    const findings = result.findings.filter((finding) => finding.code === "SURFACE_TARGET_DENSITY");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.details).toMatchObject({
      capability_count: CAPABILITY_SURFACE_DENSITY_REVIEW_THRESHOLD + 1,
      review_threshold: CAPABILITY_SURFACE_DENSITY_REVIEW_THRESHOLD,
      target: "local_postgres:public.invoices",
    });
    expect(result.summary.targets).toEqual([expect.objectContaining({ density_warning: true })]);
  });

  it("uses a conservative business-operation naming heuristic", () => {
    const result = analyzeCapabilitySurface(contract([
      capability("billing.execute"),
      capability("billing.customer_profile"),
      capability("billing.run_query"),
      capability("billing.inspect_invoice"),
      capability("billing.customer_lookup"),
      capability("billing.closeSupportTicket"),
      capability("billing.propose_plan_credit"),
    ]));
    expect(result.findings
      .filter((finding) => finding.code === "SURFACE_OPERATION_NAMING")
      .map((finding) => finding.details.capability)).toEqual([
      "billing.customer_profile",
      "billing.execute",
      "billing.run_query",
    ]);
  });

  it("flags exact and directionally loosened structural duplicates without flagging different operations", () => {
    const strict = proposalCapability("billing.propose_credit_review", {
      customer_id: { type: "string", required: true, max_length: 64 },
      reason: { type: "string", required: true, max_length: 100 },
    });
    const loose = proposalCapability("billing.propose_credit_adjustment", {
      customer_id: { type: "string", required: true, max_length: 64 },
      reason: { type: "string", required: false, max_length: 500 },
      note: { type: "string", required: false, max_length: 100 },
    });
    const exact = { ...strict, name: "billing.propose_credit_change", description: "Different prose only." };
    const different = {
      ...strict,
      name: "billing.propose_credit_reversal",
      proposal: { ...strict.proposal!, action: "billing.reverse_credit" },
    };
    const result = analyzeCapabilitySurface(contract([strict, loose, exact, different]));
    const findings = result.findings.filter((finding) => finding.code === "SURFACE_NEAR_DUPLICATE");
    expect(findings).toHaveLength(3);
    expect(findings.map((finding) => finding.details.capabilities)).toEqual([
      ["billing.propose_credit_adjustment", "billing.propose_credit_change"],
      ["billing.propose_credit_adjustment", "billing.propose_credit_review"],
      ["billing.propose_credit_change", "billing.propose_credit_review"],
    ]);
    expect(findings.flatMap((finding) => finding.details.differences as string[])).toEqual(expect.arrayContaining([
      "note adds an optional argument",
      "reason becomes optional",
      "reason.max_length widens from 100 to 500",
      "identical model-visible arguments",
    ]));
    expect(findings.flatMap((finding) => finding.details.capabilities as string[])).not.toContain("billing.propose_credit_reversal");
  });

  it("normalizes declaration and set-like array order for deterministic findings", () => {
    const first = proposalCapability("billing.propose_credit_review", {
      customer_id: { type: "string", required: true, enum: ["CUS-2", "CUS-1"] },
    });
    const second = {
      ...proposalCapability("billing.propose_credit_adjustment", {
        customer_id: { type: "string", required: true, enum: ["CUS-1", "CUS-2"] },
      }),
      visible_fields: [...first.visible_fields].reverse(),
      kept_out_fields: [...(first.kept_out_fields ?? [])].reverse(),
    };
    const forward = analyzeCapabilitySurface(contract([first, second]));
    const reverse = analyzeCapabilitySurface(contract([second, first]));
    expect(reverse).toEqual(forward);
    expect(forward.findings).toContainEqual(expect.objectContaining({ code: "SURFACE_NEAR_DUPLICATE" }));
  });

  it("groups resource and direct subjects by normalized source, schema, and table", () => {
    const resourceSubject = capability("billing.inspect_invoice");
    resourceSubject.subject = { resource: "billing_invoices" };
    const directSubject = capability("billing.inspect_invoice_status", {
      status_id: { type: "string", required: true, max_length: 128 },
    });
    const otherSource = { ...capability("billing.inspect_invoice_archive"), source: "archive_postgres" };
    const input = contract([resourceSubject, directSubject, otherSource]);
    input.resources = [{
      name: "billing_invoices",
      engine: "postgres",
      schema: "public",
      table: "invoices",
      primary_key: "id",
      tenant_key: "tenant_id",
    }];
    const result = analyzeCapabilitySurface(input);
    expect(result.summary.target_count).toBe(2);
    expect(result.summary.targets).toEqual([
      expect.objectContaining({ target: "archive_postgres:public.invoices", capability_count: 1 }),
      expect.objectContaining({ target: "local_postgres:public.invoices", capability_count: 2 }),
    ]);
  });
});

function contract(capabilities: CapabilitySpec[]): SynapsorContract {
  return {
    spec_version: "0.1",
    kind: "SynapsorContract",
    metadata: { name: "surface lint fixture", description: "Exercise deterministic surface review." },
    contexts: [{
      name: "operator",
      tenant_binding: "tenant_id",
      bindings: [{ name: "tenant_id", source: "environment", key: "SYNAPSOR_TENANT_ID", required: true }],
    }],
    capabilities,
  };
}

function capability(name: string, args: Record<string, ArgumentSpec> = {}): CapabilitySpec {
  return {
    name,
    description: "A reviewer-facing business operation.",
    returns_hint: "One bounded record.",
    kind: "read",
    context: "operator",
    source: "local_postgres",
    subject: { schema: "public", table: "invoices", primary_key: "id", tenant_key: "tenant_id" },
    args,
    visible_fields: ["id", "tenant_id", "status"],
    kept_out_fields: ["internal_note", "card_token"],
    evidence: { required: true, query_audit: true },
    max_rows: 1,
  };
}

function proposalCapability(name: string, args: Record<string, ArgumentSpec>): CapabilitySpec {
  return {
    ...capability(name, args),
    kind: "proposal",
    lookup: { id_from_arg: "customer_id" },
    proposal: {
      action: "billing.grant_credit",
      allowed_fields: ["credit_cents", "reason"],
      patch: {
        credit_cents: { fixed: 500 },
        reason: { from_arg: "reason" },
      },
      numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } },
      conflict_guard: { column: "updated_at" },
      approval: { mode: "human", required_role: "billing_lead" },
      writeback: { mode: "direct_sql" },
    },
  };
}

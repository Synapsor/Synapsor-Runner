import { describe, expect, expectTypeOf, it } from "vitest";
import { validateContract } from "@synapsor/spec";
import {
  compileContract,
  contractJson,
  defineAgentContext,
  defineCapability,
  defineContract,
  defineResource,
} from "./authoring.js";

describe("code-first canonical contract authoring", () => {
  it("preserves typed authority and compiles to the existing canonical spec", () => {
    const resource = defineResource({
      name: "support.account",
      engine: "postgres",
      schema: "public",
      table: "accounts",
      primary_key: "id",
      tenant_key: "tenant_id",
      conflict_key: "version",
    });
    const context = defineAgentContext({
      name: "support_agent",
      bindings: [
        { name: "tenant_id", source: "environment", key: "SYNAPSOR_TENANT_ID", required: true },
        { name: "principal", source: "environment", key: "SYNAPSOR_PRINCIPAL", required: true },
      ],
      tenant_binding: "tenant_id",
      principal_binding: "principal",
    });
    const capability = defineCapability({
      name: "support.propose_plan_credit",
      kind: "proposal",
      context: context.name,
      source: "app_postgres",
      subject: { resource: resource.name, primary_key: "id", tenant_key: "tenant_id" },
      args: {
        account_id: { type: "string", required: true, max_length: 128 },
        amount_cents: { type: "number", required: true, minimum: 1, maximum: 2500 },
      },
      lookup: { id_from_arg: "account_id" },
      visible_fields: ["id", "tenant_id", "plan_credit_cents", "version"],
      kept_out_fields: ["card_token", "internal_risk_score"],
      evidence: { required: true, query_audit: true },
      max_rows: 1,
      proposal: {
        action: "grant_plan_credit",
        operation: { kind: "update", version_advance: { column: "version", strategy: "integer_increment" } },
        allowed_fields: ["plan_credit_cents"],
        patch: { plan_credit_cents: { from_arg: "amount_cents" } },
        numeric_bounds: { plan_credit_cents: { minimum: 1, maximum: 2500 } },
        conflict_guard: { column: "version" },
        approval: { mode: "human", required_role: "support_lead" },
        writeback: { mode: "direct_sql" },
      },
    });
    const contract = defineContract({
      metadata: { name: "support.plan_credit", version: "1" },
      resources: [resource],
      contexts: [context],
      capabilities: [capability],
    });

    expectTypeOf(contract.capabilities[0]!.name).toEqualTypeOf<"support.propose_plan_credit">();
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
    expect(compileContract(contract).capabilities[0]?.proposal).toMatchObject({
      allowed_fields: ["plan_credit_cents"],
      approval: { mode: "human", required_role: "support_lead" },
      writeback: { mode: "direct_sql" },
    });
    expect(JSON.parse(contractJson(contract))).toMatchObject({
      spec_version: "0.1",
      kind: "SynapsorContract",
      metadata: { name: "support.plan_credit" },
    });
  });

  it("fails invalid definitions through canonical validation", () => {
    expect(() => defineContract({
      contexts: [{
        name: "unsafe",
        bindings: [{ name: "tenant_id", source: "session", key: "tool.tenant_id" }],
        tenant_binding: "tenant_id",
      }],
      capabilities: [{
        name: "unsafe.inspect_anything",
        kind: "read",
        context: "unsafe",
        source: "db",
        subject: { schema: "public", table: "accounts", primary_key: "id", tenant_key: "tenant_id" },
        args: { tenant_id: { type: "string", required: true }, id: { type: "string", required: true } },
        lookup: { id_from_arg: "id" },
        visible_fields: ["id", "tenant_id"],
      }],
    })).toThrow(/MODEL_CONTROLLED_TENANT_BINDING|tenant/i);
  });
});

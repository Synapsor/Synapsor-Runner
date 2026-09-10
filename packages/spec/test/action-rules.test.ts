import { describe, expect, it } from "vitest";
import { normalizeContract, validateContract } from "../src/index.js";

function ruleContract() {
  return {
    spec_version: "0.1" as const,
    kind: "SynapsorContract" as const,
    resources: [{
      name: "billing.preferences",
      engine: "postgres" as const,
      schema: "billing",
      table: "preferences",
      primary_key: "preference_id",
      tenant_key: "tenant_id",
      conflict_key: "version",
    }],
    contexts: [{
      name: "trusted_context",
      bindings: [
        { name: "tenant", source: "environment" as const, key: "SYNAPSOR_TENANT_ID", required: true },
        { name: "principal", source: "environment" as const, key: "SYNAPSOR_PRINCIPAL", required: true },
      ],
      tenant_binding: "tenant",
      principal_binding: "principal",
    }],
    capabilities: [],
    verification_boundaries: [{
      schema_version: "synapsor.verification-boundary.v1" as const,
      name: "billing.preference_change",
      source: "local_postgres",
      context: "trusted_context",
      generation_lock_fingerprint: `sha256:${"a".repeat(64)}` as const,
      resources: [{
        binding: "preference",
        resource: "billing.preferences",
        source: { kind: "subject_ref" as const },
        primary_key: "preference_id",
        version_field: "version",
        fields: [
          { name: "preference_id", type: { kind: "string" as const, max_length: 64, comparison: "exact" as const }, nullable: false },
          { name: "tenant_id", type: { kind: "string" as const, max_length: 64, comparison: "exact" as const }, nullable: false },
          { name: "principal_id", type: { kind: "string" as const, max_length: 64, comparison: "exact" as const }, nullable: false },
          { name: "threshold_cents", type: { kind: "money_minor" as const, currency: "USD" }, nullable: false },
          { name: "version", type: { kind: "integer" as const }, nullable: false },
        ],
        scope: { mode: "columns" as const, tenant_field: "tenant_id", principal_field: "principal_id" },
        cardinality: "one" as const,
        max_rows: 1,
        overflow: "unsupported" as const,
        lock: "for_update" as const,
      }],
      lock_order: ["preference"],
      transaction: { isolation: "repeatable_read" as const, timezone: "UTC" as const },
    }],
    derived_effect_envelopes: [{
      schema_version: "synapsor.derived-effect-envelope.v1" as const,
      name: "billing.preference_effect",
      source: "local_postgres",
      operation: "update" as const,
      target_resource: "billing.preferences",
      target_binding: "preference",
      primary_key: "preference_id",
      tenant_key: "tenant_id",
      principal_scope_key: "principal_id",
      conflict_key: "version",
      max_rows: 1 as const,
      allowed_fields: [{ name: "threshold_cents", type: { kind: "money_minor" as const, currency: "USD" }, minimum: 1000, maximum: 50000 }],
      version_advance: { column: "version", strategy: "integer_increment" as const },
      approval_classes: ["billing.preference_change"],
      writeback: { mode: "direct_sql" as const, supervised_worker: "allowed" as const },
    }],
    action_rules: [{
      schema_version: "synapsor.action-rule.v1" as const,
      name: "billing.set_spend_alert",
      outcome: "billing.set_spend_alert",
      context: "trusted_context",
      source: "local_postgres",
      verification_boundary_ref: "billing.preference_change",
      effect_envelope_ref: "billing.preference_effect",
      subjects: [{ binding: "preference", resource: "billing.preferences", input: "opaque_subject_ref" as const }],
      require: { kind: "compare" as const, operator: "gte" as const, left: { kind: "field" as const, binding: "preference", field: "version" }, right: { kind: "literal" as const, value: 0, value_type: { kind: "integer" as const } } },
      derive: { next_threshold: { kind: "literal" as const, value: 25000, value_type: { kind: "money_minor" as const, currency: "USD" } } },
      effect: { operation: "update" as const, target_resource: "billing.preferences", target_binding: "preference", set: { threshold_cents: { kind: "derived" as const, name: "next_threshold" } } },
      approval_class: "billing.preference_change",
      ttl_seconds: 300,
    }],
  };
}

describe("Action Rule contract authority", () => {
  it("preserves bounded atomic updates and rejects missing guards or nested effects", () => {
    const contract = ruleContract() as any;
    const envelope = contract.derived_effect_envelopes[0];
    const rule = contract.action_rules[0];
    const { schema_version: _s, name: _n, source: _source, approval_classes: _a, writeback: _w, ...target } = envelope;
    envelope.atomic_updates = [{ ...target, target_binding: "second_preference" }];
    rule.atomic_updates = [{ ...rule.effect, target_binding: "second_preference" }];
    expect(validateContract(contract)).toMatchObject({ ok: true });
    const normalized = normalizeContract(contract);
    expect(normalized.derived_effect_envelopes?.[0]?.atomic_updates).toEqual(envelope.atomic_updates);
    expect(normalized.action_rules?.[0]?.atomic_updates).toEqual(rule.atomic_updates);
    for (const invalid of [{ ...target, version_advance: undefined }, { ...target, atomic_updates: [target] }]) {
      envelope.atomic_updates = [invalid];
      expect(validateContract(contract).ok).toBe(false);
    }
    envelope.atomic_updates = Array(4).fill({ ...target, target_binding: "second_preference" });
    expect(validateContract(contract).ok).toBe(false);
  });

  it("preserves composite field-pair order and rejects mixed, repeated, incomplete or injected joins", () => {
    const contract = ruleContract() as any;
    const parent = contract.verification_boundaries[0].resources[0];
    const source = { kind: "relationship", from_binding: "preference", relationship: "reviewed_fk", direction: "forward",
      field_pairs: [{ local_field: "tenant_id", target_field: "tenant_id" }, { local_field: "preference_id", target_field: "preference_id" }] };
    contract.verification_boundaries[0].resources.push({ ...structuredClone(parent), binding: "related", source });
    contract.verification_boundaries[0].lock_order.push("related");
    expect(validateContract(contract)).toMatchObject({ ok: true });
    expect(normalizeContract(contract).verification_boundaries?.[0]?.resources.find((resource) => resource.binding === "related")?.source).toEqual(source);
    for (const bad of [
      { ...source, local_field: "tenant_id", target_field: "tenant_id" },
      { ...source, field_pairs: source.field_pairs.slice(0, 1) },
      { ...source, field_pairs: [source.field_pairs[0], source.field_pairs[0]] },
      { ...source, field_pairs: [{ local_field: "tenant_id OR true", target_field: "tenant_id" }, source.field_pairs[1]] },
    ]) {
      contract.verification_boundaries[0].resources[1].source = bad;
      expect(validateContract(contract).errors.map((error) => error.code)).toContain("INVALID_VERIFICATION_RELATIONSHIP");
    }
  });

  it("accepts and preserves a typed reviewed rule without creating a capability per outcome", () => {
    const contract = ruleContract();
    expect(validateContract(contract)).toMatchObject({ ok: true, errors: [] });
    const normalized = normalizeContract(contract);
    expect(normalized.capabilities).toEqual([]);
    expect(normalized.action_rules?.[0]).toMatchObject({
      outcome: "billing.set_spend_alert",
      approval_class: "billing.preference_change",
    });
  });

  it("rejects unknown operators, unbounded resources, missing effect guards, and duplicate outcomes", () => {
    const unknownOperator = structuredClone(ruleContract()) as any;
    unknownOperator.action_rules[0].require.operator = "matches_sql";
    expect(validateContract(unknownOperator).errors.map((issue) => issue.code)).toContain("INVALID_ACTION_RULE_COMPARISON");

    const unbounded = structuredClone(ruleContract()) as any;
    unbounded.verification_boundaries[0].resources[0].cardinality = "many";
    unbounded.verification_boundaries[0].resources[0].max_rows = 1000;
    expect(validateContract(unbounded).errors.map((issue) => issue.code)).toContain("INVALID_VERIFICATION_ROW_BOUND");

    const missingGuard = structuredClone(ruleContract()) as any;
    delete missingGuard.derived_effect_envelopes[0].conflict_key;
    expect(validateContract(missingGuard).errors.map((issue) => issue.code)).toContain("DERIVED_UPDATE_GUARDS_REQUIRED");

    const duplicate = structuredClone(ruleContract()) as any;
    duplicate.action_rules.push(structuredClone(duplicate.action_rules[0]));
    duplicate.action_rules[1].name = "billing.set_spend_alert_again";
    expect(validateContract(duplicate).errors.map((issue) => issue.code)).toContain("DUPLICATE_ACTION_OUTCOME");
  });

  it("requires explicit money currency, rounding, and one-use effect shape", () => {
    const badMoney = structuredClone(ruleContract()) as any;
    delete badMoney.derived_effect_envelopes[0].allowed_fields[0].type.currency;
    expect(validateContract(badMoney).errors.map((issue) => issue.code)).toContain("ACTION_RULE_CURRENCY_REQUIRED");

    const badScale = structuredClone(ruleContract()) as any;
    badScale.action_rules[0].derive.next_threshold = {
      kind: "scale",
      operation: "divide",
      input: { kind: "literal", value: 50000, value_type: { kind: "money_minor", currency: "USD" } },
      constant: 2,
    };
    expect(validateContract(badScale).errors.map((issue) => issue.code)).toContain("ACTION_RULE_ROUNDING_REQUIRED");

    const multiRow = structuredClone(ruleContract()) as any;
    multiRow.derived_effect_envelopes[0].max_rows = 2;
    expect(validateContract(multiRow).errors.map((issue) => issue.code)).toContain("DERIVED_EFFECT_SINGLE_ROW_REQUIRED");
  });

  it("rejects ambiguous union variants and malformed bounded values", () => {
    const crossVariant = structuredClone(ruleContract()) as any;
    crossVariant.action_rules[0].require.left.value = "shadow-literal";
    expect(validateContract(crossVariant).errors.map((issue) => issue.code)).toContain("INVALID_DISCRIMINATED_VARIANT_FIELD");

    const crossScope = structuredClone(ruleContract()) as any;
    crossScope.verification_boundaries[0].resources[0].scope.organization_id = "shadow-organization";
    expect(validateContract(crossScope).errors.map((issue) => issue.code)).toContain("INVALID_DISCRIMINATED_VARIANT_FIELD");

    const malformedTimestamp = structuredClone(ruleContract()) as any;
    malformedTimestamp.action_rules[0].require.right = {
      kind: "literal",
      value: "2026-09-03T00:00:00Z",
      value_type: { kind: "timestamp" },
    };
    expect(validateContract(malformedTimestamp).errors.map((issue) => issue.code)).toContain("ACTION_RULE_LITERAL_TYPE_MISMATCH");

    const impossibleDate = structuredClone(ruleContract()) as any;
    impossibleDate.action_rules[0].require.right = {
      kind: "literal",
      value: "2026-02-31",
      value_type: { kind: "date" },
    };
    expect(validateContract(impossibleDate).errors.map((issue) => issue.code)).toContain("ACTION_RULE_LITERAL_TYPE_MISMATCH");

    const malformedEnvelope = structuredClone(ruleContract()) as any;
    malformedEnvelope.derived_effect_envelopes[0].allowed_fields[0].values = [25000, 25000];
    expect(validateContract(malformedEnvelope).errors.map((issue) => issue.code)).toContain("INVALID_DERIVED_EFFECT_VALUES");
  });

  it("bounds adversarial expression trees without throwing or accepting partial authority", () => {
    const contract = structuredClone(ruleContract()) as any;
    let expression: any = contract.action_rules[0].require;
    for (let index = 0; index < 26; index += 1) expression = { kind: "not", expression };
    contract.action_rules[0].require = expression;

    expect(() => validateContract(contract)).not.toThrow();
    const result = validateContract(contract);
    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain("ACTION_RULE_EXPRESSION_TOO_DEEP");
  });
});

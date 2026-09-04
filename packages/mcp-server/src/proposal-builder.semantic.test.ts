import { describe, expect, it } from "vitest";
import {
  compileActionRule,
  createActionRuleRegistry,
  evaluateSemanticActionEligibility,
  type ActionRuleCatalogV1,
} from "@synapsor-runner/action-rules";
import type {
  ActionRuleSpecV1,
  DerivedEffectEnvelopeSpecV1,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import { buildDerivedChangeSet } from "./proposal-builder.js";

const lock = `sha256:${"a".repeat(64)}` as const;
const exactString = { kind: "string", max_length: 64, comparison: "exact" } as const;

async function eligibleDecision() {
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [{
      name: "billing.preferences",
      source: "local_postgres",
      engine: "postgres",
      schema: "billing",
      table: "preferences",
      primary_key: "preference_id",
      tenant_key: "account_id",
      principal_scope_key: "principal_id",
      version_field: "version",
      fields: [
        { name: "preference_id", type: exactString, nullable: false },
        { name: "account_id", type: exactString, nullable: false },
        { name: "principal_id", type: exactString, nullable: false },
        { name: "status", type: { kind: "string", max_length: 16, comparison: "exact", enum: ["active", "paused"] }, nullable: false },
        { name: "version", type: { kind: "integer" }, nullable: false },
      ],
    }],
    relationships: [],
  };
  const boundary: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1",
    name: "billing.pause_verification",
    source: "local_postgres",
    context: "trusted_context",
    generation_lock_fingerprint: lock,
    resources: [{
      binding: "preference",
      resource: "billing.preferences",
      source: { kind: "subject_ref" },
      primary_key: "preference_id",
      version_field: "version",
      fields: catalog.resources[0]!.fields.map(({ name, type, nullable }) => ({ name, type, nullable })),
      scope: { mode: "columns", tenant_field: "account_id", principal_field: "principal_id" },
      cardinality: "one",
      max_rows: 1,
      overflow: "unsupported",
      lock: "for_update",
    }],
    lock_order: ["preference"],
    transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const envelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1",
    name: "billing.pause_effect",
    source: "local_postgres",
    operation: "update",
    target_resource: "billing.preferences",
    target_binding: "preference",
    primary_key: "preference_id",
    tenant_key: "account_id",
    principal_scope_key: "principal_id",
    conflict_key: "version",
    max_rows: 1,
    allowed_fields: [{ name: "status", type: { kind: "string", max_length: 16, comparison: "exact", enum: ["active", "paused"] }, values: ["paused"] }],
    version_advance: { column: "version", strategy: "integer_increment" },
    approval_classes: ["billing.standard_change"],
    writeback: { mode: "direct_sql", supervised_worker: "allowed" },
  };
  const rule: ActionRuleSpecV1 = {
    schema_version: "synapsor.action-rule.v1",
    name: "billing.pause_notifications",
    outcome: "billing.pause_notifications",
    context: "trusted_context",
    source: "local_postgres",
    verification_boundary_ref: boundary.name,
    effect_envelope_ref: envelope.name,
    subjects: [{ binding: "preference", resource: "billing.preferences", input: "opaque_subject_ref" }],
    require: {
      kind: "compare",
      operator: "eq",
      left: { kind: "field", binding: "preference", field: "status" },
      right: { kind: "literal", value: "active", value_type: { kind: "string", max_length: 16, comparison: "exact", enum: ["active", "paused"] } },
    },
    derive: {},
    effect: {
      operation: "update",
      target_resource: "billing.preferences",
      target_binding: "preference",
      set: {
        status: { kind: "literal", value: "paused", value_type: { kind: "string", max_length: 16, comparison: "exact", enum: ["active", "paused"] } },
      },
    },
    approval_class: "billing.standard_change",
    ttl_seconds: 300,
  };
  const compiled = compileActionRule({ rule, verification_boundary: boundary, effect_envelope: envelope, catalog });
  const registry = createActionRuleRegistry({
    name: "billing.active_actions",
    rules: [{
      read_boundary_name: "reviewed_billing",
      read_boundary_digest: `sha256:${"c".repeat(64)}`,
      action_boundary_name: "billing.actions",
      action_boundary_digest: `sha256:${"b".repeat(64)}`,
      compiled,
      activated_at: "2026-09-02T20:00:00.000Z",
    }],
  });
  const decision = await evaluateSemanticActionEligibility({
    registry,
    outcome: rule.outcome,
    subjects: [{
      binding: "preference",
      resource: "billing.preferences",
      primary_key: { column: "preference_id", value: "pref_1" },
      subject_ref_digest: `sha256:${"c".repeat(64)}`,
    }],
    trusted: { tenant: "acct_1", principal: "customer_1", transaction_time: "2026-09-02T20:00:00.000Z" },
    adapter: {
      engine: "postgres",
      async load() {
        return [{ preference_id: "pref_1", account_id: "acct_1", principal_id: "customer_1", status: "active", version: 4 }];
      },
    },
    proposal_id: "wrp_pause_1",
    trusted_context_digest: `sha256:${"d".repeat(64)}`,
    evidence_provenance_digest: `sha256:${"e".repeat(64)}`,
    verified_at: "2026-09-02T20:00:00.000Z",
  });
  if (decision.result !== "eligible") throw new Error("Expected eligible semantic fixture.");
  return decision;
}

describe("rule-derived ChangeSet builder", () => {
  it("derives every mutation field and guard from the eligible decision", async () => {
    const decision = await eligibleDecision();
    const changeSet = buildDerivedChangeSet({
      decision,
      context: { tenant_id: "acct_1", principal: "customer_1", provenance: "environment" },
      proposalId: "wrp_pause_1",
      createdAt: "2026-09-02T20:00:01.000Z",
      evidenceBundleId: "ev_pause_1",
      queryFingerprint: `sha256:${"f".repeat(64)}`,
    });

    expect(changeSet).toMatchObject({
      schema_version: "synapsor.change-set.v4",
      action: "billing.pause_notifications",
      patch: { status: "paused" },
      guards: {
        tenant: { column: "account_id", value: "acct_1" },
        expected_version: { column: "version", value: 4 },
        allowed_columns: ["status"],
      },
      before: { preference_id: "pref_1", version: 4 },
      after: { preference_id: "pref_1", status: "paused", version: 5 },
      approval: {
        mode: "human",
        approval_class: "billing.standard_change",
        required_role: "action_reviewer",
        required_approvals: 1,
      },
      writeback: { mode: "trusted_worker_required", executor: "semantic_rule" },
      source_database_mutated: false,
    });
  });

  it("refuses a decision that does not match trusted tenant or principal context", async () => {
    const decision = await eligibleDecision();
    expect(() => buildDerivedChangeSet({
      decision,
      context: { tenant_id: "acct_2", principal: "customer_1", provenance: "environment" },
      proposalId: "wrp_pause_1",
      createdAt: "2026-09-02T20:00:01.000Z",
      evidenceBundleId: "ev_pause_1",
      queryFingerprint: `sha256:${"f".repeat(64)}`,
    })).toThrow(/trusted tenant context/i);
  });
});

import {
  canonicalJsonDigest, parseWritebackJob, type NormalizedWritebackJobV5,
} from "@synapsor-runner/protocol";
import type {
  ActionRuleSpecV1, DerivedEffectEnvelopeSpecV1, RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import { createActionRuleAuthority } from "../authority.js";
import { createSemanticActionVerifier, evaluateSemanticActionEligibility } from "../runtime.js";
import type { ActionRuleCatalogV1 } from "../types.js";
import type { ActionRuleFactLoaderAdapterV1, ActionRuleFactQueryV1 } from "../fact-loader.js";

const textType = { kind: "string", max_length: 64, comparison: "exact" } as const;
const statusType = { ...textType, enum: ["available", "consumed"] };
const generation = canonicalJsonDigest({ fixture: "independent_atomic_completion_v1" });
export const atomicTrusted = { tenant: "acct_1", principal: "customer_1" };

// Programmatic test authority only. No project activation or user database access.
export function atomicSource(engine: "postgres" | "mysql", schema = "atomic_test") {
  const common = [
    { name: "account_id", type: textType, nullable: false },
    { name: "principal_id", type: textType, nullable: false },
    { name: "version", type: { kind: "integer" as const }, nullable: false },
  ];
  const resources: ActionRuleCatalogV1["resources"] = [
    { name: `${schema}.subscriptions`, source: "atomic_source", engine, schema, table: "subscriptions",
      primary_key: "subscription_id", tenant_key: "account_id", principal_scope_key: "principal_id", version_field: "version",
      ...(engine === "mysql" ? { storage_engine: "InnoDB" } : {}),
      fields: [...common, { name: "subscription_id", type: textType, nullable: false }, { name: "plan", type: textType, nullable: false }] },
    { name: `${schema}.offers`, source: "atomic_source", engine, schema, table: "offers",
      primary_key: "offer_id", tenant_key: "account_id", principal_scope_key: "principal_id", version_field: "version",
      ...(engine === "mysql" ? { storage_engine: "InnoDB" } : {}),
      fields: [...common, ...["offer_id", "subscription_id", "old_plan", "new_plan"].map(name => ({ name, type: textType, nullable: false })),
        { name: "status", type: statusType, nullable: false }, { name: "expires_at", type: { kind: "timestamp" }, nullable: false }] },
  ];
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: generation, resources, relationships: [],
  };
  const verification: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1", name: "atomic.verify", source: "atomic_source",
    context: "trusted_context", generation_lock_fingerprint: generation,
    resources: resources.map((resource, index) => ({
      binding: index === 0 ? "subscription" : "offer", resource: resource.name, source: { kind: "subject_ref" },
      primary_key: resource.primary_key, version_field: "version", fields: resource.fields,
      scope: { mode: "columns", tenant_field: "account_id", principal_field: "principal_id" },
      cardinality: "one", max_rows: 1, overflow: "unsupported", lock: "for_update",
    })),
    lock_order: ["subscription", "offer"], transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const guards = { tenant_key: "account_id", principal_scope_key: "principal_id", conflict_key: "version", max_rows: 1 as const,
    version_advance: { column: "version", strategy: "integer_increment" as const } };
  const envelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1", name: "atomic.complete", source: "atomic_source",
    operation: "update", target_resource: resources[0]!.name, target_binding: "subscription", primary_key: "subscription_id",
    ...guards, allowed_fields: [{ name: "plan", type: textType }], approval_classes: ["atomic.review"],
    writeback: { mode: "direct_sql", supervised_worker: "allowed" },
    atomic_updates: [{ operation: "update", target_resource: resources[1]!.name, target_binding: "offer", primary_key: "offer_id",
      ...guards, allowed_fields: [{ name: "status", type: statusType, values: ["consumed"] }] }],
  };
  const rule: ActionRuleSpecV1 = {
    schema_version: "synapsor.action-rule.v1", name: "atomic.accept_offer", outcome: "atomic.accept_offer",
    context: "trusted_context", source: "atomic_source", verification_boundary_ref: verification.name, effect_envelope_ref: envelope.name,
    subjects: verification.resources.map(resource => ({ binding: resource.binding, resource: resource.resource, input: "opaque_subject_ref" })),
    require: { kind: "all", expressions: [
      { kind: "compare", operator: "eq", left: { kind: "field", binding: "offer", field: "status" }, right: { kind: "literal", value: "available", value_type: statusType } },
      { kind: "compare", operator: "eq", left: { kind: "field", binding: "subscription", field: "plan" }, right: { kind: "field", binding: "offer", field: "old_plan" } },
      { kind: "compare", operator: "eq", left: { kind: "field", binding: "subscription", field: "subscription_id" }, right: { kind: "field", binding: "offer", field: "subscription_id" } },
      { kind: "compare", operator: "gt", left: { kind: "field", binding: "offer", field: "expires_at" }, right: { kind: "trusted", binding: "transaction_time" } },
    ] },
    derive: {}, effect: { operation: "update", target_resource: resources[0]!.name, target_binding: "subscription",
      set: { plan: { kind: "field", binding: "offer", field: "new_plan" } } },
    atomic_updates: [{ operation: "update", target_resource: resources[1]!.name, target_binding: "offer",
      set: { status: { kind: "literal", value: "consumed", value_type: statusType } } }],
    approval_class: "atomic.review", ttl_seconds: 300,
  };
  return { catalog, verification, envelope, rule };
}

export function atomicFixture(engine: "postgres" | "mysql", schema = "atomic_test", now = new Date().toISOString()) {
  const source = atomicSource(engine, schema);
  const loaded = createActionRuleAuthority({ name: "atomic_test_authority", action_boundary_name: "atomic.actions", catalog: source.catalog,
    rules: [{ read_boundary_name: "atomic.read", read_boundary_digest: generation, verification_boundary: source.verification,
      effect_envelope: source.envelope, rule: source.rule, activated_at: now }] });
  const decide = (adapter: ActionRuleFactLoaderAdapterV1, proposalId: string, offerId = "offer_1") => evaluateSemanticActionEligibility({
    registry: loaded.registry, outcome: source.rule.outcome,
    subjects: [
      { binding: "subscription", resource: `${schema}.subscriptions`, primary_key: { column: "subscription_id", value: "sub_1" }, subject_ref_digest: canonicalJsonDigest({ proposalId, subject: "sub_1" }) },
      { binding: "offer", resource: `${schema}.offers`, primary_key: { column: "offer_id", value: offerId }, subject_ref_digest: canonicalJsonDigest({ proposalId, subject: offerId }) },
    ], trusted: { ...atomicTrusted, transaction_time: now }, adapter, proposal_id: proposalId,
    trusted_context_digest: canonicalJsonDigest(atomicTrusted), evidence_provenance_digest: canonicalJsonDigest({ proposalId }), verified_at: now,
  });
  return { ...source, ...loaded, now, decide, verifier: createSemanticActionVerifier({ registry: loaded.registry, clock: () => now }) };
}

export type AtomicRows = Record<"subscriptions" | "offers", Record<string, unknown>[]>;
export function atomicRows(): AtomicRows {
  const scope = { account_id: "acct_1", principal_id: "customer_1" };
  return {
    subscriptions: [
      { subscription_id: "sub_1", ...scope, plan: "plan_a", version: 7 },
      { subscription_id: "sibling", ...scope, plan: "plan_a", version: 7 },
      { subscription_id: "foreign", account_id: "acct_2", principal_id: "customer_2", plan: "plan_a", version: 7 },
    ],
    offers: ["offer_1", "offer_2"].map(offer_id => ({ offer_id, ...scope, subscription_id: "sub_1", old_plan: "plan_a",
      new_plan: "plan_b", status: "available", version: 4, expires_at: "2099-01-01T00:00:00.000Z" })),
  };
}

export function atomicMemoryLoader(engine: "postgres" | "mysql", rows: AtomicRows): ActionRuleFactLoaderAdapterV1 {
  return { engine, async load(query: ActionRuleFactQueryV1) {
    const table = rows[query.table as keyof AtomicRows];
    if (!table) throw new Error(`Unexpected fixture table: ${query.table}`);
    return structuredClone(table.filter(row => query.predicates.every(predicate => {
      if (predicate.operation !== "eq") throw new Error("Fixture only supports exact subject predicates");
      return row[predicate.column] === predicate.value;
    })).slice(0, query.limit));
  } };
}

export async function atomicJob(fixture: ReturnType<typeof atomicFixture>, rows: AtomicRows, proposalId = "wrp_atomic_1") {
  const engine = fixture.catalog.resources[0]!.engine;
  const decision = await fixture.decide(atomicMemoryLoader(engine, rows), proposalId);
  if (decision.result !== "eligible") throw new Error(`Expected eligible fixture, got ${decision.result}`);
  const effect = decision.semantic_authority.effect;
  const scope = { ...effect.principal_scope!, schema_version: "synapsor.principal-scope.v1", binding: "principal", provider: "static_dev",
    value_fingerprint: canonicalJsonDigest({ column: "principal_id", binding: "principal", provider: "static_dev", value: "customer_1" }) };
  const job = parseWritebackJob({
    protocol_version: "5.0", job_id: `wbj_${proposalId}`, proposal_id: proposalId,
    approval_id: canonicalJsonDigest({ approval: proposalId }), proposal_hash: canonicalJsonDigest({ proposalId, authority: decision.semantic_authority }),
    contract: { contract_id: fixture.rule.outcome, contract_version_id: `${fixture.rule.outcome}.v1`, digest: decision.activated.action_boundary_digest },
    source_id: effect.source, engine, operation: effect.operation,
    target: { schema: effect.schema, table: effect.table, primary_key: effect.primary_key, tenant_guard: effect.tenant_guard, principal_scope: scope },
    allowed_columns: effect.allowed_columns, patch: effect.set,
    conflict_guard: { kind: "version_column", column: effect.expected_version!.column, expected_value: effect.expected_version!.value },
    version_advance: effect.version_advance, semantic_authority: decision.semantic_authority,
    idempotency_key: `semantic:${proposalId}`, lease_expires_at: "2099-01-01T00:00:00.000Z", attempt_count: 1,
  });
  if (job.protocol_version !== "5.0") throw new Error("Expected normalized semantic job");
  return job as NormalizedWritebackJobV5;
}

export type AtomicFailure = "zero" | "excess" | "throw" | "version" | "receipt" | "commit_unknown" | "rollback_unknown";

// Durable state is separate from transaction state; rollback really discards writes and receipt claims.
export class AtomicState {
  rows = atomicRows();
  receipts: Record<string, Record<string, unknown>> = {};
  transaction?: { rows: AtomicRows; receipts: Record<string, Record<string, unknown>> };
  updates = 0;
  commits = 0;
  rollbacks = 0;
  constructor(public failure?: AtomicFailure, public failAt = 2) {}
  begin() {
    if (this.transaction) throw new Error("Nested fixture transaction");
    this.transaction = structuredClone({ rows: this.rows, receipts: this.receipts });
  }
  commit() {
    if (!this.transaction) throw new Error("No fixture transaction");
    this.rows = this.transaction.rows;
    this.receipts = this.transaction.receipts;
    this.transaction = undefined;
    this.commits++;
    if (this.failure === "commit_unknown") throw new Error("COMMIT acknowledgement lost");
  }
  rollback() {
    this.rollbacks++;
    if (this.failure === "rollback_unknown") throw new Error("ROLLBACK acknowledgement lost");
    this.transaction = undefined;
  }
  update(table: keyof AtomicRows, values: unknown[]) {
    if (!this.transaction) throw new Error("Mutation outside transaction");
    this.updates++;
    const failing = this.updates === this.failAt;
    if (failing && (this.failure === "throw" || this.failure === "rollback_unknown")) throw new Error("second member constraint failure");
    if (failing && this.failure === "zero") return { count: 0 };
    const [value, id, tenant, principal, version] = values;
    const row = this.transaction.rows[table].find(row => row[table === "subscriptions" ? "subscription_id" : "offer_id"] === id
      && row.account_id === tenant && row.principal_id === principal && row.version === version);
    if (!row) return { count: 0 };
    row[table === "subscriptions" ? "plan" : "status"] = value;
    if (!(failing && this.failure === "version")) row.version = Number(row.version) + 1;
    return { count: failing && this.failure === "excess" ? 2 : 1, version: row.version, id };
  }
}

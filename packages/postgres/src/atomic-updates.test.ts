import { describe, expect, it } from "vitest";
import { eligibilityProofDigest, exactDerivedEffectDigest, parseWritebackJob, parseWritebackResult } from "@synapsor-runner/protocol";
import type { RunnerConfig, WritebackIntentStore } from "@synapsor-runner/worker-core";
import { atomicFixture, atomicJob, atomicMemoryLoader, atomicSource, AtomicState, type AtomicFailure } from "../../action-rules/src/testing/atomic-fixture.js";
import { compileActionRule } from "../../action-rules/src/compile.js";
import { applyPostgresJobWithClient, buildPostgresReconciliationRead, type PostgresApplyClient } from "./index.js";

class IntentStore implements WritebackIntentStore {
  result?: ReturnType<typeof parseWritebackResult>;
  unknown = false;
  claimWritebackIntent() {
    if (this.unknown) return { decision: "reconciliation_required" as const, intent_id: "wbi:atomic", reason: "Source outcome unknown" };
    return this.result ? { decision: "existing_result" as const, intent_id: "wbi:atomic", result: this.result }
      : { decision: "proceed" as const, intent_id: "wbi:atomic" };
  }
  markWritebackIntentApplying() {}
  completeWritebackIntent(_id: string, result: Parameters<WritebackIntentStore["completeWritebackIntent"]>[1]) { this.result = parseWritebackResult(result); }
  requireWritebackReconciliation() { this.unknown = true; }
}

class StatefulPostgres implements PostgresApplyClient {
  state: AtomicState;
  log: string[] = [];
  constructor(failure?: AtomicFailure, failAt = 2) { this.state = new AtomicState(failure, failAt); }
  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    sql = sql.trim();
    this.log.push(sql);
    if (sql === "BEGIN") this.state.begin();
    else if (sql === "COMMIT") this.state.commit();
    else if (sql === "ROLLBACK") this.state.rollback();
    else if (sql.startsWith("SET ")) { /* Transaction configuration has no modeled row effect. */ }
    else if (sql.startsWith("SELECT c.relkind AS relation_kind")) {
      expect(values[0]).toBe("atomic_test");
      expect(["subscriptions", "offers"]).toContain(values[1]);
      return { rows: [{ relation_kind: "r" }], rowCount: 1 };
    } else if (sql.startsWith("INSERT INTO synapsor_writeback_receipts")) {
      const receipts = this.state.transaction!.receipts;
      if (receipts[String(values[0])]) return { rows: [], rowCount: 0 };
      receipts[String(values[0])] = { job_id: values[1], proposal_id: values[2], status: "in_progress", result_hash: null };
      return { rows: [{ status: "in_progress" }], rowCount: 1 };
    } else if (sql.startsWith("UPDATE synapsor_writeback_receipts")) {
      if (this.state.failure === "receipt") throw new Error("receipt persistence failed");
      Object.assign(this.state.transaction!.receipts[String(values[0])]!, { status: values[1], result_hash: values[2], semantic_verification_json: values[3] });
      return { rows: [], rowCount: 1 };
    } else if (sql.startsWith("SELECT job_id, proposal_id, status")) {
      const receipt = this.state.transaction!.receipts[String(values[0])];
      return { rows: receipt ? [receipt] : [], rowCount: receipt ? 1 : 0 };
    } else {
      const table = (["subscriptions", "offers"] as const).find(table => sql.includes(`"atomic_test"."${table}"`));
      if (!table) throw new Error(`Unexpected PostgreSQL SQL: ${sql}`);
      if (sql.startsWith("SELECT")) {
        expect(sql).toContain("FOR UPDATE");
        expect(values).toEqual([table === "subscriptions" ? "sub_1" : "offer_1", "acct_1", "customer_1", 2]);
        const rows = this.state.transaction!.rows[table].filter(row => row[table === "subscriptions" ? "subscription_id" : "offer_id"] === values[0]
          && row.account_id === values[1] && row.principal_id === values[2]);
        return { rows: structuredClone(rows), rowCount: rows.length };
      }
      if (!sql.startsWith("UPDATE")) throw new Error(`Unexpected mutation: ${sql}`);
      expect(sql).toContain('"version" = "version" + 1');
      expect(sql).toContain('AND "version" = $5');
      expect(sql).toContain('AND "account_id" = $3');
      expect(sql).toContain('AND "principal_id" = $4');
      const updated = this.state.update(table, values);
      return { rows: updated.count ? [{ __synapsor_primary_key: updated.id, __synapsor_result_version: updated.version }] : [], rowCount: updated.count };
    }
    return { rows: [], rowCount: null };
  }
}

async function setup(authority: "source_db" | "runner_ledger", failure?: AtomicFailure, failAt = 2) {
  const fixture = atomicFixture("postgres");
  const client = new StatefulPostgres(failure, failAt);
  const store = new IntentStore();
  const job = await atomicJob(fixture, client.state.rows);
  const config: RunnerConfig = {
    controlPlaneUrl: "http://127.0.0.1", runnerToken: "test", runnerId: "atomic_test", sourceId: "atomic_source", databaseUrl: "",
    engine: "postgres", pollIntervalMs: 1000, logLevel: "error", dryRun: false, stateDir: ".unused",
    receipts: { authority, provisioning: "precreated" }, writebackIntentStore: store, semanticActionVerifier: fixture.verifier,
  };
  return { fixture, client, store, job, config, apply: () => applyPostgresJobWithClient(job, config, client) };
}

describe.each(["source_db", "runner_ledger"] as const)("PostgreSQL atomic updates: %s", authority => {
  it("commits two exact effects once, retains both targets in proof, and replays without version advances", async () => {
    const f = await setup(authority);
    const before = structuredClone(f.client.state.rows);
    const result = parseWritebackResult(await f.apply());
    expect(result).toMatchObject({ status: "applied", affected_rows: 2, atomic_effects: [
      { table: "subscriptions", affected_rows: 1, target_identity: expect.arrayContaining([{ column: "subscription_id", value: "sub_1" }]) },
      { table: "offers", affected_rows: 1, target_identity: expect.arrayContaining([{ column: "offer_id", value: "offer_1" }]) },
    ], semantic_verification: { status: "reverified", effect_digest: f.job.semantic_authority.effect.effect_digest } });
    expect(f.client.state.rows.subscriptions).toEqual([{ ...before.subscriptions[0], plan: "plan_b", version: 8 }, ...before.subscriptions.slice(1)]);
    expect(f.client.state.rows.offers).toEqual([{ ...before.offers[0], status: "consumed", version: 5 }, before.offers[1]]);
    expect(f.client.state.commits).toBe(1);
    expect(f.client.state.rollbacks).toBe(0);
    const lastFactRead = f.client.log.reduce((last, sql, index) => sql.startsWith("SELECT") && sql.includes("FOR UPDATE") ? index : last, -1);
    expect(lastFactRead).toBeLessThan(f.client.log.findIndex(sql => sql.startsWith('UPDATE "')));
    if (authority === "source_db") expect(Object.values(f.client.state.receipts)).toHaveLength(1);
    else expect(f.store.result).toEqual(result);
    const after = structuredClone(f.client.state.rows);
    expect(parseWritebackResult(await f.apply())).toMatchObject({ status: "already_applied", affected_rows: 0,
      atomic_effects: [{ table: "subscriptions", affected_rows: 0 }, { table: "offers", affected_rows: 0 }],
      semantic_verification: { status: "previously_reverified", effect_digest: f.job.semantic_authority.effect.effect_digest } });
    expect(f.client.state.rows).toEqual(after);
    expect(f.client.state.updates).toBe(2);
  });

  it.each(["zero", "excess", "throw", "version"] as const)("second member %s restores both persisted rows and receipt state", async failure => {
    const f = await setup(authority, failure);
    const before = structuredClone(f.client.state.rows);
    if (authority === "source_db") await expect(f.apply()).rejects.toThrow();
    else expect(await f.apply()).toMatchObject({ status: "failed", affected_rows: 0 });
    expect(f.client.state.updates).toBe(2);
    expect(f.client.state.rows).toEqual(before);
    expect(f.client.state.receipts).toEqual({});
    expect(f.client.state.rollbacks).toBe(1);
    expect(f.client.state.commits).toBe(0);
    expect(await f.fixture.decide(atomicMemoryLoader("postgres", f.client.state.rows), "wrp_after_rollback")).toMatchObject({ result: "eligible" });
  });

  it("first member failure prevents the companion from running", async () => {
    const f = await setup(authority, "zero", 1);
    const before = structuredClone(f.client.state.rows);
    if (authority === "source_db") await expect(f.apply()).rejects.toThrow();
    else expect(await f.apply()).toMatchObject({ status: "failed", affected_rows: 0 });
    expect(f.client.state.updates).toBe(1);
    expect(f.client.state.rows).toEqual(before);
    expect(f.client.state.commits).toBe(0);
  });
});

describe("PostgreSQL atomic proof and unknown outcomes", () => {
  it("receipt failure after both mutations rolls back the business rows and the receipt claim", async () => {
    const f = await setup("source_db", "receipt");
    const before = structuredClone(f.client.state.rows);
    await expect(f.apply()).rejects.toThrow("receipt persistence failed");
    expect(f.client.state.updates).toBe(2);
    expect(f.client.state.rows).toEqual(before);
    expect(f.client.state.receipts).toEqual({});
    expect(f.client.state.rollbacks).toBe(1);
  });

  it.each(["commit_unknown", "rollback_unknown"] as const)("%s stays reconciliation-required and cannot retry mutation", async failure => {
    const f = await setup("runner_ledger", failure);
    expect(await f.apply()).toMatchObject({ status: "reconciliation_required" });
    const attempts = f.client.state.updates;
    expect(attempts).toBe(2);
    expect(f.store.result).toBeUndefined();
    expect(await f.apply()).toMatchObject({ status: "reconciliation_required" });
    expect(f.client.state.updates).toBe(attempts);
    expect(() => buildPostgresReconciliationRead(f.job)).toThrow();
  });

  it("rejects removal of only the companion with stale hashes, and rehashed drift against the active compiled authority", async () => {
    const f = await setup("runner_ledger");
    const changed = structuredClone(f.job);
    delete changed.semantic_authority.effect.atomic_updates;
    expect(() => parseWritebackJob(changed)).toThrow();
    const effect = changed.semantic_authority.effect;
    const { effect_digest: _effectDigest, ...unsignedEffect } = effect;
    effect.effect_digest = exactDerivedEffectDigest(unsignedEffect);
    changed.semantic_authority.proof.derived_effect_digest = effect.effect_digest;
    const { proof_digest: _proofDigest, ...unsignedProof } = changed.semantic_authority.proof;
    changed.semantic_authority.proof.proof_digest = eligibilityProofDigest(unsignedProof);
    const parsed = parseWritebackJob(changed);
    expect(parsed.protocol_version).toBe("5.0");
    expect(await applyPostgresJobWithClient(parsed, f.config, f.client)).toMatchObject({ status: "failed", affected_rows: 0, error_code: "SEMANTIC_AUTHORITY_STALE" });
    expect(f.client.state.updates).toBe(0);
  });

  it("refuses replay when the source receipt lost the complete semantic verification proof", async () => {
    const f = await setup("source_db");
    await f.apply();
    f.client.state.receipts[f.job.idempotency_key]!.semantic_verification_json = null;
    expect(await f.apply()).toMatchObject({ status: "failed", affected_rows: 0, error_code: "SOURCE_RECEIPT_SEMANTIC_PROOF_UNAVAILABLE" });
    expect(f.client.state.updates).toBe(2);
  });
});

describe("independent atomic compiler and protocol bounds", () => {
  const compile = (source: ReturnType<typeof atomicSource>) => compileActionRule({ catalog: source.catalog,
    rule: source.rule, verification_boundary: source.verification, effect_envelope: source.envelope });

  it("accepts exactly three companions while binding every target into the compiled plan", () => {
    const source = atomicSource("postgres");
    const original = compile(source);
    for (const index of [2, 3]) {
      const resource = { ...structuredClone(source.catalog.resources[1]!), name: `atomic_test.offers_${index}`, table: `offers_${index}` };
      const binding = `offer_${index}`;
      source.catalog.resources.push(resource);
      source.verification.resources.push({ ...structuredClone(source.verification.resources[1]!), binding, resource: resource.name });
      source.verification.lock_order.push(binding);
      source.rule.subjects.push({ binding, resource: resource.name, input: "opaque_subject_ref" });
      source.envelope.atomic_updates!.push({ ...structuredClone(source.envelope.atomic_updates![0]!), target_resource: resource.name, target_binding: binding });
      source.rule.atomic_updates!.push({ ...structuredClone(source.rule.atomic_updates![0]!), target_resource: resource.name, target_binding: binding });
    }
    const compiled = compile(source);
    expect(compiled.atomic_updates).toHaveLength(3);
    expect(compiled.compiled_plan_digest).not.toBe(original.compiled_plan_digest);
    expect(compiled.effect_envelope_digest).not.toBe(original.effect_envelope_digest);
    expect(compiled.rule_digest).not.toBe(original.rule_digest);
  });

  it.each(["empty", "four_companions", "missing_rule", "missing_envelope", "primary_insert", "companion_insert", "missing_version", "many_rows", "guard_write", "cross_source", "cross_engine", "duplicate_binding"])("rejects %s", kind => {
    const source = atomicSource("postgres");
    const member = source.envelope.atomic_updates![0]!;
    if (kind === "empty") { source.rule.atomic_updates = []; source.envelope.atomic_updates = []; }
    if (kind === "four_companions") { source.rule.atomic_updates = Array(4).fill(source.rule.atomic_updates![0]); source.envelope.atomic_updates = Array(4).fill(member); }
    if (kind === "missing_rule") delete source.rule.atomic_updates;
    if (kind === "missing_envelope") delete source.envelope.atomic_updates;
    if (kind === "primary_insert") { source.rule.effect.operation = "insert"; source.envelope.operation = "insert"; }
    if (kind === "companion_insert") Object.assign(member, { operation: "insert" });
    if (kind === "missing_version") Reflect.deleteProperty(member, "version_advance");
    if (kind === "many_rows") Object.assign(member, { max_rows: 2 });
    if (kind === "guard_write") { member.allowed_fields = [{ name: "version", type: { kind: "integer" } }]; source.rule.atomic_updates![0]!.set = { version: { kind: "literal", value: 5, value_type: { kind: "integer" } } }; }
    if (kind === "cross_source") source.catalog.resources[1]!.source = "foreign_source";
    if (kind === "cross_engine") source.catalog.resources[1]!.engine = "mysql";
    if (kind === "duplicate_binding") member.target_binding = "subscription";
    expect(() => compile(source)).toThrow();
  });

  it.each(["identity", "tenant", "principal", "patch", "expected_version", "version_advance", "source", "duplicate", "over_limit"])("rejects stale companion %s hashes", async kind => {
    const f = await setup("runner_ledger");
    const changed = structuredClone(f.job);
    const member = changed.semantic_authority.effect.atomic_updates![0]!;
    if (kind === "identity") member.primary_key.value = "offer_2";
    if (kind === "tenant") member.tenant_guard!.value = "acct_2";
    if (kind === "principal") member.principal_scope!.value = "customer_2";
    if (kind === "patch") member.set.status = "available";
    if (kind === "expected_version") member.expected_version!.value = 99;
    if (kind === "version_advance") delete member.version_advance;
    if (kind === "source") member.source = "foreign_source";
    if (kind === "duplicate") changed.semantic_authority.effect.atomic_updates!.push(structuredClone(member));
    if (kind === "over_limit") changed.semantic_authority.effect.atomic_updates = Array(4).fill(member);
    expect(() => parseWritebackJob(changed)).toThrow();
  });

  it("recomputed companion patch hashes do not authorize a different effect under the unchanged active rule", async () => {
    const f = await setup("runner_ledger");
    const changed = structuredClone(f.job);
    const member = changed.semantic_authority.effect.atomic_updates![0]!;
    member.set.status = "available";
    const { effect_digest: _memberDigest, ...unsignedMember } = member;
    member.effect_digest = exactDerivedEffectDigest(unsignedMember);
    const { effect_digest: _effectDigest, ...unsignedEffect } = changed.semantic_authority.effect;
    changed.semantic_authority.effect.effect_digest = exactDerivedEffectDigest(unsignedEffect);
    changed.semantic_authority.proof.derived_effect_digest = changed.semantic_authority.effect.effect_digest;
    const { proof_digest: _proofDigest, ...unsignedProof } = changed.semantic_authority.proof;
    changed.semantic_authority.proof.proof_digest = eligibilityProofDigest(unsignedProof);
    const parsed = parseWritebackJob(changed);
    expect(await applyPostgresJobWithClient(parsed, f.config, f.client)).toMatchObject({ status: "failed", affected_rows: 0, error_code: "SEMANTIC_AUTHORITY_STALE" });
    expect(f.client.state.updates).toBe(0);
  });
});

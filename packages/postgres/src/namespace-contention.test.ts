import { describe, expect, it, vi } from "vitest";
import { createSemanticAdapterConformanceVector } from "@synapsor-runner/action-rules";
import { eligibilityProofDigest, parseWritebackJob, parseWritebackResult } from "@synapsor-runner/protocol";
import type { WritebackIntentStore } from "@synapsor-runner/worker-core";
import { applyPostgresJobWithClient, type PostgresApplyClient } from "./index.js";
import { protectPostgresHardLimitNames } from "./hard-limit-source.js";

const namespaceLock = "LOCK TABLE ONLY pg_catalog.pg_namespace IN SHARE MODE";
const cases = [["40P01", "SOURCE_DEADLOCK"], ["55P03", "SOURCE_LOCK_UNAVAILABLE"]] as const;

// Controlled driver responses test the real namespace producer and adapter
// transaction boundary. This is not native metadata or activated authority.
class NamespaceClient implements PostgresApplyClient {
  readonly sql: string[] = [];
  constructor(readonly failure?: unknown, readonly rollbackUnknown = false,
    readonly permitted = true, readonly protectedAfterLock = true) {}
  async query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.sql.push(sql);
    if (sql === "ROLLBACK" && this.rollbackUnknown) throw new Error("private rollback failure");
    if (sql === namespaceLock) {
      if (this.failure !== undefined) throw this.failure;
      return { rows: [], rowCount: null };
    }
    if (sql.includes("server_version_num")) return { rows: [{ version: 170000, isolation: "read committed", replication_role: "origin" }], rowCount: 1 };
    if (sql.includes("pg_catalog.pg_locks")) return { rows: [{ held: this.sql.includes(namespaceLock) && this.protectedAfterLock }], rowCount: 1 };
    if (sql.includes("has_table_privilege")) return { rows: [{ permitted: this.permitted }], rowCount: 1 };
    if (["BEGIN", "COMMIT", "ROLLBACK", "SET TRANSACTION ISOLATION LEVEL READ COMMITTED", "SET LOCAL TIME ZONE 'UTC'"].includes(sql)
      || sql.includes("set_config('lock_timeout'")) return { rows: [], rowCount: null };
    throw new Error(`Unexpected component query: ${sql}`);
  }
}

class IntentStore implements WritebackIntentStore {
  readonly calls: string[] = [];
  claimWritebackIntent() { this.calls.push("claim"); return { decision: "proceed" as const, intent_id: "namespace-component-intent" }; }
  markWritebackIntentApplying() { this.calls.push("applying"); }
  completeWritebackIntent() { this.calls.push("complete"); }
  requireWritebackReconciliation() { this.calls.push("reconciliation"); }
}

async function applyNamespaceComponent(client: NamespaceClient) {
  const vector = createSemanticAdapterConformanceVector("postgres");
  const { proof_digest: _oldProofDigest, ...unsigned } = vector.job.semantic_authority.proof;
  const proof = { ...unsigned,
    verification_transaction: { isolation: "read_committed" as const, timezone: "UTC" as const } };
  const job = parseWritebackJob({ ...vector.job, semantic_authority: { ...vector.job.semantic_authority,
    proof: { ...proof, proof_digest: eligibilityProofDigest(proof) } } });
  const verifier = Object.assign(vi.fn(async () => { throw new Error("Reverification must not run after failed namespace admission"); }),
    { admitSource: async () => protectPostgresHardLimitNames(client) });
  const store = new IntentStore();
  const result = await applyPostgresJobWithClient(job, { runnerId: "namespace-component-runner", databaseUrl: "postgresql://unused/component",
    receipts: { authority: "runner_ledger" }, writebackIntentStore: store, semanticActionVerifier: verifier }, client);
  expect(verifier).not.toHaveBeenCalled();
  expect(client.sql.filter(sql => sql === namespaceLock)).toHaveLength(1);
  expect(client.sql.filter(sql => sql === "ROLLBACK")).toHaveLength(1);
  expect(client.sql).not.toContain("COMMIT");
  expect(client.sql.some(sql => /^(INSERT|UPDATE|DELETE)\b/u.test(sql))).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(() => parseWritebackResult(result)).not.toThrow();
  return { result, store };
}

describe("early hard-limit namespace contention", () => {
  it.each(cases)("preserves the exact %s driver cause at the namespace producer", async (code) => {
    const failure = Object.assign(new Error("private namespace database detail"), { code });
    await expect(protectPostgresHardLimitNames(new NamespaceClient(failure))).rejects.toBe(failure);
  });
  it.each(cases)("retains %s through whole rollback and the existing public result", async (code, expected) => {
    const { result, store } = await applyNamespaceComponent(new NamespaceClient(Object.assign(new Error("private namespace database detail"), { code })));
    expect(result).toMatchObject({ status: "failed", error_code: expected, affected_rows: 0 });
    expect(store.calls).toEqual(["claim", "applying", "complete"]);
  });
  it.each(cases)("keeps unknown rollback above %s and does not complete the intent", async (code) => {
    const { result, store } = await applyNamespaceComponent(new NamespaceClient(Object.assign(new Error("private namespace database detail"), { code }), true));
    expect(result).toMatchObject({ status: "reconciliation_required", error_code: "RECONCILIATION_REQUIRED", affected_rows: 0 });
    expect(store.calls).toEqual(["claim", "applying", "reconciliation"]);
  });
  it.each([{ message: "40P01 deadlock, lock timeout" }, { code: "40P01_private" }, { code: "57014" },
    { code: { toString: () => "55P03" } }])("keeps untyped or unrelated namespace failure %j unsupported", async failure => {
    await expect(protectPostgresHardLimitNames(new NamespaceClient(failure))).rejects.toMatchObject({
      code: "ACTION_RULE_SCOPE_UNPROVEN", path: "source.hard_limit.namespace_lock" });
  });
  it("refuses missing native privilege before trying the namespace lock", async () => {
    const client = new NamespaceClient(undefined, false, false);
    await expect(protectPostgresHardLimitNames(client)).rejects.toMatchObject({ code: "ACTION_RULE_SCOPE_UNPROVEN", path: "source.hard_limit.namespace_acl" });
    expect(client.sql).not.toContain(namespaceLock);
  });
  it("still refuses missing lock evidence after an acknowledged lock command", async () => {
    const client = new NamespaceClient(undefined, false, true, false);
    await expect(protectPostgresHardLimitNames(client)).rejects.toMatchObject({ code: "ACTION_RULE_SCOPE_UNPROVEN", path: "source.hard_limit.namespace_lock_evidence" });
    expect(client.sql.filter(sql => sql === namespaceLock)).toHaveLength(1);
  });
});

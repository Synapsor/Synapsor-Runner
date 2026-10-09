import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, parseWritebackJob } from "@synapsor-runner/protocol";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";

const ports = vi.hoisted(() => ({ url: vi.fn(), mysql: vi.fn(), postgres: vi.fn() }));
vi.mock("./writeback-execution.js", async original => ({ ...await original<typeof import("./writeback-execution.js")>(), resolveSqlWriteDatabaseUrl: ports.url }));
vi.mock("@synapsor-runner/mysql", async original => ({ ...await original<typeof import("@synapsor-runner/mysql")>(), inspectMysqlWritebackSource: ports.mysql }));
vi.mock("@synapsor-runner/postgres", async original => ({ ...await original<typeof import("@synapsor-runner/postgres")>(), inspectPostgresSourceCompletion: ports.postgres }));
import { inspectWritebackSourceContext } from "./writeback-setup.js";

const stores: ProposalStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
beforeEach(() => {
  vi.clearAllMocks();
  ports.url.mockResolvedValue("mysql://fixture:fixture@127.0.0.1:1/unused");
  ports.mysql.mockResolvedValue({ operation: "single_row_update", classification: "matches_reviewed_before",
    target_identity: [{ column: "id", value: "item_1" }], expected: {}, observed: {}, observed_digest: canonicalJsonDigest({ observation: "declared port result" }) });
  ports.postgres.mockResolvedValue({ status: "unknown", reason: "DECLARED_SOURCE_PROOF_UNAVAILABLE" });
});

/** Real local proposal/intent owners; no Source connection, receipt or completion proof. */
function fixture(engine: "mysql" | "postgres", receiptMode?: "source_db" | "runner_ledger", applying = false) {
  const store = new ProposalStore(); stores.push(store);
  const hash = canonicalJsonDigest({ declared: "unsupported reconciliation diagnostic", engine });
  const change = {
    schema_version: "synapsor.change-set.v1", proposal_id: "wrp_refusal", proposal_version: 1,
    action: "items.adjust", mode: "review_required", principal: { id: "fixture_operator", source: "trusted_session" },
    scope: { tenant_id: "fixture_tenant", business_object: "item", object_id: "item_1" },
    source: { kind: engine === "mysql" ? "external_mysql" : "external_postgres", source_id: "fixture_source", schema: "fixture", table: "items", primary_key: { column: "id", value: "item_1" } },
    before: { amount: 10, version: 1 }, patch: { amount: 11 }, after: { amount: 11, version: 1 },
    guards: { tenant: { column: "tenant_id", value: "fixture_tenant" }, allowed_columns: ["amount"], expected_version: { column: "version", value: 1 } },
    evidence: { bundle_id: "declared_evidence", query_fingerprint: canonicalJsonDigest({ query: "none executed" }), items: [] },
    approval: { status: "pending", required_role: "fixture_reviewer" }, writeback: { status: "not_applied", mode: "trusted_worker_required" },
    source_database_mutated: false, integrity: { proposal_hash: hash }, created_at: "2026-10-09T00:00:00.000Z",
  };
  store.createProposal(change);
  store.approveProposal(change.proposal_id, { approver: "declared local reviewer", proposal_hash: hash, proposal_version: 1 });
  const job = parseWritebackJob({ protocol_version: "2.0", job_id: "wbj_refusal", proposal_id: change.proposal_id,
    approval_id: hash, source_id: "fixture_source", engine, operation: "single_row_update",
    target: { schema: "fixture", table: "items", primary_key: { column: "id", value: "item_1" }, tenant_guard: { column: "tenant_id", value: "fixture_tenant" } },
    allowed_columns: ["amount"], patch: { amount: 11 }, conflict_guard: { kind: "version_column", column: "version", expected_value: 1 },
    version_advance: { column: "version", strategy: "integer_increment" }, idempotency_key: "fixture_refusal_once", lease_expires_at: "2099-01-01T00:00:00Z", attempt_count: 1 });
  const claim = store.claimWritebackIntent(job, "fixture_runner");
  if (claim.decision !== "proceed") throw new Error("Declared fresh intent was not recorded");
  store.markWritebackIntentApplying(claim.intent_id, "fixture_runner");
  if (!applying) store.requireWritebackReconciliation(claim.intent_id, "Declared unknown COMMIT acknowledgement; no Source effect was executed by this test");
  const intent = store.getWritebackIntent(claim.intent_id)!;
  const proposal = store.getProposal(change.proposal_id)!;
  const config: RuntimeConfig = { version: 1, mode: "review", capabilities: [],
    trusted_context: { provider: "static_dev", values: { tenant_id: "fixture_tenant", principal: "fixture_operator" } },
    sources: { fixture_source: { engine, read_url_env: "UNUSED_READER", write_url_env: "UNUSED_WRITER",
      ...(receiptMode ? { receipts: { authority: receiptMode, provisioning: "precreated", schema: "fixture_receipts", table: "receipts" } } : {}) } } };
  return { store, intent, proposal, config };
}

const expected = {
  code: "MYSQL_SOURCE_DB_RECONCILIATION_UNSUPPORTED",
  message: "MYSQL_SOURCE_DB_RECONCILIATION_UNSUPPORTED: MySQL source_db lost-acknowledgement reconciliation is unsupported in this build. Keep the original attempt fenced; do not replay it, treat receipt absence as rollback, or change receipt mode.",
};

describe("MySQL source completion unsupported diagnostic", () => {
  it("MR01 refuses exact source_db before writer resolution and preserves the real stored fence", async () => {
    const f = fixture("mysql", "source_db"); const before = structuredClone({ intent: f.intent, proposal: f.proposal, config: f.config });
    await expect(inspectWritebackSourceContext(f.intent, f.proposal, "/unused/config.json", f.config)).rejects.toMatchObject(expected);
    expect(ports.url).not.toHaveBeenCalled(); expect(ports.mysql).not.toHaveBeenCalled(); expect(ports.postgres).not.toHaveBeenCalled();
    expect(f.store.getWritebackIntent(f.intent.intent_id)).toEqual(before.intent); expect(f.store.getProposal(f.proposal.proposal_id)).toEqual(before.proposal); expect(f.config).toEqual(before.config);
  });
  it("MR02 reports the same unsupported default for a configured source without receipt settings", async () => {
    const f = fixture("mysql", undefined, true);
    await expect(inspectWritebackSourceContext(f.intent, f.proposal, "/unused/config.json", f.config)).rejects.toMatchObject(expected);
    expect(ports.url).not.toHaveBeenCalled(); expect(ports.mysql).not.toHaveBeenCalled();
    expect(f.store.getWritebackIntent(f.intent.intent_id)).toEqual(f.intent); expect(f.intent.status).toBe("applying"); expect(f.intent.result).toBeUndefined();
  });
  it("MR03 keeps the existing MySQL runner_ledger inspection path and exact observation", async () => {
    const f = fixture("mysql", "runner_ledger");
    const result = await inspectWritebackSourceContext(f.intent, f.proposal, "/unused/config.json", f.config);
    expect(ports.url).toHaveBeenCalledExactlyOnceWith(f.intent.intent, "/unused/config.json", process.env);
    expect(ports.mysql).toHaveBeenCalledExactlyOnceWith(f.intent.intent, "mysql://fixture:fixture@127.0.0.1:1/unused");
    expect(result).toEqual(await ports.mysql.mock.results[0]!.value); expect(ports.postgres).not.toHaveBeenCalled(); expect(f.store.getWritebackIntent(f.intent.intent_id)).toEqual(f.intent);
  });
  it("MR04 keeps PostgreSQL source_db proof inspection and unknown classification", async () => {
    const f = fixture("postgres", "source_db");
    expect(await inspectWritebackSourceContext(f.intent, f.proposal, "/unused/config.json", f.config)).toMatchObject({ classification: "outcome_unknown", source_completion: { status: "unknown", reason: "DECLARED_SOURCE_PROOF_UNAVAILABLE" } });
    expect(ports.url).toHaveBeenCalledTimes(1); expect(ports.postgres).toHaveBeenCalledTimes(1); expect(ports.mysql).not.toHaveBeenCalled();
  });
  it("MR05 preserves PostgreSQL runner_ledger atomic completion limitation without querying", async () => {
    const f = fixture("postgres", "runner_ledger");
    expect(await inspectWritebackSourceContext(f.intent, f.proposal, "/unused/config.json", f.config)).toMatchObject({ classification: "outcome_unknown", source_completion: { status: "unknown", reason: "RUNNER_LEDGER_HAS_NO_ATOMIC_SOURCE_COMPLETION" } });
    expect(ports.url).not.toHaveBeenCalled(); expect(ports.mysql).not.toHaveBeenCalled(); expect(ports.postgres).not.toHaveBeenCalled();
  });
  it("MR06 retains missing-source validation rather than calling it a configured unsupported backend", async () => {
    const f = fixture("mysql", "source_db"); f.config.sources = {};
    await expect(inspectWritebackSourceContext(f.intent, f.proposal, "/unused/config.json", f.config)).rejects.toThrow("source fixture_source does not use runner_ledger receipt authority");
    expect(ports.url).not.toHaveBeenCalled(); expect(ports.mysql).not.toHaveBeenCalled();
  });
});

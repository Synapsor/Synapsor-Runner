import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresProposalRuntimeStore, ProposalStore, migrateSharedPostgresRuntimeStore, type OperatorIdentityProof, type StoredProposal } from "./index.js";
import { sharedLedgerPayload, sharedLedgerRestoreSpecs, sharedLedgerRestoreValue } from "./shared-ledger-domain.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const databaseUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

function changeSet(id: string) {
  return {
    schema_version: "synapsor.change-set.v1" as const,
    proposal_id: id,
    proposal_version: 1,
    action: "billing.waive_late_fee",
    mode: "review_required" as const,
    principal: { id: "support_agent", source: "trusted_session" as const },
    scope: { tenant_id: "acme", business_object: "invoice", object_id: `${id}-invoice` },
    source: { kind: "external_postgres" as const, source_id: "fixture", schema: "public", table: "invoices", primary_key: { column: "id", value: `${id}-invoice` } },
    before: { amount: 1, version: 1 }, patch: { amount: 0 }, after: { amount: 0, version: 1 },
    guards: { tenant: { column: "tenant_id", value: "acme" }, allowed_columns: ["amount"], expected_version: { column: "version", value: 1 } },
    evidence: { bundle_id: `${id}-evidence`, query_fingerprint: "sha256:evidence", items: [] },
    approval: { status: "pending" as const, required_role: "support_lead" },
    writeback: { status: "not_applied" as const, mode: "trusted_worker_required" as const },
    source_database_mutated: false,
    integrity: { proposal_hash: `sha256:${id.padEnd(64, "a").slice(0, 64)}` },
    created_at: "2026-09-10T00:00:00.000Z",
  };
}

function identity(proposal: StoredProposal, roles: string[]): OperatorIdentityProof {
  const subject = "verified_operator";
  const decision = {
    schema_version: "synapsor.operator-decision.v1" as const,
    action: "worker_cancel" as const,
    proposal_id: proposal.proposal_id,
    proposal_version: proposal.proposal_version,
    proposal_hash: proposal.proposal_hash,
    subject,
    issued_at: "2026-09-10T00:01:00.000Z",
  };
  return {
    provider: "signed_key",
    verified: true,
    subject,
    roles,
    key_id: subject,
    algorithm: "SHA256",
    decision,
    decision_hash: "sha256:decision",
    integrity_hash: "sha256:identity",
  };
}

function queued(store: ProposalStore, id: string, role: string | null | undefined): StoredProposal {
  store.createProposal(changeSet(id));
  const proposal = store.getProposal(id);
  if (!proposal) throw new Error("expected proposal");
  store.approveProposal(id, { approver: "support_lead", proposal_hash: proposal.proposal_hash, proposal_version: proposal.proposal_version });
  store.enqueueWorkerProposal({
    proposal_id: id,
    execution_mode: "supervised_worker",
    contract_digest: digest,
    ...(role === undefined ? {} : { cancellation_control_role: role }),
  });
  return store.getProposal(id)!;
}

describe("worker cancellation control-role snapshots", () => {
  it("includes the explicit snapshot state in the shared-Postgres ledger projection", () => {
    const spec = sharedLedgerRestoreSpecs.worker_queue;
    expect(spec?.columns).toEqual(expect.arrayContaining([
      "cancellation_control_role",
      "cancellation_control_role_present",
    ]));
    const payload = sharedLedgerPayload("worker_queue", {
      proposal_id: "wrp_projection",
      cancellation_control_role: null,
      cancellation_control_role_present: 1,
    });
    expect(payload).toMatchObject({ cancellation_control_role_present: 1 });
    expect(sharedLedgerRestoreValue(payload, "cancellation_control_role")).toBeNull();
  });

  it("persists the trusted role and denies cancellation without it without mutating queue or proposal", () => {
    const store = new ProposalStore();
    try {
      const proposal = queued(store, "wrp_cancel_role", "old_worker_operator");
      expect(store.getWorkerQueueItem(proposal.proposal_id)).toMatchObject({ cancellation_control_role: "old_worker_operator" });
      const before = {
        queue: store.getWorkerQueueItem(proposal.proposal_id), proposal: store.getProposal(proposal.proposal_id), events: store.events(proposal.proposal_id),
      };
      expect(() => store.enqueueWorkerProposal({
        proposal_id: proposal.proposal_id,
        execution_mode: "supervised_worker",
        contract_digest: digest,
        cancellation_control_role: null,
      })).toThrowError(expect.objectContaining({ code: "WORKER_QUEUE_AUTHORITY_MISMATCH" }));
      expect({
        queue: store.getWorkerQueueItem(proposal.proposal_id), proposal: store.getProposal(proposal.proposal_id), events: store.events(proposal.proposal_id),
      }).toEqual(before);
      expect(() => store.cancelWorkerItem({
        proposalId: proposal.proposal_id,
        actor: "verified_operator",
        identity: identity(proposal, ["different_operator"]),
        require_verified_identity: true,
      })).toThrowError(expect.objectContaining({ code: "WORKER_CANCEL_CONTROL_ROLE_REQUIRED" }));
      expect({
        queue: store.getWorkerQueueItem(proposal.proposal_id), proposal: store.getProposal(proposal.proposal_id), events: store.events(proposal.proposal_id),
      }).toEqual(before);
      const unverified: OperatorIdentityProof = { ...identity(proposal, ["old_worker_operator"]), verified: false };
      expect(() => store.cancelWorkerItem({
        proposalId: proposal.proposal_id,
        actor: "verified_operator",
        identity: unverified,
        require_verified_identity: true,
      })).toThrowError(expect.objectContaining({ code: "VERIFIED_OPERATOR_IDENTITY_REQUIRED" }));
      expect({
        queue: store.getWorkerQueueItem(proposal.proposal_id), proposal: store.getProposal(proposal.proposal_id), events: store.events(proposal.proposal_id),
      }).toEqual(before);

      expect(store.cancelWorkerItem({
        proposalId: proposal.proposal_id,
        actor: "verified_operator",
        identity: identity(proposal, ["old_worker_operator"]),
        require_verified_identity: true,
      })).toMatchObject({ status: "cancelled", cancellation_control_role: "old_worker_operator" });
    } finally { store.close(); }
  });

  it("keeps an explicit reviewed no-role policy distinct from a legacy missing snapshot", () => {
    const store = new ProposalStore();
    try {
      const explicit = queued(store, "wrp_cancel_no_role", null);
      const legacy = queued(store, "wrp_cancel_legacy", undefined);
      expect(store.getWorkerQueueItem(explicit.proposal_id)).toMatchObject({ cancellation_control_role: null });
      expect(store.getWorkerQueueItem(legacy.proposal_id)).not.toHaveProperty("cancellation_control_role");
      expect(store.cancelWorkerItem({
        proposalId: explicit.proposal_id,
        actor: "verified_operator",
        identity: identity(explicit, []),
        require_verified_identity: true,
      })).toMatchObject({ status: "cancelled", cancellation_control_role: null });
    } finally { store.close(); }
  });

  it("rejects explicitly undefined snapshots and permits exact-digest retries of legacy rows without backfilling authority", () => {
    const store = new ProposalStore();
    try {
      const legacy = queued(store, "wrp_cancel_legacy_retry", undefined);
      const before = {
        queue: store.getWorkerQueueItem(legacy.proposal_id), proposal: store.getProposal(legacy.proposal_id), events: store.events(legacy.proposal_id),
      };
      expect(() => store.enqueueWorkerProposal({
        proposal_id: legacy.proposal_id,
        execution_mode: "supervised_worker",
        contract_digest: digest,
        cancellation_control_role: "new_worker_operator",
      })).not.toThrow();
      expect({
        queue: store.getWorkerQueueItem(legacy.proposal_id), proposal: store.getProposal(legacy.proposal_id), events: store.events(legacy.proposal_id),
      }).toEqual(before);

      const explicitUndefined = queued(store, "wrp_cancel_explicit_undefined", undefined);
      expect(() => store.enqueueWorkerProposal({
        proposal_id: explicitUndefined.proposal_id,
        execution_mode: "supervised_worker",
        contract_digest: digest,
        cancellation_control_role: undefined,
      })).toThrowError(expect.objectContaining({ code: "WORKER_CANCEL_CONTROL_ROLE_SNAPSHOT_INVALID" }));
      expect(store.getWorkerQueueItem(explicitUndefined.proposal_id)).not.toHaveProperty("cancellation_control_role");
    } finally { store.close(); }
  });

  it("rejects malformed persisted cancellation-role snapshots", () => {
    const store = new ProposalStore();
    try {
      const proposal = queued(store, "wrp_cancel_bad_role", null);
      store.db.prepare("UPDATE worker_queue SET cancellation_control_role = ?, cancellation_control_role_present = 1 WHERE proposal_id = ?")
        .run("not a role", proposal.proposal_id);
      expect(store.getWorkerQueueItem(proposal.proposal_id)).toBeUndefined();
      expect(() => store.cancelWorkerItem({ proposalId: proposal.proposal_id, actor: "verified_operator", identity: identity(proposal, []), require_verified_identity: true }))
        .toThrowError(expect.objectContaining({ code: "WORKER_ITEM_NOT_FOUND" }));
    } finally { store.close(); }
  });
});

describePostgres("worker cancellation control-role shared PostgreSQL persistence", () => {
  const schema = `synapsor_cancel_${process.pid}_${randomBytes(4).toString("hex")}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000, statement_timeout: 10_000 });
    await migrateSharedPostgresRuntimeStore(pool, schema, 2_000);
  });

  afterAll(async () => {
    if (!pool) return;
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool.end(); }
  });

  it("round-trips prior roles, explicit no-role, and legacy rows without backfilling legacy authority", async () => {
    const first = new PostgresProposalRuntimeStore({ pool, schema, lockTimeoutMs: 2_000 });
    const createQueued = async (id: string, role: string | null | undefined) => {
      await first.createProposal(changeSet(id));
      const proposal = await first.getProposal(id);
      if (!proposal) throw new Error("expected proposal");
      await first.approveProposalByPolicy(id, {
        policy: "shared_pg_test_policy",
        proposal_hash: proposal.proposal_hash,
        proposal_version: proposal.proposal_version,
        reason: "shared PostgreSQL cancellation snapshot test",
      });
      await first.enqueueWorkerProposal({
        proposal_id: id,
        execution_mode: "supervised_worker",
        contract_digest: digest,
        ...(role === undefined ? {} : { cancellation_control_role: role }),
      });
      return proposal;
    };
    const prior = await createQueued("wrp_pg_prior_role", "prior_worker_operator");
    const noRole = await createQueued("wrp_pg_no_role", null);
    const legacy = await createQueued("wrp_pg_legacy", undefined);

    const second = new PostgresProposalRuntimeStore({ pool, schema, lockTimeoutMs: 2_000 });
    expect(await second.getWorkerQueueItem(prior.proposal_id)).toMatchObject({ cancellation_control_role: "prior_worker_operator", status: "queued" });
    expect(await second.getWorkerQueueItem(noRole.proposal_id)).toMatchObject({ cancellation_control_role: null, status: "queued" });
    expect(await second.getWorkerQueueItem(legacy.proposal_id)).not.toHaveProperty("cancellation_control_role");

    await expect(second.cancelWorkerItem({
      proposalId: prior.proposal_id,
      actor: "verified_operator",
      identity: identity(prior, ["different_operator"]),
      require_verified_identity: true,
    })).rejects.toMatchObject({ code: "WORKER_CANCEL_CONTROL_ROLE_REQUIRED" });
    expect(await second.getWorkerQueueItem(prior.proposal_id)).toMatchObject({ status: "queued", cancellation_control_role: "prior_worker_operator" });
    await expect(second.cancelWorkerItem({
      proposalId: prior.proposal_id,
      actor: "verified_operator",
      identity: identity(prior, ["prior_worker_operator"]),
      require_verified_identity: true,
    })).resolves.toMatchObject({ status: "cancelled", cancellation_control_role: "prior_worker_operator" });
    await expect(second.cancelWorkerItem({
      proposalId: noRole.proposal_id,
      actor: "verified_operator",
      identity: identity(noRole, []),
      require_verified_identity: true,
    })).resolves.toMatchObject({ status: "cancelled", cancellation_control_role: null });

    await expect(second.enqueueWorkerProposal({
      proposal_id: legacy.proposal_id,
      execution_mode: "supervised_worker",
      contract_digest: digest,
      cancellation_control_role: "later_worker_operator",
    })).resolves.toBeDefined();
    expect(await new PostgresProposalRuntimeStore({ pool, schema, lockTimeoutMs: 2_000 }).getWorkerQueueItem(legacy.proposal_id))
      .not.toHaveProperty("cancellation_control_role");
  });
});

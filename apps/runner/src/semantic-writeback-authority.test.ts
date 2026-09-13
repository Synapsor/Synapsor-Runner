import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  compileActionRule,
  createActionRuleAuthority,
  evaluateSemanticActionEligibility,
  type ActionRuleFactLoaderAdapterV1,
  type ActionRuleCatalogV1,
} from "@synapsor-runner/action-rules";
import {
  buildDerivedChangeSet,
  type RuntimeConfig,
} from "@synapsor-runner/mcp-server";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { createPostgresActionRuleFactLoader } from "@synapsor-runner/postgres";
import {
  canonicalJsonDigest,
  parseWritebackJob,
} from "@synapsor-runner/protocol";
import {
  rolePostureFingerprint,
  type SchemaInspection,
  type TableInfo,
} from "@synapsor-runner/schema-inspector";
import type {
  ActionRuleScalarTypeSpecV1,
  ActionRuleSpecV1,
  DerivedEffectEnvelopeSpecV1,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivatedExplorationBoundary } from "./auto-boundary.js";
import {
  activateActionRuleAuthority,
  buildActionRuleAuthorityDraft,
  deactivateActionRuleAuthority,
  loadActiveActionRuleAuthority,
  writeActionRuleAuthorityDraft,
} from "./action-rule-authority.js";
import {
  semanticActionVerifierForRuntime,
  verifyLocalWritebackAuthority,
  resolveSqlWriteDatabaseUrl,
} from "./writeback-execution.js";
import {
  claimSupervisedWorkerItem,
  enqueueApprovedForSupervisedWorker,
  workerCommand,
} from "./worker-runtime.js";
import { assessSemanticSupervisedWriterPosture } from "./worker-policy.js";

const roots: string[] = [];
const generationLock = `sha256:${"a".repeat(64)}` as const;
const exactString = { kind: "string", max_length: 64, comparison: "exact" } as const;
const stateType: ActionRuleScalarTypeSpecV1 = {
  kind: "string",
  max_length: 16,
  comparison: "exact",
  enum: ["active", "paused"],
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

// Programmatic reviewed-authority fixture, not an onboarding/CLI authoring test.
// Proposal facts, approval ledger, worker command, source apply and receipts are real.
describe.skipIf(!process.env.SYNAPSOR_TEST_POSTGRES_URL)("connected semantic worker identity and trusted context", () => {
  async function fixture(run: (f: {
    runWorker: (extra?: string[]) => Promise<number>;
    rows: () => Promise<unknown[]>;
    ledger: () => { proposal: ReturnType<ProposalStore["getProposal"]>; queue: ReturnType<ProposalStore["getWorkerQueueItem"]>;
      receipts: ReturnType<ProposalStore["receipts"]> };
    config: RuntimeConfig; configPath: string;
    changeVersion: () => Promise<void>;
  }) => Promise<void>) {
    const pool = new Pool({ connectionString: process.env.SYNAPSOR_TEST_POSTGRES_URL, max: 3, connectionTimeoutMillis: 3_000 });
    const schema = `worker_context_${randomBytes(6).toString("hex")}`;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE "${schema}".preferences (
        preference_id text PRIMARY KEY, account_id text NOT NULL, principal_id text NOT NULL,
        status text NOT NULL, version integer NOT NULL)`);
      await pool.query(`INSERT INTO "${schema}".preferences VALUES
        ('pref_1', 'acct_1', 'customer_1', 'active', 4),
        ('foreign', 'acct_2', 'customer_2', 'active', 4)`);
      vi.stubEnv("DATABASE_URL", process.env.SYNAPSOR_TEST_POSTGRES_URL);
      vi.stubEnv("SYNAPSOR_DATABASE_WRITE_URL", process.env.SYNAPSOR_TEST_POSTGRES_URL);
      vi.stubEnv("TEST_WORKER_TENANT", "acct_1");
      vi.stubEnv("TEST_WORKER_PRINCIPAL", "customer_1");
      vi.stubEnv("SYNAPSOR_RUNNER_ID", undefined);
      const client = await pool.connect();
      let f;
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        f = await writebackFixture({ schema, environmentContext: true, factLoader: createPostgresActionRuleFactLoader(client) });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      const authority = await loadActiveActionRuleAuthority(f.root);
      const config = semanticWorkerConfig(f.config, authority.registry.rules[0]!.action_boundary_digest);
      config.supervised_worker!.outcomes![0]!.worker_identity = "semantic_action_worker";
      expect(config.contexts).toBeUndefined();
      expect(authority.registry.rules[0]!.compiled.context).toBe("trusted_context");
      await fs.writeFile(f.configPath, JSON.stringify(config));
      const queueStore = new ProposalStore(f.storePath);
      try { await enqueueApprovedForSupervisedWorker(queueStore, config, f.configPath, {}); }
      finally { queueStore.close(); }
      await run({ config, configPath: f.configPath,
        runWorker: (extra = []) => workerCommand(["run", "--supervised", "--once", "--yes", "--batch-quiet",
          "--config", f.configPath, "--store", f.storePath, ...extra]),
        rows: async () => (await pool.query(`SELECT * FROM "${schema}".preferences ORDER BY preference_id`)).rows,
        changeVersion: async () => { await pool.query(`UPDATE "${schema}".preferences SET version = version + 1 WHERE preference_id = 'pref_1'`); },
        ledger: () => {
          const store = new ProposalStore(f.storePath);
          try { return { proposal: store.getProposal(f.job.proposal_id), queue: store.getWorkerQueueItem(f.job.proposal_id),
            receipts: store.receipts(f.job.proposal_id) }; }
          finally { store.close(); }
        },
      });
    } finally {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await pool.end(); }
    }
  }

  it("applies with generated defaults, persists one receipt and never repeats the effect", async () => fixture(async (f) => {
    const before = await f.rows();
    expect(f.ledger().queue).toMatchObject({ status: "queued", attempts: 0 });
    await expect(f.runWorker(["--worker-id", "wrong_worker"])).rejects.toMatchObject({ code: "SUPERVISED_WORKER_IDENTITY_MISMATCH" });
    expect(f.ledger().queue).toMatchObject({ status: "queued", attempts: 0 });
    expect(await f.rows()).toEqual(before);
    expect(await f.runWorker()).toBe(0);
    expect(await f.rows()).toEqual([before[0], { preference_id: "pref_1", account_id: "acct_1", principal_id: "customer_1", status: "paused", version: 5 }]);
    const applied = f.ledger();
    expect(applied.proposal?.state).toBe("applied");
    expect(applied.queue).toMatchObject({ status: "completed", terminal_outcome: "applied", attempts: 1 });
    expect(applied.receipts).toHaveLength(1);
    expect(applied.receipts[0]!.receipt).toMatchObject({ status: "applied", rows_affected: 1, source_database_mutated: true });
    const rows = await f.rows();
    expect(await f.runWorker()).toBe(0);
    expect(await f.rows()).toEqual(rows);
    expect(f.ledger()).toEqual(applied);
  }), 30_000);

  it.each(["TEST_WORKER_TENANT", "TEST_WORKER_PRINCIPAL"])("blocks a different trusted %s without source writes", async (name) => fixture(async (f) => {
    const before = await f.rows();
    vi.stubEnv(name, "foreign_identity");
    expect(await f.runWorker()).toBe(0);
    expect(await f.rows()).toEqual(before);
    expect(f.ledger().queue).toMatchObject({ status: "blocked", attempts: 1 });
    expect(f.ledger().receipts).toEqual([]);
  }), 30_000);

  it("preserves the exact missing-binding code in the worker queue instead of a generic execution error", async () => fixture(async (f) => {
    const before = await f.rows();
    vi.stubEnv("TEST_WORKER_PRINCIPAL", undefined);
    expect(await f.runWorker()).toBe(0);
    expect(f.ledger().queue).toMatchObject({ status: "blocked", attempts: 1, last_error_code: "TRUSTED_BINDING_MISSING" });
    expect(f.ledger().receipts).toEqual([]);
    expect(await f.rows()).toEqual(before);
  }), 30_000);

  it("refuses a conflicting named session context before claiming, without top-level fallback", async () => fixture(async (f) => {
    const before = await f.rows();
    f.config.contexts = { trusted_context: { provider: "http_claims" } };
    f.config.session_auth = { provider: "jwt_hs256", secret_env: "TEST_WORKER_SESSION_SECRET",
      issuer: "test-backend", audience: "test-runner" };
    await fs.writeFile(f.configPath, JSON.stringify(f.config));
    await expect(f.runWorker()).rejects.toThrow(/TRUSTED_CONTEXT_PROVIDER_CONFLICT/);
    expect(f.ledger().queue).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.ledger().receipts).toEqual([]);
    expect(await f.rows()).toEqual(before);
  }), 30_000);

  it("refuses stale approved facts without an additional source change", async () => fixture(async (f) => {
    await f.changeVersion();
    const before = await f.rows();
    expect(await f.runWorker()).toBe(0);
    expect(await f.rows()).toEqual(before);
    const after = f.ledger();
    expect(after.proposal?.state).not.toBe("applied");
    expect(after.receipts).toHaveLength(1);
    expect(after.receipts[0]!.receipt).toMatchObject({ rows_affected: 0, source_database_mutated: false });
  }), 30_000);
});

describe("semantic writeback authority orchestration", () => {
  it("resolves a real approved v5 job to its outcome writer without changing the compiled source", async () => {
    const fixture = await writebackFixture();
    const authority = await loadActiveActionRuleAuthority(fixture.root);
    const config = semanticWorkerConfig(fixture.config, authority.registry.rules[0]!.action_boundary_digest);
    const originalSource = structuredClone(config.sources!.local_postgres!);
    config.sources!.second_writer = { ...structuredClone(originalSource), write_url_env: "SECOND_WRITER_URL" };
    config.supervised_worker!.outcomes![0]!.write_url_env = "SECOND_WRITER_URL";
    await fs.writeFile(fixture.configPath, JSON.stringify(config));
    await expect(verifyLocalWritebackAuthority(fixture.job, fixture.configPath, fixture.storePath)).resolves.toBeUndefined();
    const env: NodeJS.ProcessEnv = { SYNAPSOR_DATABASE_WRITE_URL: "first-credential", SECOND_WRITER_URL: "second-credential",
      SYNAPSOR_DATABASE_URL: "must-not-fallback" };
    await expect(resolveSqlWriteDatabaseUrl(fixture.job, fixture.configPath, env)).resolves.toBe("second-credential");
    expect(fixture.job.source_id).toBe("local_postgres");
    expect(config.sources!.local_postgres).toEqual(originalSource);
    delete env.SECOND_WRITER_URL;
    await expect(resolveSqlWriteDatabaseUrl(fixture.job, fixture.configPath, env)).rejects.toThrow(/SEMANTIC_ACTION_WRITER_URL_MISSING/);
    config.sources!.second_writer.read_url_env = "OTHER_READER_URL";
    await fs.writeFile(fixture.configPath, JSON.stringify(config));
    await expect(resolveSqlWriteDatabaseUrl(fixture.job, fixture.configPath, env)).rejects.toThrow(/SUPERVISED_WORKER_WRITER_MISMATCH/);
  });

  it("accepts one exact approved v5 job and reloads active authority for transaction verification", async () => {
    const fixture = await writebackFixture();

    await expect(verifyLocalWritebackAuthority(
      fixture.job,
      fixture.configPath,
      fixture.storePath,
    )).resolves.toBeUndefined();

    const verifier = semanticActionVerifierForRuntime(fixture.config, fixture.configPath);
    expect(verifier).toBeDefined();
    await expect(verifier!({
      job: fixture.job,
      factLoader: fixture.factLoader,
    })).resolves.toMatchObject({
      status: "reverified",
      effect_digest: fixture.job.semantic_authority.effect.effect_digest,
    });

    await deactivateActionRuleAuthority(fixture.root);
    await expect(verifyLocalWritebackAuthority(
      fixture.job,
      fixture.configPath,
      fixture.storePath,
    )).rejects.toMatchObject({ code: "ENOENT" });
    await expect(verifier!({
      job: fixture.job,
      factLoader: fixture.factLoader,
    })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts one exact policy approval while retaining a two-human fallback quorum", async () => {
    const fixture = await writebackFixture({ automaticApproval: true, requiredApprovals: 2 });

    await expect(verifyLocalWritebackAuthority(
      fixture.job,
      fixture.configPath,
      fixture.storePath,
    )).resolves.toBeUndefined();

    const store = new ProposalStore(fixture.storePath);
    try {
      const proposal = store.getProposal(fixture.job.proposal_id);
      expect(proposal?.change_set.approval).toMatchObject({
        mode: "policy",
        required_role: "billing_reviewer",
        required_approvals: 2,
      });
      expect(store.approvals(fixture.job.proposal_id)).toEqual([
        expect.objectContaining({
          approver: "policy:billing.standard_change",
          status: "approved",
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it("rejects approval-set and immutable-proposal drift before source execution", async () => {
    const fixture = await writebackFixture();
    const changedApproval = structuredClone(fixture.job);
    changedApproval.approval_id = `sha256:${"f".repeat(64)}`;
    await expect(verifyLocalWritebackAuthority(
      changedApproval,
      fixture.configPath,
      fixture.storePath,
    )).rejects.toThrow(/SEMANTIC_APPROVAL_SET_MISMATCH/);

    const changedPatch = structuredClone(fixture.job);
    changedPatch.patch.status = "active";
    await expect(verifyLocalWritebackAuthority(
      changedPatch,
      fixture.configPath,
      fixture.storePath,
    )).rejects.toThrow(/SEMANTIC_PROPOSAL_JOB_MISMATCH/);
  });

  it("queues and leases an approved semantic proposal only for its exact active outcome authority", async () => {
    const fixture = await writebackFixture();
    const authority = await loadActiveActionRuleAuthority(fixture.root);
    const activated = authority.registry.rules[0]!;
    const config = semanticWorkerConfig(fixture.config, activated.action_boundary_digest);
    await fs.writeFile(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const store = new ProposalStore(fixture.storePath);
    try {
      await enqueueApprovedForSupervisedWorker(store, config, fixture.configPath, {});
      expect(store.getWorkerQueueItem(fixture.job.proposal_id)).toMatchObject({
        status: "queued",
        execution_mode: "supervised_worker",
        contract_digest: activated.action_boundary_digest,
      });

      await expect(claimSupervisedWorkerItem(store, config, fixture.configPath, {
        workerId: "wrong_worker",
      })).resolves.toBeUndefined();
      expect(store.getWorkerQueueItem(fixture.job.proposal_id)?.status).toBe("queued");

      await expect(claimSupervisedWorkerItem(store, config, fixture.configPath, {
        workerId: "semantic_worker",
      })).resolves.toMatchObject({
        item: {
          proposal_id: fixture.job.proposal_id,
          status: "leased",
          lease_owner: "semantic_worker",
          contract_digest: activated.action_boundary_digest,
        },
        policy: {
          outcome: activated.compiled.outcome,
          action_boundary_digest: activated.action_boundary_digest,
        },
      });
    } finally {
      store.close();
    }
  });

  it("retains automatic approval history but never dispatches old unstarted work after a lower-limit replacement", async () => {
    const fixture = await writebackFixture({automaticApproval: true});
    const original = await loadActiveActionRuleAuthority(fixture.root);
    const config = semanticWorkerConfig(fixture.config, original.registry.rules[0]!.action_boundary_digest);
    await fs.writeFile(fixture.configPath, JSON.stringify(config));
    const store = new ProposalStore(fixture.storePath);
    try {
      await enqueueApprovedForSupervisedWorker(store, config, fixture.configPath, {});
      const approvals = store.approvals(fixture.job.proposal_id);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]!.approver).toBe("policy:billing.standard_change");
      expect(store.getWorkerQueueItem(fixture.job.proposal_id)?.status).toBe("queued");
      await fixture.replaceLimit(1);
      const replacement = await loadActiveActionRuleAuthority(fixture.root);
      expect(replacement.authority.digest).not.toBe(original.authority.digest);
      await expect(claimSupervisedWorkerItem(store, config, fixture.configPath, {workerId: "semantic_worker"})).resolves.toBeUndefined();
      expect(store.approvals(fixture.job.proposal_id)).toEqual(approvals);
      expect(store.getWorkerQueueItem(fixture.job.proposal_id)).toMatchObject({status: "queued", lease_id: undefined, lease_owner: undefined});
      expect(store.receipts(fixture.job.proposal_id)).toEqual([]);
      if(process.env.SYNAPSOR_TEST_EVIDENCE_DIR) await fs.writeFile(path.join(process.env.SYNAPSOR_TEST_EVIDENCE_DIR, "old-unstarted-work.json"), JSON.stringify({
        original: original.authority.digest, replacement: replacement.authority.digest,
        approvals, queue: store.getWorkerQueueItem(fixture.job.proposal_id), receipts: store.receipts(fixture.job.proposal_id),
        source_execution: "not dispatched", already_dispatched: "not exercised by this case"
      }, null, 2));
    } finally {store.close();}
  });

  it("leaves semantic work unleased after Action authority is deactivated", async () => {
    const fixture = await writebackFixture();
    const authority = await loadActiveActionRuleAuthority(fixture.root);
    const activated = authority.registry.rules[0]!;
    const config = semanticWorkerConfig(fixture.config, activated.action_boundary_digest);
    await fs.writeFile(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const store = new ProposalStore(fixture.storePath);
    try {
      await enqueueApprovedForSupervisedWorker(store, config, fixture.configPath, {});
      await deactivateActionRuleAuthority(fixture.root);
      await expect(claimSupervisedWorkerItem(store, config, fixture.configPath, {
        workerId: "semantic_worker",
      })).resolves.toBeUndefined();
      expect(store.getWorkerQueueItem(fixture.job.proposal_id)).toMatchObject({
        status: "queued",
        lease_id: undefined,
        lease_owner: undefined,
      });
    } finally {
      store.close();
    }
  });

  it("requires least-privilege access to the target and every private verification relation", () => {
    const source = authoritySourceWithPolicyFact();
    const authority = createActionRuleAuthority({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: "reviewed_billing",
        read_boundary_digest: `sha256:${"b".repeat(64)}`,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
        activated_at: "2026-09-03T00:00:00.000Z",
      }],
    });
    const activated = authority.registry.rules[0]!;
    const inspection: SchemaInspection = {
      engine: "postgres",
      server_version: "16",
      current_user: "billing_worker",
      role_posture: {
        verified: true,
        superuser: false,
        bypass_rls: false,
        read_only: false,
        writable_relations: ["billing.preferences"],
        owned_relations: [],
        reasons: [],
      },
      inspected_at: "2026-09-03T00:00:00.000Z",
      schemas: ["billing"],
      tables: [
        writerPostureTable("billing", "preferences", { select: true, update: true }),
        writerPostureTable("billing", "policy_flags", { select: true }),
      ],
      warnings: [],
    };
    const policy = {
      outcome: activated.compiled.outcome,
      action_boundary_digest: activated.action_boundary_digest,
      mode: "supervised_worker" as const,
      concurrency: 1,
      queue_limit: 10,
      lease_seconds: 60,
      max_attempts: 3,
      proposal_ttl_seconds: 3_600,
      rate_limit: { executions: 10, window_seconds: 60 },
      write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
      require_least_privilege_writer: true,
      writer_posture_fingerprint: rolePostureFingerprint(inspection),
    };
    const config: RuntimeConfig = {
      version: 1,
      mode: "review",
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
          receipts: { authority: "runner_ledger" },
        },
      },
      capabilities: [],
      supervised_worker: {
        enabled: true,
        profile: "production",
        capabilities: [],
        outcomes: [policy],
      },
    };

    expect(assessSemanticSupervisedWriterPosture(
      config, policy, authority.registry, inspection,
    )).toMatchObject({ ok: false, reasons: ["writer_row_lock_privilege_missing"] });
    inspection.tables[1]!.role_posture!.column_privileges = { update: ["policy_id"] };
    policy.writer_posture_fingerprint = rolePostureFingerprint(inspection);
    expect(assessSemanticSupervisedWriterPosture(
      config,
      policy,
      authority.registry,
      inspection,
    )).toMatchObject({
      ok: true,
      reasons: [],
      allowed_relations: ["billing.policy_flags", "billing.preferences"],
    });

    const narrow = structuredClone(inspection);
    narrow.tables[0]!.role_posture!.privileges.update = false;
    narrow.tables[0]!.role_posture!.column_privileges = { update: [
      ...activated.compiled.effect_envelope.allowed_fields.map((field) => field.name),
      activated.compiled.effect_envelope.version_advance!.column,
    ] };
    const narrowPolicy = { ...policy, writer_posture_fingerprint: rolePostureFingerprint(narrow) };
    expect(assessSemanticSupervisedWriterPosture(config, narrowPolicy, authority.registry, narrow).ok).toBe(true);
    const missingVersion = structuredClone(narrow);
    missingVersion.tables[0]!.role_posture!.column_privileges!.update = activated.compiled.effect_envelope.allowed_fields.map((field) => field.name);
    expect(assessSemanticSupervisedWriterPosture(config, narrowPolicy, authority.registry, missingVersion).reasons).toContain("writer_update_missing");
    const rlsLock = structuredClone(narrow);
    rlsLock.tables[1]!.row_level_security = true;
    rlsLock.tables[1]!.role_posture!.row_security_update_permitted = false;
    expect(assessSemanticSupervisedWriterPosture(config, narrowPolicy, authority.registry, rlsLock).reasons).toContain("writer_row_lock_rls_policy_missing");
    rlsLock.tables[1]!.role_posture!.row_security_update_permitted = true;
    expect(assessSemanticSupervisedWriterPosture(config, narrowPolicy, authority.registry, rlsLock).reasons).not.toContain("writer_row_lock_rls_policy_missing");
    const missingColumn = structuredClone(narrow);
    missingColumn.tables[0]!.role_posture!.column_privileges!.update = ["preference_id"];
    expect(assessSemanticSupervisedWriterPosture(config, narrowPolicy, authority.registry, missingColumn).reasons).toContain("writer_update_missing");
    const excessColumn = structuredClone(narrow);
    excessColumn.tables[1]!.role_posture!.column_privileges!.update!.push("auto_approval_eligible");
    expect(assessSemanticSupervisedWriterPosture(config, narrowPolicy, authority.registry, excessColumn).reasons).toContain("writer_excess_column_privilege");
    const extraIssues = assessSemanticSupervisedWriterPosture(config, narrowPolicy, authority.registry, excessColumn).relation_issues!;
    expect(extraIssues.filter((issue) => issue.issue === "excess").map((issue) => issue.privileges)).toContainEqual(["update (auto_approval_eligible)"]);
    const extraTarget = structuredClone(narrow);
    extraTarget.tables[0]!.role_posture!.column_privileges!.update!.push("unreviewed_note");
    const targetAssessment = assessSemanticSupervisedWriterPosture(config, narrowPolicy, authority.registry, extraTarget);
    expect(targetAssessment.relation_issues!.filter((issue) => issue.issue === "excess").map((issue) => issue.privileges)).toEqual([["update (unreviewed_note)"]]);
    expect(targetAssessment.required_relations![0]!.update_columns).toContain("version");
    const broadLock = structuredClone(inspection);
    broadLock.tables[1]!.role_posture!.privileges.update = true;
    expect(assessSemanticSupervisedWriterPosture(config, policy, authority.registry, broadLock).reasons).toContain("writer_excess_relation_privilege");

    const missingPrivateRead = structuredClone(inspection);
    missingPrivateRead.tables[1]!.role_posture!.privileges.select = false;
    expect(assessSemanticSupervisedWriterPosture(
      config,
      policy,
      authority.registry,
      missingPrivateRead,
    )).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(["writer_select_missing", "writer_posture_fingerprint_changed"]),
      relation_issues: expect.arrayContaining([expect.objectContaining({ issue: "missing", privileges: ["select"] })]),
    });

    const excessive = structuredClone(inspection);
    excessive.tables.push(writerPostureTable("billing", "private_notes", { select: true }));
    expect(assessSemanticSupervisedWriterPosture(
      config,
      policy,
      authority.registry,
      excessive,
    )).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining([
        "writer_unreviewed_relation_privilege",
        "writer_posture_fingerprint_changed",
      ]),
      relation_issues: expect.arrayContaining([{ relation: "billing.private_notes", issue: "unreviewed", privileges: ["select"] }]),
    });
  });
});

function semanticWorkerConfig(
  config: RuntimeConfig,
  actionBoundaryDigest: `sha256:${string}`,
): RuntimeConfig {
  return {
    ...structuredClone(config),
    supervised_worker: {
      enabled: true,
      profile: "staging",
      capabilities: [],
      outcomes: [{
        outcome: "billing.pause_notifications",
        action_boundary_digest: actionBoundaryDigest,
        mode: "supervised_worker",
        concurrency: 1,
        queue_limit: 10,
        lease_seconds: 60,
        max_attempts: 3,
        proposal_ttl_seconds: 3_600,
        rate_limit: { executions: 10, window_seconds: 60 },
        write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
        worker_identity: "semantic_worker",
      }],
    },
  };
}

async function writebackFixture(options: {
  automaticApproval?: boolean;
  requiredApprovals?: number;
  schema?: string;
  environmentContext?: boolean;
  factLoader?: ActionRuleFactLoaderAdapterV1;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-semantic-writeback-"));
  roots.push(root);
  const readBoundary = activeReadBoundary(options.environmentContext);
  await writeActiveReadSet(root, readBoundary);
  const source = authoritySource(options.schema);
  const approvalClass = {
    name: "billing.standard_change",
    mode: "policy" as const,
    rules: [{ outcome: source.rule.outcome, auto_approve_when: structuredClone(source.rule.require) }],
    required_role: "billing_reviewer",
    required_approvals: options.requiredApprovals ?? 1,
    shared_limits: [{
      id: "billing_pause_action_24h",
      kind: "count" as const,
      scope: "capability" as const,
      maximum: 10,
      window_seconds: 86_400,
      capability: source.rule.outcome,
    }, {
      id: "billing_pause_customer_24h",
      kind: "count" as const,
      scope: "tenant_principal" as const,
      maximum: 3,
      window_seconds: 86_400,
      capability: source.rule.outcome,
    }],
  };
  const activatedAt = new Date().toISOString();
  const createDraft = (maximum?: number) => buildActionRuleAuthorityDraft({
    name: "billing_active_rules",
    action_boundary_name: "billing_actions",
    catalog: source.catalog,
    rules: [{
      read_boundary_name: readBoundary.pack.name,
      read_boundary_digest: readBoundary.activation.digest,
      verification_boundary: source.verification,
      effect_envelope: source.envelope,
      rule: source.rule,
    }],
    ...(options.automaticApproval ? { approval_classes: [{...approvalClass, shared_limits: approvalClass.shared_limits.map(l => ({...l, maximum: maximum ?? l.maximum}))}] } : {}),
    reviews: [{
      outcome: source.rule.outcome,
      when: "The preference is active.",
      then: "Propose pausing notifications.",
      refused: ["The preference is already paused."],
      human_review: "One action reviewer must approve.",
      examples: [
        { kind: "eligible", scenario: "Active preference", result: "Create one proposal" },
        { kind: "ineligible", scenario: "Paused preference", result: "Refuse" },
      ],
    }],
    now: activatedAt,
  });
  const draft = createDraft();
  await writeActionRuleAuthorityDraft(root, draft);
  await activateActionRuleAuthority({
    projectRoot: root,
    name: draft.authority.name,
    expected_digest: draft.digest,
    confirmation: `ACTIVATE ${draft.digest}`,
    actor: "action reviewer",
    now: activatedAt,
  });
  const loaded = await loadActiveActionRuleAuthority(root);
  const verifiedAt = new Date().toISOString();
  const factLoader = options.factLoader ?? {
    engine: "postgres" as const,
    async load() {
      return [{
        preference_id: "pref_1",
        account_id: "acct_1",
        principal_id: "customer_1",
        status: "active",
        version: 4,
      }];
    },
  };
  const decision = await evaluateSemanticActionEligibility({
    registry: loaded.registry,
    outcome: source.rule.outcome,
    subjects: [{
      binding: "preference",
      resource: source.catalog.resources[0]!.name,
      primary_key: { column: "preference_id", value: "pref_1" },
      subject_ref_digest: canonicalJsonDigest({ subject_ref: "pref_1" }),
    }],
    trusted: { tenant: "acct_1", principal: "customer_1", transaction_time: verifiedAt },
    adapter: factLoader,
    proposal_id: "wrp_pause_pref_1",
    trusted_context_digest: canonicalJsonDigest({ tenant: "acct_1", principal: "customer_1" }),
    evidence_provenance_digest: canonicalJsonDigest({ evidence: "pref_1" }),
    verified_at: verifiedAt,
  });
  if (decision.result !== "eligible") throw new Error("Expected the semantic writeback fixture to be eligible.");
  const changeSet = buildDerivedChangeSet({
    decision,
    context: { tenant_id: "acct_1", principal: "customer_1", provenance: options.environmentContext ? "environment" : "static_dev" },
    proposalId: "wrp_pause_pref_1",
    createdAt: verifiedAt,
    evidenceBundleId: "ev_pause_pref_1",
    queryFingerprint: canonicalJsonDigest({ query: "pref_1" }),
  });
  const storePath = path.join(root, ".synapsor", "local.db");
  const store = new ProposalStore(storePath);
  let job;
  try {
    const proposal = store.createProposal(changeSet);
    if (options.automaticApproval) {
      store.approveProposalByPolicy(proposal.proposal_id, {
        policy: decision.approval.authority.name,
        proposal_hash: proposal.proposal_hash,
        proposal_version: proposal.proposal_version,
        reason: "Exact semantic policy matched.",
        action_boundary: {
          name: decision.activated.action_boundary_name,
          digest: decision.activated.action_boundary_digest,
          limits: decision.approval.authority.shared_limits,
        },
        now: verifiedAt,
      });
    } else {
      store.approveProposal(proposal.proposal_id, {
        approver: "action_reviewer",
        proposal_hash: proposal.proposal_hash,
        proposal_version: proposal.proposal_version,
      });
    }
    job = parseWritebackJob(store.createWritebackJobFromProposal(proposal.proposal_id));
  } finally {
    store.close();
  }
  if (job.protocol_version !== "5.0") throw new Error("Expected a normalized semantic v5 writeback job.");

  const config: RuntimeConfig = {
    version: 1,
    mode: "review",
    storage: { sqlite_path: "./.synapsor/local.db" },
    sources: {
      local_postgres: {
        engine: "postgres",
        read_url_env: "DATABASE_URL",
        write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
        receipts: { authority: "runner_ledger" },
      },
    },
    trusted_context: options.environmentContext ? {
      provider: "environment", values: { tenant_id_env: "TEST_WORKER_TENANT", principal_env: "TEST_WORKER_PRINCIPAL" },
    } : {
      provider: "static_dev",
      values: { tenant_id: "acct_1", principal: "customer_1" },
    },
    capabilities: [{
      name: "billing.inspect_preference",
      kind: "read",
      source: "local_postgres",
      target: {
        schema: source.catalog.resources[0]!.schema,
        table: "preferences",
        primary_key: "preference_id",
        tenant_key: "account_id",
        principal_scope_key: "principal_id",
      },
      args: { preference_id: { type: "string", required: true } },
      lookup: { id_from_arg: "preference_id" },
      visible_columns: ["status"],
    }],
    action_rules: { project_root: "." },
  };
  const configPath = path.join(root, "synapsor.runner.json");
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { root, config, configPath, storePath, job, factLoader, replaceLimit: async (maximum: number) => {
    const replacement = createDraft(maximum);
    await writeActionRuleAuthorityDraft(root, replacement);
    return activateActionRuleAuthority({projectRoot: root, name: replacement.authority.name, expected_digest: replacement.digest,
      confirmation: `ACTIVATE ${replacement.digest}`, actor: "action reviewer"});
  }};
}

function authoritySource(schema = "billing"): {
  catalog: ActionRuleCatalogV1;
  verification: RuleVerificationBoundarySpecV1;
  envelope: DerivedEffectEnvelopeSpecV1;
  rule: ActionRuleSpecV1;
} {
  const fields = [
    { name: "preference_id", type: exactString, nullable: false },
    { name: "account_id", type: exactString, nullable: false },
    { name: "principal_id", type: exactString, nullable: false },
    { name: "status", type: stateType, nullable: false },
    { name: "version", type: { kind: "integer" as const }, nullable: false },
  ];
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: generationLock,
    resources: [{
      name: `${schema}.preferences`,
      source: "local_postgres",
      engine: "postgres",
      schema,
      table: "preferences",
      primary_key: "preference_id",
      tenant_key: "account_id",
      principal_scope_key: "principal_id",
      version_field: "version",
      fields,
    }],
    relationships: [],
  };
  const verification: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1",
    name: "billing.pause_verification",
    source: "local_postgres",
    context: "trusted_context",
    generation_lock_fingerprint: generationLock,
    resources: [{
      binding: "preference",
      resource: `${schema}.preferences`,
      source: { kind: "subject_ref" },
      primary_key: "preference_id",
      version_field: "version",
      fields,
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
    target_resource: `${schema}.preferences`,
    target_binding: "preference",
    primary_key: "preference_id",
    tenant_key: "account_id",
    principal_scope_key: "principal_id",
    conflict_key: "version",
    max_rows: 1,
    allowed_fields: [{ name: "status", type: stateType, values: ["paused"] }],
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
    verification_boundary_ref: verification.name,
    effect_envelope_ref: envelope.name,
    subjects: [{ binding: "preference", resource: `${schema}.preferences`, input: "opaque_subject_ref" }],
    require: {
      kind: "compare",
      operator: "eq",
      left: { kind: "field", binding: "preference", field: "status" },
      right: { kind: "literal", value: "active", value_type: stateType },
    },
    derive: {},
    effect: {
      operation: "update",
      target_resource: `${schema}.preferences`,
      target_binding: "preference",
      set: { status: { kind: "literal", value: "paused", value_type: stateType } },
    },
    approval_class: "billing.standard_change",
    ttl_seconds: 300,
  };
  return { catalog, verification, envelope, rule };
}

function authoritySourceWithPolicyFact(): ReturnType<typeof authoritySource> {
  const source = authoritySource();
  const policyId = { kind: "string", max_length: 64, comparison: "exact" } as const;
  source.catalog.resources[0]!.fields.push({ name: "policy_id", type: policyId, nullable: false });
  source.catalog.resources.push({
    name: "billing.policy_flags",
    source: "local_postgres",
    engine: "postgres",
    schema: "billing",
    table: "policy_flags",
    primary_key: "policy_id",
    version_field: "version",
    fields: [
      { name: "policy_id", type: policyId, nullable: false },
      { name: "pause_allowed", type: { kind: "boolean" }, nullable: false },
      { name: "version", type: { kind: "integer" }, nullable: false },
    ],
  });
  source.catalog.relationships.push({
    name: "preferences_policy_fk",
    from_resource: "billing.preferences",
    to_resource: "billing.policy_flags",
    local_field: "policy_id",
    target_field: "policy_id",
    cardinality: "many_to_one",
    nullable: false,
    target_unique: true,
  });
  source.verification.resources.push({
    binding: "policy",
    resource: "billing.policy_flags",
    source: {
      kind: "relationship",
      from_binding: "preference",
      relationship: "preferences_policy_fk",
      local_field: "policy_id",
      target_field: "policy_id",
      direction: "forward",
    },
    primary_key: "policy_id",
    version_field: "version",
    fields: source.catalog.resources[1]!.fields,
    scope: { mode: "inherited", from_binding: "preference" },
    cardinality: "one",
    max_rows: 1,
    overflow: "unsupported",
    lock: "for_update",
  });
  source.verification.lock_order.push("policy");
  source.rule.require = {
    kind: "all",
    expressions: [
      source.rule.require,
      {
        kind: "compare",
        operator: "eq",
        left: { kind: "field", binding: "policy", field: "pause_allowed" },
        right: { kind: "literal", value: true, value_type: { kind: "boolean" } },
      },
    ],
  };
  return source;
}

function writerPostureTable(
  schema: string,
  name: string,
  privileges: { select?: boolean; insert?: boolean; update?: boolean; delete?: boolean },
): TableInfo {
  return {
    schema,
    name,
    type: "table",
    writable: true,
    columns: [],
    primary_key: [],
    unique_constraints: [],
    foreign_keys: [],
    indexes: [],
    row_level_security: false,
    row_level_security_policies: [],
    role_posture: {
      owner: "database_owner",
      current_role_is_owner: false,
      current_role_can_assume_owner: false,
      privileges: {
        select: privileges.select ?? false,
        insert: privileges.insert ?? false,
        update: privileges.update ?? false,
        delete: privileges.delete ?? false,
        truncate: false,
        references: false,
        trigger: false,
      },
      row_security_forced: false,
      row_security_effective_for_current_role: false,
    },
    suggestions: {
      tenant_columns: [],
      conflict_columns: [],
      sensitive_columns: [],
      default_visible_columns: [],
    },
  };
}

function activeReadBoundary(environmentContext = false): ActivatedExplorationBoundary {
  const authority = {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "reviewed" as const,
    deployment_profile: "staging" as const,
    source: "local_postgres",
    compiler_version: "test",
    spec_version: "test",
    trusted_context: environmentContext ? {
      provider: "environment" as const, tenant_env: "TEST_WORKER_TENANT", principal_env: "TEST_WORKER_PRINCIPAL",
    } : {
      provider: "static_dev" as const,
      tenant_id: "acct_1",
      principal: "customer_1",
    },
    generation_lock_fingerprint: generationLock,
    role_posture_fingerprint: `sha256:${"b".repeat(64)}` as const,
    pack: { name: "reviewed_billing", resources: [] },
    budgets: {},
  };
  return {
    ...authority,
    activation: {
      state: "active",
      digest: canonicalJsonDigest(authority),
      actor: "test",
      activated_at: new Date().toISOString(),
      generation_lock_fingerprint: generationLock,
      reviewed_decisions: [],
    },
  } as unknown as ActivatedExplorationBoundary;
}

async function writeActiveReadSet(root: string, boundary: ActivatedExplorationBoundary): Promise<void> {
  const state = path.join(root, ".synapsor");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "exploration-boundaries.active.json"), `${JSON.stringify({
    schema_version: "synapsor.active-exploration-boundaries.v1",
    selected_name: boundary.pack.name,
    boundaries: [boundary],
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

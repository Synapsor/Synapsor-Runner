import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { evaluateSemanticActionEligibility } from "../packages/action-rules/dist/index.js";
import { buildDerivedChangeSet } from "../packages/mcp-server/dist/index.js";
import { ProposalStore } from "../packages/proposal-store/dist/index.js";
import { canonicalJsonDigest } from "../packages/protocol/dist/index.js";
import { createPostgresActionRuleFactLoader } from "../packages/postgres/dist/index.js";
import {
  activateActionRuleAuthority,
  buildActionRuleAuthorityDraft,
  loadActiveActionRuleAuthority,
  writeActionRuleAuthorityDraft,
} from "../apps/runner/dist/action-rule-authority.js";
import { enqueueApprovedForSupervisedWorker, workerCommand } from "../apps/runner/dist/worker-runtime.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = "routine_schedule";
const capability = "support.schedule_offer";
const boundary = {
  name: "support_schedule_actions",
  digest: `sha256:${"a".repeat(64)}`,
  limits: [
    { id: "capability_24h", kind: "count", scope: "capability", maximum: 10, window_seconds: 86_400, capability },
    { id: "account_24h", kind: "count", scope: "tenant", maximum: 3, window_seconds: 86_400, capability },
  ],
};
const now = "2026-09-05T12:00:00.000Z";
const { Pool } = pg;

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}

function changeSet(id, tenant, principal) {
  return {
    schema_version: "synapsor.change-set.v1",
    proposal_id: id,
    proposal_version: 1,
    action: capability,
    mode: "review_required",
    principal: { id: principal, source: "trusted_session" },
    scope: { tenant_id: tenant, business_object: "subscription", object_id: `subscription_${id}` },
    source: {
      kind: "external_postgres",
      source_id: "disposable_runtime",
      schema: "public",
      table: "subscriptions",
      primary_key: { column: "id", value: `subscription_${id}` },
    },
    before: { status: "active", version: 1 },
    patch: { status: "scheduled" },
    after: { status: "scheduled", version: 1 },
    guards: {
      tenant: { column: "tenant_id", value: tenant },
      allowed_columns: ["status"],
      expected_version: { column: "version", value: 1 },
    },
    evidence: { bundle_id: `evidence_${id}`, query_fingerprint: `sha256:evidence_${id}`, items: [] },
    approval: { status: "pending", mode: "policy", policy, required_role: "support_reviewer" },
    writeback: { status: "not_applied", mode: "trusted_worker_required" },
    source_database_mutated: false,
    integrity: { proposal_hash: `sha256:${crypto.createHash("sha256").update(id).digest("hex")}` },
    created_at: now,
  };
}

function create(store, id, tenant, principal, actionBoundary = boundary) {
  const proposal = store.createProposal(changeSet(id, tenant, principal));
  return approve(store, proposal, actionBoundary);
}

function approve(store, proposal, actionBoundary = boundary, proposalHash = proposal.proposal_hash) {
  return store.approveProposalByPolicy(proposal.proposal_id, {
    policy,
    proposal_hash: proposalHash,
    proposal_version: proposal.proposal_version,
    reason: "routine eligibility verified",
    action_boundary: actionBoundary,
    now,
  });
}

async function waitForPaths(paths) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ready = await Promise.all(paths.map(async (filePath) => {
      try { await fs.access(filePath); return true; }
      catch { return false; }
    }));
    if (ready.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("contention workers did not reach the start barrier");
}

function runChild(storePath, proposalId, actionBoundary, readyPath, startPath) {
  const moduleUrl = new URL("../packages/proposal-store/dist/index.js", import.meta.url).href;
  const source = `
    import fs from "node:fs/promises";
    const { ProposalStore } = await import(process.argv[1]);
    const boundary = JSON.parse(process.argv[4]);
    await fs.writeFile(process.argv[5], "ready");
    const deadline = Date.now() + 10000;
    while (true) {
      if (Date.now() >= deadline) throw new Error("contention start barrier timed out");
      try { await fs.access(process.argv[6]); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    const store = new ProposalStore(process.argv[2]);
    try {
      const proposal = store.getProposal(process.argv[3]);
      const result = store.approveProposalByPolicy(proposal.proposal_id, {
        policy: "routine_schedule",
        proposal_hash: proposal.proposal_hash,
        proposal_version: proposal.proposal_version,
        reason: "routine eligibility verified",
        action_boundary: boundary,
        now: "2026-09-05T12:00:00.000Z",
      });
      process.stdout.write(JSON.stringify({ approved: result.approved, state: result.proposal.state }));
    } finally { store.close(); }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, moduleUrl, storePath, proposalId, JSON.stringify(actionBoundary), readyPath, startPath], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`child failed (${code}): ${stderr}`)));
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed with exit ${result.status}`);
  }
  return result;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("could not allocate an isolated PostgreSQL port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForPostgres(composeProject, composeFile, composeEnv) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = run("docker", ["compose", "-p", composeProject, "-f", composeFile, "exec", "-T", "postgres", "psql", "-U", "synapsor_admin", "-d", "synapsor_fleet", "-tAc", "SELECT pg_postmaster_start_time() > initialized_at FROM public.synapsor_fixture_ready LIMIT 1"], {
      allowFailure: true,
      env: composeEnv,
    });
    if (result.status === 0 && result.stdout.trim() === "t") return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("isolated PostgreSQL fixture did not become ready");
}

function semanticFixture() {
  const exact = { kind: "string", max_length: 64, comparison: "exact" };
  const timestamp = { kind: "timestamp" };
  const status = { kind: "string", max_length: 16, comparison: "exact", enum: ["active", "paused"] };
  const plan = { kind: "string", max_length: 32, comparison: "exact" };
  const fields = [
    { name: "change_id", type: exact, nullable: false },
    { name: "account_id", type: exact, nullable: false },
    { name: "principal_id", type: exact, nullable: false },
    { name: "status", type: status, nullable: false },
    { name: "current_plan", type: plan, nullable: false },
    { name: "offered_from_plan", type: plan, nullable: false },
    { name: "effective_at", type: timestamp, nullable: false },
    { name: "expires_at", type: timestamp, nullable: false },
    { name: "automatic_eligible", type: { kind: "boolean" }, nullable: false },
    { name: "version", type: { kind: "integer" }, nullable: false },
  ];
  const source = "local_postgres";
  const resource = "billing.plan_changes";
  const generation = canonicalJsonDigest({ fixture: "policy-coverage-runtime", revision: 1 });
  const field = (name) => ({ kind: "field", binding: "change", field: name });
  return {
    catalog: {
      schema_version: "synapsor.action-rule-catalog.v1",
      generation_lock_fingerprint: generation,
      resources: [{ name: resource, source, engine: "postgres", schema: "billing", table: "plan_changes", primary_key: "change_id", tenant_key: "account_id", principal_scope_key: "principal_id", version_field: "version", fields }],
      relationships: [],
    },
    verification: {
      schema_version: "synapsor.verification-boundary.v1",
      name: "billing.plan_change_verification",
      source,
      context: "trusted_context",
      generation_lock_fingerprint: generation,
      resources: [{ binding: "change", resource, source: { kind: "subject_ref" }, primary_key: "change_id", version_field: "version", fields, scope: { mode: "columns", tenant_field: "account_id", principal_field: "principal_id" }, cardinality: "one", max_rows: 1, overflow: "unsupported", lock: "for_update" }],
      lock_order: ["change"],
      transaction: { isolation: "repeatable_read", timezone: "UTC" },
    },
    envelope: {
      schema_version: "synapsor.derived-effect-envelope.v1",
      name: "billing.pause_plan_change_effect",
      source,
      operation: "update",
      target_resource: resource,
      target_binding: "change",
      primary_key: "change_id",
      tenant_key: "account_id",
      principal_scope_key: "principal_id",
      conflict_key: "version",
      max_rows: 1,
      allowed_fields: [{ name: "status", type: status, values: ["paused"] }],
      version_advance: { column: "version", strategy: "integer_increment" },
      approval_classes: ["billing.plan_change"],
      writeback: { mode: "direct_sql", supervised_worker: "allowed" },
    },
    rule: {
      schema_version: "synapsor.action-rule.v1",
      name: "billing.pause_expired_plan_change",
      outcome: "billing.pause_expired_plan_change",
      context: "trusted_context",
      source,
      verification_boundary_ref: "billing.plan_change_verification",
      effect_envelope_ref: "billing.pause_plan_change_effect",
      subjects: [{ binding: "change", resource, input: "opaque_subject_ref" }],
      require: { kind: "all", expressions: [
        { kind: "compare", operator: "eq", left: field("status"), right: { kind: "literal", value: "active", value_type: status } },
        { kind: "compare", operator: "lte", left: field("effective_at"), right: { kind: "trusted", binding: "transaction_time" } },
        { kind: "compare", operator: "gt", left: field("expires_at"), right: { kind: "trusted", binding: "transaction_time" } },
        { kind: "compare", operator: "eq", left: field("offered_from_plan"), right: field("current_plan") },
      ] },
      derive: {},
      effect: { operation: "update", target_resource: resource, target_binding: "change", set: { status: { kind: "literal", value: "paused", value_type: status } } },
      approval_class: "billing.plan_change",
      ttl_seconds: 300,
    },
    approvalClass: {
      name: "billing.plan_change",
      mode: "policy",
      rules: [{ outcome: "billing.pause_expired_plan_change", auto_approve_when: { kind: "compare", operator: "eq", left: field("automatic_eligible"), right: { kind: "literal", value: true, value_type: { kind: "boolean" } } } }],
      required_role: "billing_reviewer",
      required_approvals: 1,
      shared_limits: boundary.limits.map((limit) => ({ ...limit, capability: "billing.pause_expired_plan_change" })),
    },
  };
}

async function writeActiveReadSet(projectRoot, generation) {
  const authority = {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "reviewed",
    deployment_profile: "staging",
    source: "local_postgres",
    compiler_version: "policy-coverage-runtime",
    spec_version: "1",
    trusted_context: { provider: "static_dev", tenant_id: "account_northstar", principal: "agent_1" },
    generation_lock_fingerprint: generation,
    role_posture_fingerprint: `sha256:${"b".repeat(64)}`,
    pack: { name: "policy_coverage_read", resources: [] },
    budgets: {},
  };
  const boundary = {
    ...authority,
    activation: { state: "active", digest: canonicalJsonDigest(authority), actor: "runtime verifier", activated_at: new Date().toISOString(), generation_lock_fingerprint: generation, reviewed_decisions: [] },
  };
  const state = path.join(projectRoot, ".synapsor");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "exploration-boundaries.active.json"), `${JSON.stringify({ schema_version: "synapsor.active-exploration-boundaries.v1", selected_name: authority.pack.name, boundaries: [boundary], updated_at: new Date().toISOString() }, null, 2)}\n`);
  return boundary.activation.digest;
}

async function verifySemanticWorkerRuntime(tempDir) {
  const composeFile = path.join(root, "examples", "runner-fleet", "docker-compose.yml");
  const composeProject = `synapsor-policy-runtime-${process.pid}`;
  const port = await availablePort();
  const composeEnv = { SYNAPSOR_FLEET_POSTGRES_PORT: String(port) };
  const urls = {
    admin: `postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:${port}/synapsor_fleet`,
    writer: `postgresql://synapsor_crud_ledger:synapsor_crud_ledger_password@127.0.0.1:${port}/synapsor_fleet`,
  };
  const projectRoot = await fs.mkdtemp(path.join(tempDir, "semantic-worker-"));
  let admin;
  let writer;
  const priorRead = process.env.POLICY_COVERAGE_READ_URL;
  const priorWrite = process.env.POLICY_COVERAGE_WRITE_URL;
  const priorTenant = process.env.SYNAPSOR_TENANT_ID;
  const priorPrincipal = process.env.SYNAPSOR_PRINCIPAL;
  try {
    run("docker", ["compose", "-p", composeProject, "-f", composeFile, "up", "-d", "postgres"], { env: composeEnv });
    await waitForPostgres(composeProject, composeFile, composeEnv);
    admin = new Pool({ connectionString: urls.admin, max: 1 });
    writer = new Pool({ connectionString: urls.writer, max: 1 });
    await admin.query("CREATE SCHEMA IF NOT EXISTS billing");
    await admin.query("DROP TABLE IF EXISTS billing.plan_changes");
    await admin.query(`CREATE TABLE billing.plan_changes (
      change_id text PRIMARY KEY, account_id text NOT NULL, principal_id text NOT NULL, status text NOT NULL,
      current_plan text NOT NULL, offered_from_plan text NOT NULL, effective_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL, automatic_eligible boolean NOT NULL, version bigint NOT NULL
    )`);
    await admin.query("GRANT USAGE ON SCHEMA billing TO synapsor_crud_ledger");
    await admin.query("GRANT SELECT, UPDATE ON billing.plan_changes TO synapsor_crud_ledger");
    const transactionTime = new Date().toISOString();
    const before = new Date(Date.now() - 60_000).toISOString();
    const after = new Date(Date.now() + 3_600_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const expired = new Date(Date.now() - 1_000).toISOString();
    const rows = [
      ["change_queued", "account_northstar", "agent_1", "active", "basic", "basic", before, after, true, 4],
      ["change_stale", "account_northstar", "agent_1", "active", "basic", "basic", before, after, true, 4],
      ["change_human", "account_northstar", "agent_1", "active", "basic", "basic", before, after, false, 4],
      ["change_future", "account_northstar", "agent_1", "active", "basic", "basic", future, after, true, 4],
      ["change_expired", "account_northstar", "agent_1", "active", "basic", "basic", before, expired, true, 4],
      ["change_plan_mismatch", "account_northstar", "agent_1", "active", "premium", "basic", before, after, true, 4],
    ];
    for (const values of rows) await admin.query("INSERT INTO billing.plan_changes VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", values);

    const fixture = semanticFixture();
    const generation = fixture.catalog.generation_lock_fingerprint;
    const readBoundaryDigest = await writeActiveReadSet(projectRoot, generation);
    const activatedAt = new Date().toISOString();
    const draft = buildActionRuleAuthorityDraft({
      name: "policy_coverage_actions",
      action_boundary_name: "policy_coverage_actions",
      catalog: fixture.catalog,
      rules: [{ read_boundary_name: "policy_coverage_read", read_boundary_digest: readBoundaryDigest, verification_boundary: fixture.verification, effect_envelope: fixture.envelope, rule: fixture.rule }],
      approval_classes: [fixture.approvalClass],
      reviews: [{ outcome: fixture.rule.outcome, when: "The plan change is current and valid.", then: "Pause the pending change.", refused: ["The timing or current plan no longer matches."], human_review: "A billing reviewer must approve.", examples: [{ kind: "eligible", scenario: "Current plan change", result: "Create one proposal" }, { kind: "ineligible", scenario: "Expired plan change", result: "Refuse" }] }],
      now: activatedAt,
    });
    await writeActionRuleAuthorityDraft(projectRoot, draft);
    await activateActionRuleAuthority({ projectRoot, name: draft.authority.name, expected_digest: draft.digest, confirmation: `ACTIVATE ${draft.digest}`, actor: "runtime verifier", now: activatedAt });
    const authority = await loadActiveActionRuleAuthority(projectRoot);
    const activated = authority.registry.rules[0];
    assert(activated, "semantic authority did not activate");
    const config = {
      version: 1,
      mode: "review",
      storage: { sqlite_path: "./.synapsor/policy-runtime.db" },
      sources: { local_postgres: { engine: "postgres", read_url_env: "POLICY_COVERAGE_READ_URL", write_url_env: "POLICY_COVERAGE_WRITE_URL", receipts: { authority: "runner_ledger" } } },
      trusted_context: { provider: "static_dev", values: { tenant_id: "account_northstar", principal: "agent_1" } },
      contexts: { trusted_context: { provider: "static_dev", values: { tenant_id: "account_northstar", principal: "agent_1" } } },
      capabilities: [{ name: "billing.inspect_plan_change", kind: "read", source: "local_postgres", target: { schema: "billing", table: "plan_changes", primary_key: "change_id", tenant_key: "account_id", principal_scope_key: "principal_id" }, args: { change_id: { type: "string", required: true } }, lookup: { id_from_arg: "change_id" }, visible_columns: ["status"] }],
      action_rules: { project_root: "." },
      supervised_worker: { enabled: true, profile: "staging", capabilities: [], outcomes: [{ outcome: fixture.rule.outcome, action_boundary_digest: activated.action_boundary_digest, mode: "supervised_worker", concurrency: 1, queue_limit: 10, lease_seconds: 60, max_attempts: 1, proposal_ttl_seconds: 3_600, rate_limit: { executions: 10, window_seconds: 60 }, write_url_env: "POLICY_COVERAGE_WRITE_URL", worker_identity: "policy_runtime_worker", require_least_privilege_writer: false }] },
    };
    const configPath = path.join(projectRoot, "synapsor.runner.json");
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const storePath = path.join(projectRoot, ".synapsor", "policy-runtime.db");
    const factLoader = createPostgresActionRuleFactLoader(writer);
    const evaluate = async (changeId, proposalId) => evaluateSemanticActionEligibility({
      registry: authority.registry,
      outcome: fixture.rule.outcome,
      subjects: [{ binding: "change", resource: "billing.plan_changes", primary_key: { column: "change_id", value: changeId }, subject_ref_digest: canonicalJsonDigest({ changeId }) }],
      trusted: { tenant: "account_northstar", principal: "agent_1", transaction_time: transactionTime },
      adapter: factLoader,
      proposal_id: proposalId,
      trusted_context_digest: canonicalJsonDigest({ tenant: "account_northstar", principal: "agent_1" }),
      evidence_provenance_digest: canonicalJsonDigest({ changeId, source: "isolated-postgres" }),
      verified_at: transactionTime,
    });
    const auto = await evaluate("change_queued", "semantic_queued");
    const human = await evaluate("change_human", "semantic_human");
    assert(auto.result === "eligible" && auto.approval.path === "automatic_eligible", "eligible current plan change was not automatically eligible", auto);
    assert(human.result === "eligible" && human.approval.path === "human_review", "valid non-automatic plan change did not fall back to human review", human);
    for (const changeId of ["change_future", "change_expired", "change_plan_mismatch"]) {
      const invalid = await evaluate(changeId, `semantic_${changeId}`);
      assert(invalid.result === "ineligible" && !("semantic_authority" in invalid), `${changeId} did not refuse invalid eligibility`, invalid);
    }
    const store = new ProposalStore(storePath);
    try {
      const createFromDecision = (decision, proposalId, autoApprove) => {
        assert(decision.result === "eligible", "cannot persist an ineligible semantic decision", decision);
        const changeSet = buildDerivedChangeSet({ decision, context: { tenant_id: "account_northstar", principal: "agent_1", provenance: "static_dev" }, proposalId, createdAt: transactionTime, evidenceBundleId: `evidence_${proposalId}`, queryFingerprint: canonicalJsonDigest({ proposalId }) });
        const proposal = store.createProposal(changeSet);
        if (autoApprove) store.approveProposalByPolicy(proposal.proposal_id, { policy: decision.approval.authority.name, proposal_hash: proposal.proposal_hash, proposal_version: proposal.proposal_version, reason: "reviewed automatic eligibility", action_boundary: { name: decision.activated.action_boundary_name, digest: decision.activated.action_boundary_digest, limits: decision.approval.authority.shared_limits }, now: transactionTime });
        return proposal;
      };
      const queued = createFromDecision(auto, "semantic_queued", true);
      const humanProposal = createFromDecision(human, "semantic_human", false);
      assert(store.getProposal(humanProposal.proposal_id).state === "pending_review", "valid non-automatic proposal did not remain for human approval");
      await enqueueApprovedForSupervisedWorker(store, config, configPath, {});
      assert(store.getProposal(queued.proposal_id).state === "approved", "stopped worker changed the approved proposal before execution", { proposal: store.getProposal(queued.proposal_id), queue: store.getWorkerQueueItem(queued.proposal_id) });
      assert(store.getWorkerQueueItem(queued.proposal_id)?.status === "queued", "stopped worker queue state was not queued");
      assert((await admin.query("SELECT status, version FROM billing.plan_changes WHERE change_id = 'change_queued'")).rows[0].status === "active", "stopped worker changed source data");
      assert(store.receipts(queued.proposal_id).length === 0, "stopped worker produced a receipt before execution");
    } finally { store.close(); }
    process.env.POLICY_COVERAGE_READ_URL = urls.writer;
    process.env.POLICY_COVERAGE_WRITE_URL = urls.writer;
    process.env.SYNAPSOR_TENANT_ID = "account_northstar";
    process.env.SYNAPSOR_PRINCIPAL = "agent_1";
    assert(await workerCommand(["run", "--supervised", "--once", "--yes", "--config", configPath, "--store", storePath, "--worker-id", "policy_runtime_worker", "--batch-quiet"]) === 0, "semantic worker did not complete queued work");
    const appliedStore = new ProposalStore(storePath);
    try {
      assert(appliedStore.getProposal("semantic_queued").state === "applied", "semantic worker did not apply eligible proposal", { proposal: appliedStore.getProposal("semantic_queued"), queue: appliedStore.getWorkerQueueItem("semantic_queued"), receipts: appliedStore.receipts("semantic_queued") });
      assert(appliedStore.getWorkerQueueItem("semantic_queued")?.status === "completed" && appliedStore.getWorkerQueueItem("semantic_queued")?.terminal_outcome === "applied", "semantic worker queue item was not completed");
      assert(appliedStore.receipts("semantic_queued").at(-1)?.receipt.status === "applied", "semantic worker did not persist an applied receipt");
    } finally { appliedStore.close(); }
    const appliedRow = (await admin.query("SELECT status, version FROM billing.plan_changes WHERE change_id = 'change_queued'")).rows[0];
    assert(appliedRow.status === "paused" && Number(appliedRow.version) === 5, "semantic worker did not apply exactly the reverified source effect", appliedRow);

    const stale = await evaluate("change_stale", "semantic_stale");
    const staleStore = new ProposalStore(storePath);
    try {
      assert(stale.result === "eligible", "stale fixture was not initially eligible", stale);
      const changeSet = buildDerivedChangeSet({ decision: stale, context: { tenant_id: "account_northstar", principal: "agent_1", provenance: "static_dev" }, proposalId: "semantic_stale", createdAt: transactionTime, evidenceBundleId: "evidence_semantic_stale", queryFingerprint: canonicalJsonDigest({ proposalId: "semantic_stale" }) });
      const proposal = staleStore.createProposal(changeSet);
      staleStore.approveProposalByPolicy(proposal.proposal_id, { policy: stale.approval.authority.name, proposal_hash: proposal.proposal_hash, proposal_version: proposal.proposal_version, reason: "reviewed automatic eligibility", action_boundary: { name: stale.activated.action_boundary_name, digest: stale.activated.action_boundary_digest, limits: stale.approval.authority.shared_limits }, now: transactionTime });
      await enqueueApprovedForSupervisedWorker(staleStore, config, configPath, {});
    } finally { staleStore.close(); }
    await admin.query("UPDATE billing.plan_changes SET current_plan = 'changed_before_execution' WHERE change_id = 'change_stale'");
    assert(await workerCommand(["run", "--supervised", "--once", "--yes", "--config", configPath, "--store", storePath, "--worker-id", "policy_runtime_worker", "--batch-quiet"]) === 0, "semantic worker did not safely process stale work");
    const staleAfter = new ProposalStore(storePath);
    try {
      assert(staleAfter.getProposal("semantic_stale").state !== "applied", "stale semantic proposal was applied");
      assert(staleAfter.receipts("semantic_stale").at(-1)?.receipt.safe_error_code === "SEMANTIC_AUTHORITY_STALE", "stale semantic proposal did not retain the safe stale-evidence code", staleAfter.receipts("semantic_stale"));
    } finally { staleAfter.close(); }
    const staleRow = (await admin.query("SELECT status, version FROM billing.plan_changes WHERE change_id = 'change_stale'")).rows[0];
    assert(staleRow.status === "active" && Number(staleRow.version) === 4, "stale semantic work changed the source row", staleRow);
    process.stdout.write("PASS semantic supervised worker: stopped-worker queue, actual eligible apply with receipt, stale-fact refusal, valid human fallback, and start/expiry/current-plan refusals\n");
  } finally {
    if (priorRead === undefined) delete process.env.POLICY_COVERAGE_READ_URL;
    else process.env.POLICY_COVERAGE_READ_URL = priorRead;
    if (priorWrite === undefined) delete process.env.POLICY_COVERAGE_WRITE_URL;
    else process.env.POLICY_COVERAGE_WRITE_URL = priorWrite;
    if (priorTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID;
    else process.env.SYNAPSOR_TENANT_ID = priorTenant;
    if (priorPrincipal === undefined) delete process.env.SYNAPSOR_PRINCIPAL;
    else process.env.SYNAPSOR_PRINCIPAL = priorPrincipal;
    await writer?.end();
    await admin?.end();
    run("docker", ["compose", "-p", composeProject, "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true, env: composeEnv });
  }
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-policy-coverage-runtime-"));
try {
  const store = new ProposalStore(path.join(tempDir, "limits.db"));
  try {
    for (let index = 0; index < 3; index += 1) {
      assert(create(store, `account_${index}`, "account_northstar", `agent_${index + 1}`).approved, "first three account actions must auto-approve");
    }
    const accountOverage = create(store, "account_overage", "account_northstar", "agent_4");
    assert(!accountOverage.approved && accountOverage.proposal.state === "pending_review", "valid account-limit overage must defer to human review", accountOverage);

    for (let index = 0; index < 7; index += 1) {
      assert(create(store, `capability_${index}`, `account_${index + 2}`, "agent_1").approved, "remaining capability budget must auto-approve");
    }
    const capabilityOverage = create(store, "capability_overage", "account_99", "agent_1");
    assert(!capabilityOverage.approved && capabilityOverage.proposal.state === "pending_review", "valid capability-limit overage must defer to human review", capabilityOverage);
    assert(capabilityOverage.tripped_limits.some((limit) => limit.id === "capability_24h"), "capability overage must identify the tripped rolling limit", capabilityOverage);
    process.stdout.write("PASS rolling 24h limits: 3 per tenant account across principals and 10 per capability defer valid overages to human review\n");
  } finally { store.close(); }

  const concurrencyBoundary = { ...boundary, limits: [{ ...boundary.limits[0], maximum: 1 }] };
  const sequentialStore = new ProposalStore(path.join(tempDir, "sequential.db"));
  try {
    assert(create(sequentialStore, "sequential_one", "account_one", "agent_one", concurrencyBoundary).approved, "first sequential capability action must auto-approve");
    const deferred = create(sequentialStore, "sequential_two", "account_two", "agent_two", concurrencyBoundary);
    assert(!deferred.approved && deferred.proposal.state === "pending_review", "sequential one-action overage must defer to human review", deferred);
  } finally { sequentialStore.close(); }
  process.stdout.write("PASS sequential control: one-action capability limit defers the second approval\n");

  const rollbackStore = new ProposalStore(path.join(tempDir, "rollback.db"));
  try {
    const first = rollbackStore.createProposal(changeSet("rollback_one", "account_one", "agent_one"));
    let invalidHashRefused = false;
    try { approve(rollbackStore, first, concurrencyBoundary, "sha256:wrong"); }
    catch (error) { invalidHashRefused = error?.code === "PROPOSAL_HASH_MISMATCH"; }
    assert(invalidHashRefused, "invalid policy delivery must be refused before reserving a limit slot");
    assert(rollbackStore.approvals(first.proposal_id).length === 0, "refused policy delivery left an approval reservation");
    assert(approve(rollbackStore, first, concurrencyBoundary).approved, "valid retry after rollback must reserve the first slot");
    let duplicateRefused = false;
    try { approve(rollbackStore, first, concurrencyBoundary); }
    catch (error) { duplicateRefused = error?.code === "PROPOSAL_NOT_PENDING_REVIEW"; }
    assert(duplicateRefused, "duplicate delivery must not create a second policy approval");
    assert(rollbackStore.approvals(first.proposal_id).length === 1, "duplicate delivery created an extra approval record");
    const second = create(rollbackStore, "rollback_two", "account_two", "agent_two", concurrencyBoundary);
    assert(!second.approved && second.proposal.state === "pending_review", "duplicate or refused delivery consumed the wrong limit capacity", second);
  } finally { rollbackStore.close(); }
  process.stdout.write("PASS rollback and duplicate delivery: invalid delivery reserves nothing and a duplicate has no second approval or slot\n");

  for (let round = 0; round < 5; round += 1) {
    const concurrentPath = path.join(tempDir, `concurrent-${round}.db`);
    const concurrentStore = new ProposalStore(concurrentPath);
    try {
      for (const id of ["concurrent_one", "concurrent_two"]) {
        concurrentStore.createProposal(changeSet(`${id}_${round}`, `account_${id}`, "agent_1"));
      }
    } finally { concurrentStore.close(); }
    const startPath = path.join(tempDir, `start-${round}`);
    const readyPaths = [path.join(tempDir, `ready-${round}-one`), path.join(tempDir, `ready-${round}-two`)];
    const pending = [
      runChild(concurrentPath, `concurrent_one_${round}`, concurrencyBoundary, readyPaths[0], startPath),
      runChild(concurrentPath, `concurrent_two_${round}`, concurrencyBoundary, readyPaths[1], startPath),
    ];
    await waitForPaths(readyPaths);
    await fs.writeFile(startPath, "go");
    const results = await Promise.all(pending);
    assert(results.filter((result) => result.approved).length === 1, "concurrent policy approvals exceeded the one-action limit", { round, results });
    const checked = new ProposalStore(concurrentPath);
    try {
      assert(checked.listProposals({ state: "approved" }).length === 1, "ledger retained more than one concurrent approval");
      assert(checked.listProposals({ state: "pending_review" }).length === 1, "valid concurrent overage was not left for human review");
    } finally { checked.close(); }
  }
  process.stdout.write("PASS concurrency: barrier-synchronized OS processes reserve one rolling-limit slot atomically across five rounds\n");

  await verifySemanticWorkerRuntime(tempDir);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

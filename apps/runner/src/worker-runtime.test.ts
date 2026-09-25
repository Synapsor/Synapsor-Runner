import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { readRuntimeConfig } from "./cli-project.js";
import { applyProposal } from "./guarded-apply.js";
import { waitFor } from "./cli-options.js";
import { assessUnstartedSemanticQueueAuthority, isRetryableWritebackCode, workerCommand, workerFailureRecovery, workerQueueAuthorityHumanLines } from "./worker-runtime.js";
import { workerCancellationRequiredRole } from "./worker-cancellation-authority.js";
import * as workerLaunch from "./worker-launch.js";

vi.mock("./cli-project.js", async (original) => ({ ...await original<typeof import("./cli-project.js")>(), readRuntimeConfig: vi.fn() }));
vi.mock("./guarded-apply.js", () => ({ applyProposal: vi.fn() }));
vi.mock("./cli-options.js", async (original) => ({ ...await original<typeof import("./cli-options.js")>(), waitFor: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks(); vi.mocked(readRuntimeConfig).mockReset(); vi.mocked(applyProposal).mockReset();
  vi.mocked(waitFor).mockReset();
  for (const root of roots.splice(0)) await fs.rm(root, { force: true, recursive: true });
});

describe("controlled delegation worker diagnostics", () => {
  const failures = [
    ["DELEGATION_SOURCE_SCOPE_UNSUPPORTED", "approved proposal and reviewed source-scope"],
    ["DELEGATION_JOB_CHANGED", "fresh request"],
    ["DELEGATION_PROOF_REQUIRED", "approved proposal and reviewed delegation"],
    ["DELEGATION_PROOF_INVALID", "approved proposal and reviewed delegation"],
    ["DELEGATION_CHANGED", "fresh request"],
    ["DELEGATION_PARENT_CHANGED", "fresh request"],
    ["DELEGATION_REQUEST_REFUSED", "current eligibility"],
    ["DELEGATION_NOT_AVAILABLE", "current eligibility"],
    ["DELEGATION_CONFIGURATION_INVALID", "approved proposal and reviewed delegation"],
    ["DELEGATION_AUTHENTICATION_FAILED", "fresh authenticated request"],
    ["DELEGATION_BUDGET_UNAVAILABLE", "budget definitions and exact effect charges"],
    ["DELEGATION_BUDGET_CHARGE_NOT_PROVEN", "budget definitions and exact effect charges"],
    ["DELEGATION_BUDGET_INCOMPATIBLE", "budget definitions and exact effect charges"],
    ["DELEGATION_BUDGET_LIMIT", "budget definitions and exact effect charges"],
    ["DELEGATION_EFFECT_RECONCILIATION_REQUIRED", "Reconcile the exact proposal"],
    ["RUNTIME_PROOF_UNAVAILABLE", "reviewed delegation binding and stored proof integrity"],
    ["RUNTIME_PROOF_EXPIRED", "fresh authenticated request"],
    ["RUNTIME_PROOF_INTEGRITY_INVALID", "reviewed delegation binding and stored proof integrity"],
  ] as const;

  it.each(failures)("reports %s safely in worker logs and read-only operator details without retrying", async (code, guidance) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-worker-delegation-diagnostic-")); roots.push(root);
    const storePath = path.join(root, "local.db"), configPath = path.join(root, "missing.runner.json");
    const config: RuntimeConfig = { version: 1, mode: "review", capabilities: [], storage: { sqlite_path: storePath } };
    vi.mocked(readRuntimeConfig).mockResolvedValue(config);
    vi.mocked(applyProposal).mockRejectedValue(Object.assign(new Error("private-principal postgres://user:private-password@host/db token=private-token"), { code }));
    const initial = new ProposalStore(storePath);
    try {
      initial.createProposal({ schema_version: "synapsor.change-set.v1", proposal_id: "wrp_diagnostic", proposal_version: 1,
        action: "inventory.correct", mode: "review_required", principal: { id: "private-principal", source: "trusted_session" },
        scope: { tenant_id: "private-tenant", business_object: "item", object_id: "item-1" },
        source: { kind: "external_postgres", source_id: "fixture", schema: "inventory", table: "items", primary_key: { column: "id", value: "item-1" } },
        before: { quantity: 1 }, patch: { quantity: 2 }, after: { quantity: 2 },
        guards: { tenant: { column: "tenant_id", value: "private-tenant" }, allowed_columns: ["quantity"], expected_version: { column: "version", value: 1 } },
        evidence: { bundle_id: "ev_diagnostic", query_fingerprint: "sha256:evidence", items: [] },
        approval: { status: "pending", required_role: "reviewer" }, writeback: { status: "not_applied", mode: "trusted_worker_required" },
        source_database_mutated: false, integrity: { proposal_hash: "sha256:diagnostic" }, created_at: new Date().toISOString() });
      initial.approveProposal("wrp_diagnostic", { approver: "reviewer", proposal_hash: "sha256:diagnostic", proposal_version: 1 });
    } finally { initial.close(); }
    const logs = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const args = ["run", "--once", "--batch-quiet", "--yes", "--worker-id", "diagnostic_worker", "--config", configPath, "--store", storePath];
    expect(await workerCommand(args)).toBe(0);
    expect(await workerCommand(args)).toBe(0);
    expect(applyProposal).toHaveBeenCalledOnce();
    expect(isRetryableWritebackCode(code, "supervised_worker")).toBe(false);
    expect(isRetryableWritebackCode(code, "legacy")).toBe(false);
    const recovery = workerFailureRecovery(code);
    expect(recovery).toContain(guidance);
    expect(recovery!.length).toBeLessThanOrEqual(200);
    const logText = logs.mock.calls.map(([text]) => String(text)).join("");
    const failed = logText.trim().split("\n").map(line => JSON.parse(line)).find(event => event.event === "worker_item_dead_lettered");
    expect(failed).toMatchObject({ error_code: code, recovery, attempt: 1 });
    expect(logText).not.toMatch(/private-|postgres:\/\/|worker_retry_scheduled|<redacted>/);
    const store = new ProposalStore(storePath);
    try {
      const snapshot = { item: store.getWorkerQueueItem("wrp_diagnostic"), proposal: store.getProposal("wrp_diagnostic"), events: store.events("wrp_diagnostic") };
      expect(snapshot.item).toMatchObject({ status: "dead_letter", attempts: 1, last_error_code: code });
      const show = ["dead-letter", "show", "wrp_diagnostic", "--config", configPath, "--store", storePath];
      expect(await workerCommand(show)).toBe(0);
      const text = output.mock.calls.map(([value]) => String(value)).join("");
      expect(text).toContain(`Last safe error: ${code}`);
      expect(text).toContain(`Next: ${recovery}`);
      expect(text).not.toMatch(/private-|postgres:\/\//);
      output.mockClear();
      expect(await workerCommand([...show, "--json"])).toBe(0);
      expect(JSON.parse(output.mock.calls.map(([value]) => String(value)).join("")).recovery).toBe(recovery);
      output.mockClear();
      expect(await workerCommand(["status", "--config", configPath, "--store", storePath])).toBe(0);
      expect(output.mock.calls.map(([value]) => String(value)).join("")).toContain(`Next: ${recovery}`);
      expect({ item: store.getWorkerQueueItem("wrp_diagnostic"), proposal: store.getProposal("wrp_diagnostic"), events: store.events("wrp_diagnostic") }).toEqual(snapshot);
      expect(store.receipts("wrp_diagnostic")).toEqual([]);
    } finally { store.close(); }
  });

  it.each(["OUTCOME_UNKNOWN", "RECONCILIATION_REQUIRED", "RECEIPT_OUTCOME_UNKNOWN", "DELEGATION_EFFECT_RECONCILIATION_REQUIRED"])("requires exact receipt reconciliation, not a retry, for %s", code => {
    expect(workerFailureRecovery(code)).toMatch(/Reconcile the exact proposal.*receipt.*Do not retry or requeue/);
    expect(workerFailureRecovery(code)).not.toMatch(/unchanged|no (source )?(write|effect)|fresh request/);
    expect(isRetryableWritebackCode(code, "supervised_worker")).toBe(false);
  });

  it("prioritizes unknown dispatch state over a changed-authority error", () => {
    expect(workerFailureRecovery("DELEGATION_CHANGED", "reconciliation_required")).toContain("Do not retry or requeue");
    expect(workerFailureRecovery("DELEGATION_CHANGED", "reconciliation_required")).not.toContain("fresh request");
  });

  it.each([null, "DELEGATION_UNKNOWN", "DELEGATION_CHANGED private-token", "DELEGATION_SOURCE_SCOPE_UNSUPPORTED\nsecret", "DELEGATION_JOB_CHANGED_SUFFIX", "RUNTIME_PROOF_EXPIRED_SUFFIX", "RUNTIME_PROOF_UNAVAILABLE private-token"])("does not infer a recovery action from unrecognized code %s", code => {
    expect(workerFailureRecovery(code)).toBeUndefined();
    if (code) expect(isRetryableWritebackCode(code, "supervised_worker")).toBe(false);
  });

  it("keeps the existing narrow retry distinction for transport failures", () => {
    expect(isRetryableWritebackCode("DATABASE_UNAVAILABLE", "supervised_worker")).toBe(true);
    expect(isRetryableWritebackCode("HANDLER_TIMEOUT", "supervised_worker")).toBe(false);
    expect(isRetryableWritebackCode("HANDLER_TIMEOUT", "legacy")).toBe(true);
    expect(isRetryableWritebackCode("WORKER_EXECUTION_ERROR", "supervised_worker")).toBe(false);
    expect(workerFailureRecovery("DATABASE_UNAVAILABLE")).toBeUndefined();
  });
});

describe("read-only semantic queue authority status", () => {
  const oldDigest = `sha256:${"a".repeat(64)}` as const;
  const currentDigest = `sha256:${"b".repeat(64)}` as const;
  const item = {
    proposal_id: "wrp_old_rule", status: "queued", execution_mode: "supervised_worker", contract_digest: oldDigest,
    attempts: 0, max_attempts: 3, next_attempt_at: "2026-09-10T00:00:00.000Z",
    created_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z",
  } as const;
  const semanticProposal = { change_set: { schema_version: "synapsor.change-set.v4" } } as unknown as import("@synapsor-runner/proposal-store").StoredProposal;

  it("identifies an unstarted old semantic queue digest as blocked without mutating the queue or proposal", () => {
    const before = structuredClone({ item, semanticProposal });
    expect(assessUnstartedSemanticQueueAuthority(item, semanticProposal, currentDigest)).toEqual({
      state: "blocked_by_changed_rules", queued_action_boundary_digest: oldDigest, current_action_boundary_digest: currentDigest,
    });
    expect({ item, semanticProposal }).toEqual(before);
  });

  it("renders the stale rule recovery as a copyable cancellation for the exact request, without digest jargon", () => {
    const assessment = assessUnstartedSemanticQueueAuthority(item, semanticProposal, currentDigest)!;
    expect(workerQueueAuthorityHumanLines(assessment, item.proposal_id, "/tmp/generated actions.runner.json")).toEqual([
      "Blocked: the rules changed before this request started.",
      "Inspect the exact request. Cancellation, if available to a separately authorized control actor, uses synapsor-runner worker cancel wrp_old_rule --yes --config '/tmp/generated actions.runner.json'. This status does not establish that such an actor is configured.",
      "Only after this active request is lawfully resolved, read again and submit a fresh request under the current rules.",
      "Warning: do not cancel leased, dispatched, or reconciliation-required work; inspect its receipt instead.",
    ]);
  });

  it("labels a matching queued digest as current authority only, not execution eligibility", () => {
    expect(assessUnstartedSemanticQueueAuthority(item, semanticProposal, oldDigest)).toEqual({
      state: "current_authority_digest_matches", queued_action_boundary_digest: oldDigest, current_action_boundary_digest: oldDigest,
    });
  });

  it("returns unknown when current semantic authority is unavailable and does not classify leased or attempted work", () => {
    expect(assessUnstartedSemanticQueueAuthority(item, semanticProposal, undefined)).toEqual({
      state: "unknown", reason: "CURRENT_SEMANTIC_AUTHORITY_UNAVAILABLE",
    });
    expect(assessUnstartedSemanticQueueAuthority({ ...item, attempts: 1 }, semanticProposal, currentDigest)).toBeUndefined();
    expect(assessUnstartedSemanticQueueAuthority({ ...item, status: "leased" }, semanticProposal, currentDigest)).toBeUndefined();
  });
});

describe("worker cancellation authority continuity", () => {
  const oldDigest = `sha256:${"a".repeat(64)}` as const;
  const newDigest = `sha256:${"b".repeat(64)}` as const;
  const legacyQueue = {
    proposal_id: "wrp_old", status: "queued" as const, execution_mode: "supervised_worker" as const, contract_digest: oldDigest,
    attempts: 0, max_attempts: 3, next_attempt_at: "2026-09-10T00:00:00.000Z", created_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z",
  };

  it("uses the queue snapshot after an Action digest changes", () => {
    expect(workerCancellationRequiredRole({
      queue: { ...legacyQueue, cancellation_control_role: "old_worker_operator" },
      exactCurrentPolicy: { outcome: "billing.waive_late_fee", action_boundary_digest: newDigest, mode: "supervised_worker", concurrency: 1, queue_limit: 1, lease_seconds: 60, max_attempts: 1, proposal_ttl_seconds: 60, rate_limit: { executions: 1, window_seconds: 60 }, write_url_env: "WRITER", control_role: "new_worker_operator" },
      production: true,
    })).toBe("old_worker_operator");
  });

  it("retains an explicitly reviewed no-role policy after an Action digest changes", () => {
    expect(workerCancellationRequiredRole({
      queue: { ...legacyQueue, cancellation_control_role: null },
      exactCurrentPolicy: undefined,
      production: true,
    })).toBeUndefined();
  });

  it("uses the original exact-digest worker configuration for legacy cancellation or fails closed with recovery guidance", () => {
    const policy = { capability: "billing.waive_late_fee", contract_digest: oldDigest, mode: "supervised_worker" as const, concurrency: 1, queue_limit: 1, lease_seconds: 60, max_attempts: 1, proposal_ttl_seconds: 60, rate_limit: { executions: 1, window_seconds: 60 }, write_url_env: "WRITER", control_role: "legacy_operator" };
    expect(workerCancellationRequiredRole({ queue: legacyQueue, exactCurrentPolicy: policy, production: true })).toBe("legacy_operator");
    expect(() => workerCancellationRequiredRole({ queue: legacyQueue, exactCurrentPolicy: undefined, production: true }))
      .toThrow(/WORKER_CANCEL_PRIOR_AUTHORITY_UNAVAILABLE.*original reviewed worker --config.*signed operator identity/);
  });
});

describe("supervised worker current execution policy", () => {
  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-worker-policy-refresh-")); roots.push(root);
    const storePath = path.join(root, "control.db");
    // This existing unit fixture substitutes readRuntimeConfig and applyProposal
    // and has no saved semantic authority. Keep it focused on policy refresh and
    // identity precedence. Real launch assessment and nonempty-queue refusal are
    // covered through actual saved authority in semantic-writeback-authority.
    vi.spyOn(workerLaunch, "assessWorkerLaunch").mockResolvedValue({
      config_path: path.join(root, "runner.json"), scope: "inventory.replenish",
      coverage: "selected_semantic_outcome", local_identity: "environment_or_other_trusted_provider",
      inputs: [], issues: [], execution_enabled: true, execution_binding: "current",
      receipt: { mode: "runner_ledger", selected_mode: null, matches_execution_configuration: null,
        selection: "unverified", live_verification: "not_performed" },
      apply_identity: { state: "unassessed", verified: false },
    });
    const config: RuntimeConfig = { version: 1, mode: "review", capabilities: [],
      trusted_context: { provider: "environment" },
      action_rules: { project_root: root }, storage: { sqlite_path: storePath },
      sources: { local_postgres: { engine: "postgres", read_url_env: "READER_URL", write_url_env: "WRITER_URL",
        receipts: { authority: "runner_ledger" } } },
      supervised_worker: { enabled: true, profile: "staging", capabilities: [], outcomes: [{
        outcome: "inventory.replenish", action_boundary_digest: `sha256:${"a".repeat(64)}`,
        mode: "supervised_worker", concurrency: 1, queue_limit: 10, lease_seconds: 60, max_attempts: 3,
        proposal_ttl_seconds: 300, rate_limit: { executions: 10, window_seconds: 60 }, write_url_env: "WRITER_URL",
      }] } };
    return { storePath, config, args: ["run", "--supervised", "--once", "--batch-quiet", "--yes",
      "--config", path.join(root, "runner.json"), "--store", storePath] };
  }

  it("uses the single reviewed worker identity when the documented command omits --worker-id", async () => {
    vi.stubEnv("SYNAPSOR_RUNNER_ID", undefined);
    const { config, args } = await fixture();
    config.supervised_worker!.outcomes![0]!.worker_identity = "semantic_action_worker";
    vi.mocked(readRuntimeConfig).mockResolvedValue(config);
    const events = vi.spyOn(ProposalStore.prototype, "recordAttentionEvent");
    expect(await workerCommand(args)).toBe(0);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ event_type: "worker.started",
      details: expect.objectContaining({ worker_identity: "semantic_action_worker" }) }));
  });

  it("announces a running idle worker once and stops cleanly without implying a completed effect", async () => {
    const { config, args } = await fixture();
    vi.mocked(readRuntimeConfig).mockResolvedValue(config);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const before = process.listenerCount("SIGINT");
    vi.mocked(waitFor).mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      process.emit("SIGINT");
      expect(process.listenerCount("SIGINT")).toBe(before + 1);
      process.emit("SIGINT");
    });
    expect(await workerCommand(args.filter((arg) => !["--once", "--batch-quiet"].includes(arg)))).toBe(0);
    const text = output.mock.calls.map(([value]) => String(value)).join("");
    expect(text.match(/Worker started\./g)).toHaveLength(1);
    expect(text).toContain("each execution still requires current authority");
    expect(text).toContain("Ctrl-C stops the worker; saved rules and queued requests remain");
    expect(text).not.toMatch(/completed|healthy|ready for customer/i);
    expect(applyProposal).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it.each(["--once", "--drain", "--batch-quiet", "--json"])("does not add a daemon banner in %s mode", async (mode) => {
    const { config, args } = await fixture();
    vi.mocked(readRuntimeConfig).mockResolvedValue(config);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.mocked(waitFor).mockImplementation(async () => { process.emit("SIGINT"); });
    expect(await workerCommand([...args.filter((arg) => !["--once", "--batch-quiet"].includes(arg)), mode])).toBe(0);
    expect(output).not.toHaveBeenCalled();
    expect(applyProposal).not.toHaveBeenCalled();
  });

  it("does not announce startup when reviewed worker identity validation fails", async () => {
    const { config, args } = await fixture();
    config.supervised_worker!.outcomes![0]!.worker_identity = "reviewed_worker";
    vi.mocked(readRuntimeConfig).mockResolvedValue(config);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(workerCommand([...args.filter((arg) => !["--once", "--batch-quiet"].includes(arg)), "--worker-id", "wrong_worker"]))
      .rejects.toMatchObject({ code: "SUPERVISED_WORKER_IDENTITY_MISMATCH" });
    expect(output).not.toHaveBeenCalled();
  });

  it.each(["argument", "environment"])("refuses an explicit wrong %s identity before touching the queue", async (source) => {
    vi.stubEnv("SYNAPSOR_RUNNER_ID", source === "environment" ? "wrong_worker" : undefined);
    const { config, args } = await fixture();
    config.supervised_worker!.outcomes![0]!.worker_identity = "semantic_action_worker";
    vi.mocked(readRuntimeConfig).mockResolvedValue(config);
    const claim = vi.spyOn(ProposalStore.prototype, "claimWorkerItem");
    const events = vi.spyOn(ProposalStore.prototype, "recordAttentionEvent");
    await expect(workerCommand([...args, ...(source === "argument" ? ["--worker-id", "wrong_worker"] : [])]))
      .rejects.toMatchObject({ code: "SUPERVISED_WORKER_IDENTITY_MISMATCH",
        message: expect.stringMatching(/--worker-id.*semantic_action_worker/) });
    expect(claim).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
    expect(applyProposal).not.toHaveBeenCalled();
  });

  it("requires selection for distinct reviewed identities, and honors an exact capability filter", async () => {
    vi.stubEnv("SYNAPSOR_RUNNER_ID", undefined);
    const { config, args } = await fixture();
    const policy = config.supervised_worker!.outcomes![0]!;
    policy.worker_identity = "stockroom_worker";
    config.supervised_worker!.outcomes!.push({ ...policy, outcome: "billing.pause", worker_identity: "billing_worker" });
    vi.mocked(readRuntimeConfig).mockResolvedValue(config);
    await expect(workerCommand(args)).rejects.toMatchObject({ code: "SUPERVISED_WORKER_IDENTITY_AMBIGUOUS",
      message: expect.stringContaining("--capability") });
    const events = vi.spyOn(ProposalStore.prototype, "recordAttentionEvent");
    expect(await workerCommand([...args, "--capability", policy.outcome])).toBe(0);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ event_type: "worker.started",
      details: expect.objectContaining({ worker_identity: "stockroom_worker" }) }));
    expect(await workerCommand([...args, "--worker-id", "billing_worker"])).toBe(0);
  });

  it("retains legacy identity precedence and defaults for unpinned policies", async () => {
    vi.stubEnv("SYNAPSOR_RUNNER_ID", "environment_worker");
    const { config, args } = await fixture();
    vi.mocked(readRuntimeConfig).mockResolvedValue(config);
    const events = vi.spyOn(ProposalStore.prototype, "recordAttentionEvent");
    for (const [extra, expected] of [[[], "environment_worker"], [["--worker-id", "argument_worker"], "argument_worker"]] as const) {
      expect(await workerCommand([...args, ...extra])).toBe(0);
      expect(events).toHaveBeenCalledWith(expect.objectContaining({ event_type: "worker.started",
        details: expect.objectContaining({ worker_identity: expected }) }));
    }
    vi.stubEnv("SYNAPSOR_RUNNER_ID", undefined);
    expect(await workerCommand(args)).toBe(0);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ event_type: "worker.started",
      details: expect.objectContaining({ worker_identity: `worker_${process.pid}` }) }));
  });

  it("does not adopt a supervised identity for the legacy worker command", async () => {
    vi.stubEnv("SYNAPSOR_RUNNER_ID", undefined);
    const { config, args } = await fixture();
    config.supervised_worker!.outcomes![0]!.worker_identity = "semantic_action_worker";
    vi.mocked(readRuntimeConfig).mockResolvedValue(config);
    const events = vi.spyOn(ProposalStore.prototype, "recordAttentionEvent");
    expect(await workerCommand(args.filter((arg) => arg !== "--supervised"))).toBe(0);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ event_type: "worker.started",
      details: expect.objectContaining({ worker_identity: `worker_${process.pid}`, execution_mode: "legacy" }) }));
  });

  it("deduplicates reviewed identities across outcomes and legacy capabilities", async () => {
    vi.stubEnv("SYNAPSOR_RUNNER_ID", undefined);
    const { config, args } = await fixture();
    const outcome = config.supervised_worker!.outcomes![0]!;
    outcome.worker_identity = "shared_reviewed_worker";
    const { outcome: _name, action_boundary_digest, ...limits } = outcome;
    config.supervised_worker!.capabilities.push({ ...limits, capability: "billing.pause",
      contract_digest: action_boundary_digest });
    config.capabilities!.push({ name: "billing.pause", kind: "proposal", source: "local_postgres",
      contract_provenance: { digest: action_boundary_digest, version: "1" },
      target: { schema: "billing", table: "preferences", primary_key: "id", tenant_key: "tenant_id" },
      args: { id: { type: "string", required: true } }, lookup: { id_from_arg: "id" }, visible_columns: ["status"],
      patch: { status: { fixed: "paused" } }, allowed_columns: ["status"], conflict_guard: { column: "version" },
      operation: { kind: "update", version_advance: { column: "version", strategy: "integer_increment" } },
      approval: { mode: "human", required_role: "reviewer", required_approvals: 1 },
      execution: { supervised_worker: "allowed" }, writeback: { mode: "direct_sql" } });
    vi.mocked(readRuntimeConfig).mockResolvedValue(config);
    const events = vi.spyOn(ProposalStore.prototype, "recordAttentionEvent");
    expect(await workerCommand(args)).toBe(0);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ event_type: "worker.started",
      details: expect.objectContaining({ worker_identity: "shared_reviewed_worker" }) }));
    await expect(workerCommand([...args, "--capability", "billing.pause", "--worker-id", "wrong_worker"]))
      .rejects.toMatchObject({ code: "SUPERVISED_WORKER_IDENTITY_MISMATCH" });
  });

  it("refuses a policy identity change before the next claim without switching identities", async () => {
    vi.stubEnv("SYNAPSOR_RUNNER_ID", undefined);
    const { config, args } = await fixture();
    config.supervised_worker!.outcomes![0]!.worker_identity = "original_worker";
    const changed = structuredClone(config);
    changed.supervised_worker!.outcomes![0]!.worker_identity = "replacement_worker";
    vi.mocked(readRuntimeConfig).mockResolvedValueOnce(config).mockResolvedValueOnce(config).mockResolvedValue(changed);
    const claim = vi.spyOn(ProposalStore.prototype, "claimWorkerItem");
    await expect(workerCommand(args)).rejects.toMatchObject({ code: "SUPERVISED_WORKER_IDENTITY_MISMATCH" });
    expect(claim).not.toHaveBeenCalled(); expect(applyProposal).not.toHaveBeenCalled();
  });

  it.each(["before_enqueue", "before_claim"])("stops after revocation %s without claiming or applying", async (phase) => {
    const { config, storePath, args } = await fixture();
    const disabled = structuredClone(config); disabled.supervised_worker!.enabled = false;
    const reader = vi.mocked(readRuntimeConfig).mockResolvedValueOnce(config);
    if (phase === "before_claim") reader.mockResolvedValueOnce(config);
    reader.mockResolvedValue(disabled);
    const claim = vi.spyOn(ProposalStore.prototype, "claimWorkerItem");
    expect(await workerCommand(args)).toBe(0);
    expect(reader).toHaveBeenCalledTimes(phase === "before_claim" ? 3 : 2);
    expect(claim).not.toHaveBeenCalled(); expect(applyProposal).not.toHaveBeenCalled();
    const store = new ProposalStore(storePath);
    try { expect(store.listWorkerQueue()).toEqual([]); } finally { store.close(); }
  });

  it("refuses a changed source binding before claiming from the original store", async () => {
    const { config, args } = await fixture();
    const changed = structuredClone(config); changed.sources!.local_postgres!.write_url_env = "DIFFERENT_WRITER";
    vi.mocked(readRuntimeConfig).mockResolvedValueOnce(config).mockResolvedValue(changed);
    const claim = vi.spyOn(ProposalStore.prototype, "claimWorkerItem");
    await expect(workerCommand(args)).rejects.toMatchObject({ code: "WORKER_RUNTIME_BINDING_CHANGED" });
    expect(claim).not.toHaveBeenCalled(); expect(applyProposal).not.toHaveBeenCalled();
  });

  it("does not fall back to startup authority when the current policy store is unavailable", async () => {
    const { config, args } = await fixture();
    const error = Object.assign(new Error("Policy repository unavailable"), { code: "POLICY_STORE_UNAVAILABLE" });
    vi.mocked(readRuntimeConfig).mockResolvedValueOnce(config).mockRejectedValue(error);
    const claim = vi.spyOn(ProposalStore.prototype, "claimWorkerItem");
    await expect(workerCommand(args)).rejects.toBe(error);
    expect(claim).not.toHaveBeenCalled(); expect(applyProposal).not.toHaveBeenCalled();
  });
});

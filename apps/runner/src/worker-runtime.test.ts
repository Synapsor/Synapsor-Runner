import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { readRuntimeConfig } from "./cli-project.js";
import { applyProposal } from "./guarded-apply.js";
import { workerCommand } from "./worker-runtime.js";

vi.mock("./cli-project.js", async (original) => ({ ...await original<typeof import("./cli-project.js")>(), readRuntimeConfig: vi.fn() }));
vi.mock("./guarded-apply.js", () => ({ applyProposal: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks(); vi.mocked(readRuntimeConfig).mockReset(); vi.mocked(applyProposal).mockReset();
  for (const root of roots.splice(0)) await fs.rm(root, { force: true, recursive: true });
});

describe("supervised worker current execution policy", () => {
  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-worker-policy-refresh-")); roots.push(root);
    const storePath = path.join(root, "control.db");
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

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

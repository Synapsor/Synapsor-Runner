import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { readLedgerRuntimeConfig, readRuntimeConfig, withRuntimeConfigAdmission } from "./cli-project.js";
import { encodeOperatorExecutionPolicy } from "./control-policy-execution.js";
import { migrateProjectControlPolicies } from "./control-policy-store.js";
import { evidenceList, receiptsList, receiptsShow, replayList } from "./proposal-ledger.js";
import { withProjectRuntimeCutover } from "./project-runtime-admission.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ledger-config-")); roots.push(root);
  const storePath = path.join(root, "control.db"), file = path.join(root, "synapsor.runner.json");
  const initial = resolveRuntimeConfig({ version: 1, mode: "review", capabilities: [],
    action_rules: { project_root: root }, trusted_context: { provider: "environment" },
    sources: { local_postgres: { engine: "postgres", read_url_env: "READER_URL", read_only: true } },
    storage: { sqlite_path: storePath },
    supervised_worker: { enabled: false, profile: "development", capabilities: [] },
  } as RuntimeConfig, root);
  const proposal = JSON.parse(await fs.readFile("fixtures/protocol/change-set.late-fee-waiver.v1.json", "utf8"));
  const receipt = JSON.parse(await fs.readFile("fixtures/protocol/execution-receipt.applied.v1.json", "utf8"));
  const store = new ProposalStore(storePath);
  try {
    store.createProposal(proposal);
    store.approveProposal(proposal.proposal_id, { approver: "fixture_reviewer", proposal_hash: proposal.integrity.proposal_hash, proposal_version: 1 });
    const job = store.createWritebackJobFromProposal(proposal.proposal_id);
    store.recordExecutionReceipt({ ...receipt, proposal_id: proposal.proposal_id, writeback_job_id: job.writeback_job_id, idempotency_key: job.idempotency_key });
  } finally { store.close(); }
  const revision = encodeOperatorExecutionPolicy(initial)!;
  const { binding } = await migrateProjectControlPolicies({ projectRoot: root, config: initial, storePath,
    actor: "fixture_operator", readLegacySnapshot: async () => ({ revisions: [revision],
      active: [{ scope: revision.scope, kind: revision.kind, name: revision.name, revision_id: revision.revision_id }], drafts: [], provenance: [] }),
    validateSnapshot: async () => undefined });
  await binding.close();
  const changed = { ...initial, mode: "shadow" as const };
  await fs.writeFile(file, JSON.stringify(changed));
  return { root, file, storePath, changed, proposal, receipt };
}

describe("read-only ledger configuration", () => {
  it("shows stored receipts and history when execution binding is stale without granting execution", async () => {
    const f = await fixture(), text: string[] = [];
    const output = vi.spyOn(process.stdout, "write").mockImplementation((value) => { text.push(String(value)); return true; });
    const args = ["--config", f.file, "--store", f.storePath, "--json"];
    const before = await fs.readFile(f.file, "utf8");
    const snapshot = () => {
      const store = new ProposalStore(f.storePath);
      try { return { proposals: store.listProposals(), receipts: store.listReceipts(), events: store.listEvents() }; }
      finally { store.close(); }
    };
    const prior = snapshot();
    await expect(readRuntimeConfig(f.file)).rejects.toHaveProperty("code", "POLICY_EXECUTION_BINDING_CHANGED");
    const execution = vi.fn(async () => undefined);
    await expect(withRuntimeConfigAdmission(f.file, execution)).rejects.toHaveProperty("code", "POLICY_EXECUTION_BINDING_CHANGED");
    expect(execution).not.toHaveBeenCalled();
    expect(await readLedgerRuntimeConfig(f.file)).not.toHaveProperty("supervised_worker");
    expect(await receiptsList(args)).toBe(0);
    expect(JSON.parse(text.join("")).receipts[0].receipt.receipt_hash).toBe(f.receipt.receipt_hash);
    text.length = 0;
    expect(await receiptsShow(["1", ...args])).toBe(0);
    expect(JSON.parse(text.join("")).receipt.status).toBe("applied");
    text.length = 0;
    expect(await replayList(args)).toBe(0);
    expect(JSON.parse(text.join("")).replays[0].proposal_id).toBe(f.proposal.proposal_id);
    text.length = 0;
    expect(await evidenceList(args)).toBe(0);
    expect(text.join("")).not.toContain("owner sign-in");
    expect(snapshot()).toEqual(prior);
    expect(await fs.readFile(f.file, "utf8")).toBe(before);
    output.mockRestore();
  });

  it("refuses changed control-store selection rather than consulting another ledger", async () => {
    const f = await fixture(), shadow = path.join(f.root, "shadow.db");
    await fs.writeFile(f.file, JSON.stringify({ ...f.changed, storage: { sqlite_path: shadow } }));
    await expect(receiptsList(["--config", f.file, "--store", shadow, "--json"]))
      .rejects.toHaveProperty("code", "POLICY_STORE_SELECTION_CHANGED");
    await expect(fs.stat(shadow)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("does not ignore malformed storage or invalid JSON on the observational route", async () => {
    const f = await fixture();
    await fs.writeFile(f.file, JSON.stringify({ ...f.changed, storage: { shared_postgres: {
      mode: "runtime_store", url_env: "CONTROL_URL", schema: "bad.schema",
    } } }));
    await expect(readLedgerRuntimeConfig(f.file)).rejects.toThrow("INVALID_SHARED_POSTGRES_SCHEMA");
    await fs.writeFile(f.file, "{");
    await expect(readLedgerRuntimeConfig(f.file)).rejects.toThrow("Runner config");
  });

  it("reloads under admission and refuses a concurrent project redirect before reading receipts", async () => {
    const first = await fixture(), second = await fixture();
    let pending!: Promise<unknown>;
    await withProjectRuntimeCutover(first.root, async () => {
      pending = readLedgerRuntimeConfig(first.file).then(value => value, error => error);
      await delay(50);
      await fs.writeFile(first.file, JSON.stringify({ ...first.changed, action_rules: { project_root: second.root } }));
    });
    expect(await pending).toHaveProperty("code", "POLICY_RUNTIME_PROJECT_CHANGED");
  });
});

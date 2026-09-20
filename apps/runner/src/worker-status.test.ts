import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { workerCommand } from "./worker-runtime.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const p of roots.splice(0)) await fs.rm(p, { recursive: true, force: true }); });

// Labelled renderer fixture: synthetic proposals/approvals/queue states are
// established with store APIs. This is not a public request-to-worker journey.
async function fixture(states: string[] = ["blocked", "queued"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-status-")); roots.push(root);
  const storePath = path.join(root, "control.db"), configPath = path.join(root, "actions config.json");
  await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: "review", sources: { fixture: { engine: "postgres", read_url_env: "STATUS_TEST_UNUSED_DATABASE_URL" } }, trusted_context: { provider: "environment" }, capabilities: [{ name: "inventory.inspect", kind: "read", source: "fixture", target: { schema: "inventory", table: "items", primary_key: "id", tenant_key: "tenant_id" }, args: { id: { type: "string", required: true } }, lookup: { id_from_arg: "id" }, visible_columns: ["quantity"] }], storage: { sqlite_path: storePath } }));
  const store = new ProposalStore(storePath);
  for (const status of states) {
    const id = `wrp_${status === "queued" ? "waiting" : status}`;
    const hash = `sha256:${id}`;
    store.createProposal({ schema_version: "synapsor.change-set.v1", proposal_id: id, proposal_version: 1,
      action: "inventory.correct", mode: "review_required", principal: { id: "synthetic_person", source: "trusted_session" },
      scope: { tenant_id: "synthetic_tenant", business_object: "item", object_id: id },
      source: { kind: "external_postgres", source_id: "fixture", schema: "inventory", table: "items", primary_key: { column: "id", value: id } },
      before: { quantity: 1 }, patch: { quantity: 2 }, after: { quantity: 2 },
      guards: { tenant: { column: "tenant_id", value: "synthetic_tenant" }, allowed_columns: ["quantity"], expected_version: { column: "version", value: 1 } },
      evidence: { bundle_id: "ev_status", query_fingerprint: "sha256:status", items: [] },
      approval: { status: "pending", required_role: "reviewer" }, writeback: { status: "not_applied", mode: "trusted_worker_required" },
      source_database_mutated: false, integrity: { proposal_hash: hash }, created_at: new Date().toISOString() });
    store.approveProposal(id, { approver: "reviewer", proposal_hash: hash, proposal_version: 1 });
    store.enqueueWorkerProposal({ proposal_id: id, execution_mode: "supervised_worker", contract_digest: `sha256:${"a".repeat(64)}`, max_attempts: 5, queue_limit: 10 });
    if (status !== "queued") {
      const item = store.claimWorkerItem({ workerId: "test_worker", executionMode: "supervised_worker", leaseSeconds: 60 })!;
      const opts = { proposalId: id, workerId: "test_worker", leaseId: item.lease_id! };
      if (status === "blocked") store.blockWorkerItem({ ...opts, errorCode: "TRUSTED_BINDING_MISSING" });
      if (status === "retry_wait") store.retryWorkerItem({ ...opts, errorCode: "DATABASE_UNAVAILABLE", retryAt: "2099-01-01T00:00:00.000Z" });
      if (status === "completed") store.completeWorkerItem(id, "test_worker", "applied", undefined, item.lease_id!);
      if (status === "reconciliation_required") store.requireWorkerReconciliation({ ...opts, errorCode: "OUTCOME_UNKNOWN" });
    }
  }
  const snapshot = () => Object.fromEntries((store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
  return { store, snapshot, configPath };
}
async function output(args: string[]) {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try { expect(await workerCommand(args)).toBe(0); return spy.mock.calls.map(([s]) => String(s)).join(""); }
  finally { spy.mockRestore(); }
}

describe("durable worker status projection", () => {
  it("counts blocked work and completed attempts consistently without changing any table", async () => {
    const f = await fixture();
    try {
      const before = f.snapshot();
      const args = ["status", "--config", f.configPath];
      const json = JSON.parse(await output([...args, "--json"]));
      const human = await output(args);
      const empty = await output(["dead-letter", "list", "--config", f.configPath]);
      const detail = await output(["dead-letter", "show", "wrp_blocked", "--config", f.configPath]);
      if (process.env.SYNAPSOR_TEST_EVIDENCE_ROOT) await fs.writeFile(path.join(process.env.SYNAPSOR_TEST_EVIDENCE_ROOT, "status-before-capture.json"), JSON.stringify({ fixture: "store API renderer fixture", json, human, empty, detail, all_tables_unchanged: JSON.stringify(f.snapshot()) === JSON.stringify(before) }, null, 2));
      expect(f.snapshot()).toEqual(before);
      expect(json.summary.blocked).toBe(1); // Existing positive baseline.
      expect(human).toContain("1 blocked");
      expect(human).toContain("attempts completed=1");
      expect(human).toContain("No automatic retry scheduled");
      expect(detail).toContain("Attempts completed: 1");
      expect(empty).toContain("No dead-letter items");
      expect(empty).not.toContain("Worker queue is empty");
      expect(json.worker_queue.find((x: { proposal_id: string }) => x.proposal_id === "wrp_blocked")).toMatchObject({ attempts: 1, max_attempts: 5, attempt_status: { attempts_completed: 1, automatic_retry_scheduled: false } });
    } finally { f.store.close(); }
  });
});

describe("status scope and attempt facts", () => {
  it("keeps full filtered counts across bounded pages and distinguishes durable retry, lease and uncertain states", async () => {
    const f = await fixture(["blocked", "retry_wait", "completed", "reconciliation_required", "leased", "queued"]);
    try {
      const before = f.snapshot();
      const base = ["status", "--config", f.configPath];
      const full = JSON.parse(await output([...base, "--json"]));
      const page = JSON.parse(await output([...base, "--json", "--limit", "1", "--offset", "2"]));
      expect(page.summary).toEqual(full.summary);
      expect(page.page).toMatchObject({ matching_total: 6, displayed: 1, offset: 2 });
      const state = (status: string) => full.worker_queue.find((x: {status:string}) => x.status === status);
      expect(state("retry_wait").attempt_status).toMatchObject({ attempts_completed: 1, automatic_retry_scheduled: true, next_retry_at: "2099-01-01T00:00:00.000Z" });
      expect(state("leased").attempt_status).toMatchObject({ attempts_completed: 0, attempt_in_progress: true, automatic_retry_scheduled: false });
      expect(state("completed").attempt_status).toMatchObject({ attempts_completed: 1, automatic_retry_scheduled: false });
      expect(state("queued").attempt_status).toMatchObject({ attempts_completed: 0, automatic_retry_scheduled: false });
      expect(state("reconciliation_required").recovery).toContain("completion is not proven");
      expect(state("blocked").recovery).toContain("Preview worker close-blocked");
      expect(state("blocked").recovery).toContain("only producer-proven no-effect work can close");
      expect(state("blocked").recovery).toContain("Unknown outcomes require reconciliation");
      const filtered = JSON.parse(await output([...base, "--json", "--status", "blocked", "--limit", "1"]));
      expect(filtered.page.matching_total).toBe(1); expect(filtered.summary.blocked).toBe(1); expect(filtered.summary.queue_depth).toBe(0);
      const human = await output([...base, "--limit", "1"]);
      expect(human).toContain("6 matching, showing 1"); expect(human).toContain("1 blocked");
      expect(human.split("\n").length).toBeLessThan(15);
      expect(f.snapshot()).toEqual(before);
    } finally { f.store.close(); }
  });
  it("distinguishes a genuinely empty queue from a filter with no matches", async () => {
    const f = await fixture([]);
    try {
      expect(await output(["status", "--config", f.configPath])).toContain("Worker queue is empty");
      expect(await output(["dead-letter", "list", "--config", f.configPath])).toContain("No dead-letter items");
    } finally { f.store.close(); }
  });
});

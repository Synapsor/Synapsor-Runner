import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ProposalStore } from "@synapsor-runner/proposal-store";
import { startLocalUiServer } from "./local-ui.js";

async function fixture(events: Array<{ kind: string; actor: string; payload: Record<string, unknown> }> = [],
  approvals: Array<{ approver: string; status: string; proposal_hash: string; proposal_version: number }> = []) {
  const directory = await mkdtemp(join(tmpdir(), "new9-local-ui-"));
  const configPath = join(directory, "runner.json");
  const config = { version: 1, mode: "read_only", storage: { sqlite_path: ":memory:" },
    sources: { app: { engine: "postgres", read_url_env: "NEW9_INERT_READ_URL" } },
    trusted_context: { provider: "environment", values: { tenant_id_env: "NEW9_INERT_TENANT" } },
    capabilities: ["business.normal", "business.execute_sql_approve_commit"].map(name => ({ name, kind: "read",
      source: "app", target: { schema: "public", table: "items", primary_key: "id", tenant_key: "tenant_id" },
      args: { id: { type: "string", required: true, max_length: 128 } }, lookup: { id_from_arg: "id" },
      visible_columns: ["id"], evidence: "required", max_rows: 1 })) };
  await writeFile(configPath, JSON.stringify(config));
  const proposal = { proposal_id: "new9", action: "business.normal", proposal_version: 1,
    proposal_hash: canonicalJsonDigest("new9 proposal"), tenant_id: "fixture", source_database_mutated: false };
  const store = { workerControlState: () => ({ capability_controls: [], mode: "running", revision: 0 }),
    listWorkerQueue: () => [{ proposal_id: "new9", status: "queued", execution_mode: "direct_sql",
      attempts: 0, max_attempts: 3, created_at: "2026-10-08T00:00:00Z" }],
    getProposal: () => proposal, events: () => events, approvals: () => approvals } as unknown as ProposalStore;
  const server = await startLocalUiServer({ projectRoot: directory, configPath, storePath: ":memory:",
    deploymentProfile: "development", token: "new9-local-token", csrfToken: "new9-local-csrf",
    storeAccess: async (_mode, _operation, callback) => callback(store) });
  const get = async (path: string) => {
    const response = await fetch(`http://${server.host}:${server.port}${path}`, { headers: { "x-synapsor-ui-token": server.token } });
    expect(response.status).toBe(200);
    return response.json();
  };
  return { server, get };
}

describe("B64 NEW9 actual local UI projections", () => {
  it("I03543 reports unverified tool exposure independently of configured names", async () => {
    const f = await fixture();
    try {
      const summary = await f.get("/api/summary");
      expect(summary.doctor.no_raw_sql_exposed).toBeNull();
      expect(summary.doctor.forbidden_model_tools).toBeNull();
      const tools = await f.get("/api/tools");
      expect(tools.tools).toHaveLength(2);
      for (const tool of tools.tools) expect(tool).toMatchObject({ no_raw_sql_exposed: null, approval_or_commit_exposed: null });
    } finally { await f.server.close(); }
  });

  it.each([
    { kind: "policy_auto_approval_deferred", actor: "policy:reviewed", payload: {}, approver: undefined, expected: "none" },
    { kind: "policy_auto_approval_deferred", actor: "policy:reviewed", payload: {}, approver: "human", expected: "human" },
    { kind: "proposal_approved", actor: "policy:reviewed", payload: { policy: "reviewed", proposal_hash: canonicalJsonDigest("new9 proposal"), proposal_version: 1 }, approver: "policy:reviewed", expected: "policy_auto" },
  ])("I03544 uses exact successful approval record/event facts ($kind, $expected)", async ({ kind, actor, payload, approver, expected }) => {
    const f = await fixture([{ kind, actor, payload }], approver ? [{ approver, status: "approved",
      proposal_hash: canonicalJsonDigest("new9 proposal"), proposal_version: 1 }] : []);
    try {
      const worker = await f.get("/api/worker");
      expect(worker.worker.queue[0].approval_source).toBe(expected);
      expect(worker.worker.queue[0]).toMatchObject({ status: "queued", source_database_changed: false });
      expect(worker.source_database_changed).toBe(false);
    } finally { await f.server.close(); }
  });
});

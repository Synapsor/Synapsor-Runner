import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { readLedgerRuntimeConfig, readRuntimeConfig, withRuntimeConfigAdmission } from "./cli-project.js";
import { encodeOperatorExecutionPolicy } from "./control-policy-execution.js";
import { migrateProjectControlPolicies } from "./control-policy-store.js";
import { receiptsList, receiptsShow } from "./proposal-ledger.js";
import { storeSharedPostgres } from "./store-shared.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(!process.env.SYNAPSOR_TEST_POSTGRES_URL)("read-only shared PostgreSQL ledger configuration", () => {
  it("reads receipts through the governed bridge despite a stale execution binding and refuses an alternate store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ledger-postgres-"));
    roots.push(root);
    const schema = `ledger_config_${randomBytes(8).toString("hex")}`;
    const shadowSchema = `${schema}_shadow`;
    const storePath = path.join(root, "seed.db");
    const file = path.join(root, "synapsor.runner.json");
    const pool = new Pool({ connectionString: process.env.SYNAPSOR_TEST_POSTGRES_URL });
    const initial = resolveRuntimeConfig({
      version: 1,
      mode: "review",
      capabilities: [],
      action_rules: { project_root: root },
      trusted_context: { provider: "environment" },
      sources: { local_postgres: { engine: "postgres", read_url_env: "READER_URL", read_only: true } },
      storage: { shared_postgres: { mode: "runtime_store", url_env: "SYNAPSOR_TEST_POSTGRES_URL", schema } },
      supervised_worker: { enabled: false, profile: "development", capabilities: [] },
    } as RuntimeConfig, root);
    const proposal = JSON.parse(await fs.readFile("fixtures/protocol/change-set.late-fee-waiver.v1.json", "utf8"));
    const receipt = JSON.parse(await fs.readFile("fixtures/protocol/execution-receipt.applied.v1.json", "utf8"));

    try {
      const store = new ProposalStore(storePath);
      try {
        store.createProposal(proposal);
        store.approveProposal(proposal.proposal_id, {
          approver: "fixture_reviewer",
          proposal_hash: proposal.integrity.proposal_hash,
          proposal_version: 1,
        });
        const job = store.createWritebackJobFromProposal(proposal.proposal_id);
        store.recordExecutionReceipt({
          ...receipt,
          proposal_id: proposal.proposal_id,
          writeback_job_id: job.writeback_job_id,
          idempotency_key: job.idempotency_key,
        });
      } finally {
        store.close();
      }

      const revision = encodeOperatorExecutionPolicy(initial)!;
      const { binding } = await migrateProjectControlPolicies({
        projectRoot: root,
        config: initial,
        storePath,
        env: process.env,
        actor: "fixture_operator",
        readLegacySnapshot: async () => ({
          revisions: [revision],
          active: [{ scope: revision.scope, kind: revision.kind, name: revision.name, revision_id: revision.revision_id }],
          drafts: [],
          provenance: [],
        }),
        validateSnapshot: async () => undefined,
      });
      await binding.close();

      await storeSharedPostgres([
        "sync", "--yes", "--store", storePath, "--schema", schema,
        "--url-env", "SYNAPSOR_TEST_POSTGRES_URL", "--json",
      ]);

      const changed = { ...initial, mode: "shadow" as const };
      await fs.writeFile(file, JSON.stringify(changed));
      const args = ["--config", file, "--json"];
      const countEntries = async () => Number((await pool.query(
        `SELECT COUNT(*)::int AS count FROM "${schema}".ledger_entries`,
      )).rows[0]?.count ?? 0);
      const beforeEntries = await countEntries();

      await expect(readRuntimeConfig(file)).rejects.toHaveProperty("code", "POLICY_EXECUTION_BINDING_CHANGED");
      const execution = vi.fn(async () => undefined);
      await expect(withRuntimeConfigAdmission(file, execution)).rejects.toHaveProperty("code", "POLICY_EXECUTION_BINDING_CHANGED");
      expect(execution).not.toHaveBeenCalled();
      expect(await readLedgerRuntimeConfig(file)).not.toHaveProperty("supervised_worker");

      const output: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((value) => {
        output.push(String(value));
        return true;
      });
      try {
        expect(await receiptsList(args)).toBe(0);
        expect(JSON.parse(output.join("")).receipts[0].receipt.receipt_hash).toBe(receipt.receipt_hash);
        output.length = 0;
        expect(await receiptsShow(["1", ...args])).toBe(0);
        expect(JSON.parse(output.join("")).receipt.status).toBe("applied");
      } finally {
        stdout.mockRestore();
      }
      expect(await countEntries()).toBe(beforeEntries);

      await fs.writeFile(file, JSON.stringify({
        ...changed,
        storage: { shared_postgres: { mode: "runtime_store", url_env: "SYNAPSOR_TEST_POSTGRES_URL", schema: shadowSchema } },
      }));
      await expect(receiptsList(["--config", file, "--json"])).rejects.toHaveProperty("code", "POLICY_STORE_SELECTION_CHANGED");
      expect((await pool.query("SELECT to_regnamespace($1) AS schema", [shadowSchema])).rows[0]?.schema).toBeNull();
    } finally {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });
});

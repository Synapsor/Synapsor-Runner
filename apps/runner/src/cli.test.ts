import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { main } from "./cli.js";

const changeSet = {
  schema_version: "synapsor.change-set.v1",
  proposal_id: "wrp_cli",
  proposal_version: 1,
  action: "billing.waive_late_fee",
  mode: "review_required",
  principal: { id: "support_agent_17", source: "trusted_session" },
  scope: { tenant_id: "acme", business_object: "invoice", object_id: "INV-CLI" },
  source: {
    kind: "external_postgres",
    source_id: "src_pg_acme",
    schema: "public",
    table: "invoices",
    primary_key: { column: "id", value: "INV-CLI" }
  },
  before: { late_fee_cents: 5500, waiver_reason: null, updated_at: "2026-06-20T14:31:08Z" },
  patch: { late_fee_cents: 0, waiver_reason: "customer requested review" },
  after: { late_fee_cents: 0, waiver_reason: "customer requested review", updated_at: "2026-06-20T14:31:08Z" },
  guards: {
    tenant: { column: "tenant_id", value: "acme" },
    allowed_columns: ["late_fee_cents", "waiver_reason"],
    expected_version: { column: "updated_at", value: "2026-06-20T14:31:08Z" }
  },
  evidence: { bundle_id: "ev_cli", query_fingerprint: "sha256:evidence", items: [] },
  approval: { status: "pending", required_role: "support_lead" },
  writeback: { status: "not_applied", mode: "trusted_worker_required" },
  source_database_mutated: false,
  integrity: { proposal_hash: "sha256:proposal" },
  created_at: "2026-06-20T14:31:09Z"
};

function shadowChangeSet() {
  return {
    ...structuredClone(changeSet),
    proposal_id: "wrp_cli_shadow",
    mode: "shadow",
    integrity: { proposal_hash: "sha256:shadow" },
  };
}

describe("runner cli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes a safe local runner config and refuses accidental overwrite", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-init-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["init", "--engine", "mysql", "--mode", "shadow", "--output", configPath])).resolves.toBe(0);
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(config.mode).toBe("shadow");
    expect(config.sources.app_mysql.engine).toBe("mysql");
    expect(JSON.stringify(config)).not.toMatch(/password|secret|mysql:\/\/|postgres(?:ql)?:\/\//i);
    expect(output.join("")).toContain("created");
    await expect(main(["init", "--output", configPath])).rejects.toThrow(/already exists/);
  });

  it("reports missing cloud connection environment without printing secrets", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-cloud-"));
    const configPath = path.join(tempDir, "synapsor.cloud.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        mode: "cloud",
        trusted_context: { provider: "cloud_session" },
        cloud: {
          base_url_env: "SYNAPSOR_TEST_CLOUD_BASE_URL",
          runner_token_env: "SYNAPSOR_TEST_RUNNER_TOKEN",
          adapter_id: "mcp.billing",
          source_id: "src_pg",
        },
      }),
      "utf8",
    );
    const oldBase = process.env.SYNAPSOR_TEST_CLOUD_BASE_URL;
    const oldToken = process.env.SYNAPSOR_TEST_RUNNER_TOKEN;
    delete process.env.SYNAPSOR_TEST_CLOUD_BASE_URL;
    delete process.env.SYNAPSOR_TEST_RUNNER_TOKEN;
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await expect(main(["cloud", "connect", "--config", configPath])).resolves.toBe(1);
      expect(output.join("")).toContain("SYNAPSOR_TEST_CLOUD_BASE_URL");
      expect(output.join("")).toContain("SYNAPSOR_TEST_RUNNER_TOKEN");
      expect(output.join("")).not.toMatch(/syn_wbr_|Bearer|password/i);
    } finally {
      if (oldBase === undefined) {
        delete process.env.SYNAPSOR_TEST_CLOUD_BASE_URL;
      } else {
        process.env.SYNAPSOR_TEST_CLOUD_BASE_URL = oldBase;
      }
      if (oldToken === undefined) {
        delete process.env.SYNAPSOR_TEST_RUNNER_TOKEN;
      } else {
        process.env.SYNAPSOR_TEST_RUNNER_TOKEN = oldToken;
      }
    }
  });

  it("connects Cloud mode by registering and heartbeating runner metadata without database credentials", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-cloud-connect-"));
    const configPath = path.join(tempDir, "synapsor.cloud.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        mode: "cloud",
        trusted_context: { provider: "cloud_session" },
        cloud: {
          base_url_env: "SYNAPSOR_TEST_CLOUD_BASE_URL",
          runner_token_env: "SYNAPSOR_TEST_RUNNER_TOKEN",
          runner_id: "runner_cloud_test",
          runner_version: "0.1.0-test",
          project_id: "proj_token_scope",
          adapter_id: "mcp.billing",
          source_id: "src_pg_cloud",
          engines: ["postgres"],
          capabilities: ["adapter:read", "adapter:invoke", "writeback:claim", "writeback:complete"],
        },
      }),
      "utf8",
    );
    const oldBase = process.env.SYNAPSOR_TEST_CLOUD_BASE_URL;
    const oldToken = process.env.SYNAPSOR_TEST_RUNNER_TOKEN;
    process.env.SYNAPSOR_TEST_CLOUD_BASE_URL = "https://api.synapsor.example";
    process.env.SYNAPSOR_TEST_RUNNER_TOKEN = "syn_wbr_cloud_secret";
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/writeback/runner/doctor")) {
        return new Response(JSON.stringify({ ok: true, source_id: "src_pg_cloud" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      requests.push({ url, method: String(init?.method || "GET"), body });
      return new Response(JSON.stringify({ ok: true, runner: { runner_id: "runner_cloud_test" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    try {
      await expect(main(["cloud", "connect", "--config", configPath])).resolves.toBe(0);
      expect(requests.map((request) => request.url)).toEqual([
        "https://api.synapsor.example/v1/runner/register",
        "https://api.synapsor.example/v1/runner/heartbeat",
      ]);
      expect(requests[0]?.body).toMatchObject({
        schema_version: "synapsor.runner-registration.v1",
        runner_id: "runner_cloud_test",
        runner_version: "0.1.0-test",
        engines: ["postgres"],
        scope: { project_id: "proj_token_scope", source_ids: ["src_pg_cloud"] },
      });
      expect(requests[1]?.body).toMatchObject({
        runner_id: "runner_cloud_test",
        runner_version: "0.1.0-test",
        engines: ["postgres"],
        source_ids: ["src_pg_cloud"],
        status: "online",
      });
      expect(output.join("")).toContain("registered runner runner_cloud_test");
      expect(output.join("")).toContain("Database URLs and credentials were not sent");
      const serialized = JSON.stringify({ requests, output });
      expect(serialized).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|reader_password|writer_password/i);
      expect(output.join("")).not.toContain("syn_wbr_cloud_secret");
      expect(serialized).not.toContain("syn_wbr_cloud_secret");
    } finally {
      if (oldBase === undefined) {
        delete process.env.SYNAPSOR_TEST_CLOUD_BASE_URL;
      } else {
        process.env.SYNAPSOR_TEST_CLOUD_BASE_URL = oldBase;
      }
      if (oldToken === undefined) {
        delete process.env.SYNAPSOR_TEST_RUNNER_TOKEN;
      } else {
        process.env.SYNAPSOR_TEST_RUNNER_TOKEN = oldToken;
      }
    }
  });

  it("lists, shows, approves, and exports local proposals", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-"));
    const storePath = path.join(tempDir, "local.db");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.close();

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["proposals", "list", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("wrp_cli");

    output.length = 0;
    await expect(main(["proposals", "show", "wrp_cli", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("source database changed: no");
    expect(output.join("")).toContain("late_fee_cents");
    expect(output.join("")).toContain("principal: support_agent_17 (trusted_session)");
    expect(output.join("")).toContain("approval: pending required role support_lead");
    expect(output.join("")).toContain("allowed columns: late_fee_cents, waiver_reason");
    expect(output.join("")).toContain("conflict guard: updated_at=2026-06-20T14:31:08Z");
    expect(output.join("")).toContain("evidence: ev_cli  query sha256:evidence");
    expect(output.join("")).toContain("writeback: not_applied via trusted_worker_required");

    output.length = 0;
    await expect(main(["proposals", "approve", "wrp_cli", "--store", storePath, "--actor", "support_lead_1", "--yes"])).resolves.toBe(0);
    expect(output.join("")).toContain("target: external_postgres:src_pg_acme/public.invoices/INV-CLI");
    expect(output.join("")).toContain("conflict guard: updated_at=2026-06-20T14:31:08Z");
    expect(output.join("")).toContain("approved wrp_cli");

    output.length = 0;
    const jobPath = path.join(tempDir, "job.json");
    await expect(main([
      "proposals",
      "writeback-job",
      "wrp_cli",
      "--store",
      storePath,
      "--output",
      jobPath,
      "--project",
      "local",
      "--runner",
      "local_runner",
    ])).resolves.toBe(0);
    await expect(main(["apply", "--job", jobPath, "--dry-run", "--store", storePath])).resolves.toBe(0);

    output.length = 0;
    const replayPath = path.join(tempDir, "replay.json");
    await expect(main(["replay", "export", "wrp_cli", "--store", storePath, "--output", replayPath])).resolves.toBe(0);
    const replay = JSON.parse(await fs.readFile(replayPath, "utf8"));
    expect(replay.replay_id).toBe("replay_wrp_cli");
    expect(replay.events.map((event: { kind: string }) => event.kind)).toContain("proposal_approved");
    expect(replay.events.map((event: { kind: string }) => event.kind)).toContain("writeback_applied");
    expect(replay.receipts).toHaveLength(1);
    expect(replay.receipts[0].receipt).toMatchObject({
      schema_version: "synapsor.execution-receipt.v1",
      proposal_id: "wrp_cli",
      status: "applied",
      rows_affected: 0,
      source_database_mutated: false,
    });
  });

  it("refuses to approve or write back shadow proposals", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-shadow-"));
    const storePath = path.join(tempDir, "local.db");
    const store = new ProposalStore(storePath);
    store.createProposal(shadowChangeSet());
    store.close();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main([
      "proposals",
      "approve",
      "wrp_cli_shadow",
      "--store",
      storePath,
      "--actor",
      "support_lead_1",
      "--yes",
    ])).rejects.toThrow(/shadow proposal wrp_cli_shadow cannot be approved/);

    await expect(main([
      "proposals",
      "writeback-job",
      "wrp_cli_shadow",
      "--store",
      storePath,
    ])).rejects.toThrow(/shadow proposal wrp_cli_shadow cannot be converted into a writeback job/);
  });
});

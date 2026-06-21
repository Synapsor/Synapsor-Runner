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

  it("initializes from a reviewed onboarding spec and generates MCP snippets", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-init-spec-"));
    const oldCwd = process.cwd();
    const specPath = path.join(tempDir, "selection.json");
    await fs.writeFile(specPath, JSON.stringify({
      version: 1,
      engine: "postgres",
      mode: "review",
      schema: "public",
      table: "invoices",
      primary_key: "id",
      tenant_key: "tenant_id",
      conflict_column: "updated_at",
      namespace: "billing",
      object_name: "invoice",
      visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
      allowed_columns: ["late_fee_cents", "waiver_reason"],
      patch: {
        late_fee_cents: { fixed: 0 },
        waiver_reason: { from_arg: "reason" },
      },
    }), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      process.chdir(tempDir);
      await expect(main(["init", "--spec", specPath, "--non-interactive"])).resolves.toBe(0);
      const config = JSON.parse(await fs.readFile(path.join(tempDir, "synapsor.runner.json"), "utf8"));
      expect(config.capabilities.map((capability: { name: string }) => capability.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_invoice_update",
      ]);
      expect(JSON.stringify(config)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password/i);
      expect(await fs.readFile(path.join(tempDir, ".synapsor/mcp/generic-stdio.json"), "utf8")).toContain("mcp");
      expect(await fs.readFile(path.join(tempDir, ".env.example"), "utf8")).toContain("SYNAPSOR_DATABASE_READ_URL");
      expect(output.join("")).toContain("MCP client snippets");
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("validates and shows redacted runner config", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-config-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: {
        app_postgres: {
          engine: "postgres",
          read_url_env: "APP_POSTGRES_READ_URL",
        },
      },
      trusted_context: {
        provider: "environment",
        values: {
          tenant_id_env: "SYNAPSOR_TENANT_ID",
          principal_env: "SYNAPSOR_PRINCIPAL",
        },
      },
      capabilities: [
        {
          name: "billing.inspect_invoice",
          kind: "read",
          source: "app_postgres",
          target: {
            schema: "public",
            table: "invoices",
            primary_key: "id",
            tenant_key: "tenant_id",
          },
          args: {
            invoice_id: { type: "string", required: true, max_length: 128 },
          },
          lookup: { id_from_arg: "invoice_id" },
          visible_columns: ["id", "tenant_id", "updated_at"],
          evidence: "required",
          max_rows: 1,
        },
      ],
    }), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    await expect(main(["config", "validate", "--config", configPath])).resolves.toBe(0);
    expect(output.join("")).toContain("config valid");
    output.length = 0;
    await expect(main(["config", "show", "--config", configPath, "--redacted"])).resolves.toBe(0);
    expect(output.join("")).toContain("<redacted>");
  });

  it("runs the reproducible MCP efficiency benchmark", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["benchmark", "mcp-efficiency"])).resolves.toBe(0);
    const text = output.join("");
    expect(text).toContain("MCP efficiency benchmark: late-fee-waiver fixture");
    expect(text).toContain("not a universal savings claim");
    expect(text).toContain("raw SQL exposed: yes");
    expect(text).toContain("raw SQL exposed: no");
  });

  it("emits JSON for the MCP efficiency benchmark", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["benchmark", "mcp-efficiency", "--json"])).resolves.toBe(0);
    const report = JSON.parse(output.join(""));
    expect(report.tokenizer.name).toBe("synapsor-fixture-tokenizer-v1");
    expect(report.note).toContain("not a universal token-savings claim");
    expect(report.paths.generic_database_mcp_reference.exposes_raw_sql).toBe(true);
    expect(report.paths.synapsor_runner_semantic_path.exposes_raw_sql).toBe(false);
    expect(report.paths.synapsor_runner_semantic_path.approval_separated).toBe(true);
    expect(report.scripted_plans.synapsor_runner_semantic_path).toEqual([
      "billing.inspect_invoice",
      "billing.propose_late_fee_waiver",
    ]);
  });

  it("doctors a local config without printing secret values", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-local-doctor-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: ":memory:" },
      sources: {
        app_postgres: {
          engine: "postgres",
          read_url_env: "APP_POSTGRES_READ_URL",
        },
      },
      trusted_context: {
        provider: "environment",
        values: {
          tenant_id_env: "SYNAPSOR_TENANT_ID",
          principal_env: "SYNAPSOR_PRINCIPAL",
        },
      },
      capabilities: [
        {
          name: "billing.inspect_invoice",
          kind: "read",
          source: "app_postgres",
          target: {
            schema: "public",
            table: "invoices",
            primary_key: "id",
            tenant_key: "tenant_id",
          },
          args: {
            invoice_id: { type: "string", required: true, max_length: 128 },
          },
          lookup: { id_from_arg: "invoice_id" },
          visible_columns: ["id", "tenant_id", "updated_at"],
          evidence: "required",
          max_rows: 1,
        },
      ],
    }), "utf8");
    const oldRead = process.env.APP_POSTGRES_READ_URL;
    const oldTenant = process.env.SYNAPSOR_TENANT_ID;
    const oldPrincipal = process.env.SYNAPSOR_PRINCIPAL;
    delete process.env.APP_POSTGRES_READ_URL;
    process.env.SYNAPSOR_TENANT_ID = "acme";
    process.env.SYNAPSOR_PRINCIPAL = "local_operator";
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await expect(main(["doctor", "--config", configPath, "--json"])).resolves.toBe(1);
      const report = JSON.parse(output.join(""));
      expect(report.tools).toEqual(["billing.inspect_invoice"]);
      expect(report.checks.some((check: { name: string; level: string }) => check.name === "env:APP_POSTGRES_READ_URL" && check.level === "fail")).toBe(true);
      expect(output.join("")).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|reader_secret/i);
    } finally {
      if (oldRead === undefined) delete process.env.APP_POSTGRES_READ_URL; else process.env.APP_POSTGRES_READ_URL = oldRead;
      if (oldTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID; else process.env.SYNAPSOR_TENANT_ID = oldTenant;
      if (oldPrincipal === undefined) delete process.env.SYNAPSOR_PRINCIPAL; else process.env.SYNAPSOR_PRINCIPAL = oldPrincipal;
    }
  });

  it("fails doctor when read and write credentials are shared without override", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-shared-doctor-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: ":memory:" },
      sources: {
        app_postgres: {
          engine: "postgres",
          read_url_env: "APP_POSTGRES_READ_URL",
          write_url_env: "APP_POSTGRES_WRITE_URL",
        },
      },
      trusted_context: {
        provider: "environment",
        values: {
          tenant_id_env: "SYNAPSOR_TENANT_ID",
          principal_env: "SYNAPSOR_PRINCIPAL",
        },
      },
      capabilities: [
        {
          name: "billing.inspect_invoice",
          kind: "read",
          source: "app_postgres",
          target: {
            schema: "public",
            table: "invoices",
            primary_key: "id",
            tenant_key: "tenant_id",
          },
          args: {
            invoice_id: { type: "string", required: true, max_length: 128 },
          },
          lookup: { id_from_arg: "invoice_id" },
          visible_columns: ["id", "tenant_id", "updated_at"],
          evidence: "required",
          max_rows: 1,
        },
        {
          name: "billing.propose_invoice_update",
          kind: "proposal",
          source: "app_postgres",
          target: {
            schema: "public",
            table: "invoices",
            primary_key: "id",
            tenant_key: "tenant_id",
          },
          args: {
            invoice_id: { type: "string", required: true, max_length: 128 },
            reason: { type: "string", required: true, max_length: 500 },
          },
          lookup: { id_from_arg: "invoice_id" },
          visible_columns: ["id", "tenant_id", "updated_at", "waiver_reason"],
          evidence: "required",
          max_rows: 1,
          patch: { waiver_reason: { from_arg: "reason" } },
          allowed_columns: ["waiver_reason"],
          conflict_guard: { column: "updated_at" },
        },
      ],
    }), "utf8");
    const oldRead = process.env.APP_POSTGRES_READ_URL;
    const oldWrite = process.env.APP_POSTGRES_WRITE_URL;
    const oldTenant = process.env.SYNAPSOR_TENANT_ID;
    const oldPrincipal = process.env.SYNAPSOR_PRINCIPAL;
    process.env.APP_POSTGRES_READ_URL = "postgresql://reader:shared@example/app";
    process.env.APP_POSTGRES_WRITE_URL = "postgresql://reader:shared@example/app";
    process.env.SYNAPSOR_TENANT_ID = "acme";
    process.env.SYNAPSOR_PRINCIPAL = "local_operator";
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await expect(main(["doctor", "--config", configPath, "--json"])).resolves.toBe(1);
      const report = JSON.parse(output.join(""));
      expect(report.checks.some((check: { name: string; level: string }) => check.name.includes("credential-separation") && check.level === "fail")).toBe(true);
      expect(output.join("")).not.toContain("reader:shared");
      output.length = 0;
      await expect(main(["doctor", "--config", configPath, "--json", "--allow-shared-credential"])).resolves.toBe(1);
      const overrideReport = JSON.parse(output.join(""));
      expect(overrideReport.checks.some((check: { name: string; level: string }) => check.name.includes("credential-separation") && check.level === "warn")).toBe(true);
    } finally {
      if (oldRead === undefined) delete process.env.APP_POSTGRES_READ_URL; else process.env.APP_POSTGRES_READ_URL = oldRead;
      if (oldWrite === undefined) delete process.env.APP_POSTGRES_WRITE_URL; else process.env.APP_POSTGRES_WRITE_URL = oldWrite;
      if (oldTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID; else process.env.SYNAPSOR_TENANT_ID = oldTenant;
      if (oldPrincipal === undefined) delete process.env.SYNAPSOR_PRINCIPAL; else process.env.SYNAPSOR_PRINCIPAL = oldPrincipal;
    }
  });

  it("cross-checks writeback jobs against reviewed local config before apply", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-authority-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const jobPath = path.join(tempDir, "job.json");
    const baseJob = {
      protocol_version: "1.0",
      job_id: "wbj_local",
      proposal_id: "wrp_local",
      approval_id: "sha256:proposal",
      source_id: "app_postgres",
      engine: "postgres",
      target: {
        schema: "public",
        table: "invoices",
        primary_key: { column: "id", value: "INV-1" },
        tenant_guard: { column: "tenant_id", value: "acme" },
      },
      allowed_columns: ["late_fee_cents", "waiver_reason"],
      patch: { late_fee_cents: 0, waiver_reason: "approved waiver" },
      conflict_guard: { kind: "version_column", column: "updated_at", expected_value: "2026-06-20T12:00:00Z" },
      idempotency_key: "idem_local",
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: ":memory:" },
      sources: {
        app_postgres: {
          engine: "postgres",
          read_url_env: "APP_POSTGRES_READ_URL",
          write_url_env: "APP_POSTGRES_WRITE_URL",
        },
      },
      trusted_context: {
        provider: "environment",
        values: {
          tenant_id_env: "SYNAPSOR_TENANT_ID",
          principal_env: "SYNAPSOR_PRINCIPAL",
        },
      },
      capabilities: [
        {
          name: "billing.propose_invoice_update",
          kind: "proposal",
          source: "app_postgres",
          target: {
            schema: "public",
            table: "invoices",
            primary_key: "id",
            tenant_key: "tenant_id",
          },
          args: {
            invoice_id: { type: "string", required: true, max_length: 128 },
            reason: { type: "string", required: true, max_length: 500 },
          },
          lookup: { id_from_arg: "invoice_id" },
          visible_columns: ["id", "tenant_id", "updated_at", "late_fee_cents", "waiver_reason"],
          evidence: "required",
          max_rows: 1,
          patch: { late_fee_cents: { fixed: 0 }, waiver_reason: { from_arg: "reason" } },
          allowed_columns: ["late_fee_cents", "waiver_reason"],
          conflict_guard: { column: "updated_at" },
        },
      ],
    }), "utf8");
    await fs.writeFile(jobPath, JSON.stringify(baseJob), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    await expect(main(["apply", "--job", jobPath, "--config", configPath, "--dry-run"])).resolves.toBe(0);
    expect(JSON.parse(output.join("")).status).toBe("applied");

    output.length = 0;
    await fs.writeFile(jobPath, JSON.stringify({ ...baseJob, target: { ...baseJob.target, table: "accounts" } }), "utf8");
    await expect(main(["apply", "--job", jobPath, "--config", configPath, "--dry-run"])).rejects.toThrow(/does not match any reviewed proposal capability/i);

    await fs.writeFile(jobPath, JSON.stringify({
      ...baseJob,
      target: { ...baseJob.target, table: "invoices" },
      allowed_columns: ["late_fee_cents", "admin_override"],
      patch: { late_fee_cents: 0 },
    }), "utf8");
    await expect(main(["apply", "--job", jobPath, "--config", configPath, "--dry-run"])).rejects.toThrow(/widens reviewed authority/i);
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

  it("audits a remote MCP tools/list endpoint without calling business tools", async () => {
    const output: string[] = [];
    const oldToken = process.env.SYNAPSOR_TEST_MCP_AUDIT_TOKEN;
    process.env.SYNAPSOR_TEST_MCP_AUDIT_TOKEN = "audit_secret";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://mcp.example.test");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer audit_secret");
      const payload = JSON.parse(String(init?.body || "{}")) as { method?: string };
      expect(payload.method).toBe("tools/list");
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            {
              name: "execute_sql",
              description: "Run SQL",
              inputSchema: { type: "object", properties: { sql: { type: "string" }, tenant_id: { type: "string" } } },
            },
          ],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    try {
      await expect(main(["mcp", "audit", "https://mcp.example.test", "--bearer-env", "SYNAPSOR_TEST_MCP_AUDIT_TOKEN", "--json"]))
        .resolves.toBe(0);
      const report = JSON.parse(output.join(""));
      expect(report.findings.map((finding: { code: string }) => finding.code)).toContain("GENERIC_SQL_TOOL");
      expect(output.join("")).toContain("static risk review");
      expect(output.join("")).not.toContain("audit_secret");
    } finally {
      if (oldToken === undefined) {
        delete process.env.SYNAPSOR_TEST_MCP_AUDIT_TOKEN;
      } else {
        process.env.SYNAPSOR_TEST_MCP_AUDIT_TOKEN = oldToken;
      }
    }
  });

  it("audits a stdio MCP tools/list server", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-mcp-audit-stdio-"));
    const serverPath = path.join(tempDir, "server.mjs");
    await fs.writeFile(serverPath, `
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "test", version: "1" } } }) + "\\n");
        }
        if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "approve_proposal", description: "Approve proposal", inputSchema: { type: "object", properties: { proposal_id: { type: "string" } } } }] } }) + "\\n");
        }
      });
    `, "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["mcp", "audit", `stdio:${process.execPath} ${serverPath}`, "--json", "--timeout-ms", "5000"]))
      .resolves.toBe(0);
    const report = JSON.parse(output.join(""));
    expect(report.findings.map((finding: { code: string }) => finding.code)).toContain("MODEL_CALLABLE_COMMIT_OR_APPROVAL");
    expect(report.summary.tools_inspected).toBe(1);
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

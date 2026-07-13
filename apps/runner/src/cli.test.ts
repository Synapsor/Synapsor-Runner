import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpRuntime, loadRuntimeConfigFromFile, type DbRowReader } from "@synapsor-runner/mcp-server";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { main, resolveSqlWriteDatabaseUrl, runInitWizard } from "./cli.js";

function workspacePath(...segments: string[]): string {
  for (const candidate of [process.cwd(), path.resolve(process.cwd(), "../..")]) {
    if (existsSync(path.join(candidate, "pnpm-workspace.yaml"))) {
      return path.join(candidate, ...segments);
    }
  }
  return path.resolve(process.cwd(), ...segments);
}

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

const contractFixtureRow = {
  id: "INV-3001",
  tenant_id: "acme",
  customer_id: "cus_3001",
  status: "open",
  balance_cents: 12000,
  late_fee_cents: 5500,
  waiver_reason: null,
  updated_at: "2026-06-20T14:31:08Z",
};

async function writeContractApplyFixture(
  tempDir: string,
  options: {
    writeback?: Record<string, unknown>;
    source?: Record<string, unknown>;
    executors?: Record<string, unknown>;
    embeddedDuplicate?: boolean;
  } = {},
): Promise<{ configPath: string; storePath: string; contractPath: string }> {
  const sourceContract = JSON.parse(await fs.readFile(workspacePath("packages/spec/examples/guarded-writeback.contract.json"), "utf8")) as Record<string, any>;
  const proposal = sourceContract.capabilities.find((capability: Record<string, unknown>) => capability.name === "billing.propose_late_fee_waiver");
  if (!proposal?.proposal) throw new Error("proposal capability fixture missing");
  if (options.writeback) proposal.proposal.writeback = options.writeback;
  const contractPath = path.join(tempDir, "synapsor.contract.json");
  const configPath = path.join(tempDir, "synapsor.runner.json");
  const storePath = path.join(tempDir, ".synapsor", "local.db");
  await fs.writeFile(contractPath, `${JSON.stringify(sourceContract, null, 2)}\n`, "utf8");
  const config: Record<string, unknown> = {
    version: 1,
    mode: "review",
    storage: { sqlite_path: storePath },
    contracts: ["./synapsor.contract.json"],
    sources: {
      local_postgres: {
        engine: "postgres",
        read_url_env: "APP_POSTGRES_READ_URL",
        write_url_env: "APP_POSTGRES_WRITE_URL",
        ...(options.source ?? {}),
      },
    },
    ...(options.executors ? { executors: options.executors } : {}),
  };
  if (options.embeddedDuplicate) {
    config.capabilities = [
      {
        name: "billing.inspect_invoice",
        kind: "read",
        source: "local_postgres",
        target: { schema: "public", table: "invoices", primary_key: "id", tenant_key: "tenant_id" },
        args: { invoice_id: { type: "string", required: true } },
        lookup: { id_from_arg: "invoice_id" },
        visible_columns: ["id", "tenant_id", "updated_at"],
      },
    ];
  }
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { configPath, storePath, contractPath };
}

async function createApprovedContractProposal(input: {
  configPath: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const store = new ProposalStore(input.storePath);
  const config = loadRuntimeConfigFromFile(input.configPath);
  const runtime = createMcpRuntime(config, {
    store,
    env: input.env ?? {
      APP_POSTGRES_READ_URL: "postgresql://reader@example/app",
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "local_operator",
    } as NodeJS.ProcessEnv,
    readRow: async () => ({ row: contractFixtureRow, rowCount: 1 }),
  });
  try {
    const result = await runtime.callTool("billing.propose_late_fee_waiver", {
      invoice_id: "INV-3001",
      waiver_reason: "approved support waiver",
    });
    const proposalId = String(result.proposal_id);
    store.approveProposal(proposalId, {
      approver: "local_reviewer",
      proposal_hash: String(result.proposal_hash),
      proposal_version: Number(result.proposal_version),
    });
    return proposalId;
  } finally {
    runtime.close();
    store.close();
  }
}

describe("runner cli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("prints product help for the public synapsor-runner command surface", async () => {
    const commands = [
      ["--help"],
      ["start", "--help"],
      ["up", "--help"],
      ["inspect", "--help"],
      ["init", "--help"],
      ["init", "--wizard", "--help"],
      ["mcp", "--help"],
      ["mcp", "serve", "--help"],
      ["mcp", "serve-streamable-http", "--help"],
      ["mcp", "serve-http", "--help"],
      ["mcp", "config", "--help"],
      ["onboard", "--help"],
      ["smoke", "--help"],
      ["smoke", "call", "--help"],
      ["writeback", "--help"],
      ["handler", "--help"],
      ["handler", "template", "--help"],
      ["propose", "--help"],
      ["audit", "--help"],
      ["proposals", "--help"],
      ["evidence", "--help"],
      ["query-audit", "--help"],
      ["receipts", "--help"],
      ["activity", "--help"],
      ["events", "--help"],
      ["metrics", "--help"],
      ["worker", "--help"],
      ["apply", "--help"],
      ["replay", "--help"],
      ["cloud", "push", "--help"],
      ["demo", "--help"],
      ["ui", "--help"],
    ];
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    for (const command of commands) {
      output.length = 0;
      await expect(main(command)).resolves.toBe(0);
      expect(output.join("")).toMatch(/synapsor/);
    }

    await expect(main(["--help"])).resolves.toBe(0);
    expect(output.join("")).toContain("inspect");
    expect(output.join("")).toContain("start");
    expect(output.join("")).toContain("up");
    expect(output.join("")).toContain("propose");
    expect(output.join("")).toContain("audit");
    expect(output.join("")).toContain("smoke");
    expect(output.join("")).toContain("writeback");
    expect(output.join("")).toContain("handler");

    output.length = 0;
    await expect(main(["cloud", "push", "--help"])).resolves.toBe(0);
    expect(output.join("")).toContain("With --dry-run it makes no network request");
    expect(output.join("")).toContain("uploads to the authenticated Cloud registry");
    expect(output.join("")).not.toContain("until a real Cloud registry endpoint is wired");

    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      errors.push(String(chunk));
      return true;
    });
    await expect(main(["unknown-command"])).resolves.toBe(2);
    expect(errors.join("")).toContain("Unknown command: synapsor-runner unknown-command");
  });

  it("prints the runner package version", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    vi.stubEnv("npm_package_version", "1.0.0");

    const invocations = [
      ["--version"],
      ["-v"],
      ["version"],
      ["synapsor-runner", "--version"],
      ["synapsor-runner", "-v"],
      ["synapsor-runner", "version"],
    ];

    for (const invocation of invocations) {
      output.length = 0;
      await expect(main(invocation)).resolves.toBe(0);
      expect(output.join("").trim()).toBe("1.1.2");
    }
  });

  it("prints the concise quick demo without requiring Docker in noninteractive mode", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-quick-demo-"));
    const oldCwd = process.cwd();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    try {
      process.chdir(tempDir);
      await expect(main(["demo", "--quick", "--no-interactive"])).resolves.toBe(0);
      const text = output.join("");
      expect(text).toContain("Synapsor quick demo complete.");
      expect(text).toContain("billing.propose_late_fee_waiver(invoice_id=\"INV-3001\")");
      expect(text).toContain("* proposal created");
      expect(text).toContain("* source DB changed: no");
      expect(text).toContain("* approval required outside MCP");
      expect(text).toContain("* evidence + replay saved locally");
      expect(text).toContain("./.synapsor/quick-demo.db");
      expect(text).toContain("synapsor-runner demo inspect");
      expect(text).not.toContain("Raw MCP shape");
      expect(text).not.toContain("synapsor-runner proposals show latest --store ./.synapsor/quick-demo.db");
      await fs.access(path.join(tempDir, ".synapsor/quick-demo.db"));

      output.length = 0;
      await expect(main(["demo", "--quick"])).resolves.toBe(0);
      expect(output.join("")).toContain("Synapsor quick demo complete.");
      expect(output.join("")).not.toContain("Press Enter to continue...");

      output.length = 0;
      await expect(main(["activity", "search", "--object", "invoice:INV-3001", "--store", "./.synapsor/quick-demo.db"])).resolves.toBe(0);
      expect(output.join("")).toContain("billing.propose_late_fee_waiver");
      expect(output.join("")).toContain("wrp_quick_INV_3001");

      output.length = 0;
      await expect(main(["store", "stats", "--store", "./.synapsor/quick-demo.db", "--json"])).resolves.toBe(0);
      expect(JSON.parse(output.join("")).proposals).toBe(1);

      output.length = 0;
      await expect(main(["events", "tail", "--store", "./.synapsor/quick-demo.db"])).resolves.toBe(0);
      expect(output.join("")).toContain("proposal_created");
      expect(output.join("")).toContain("wrp_quick_INV_3001");

      output.length = 0;
      await expect(main(["events", "tail", "--kind", "evidence_recorded", "--store", "./.synapsor/quick-demo.db", "--json"])).resolves.toBe(0);
      expect(JSON.parse(output.join("")).events[0].kind).toBe("evidence_recorded");

      output.length = 0;
      await expect(main(["events", "webhook", "--url", "https://hooks.example.test/synapsor", "--kind", "proposal_created", "--store", "./.synapsor/quick-demo.db", "--dry-run"])).resolves.toBe(0);
      expect(output.join("")).toContain("synapsor.local-event-webhook.v1");
      expect(output.join("")).toContain("proposal_created");
      expect(output.join("")).toContain("wrp_quick_INV_3001");

      const oldWebhookToken = process.env.SYNAPSOR_TEST_EVENT_WEBHOOK_TOKEN;
      process.env.SYNAPSOR_TEST_EVENT_WEBHOOK_TOKEN = "evt_secret_token";
      const webhookRequests: Array<{ url: string; auth?: string; body: Record<string, unknown> }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        webhookRequests.push({
          url: String(input),
          auth: String(headers?.authorization ?? ""),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      output.length = 0;
      try {
        await expect(main([
          "events",
          "push",
          "--url",
          "https://hooks.example.test/synapsor?secret=hidden",
          "--auth-token-env",
          "SYNAPSOR_TEST_EVENT_WEBHOOK_TOKEN",
          "--kind",
          "proposal_created",
          "--store",
          "./.synapsor/quick-demo.db",
        ])).resolves.toBe(0);
      } finally {
        if (oldWebhookToken === undefined) delete process.env.SYNAPSOR_TEST_EVENT_WEBHOOK_TOKEN;
        else process.env.SYNAPSOR_TEST_EVENT_WEBHOOK_TOKEN = oldWebhookToken;
      }
      expect(webhookRequests).toHaveLength(1);
      expect(webhookRequests[0]?.auth).toBe("Bearer evt_secret_token");
      expect(webhookRequests[0]?.body).toMatchObject({
        schema_version: "synapsor.local-event-webhook.v1",
        event: { kind: "proposal_created", proposal_id: "wrp_quick_INV_3001" },
      });
      expect(output.join("")).toContain("pushed event");
      expect(output.join("")).toContain("https://hooks.example.test/synapsor");
      expect(output.join("")).not.toContain("hidden");
      expect(output.join("")).not.toContain("evt_secret_token");

      output.length = 0;
      await expect(main(["store", "prune", "--store", "./.synapsor/quick-demo.db", "--older-than", "0d", "--dry-run", "--json"])).resolves.toBe(0);
      const dryRun = JSON.parse(output.join(""));
      expect(dryRun.dry_run).toBe(true);
      expect(dryRun.deleted.proposals).toBe(0);

      output.length = 0;
      await expect(main(["store", "stats", "--store", "./.synapsor/quick-demo.db", "--json"])).resolves.toBe(0);
      expect(JSON.parse(output.join("")).proposals).toBe(1);

      await fs.writeFile(
        path.join(tempDir, ".synapsor/quick-demo.db.lease.json"),
        JSON.stringify({
          pid: process.pid,
          mode: "mcp",
          transport: "streamable-http",
          store_path: path.join(tempDir, ".synapsor/quick-demo.db"),
          started_at: new Date().toISOString(),
        }),
        "utf8",
      );
      output.length = 0;
      await expect(main(["store", "prune", "--store", "./.synapsor/quick-demo.db", "--older-than", "0d", "--yes"])).rejects.toThrow(/Local store appears active/);

      output.length = 0;
      await expect(main(["store", "prune", "--store", "./.synapsor/quick-demo.db", "--older-than", "0d", "--yes", "--force"])).resolves.toBe(0);
      expect(output.join("")).toContain("Local store prune complete");
      output.length = 0;
      await expect(main(["store", "vacuum", "--store", "./.synapsor/quick-demo.db"])).resolves.toBe(0);
      expect(output.join("")).toContain("vacuumed local store");
      output.length = 0;
      await expect(main(["store", "stats", "--store", "./.synapsor/quick-demo.db", "--json"])).resolves.toBe(0);
      expect(JSON.parse(output.join("")).proposals).toBe(1);
    } finally {
      process.chdir(oldCwd);
    }
  }, 15000);

  it("prints shared Postgres ledger migration SQL without exposing a database URL", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["store", "shared-postgres", "migration", "--schema", "synapsor_runner"])).resolves.toBe(0);
    const sql = output.join("");
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "synapsor_runner"');
    expect(sql).toContain('"synapsor_runner".ledger_entries');
    expect(sql).toContain('"synapsor_runner".proposal_locks');
    expect(sql).toContain('"synapsor_runner".worker_leases');
    expect(sql).not.toMatch(/postgres(?:ql)?:\/\//i);

    output.length = 0;
    await expect(main(["store", "shared-postgres", "apply-migration", "--schema", "synapsor_runner"])).rejects.toThrow(/requires --yes/);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-shared-ledger-"));
    const storePath = path.join(tempDir, ".synapsor", "local.db");
    const store = new ProposalStore(storePath);
    try {
      store.createProposal(changeSet);
    } finally {
      store.close();
    }

    output.length = 0;
    await expect(main([
      "store", "shared-postgres", "sync",
      "--store", storePath,
      "--schema", "synapsor_runner",
      "--url-env", "SYNAPSOR_LEDGER_DATABASE_URL",
      "--dry-run",
      "--json",
    ])).resolves.toBe(0);
    const dryRun = JSON.parse(output.join(""));
    expect(dryRun).toMatchObject({
      ok: true,
      dry_run: true,
      engine: "postgres",
      schema: "synapsor_runner",
      url_env: "SYNAPSOR_LEDGER_DATABASE_URL",
    });
    expect(dryRun.entries).toBeGreaterThan(0);
    expect(output.join("")).not.toMatch(/postgres(?:ql)?:\/\//i);

    await expect(main([
      "store", "shared-postgres", "sync",
      "--store", storePath,
      "--schema", "synapsor_runner",
      "--url-env", "SYNAPSOR_LEDGER_DATABASE_URL",
    ])).rejects.toThrow(/requires --yes/);

    await expect(main([
      "store", "shared-postgres", "restore",
      "--store", path.join(tempDir, "restored.db"),
      "--schema", "synapsor_runner",
      "--url-env", "SYNAPSOR_LEDGER_DATABASE_URL",
    ])).rejects.toThrow(/requires --yes/);

    const archivePath = path.join(tempDir, "ledger-backup.json");
    const entries: unknown[] = [];
    const digest = `sha256:${crypto.createHash("sha256").update(JSON.stringify({
      schema_version: "synapsor.shared-ledger-archive.v1",
      entries,
    })).digest("hex")}`;
    await fs.writeFile(archivePath, JSON.stringify({
      schema_version: "synapsor.shared-ledger-archive.v1",
      created_at: "2026-07-12T00:00:00.000Z",
      source: { engine: "postgres", schema: "synapsor_runner" },
      entries,
      manifest: { entries: 0, digest },
    }), "utf8");
    output.length = 0;
    await expect(main(["store", "shared-postgres", "verify-backup", "--input", archivePath, "--json"])).resolves.toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ ok: true, entries: 0, digest });
    await fs.writeFile(archivePath, JSON.stringify({
      schema_version: "synapsor.shared-ledger-archive.v1",
      created_at: "2026-07-12T00:00:00.000Z",
      source: { engine: "postgres", schema: "synapsor_runner" },
      entries: [{ entry_key: "tampered" }],
      manifest: { entries: 0, digest },
    }), "utf8");
    await expect(main(["store", "shared-postgres", "verify-backup", "--input", archivePath])).rejects.toThrow(/manifest digest mismatch/);
  });

  it("keeps shared Postgres ledger mirroring explicit and bounded", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-shared-ledger-mirror-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, ".synapsor", "local.db");
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");

    await expect(main([
      "propose", "billing.waive_late_fee",
      "--shared-ledger-mirror",
      "--config", configPath,
      "--store", ":memory:",
    ])).rejects.toThrow(/requires a durable --store path/);

    await expect(main([
      "propose", "billing.waive_late_fee",
      "--config", configPath,
      "--store", storePath,
      "--shared-ledger-mirror",
      "--shared-ledger-url-env", "SYNAPSOR_TEST_LEDGER_URL",
      "--shared-ledger-lock-timeout-ms", "-1",
      "--sample",
    ])).rejects.toThrow(/--shared-ledger-lock-timeout-ms must be a non-negative integer/);

    await expect(main([
      "propose", "billing.waive_late_fee",
      "--config", configPath,
      "--store", storePath,
      "--shared-ledger-mirror",
      "--shared-ledger-url-env", "SYNAPSOR_TEST_LEDGER_URL",
      "--sample",
    ])).rejects.toThrow(/SYNAPSOR_TEST_LEDGER_URL is not set/);

    const configuredMirror = httpHandlerConfig() as any;
    configuredMirror.storage = {
      sqlite_path: storePath,
      shared_postgres: {
        mode: "mirror",
        url_env: "SYNAPSOR_TEST_LEDGER_URL",
        schema: "synapsor_runner",
        lock_timeout_ms: 0,
      },
    };
    await fs.writeFile(configPath, JSON.stringify(configuredMirror), "utf8");
    await expect(main([
      "propose", "billing.waive_late_fee",
      "--config", configPath,
      "--sample",
    ])).rejects.toThrow(/SYNAPSOR_TEST_LEDGER_URL is not set/);

    await expect(main([
      "worker", "run",
      "--yes",
      "--config", configPath,
      "--store", storePath,
      "--shared-ledger-mirror",
    ])).rejects.toThrow(/requires --once or --drain/);
  });

  it("refuses concurrent MCP server modes on an active local store lease", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-store-concurrent-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, ".synapsor/local.db");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: storePath },
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
    await fs.writeFile(`${storePath}.lease.json`, JSON.stringify({
      pid: process.pid,
      mode: "mcp",
      transport: "stdio",
      store_path: storePath,
      started_at: new Date().toISOString(),
    }), "utf8");

    await expect(main([
      "mcp",
      "serve-streamable-http",
      "--config",
      configPath,
      "--store",
      storePath,
      "--dev-no-auth",
    ])).rejects.toThrow(/Local store appears active.*Refusing serve/);

    await expect(main([
      "mcp",
      "serve-http",
      "--config",
      configPath,
      "--store",
      storePath,
      "--dev-no-auth",
    ])).rejects.toThrow(/Local store appears active.*Refusing serve/);
  });

  it("does not create a local store lease for Postgres runtime-store MCP serving", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-runtime-store-lease-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, ".synapsor/local.db");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: {
        sqlite_path: storePath,
        shared_postgres: {
          mode: "runtime_store",
          url_env: "SYNAPSOR_TEST_LEDGER_URL",
          schema: "synapsor_runner",
          lock_timeout_ms: 0,
        },
      },
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
    const oldLedgerUrl = process.env.SYNAPSOR_TEST_LEDGER_URL;
    delete process.env.SYNAPSOR_TEST_LEDGER_URL;
    try {
      await expect(main([
        "mcp",
        "serve-streamable-http",
        "--config",
        configPath,
        "--store",
        storePath,
        "--dev-no-auth",
      ])).rejects.toThrow(/SYNAPSOR_TEST_LEDGER_URL is required/);
      await expect(fs.stat(`${storePath}.lease.json`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(main([
        "proposals",
        "approve",
        "latest",
        "--config",
        configPath,
        "--store",
        storePath,
        "--yes",
      ])).rejects.toThrow(/SYNAPSOR_TEST_LEDGER_URL is not set/);
      await expect(main([
        "apply",
        "--all-approved",
        "--yes",
        "--config",
        configPath,
        "--store",
        storePath,
      ])).rejects.toThrow(/SYNAPSOR_TEST_LEDGER_URL is not set/);
      await expect(main([
        "worker",
        "run",
        "--once",
        "--yes",
        "--config",
        configPath,
        "--store",
        storePath,
      ])).rejects.toThrow(/SYNAPSOR_TEST_LEDGER_URL is not set/);
      await expect(main([
        "worker",
        "run",
        "--yes",
        "--config",
        configPath,
        "--store",
        storePath,
        "--poll-ms",
        "10",
      ])).rejects.toThrow(/SYNAPSOR_TEST_LEDGER_URL is not set/);
    } finally {
      if (oldLedgerUrl === undefined) delete process.env.SYNAPSOR_TEST_LEDGER_URL; else process.env.SYNAPSOR_TEST_LEDGER_URL = oldLedgerUrl;
    }
  });

  it("resets the local store only after confirmation and lease checks", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-store-reset-"));
    const oldCwd = process.cwd();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      process.chdir(tempDir);
      await expect(main(["demo", "--quick", "--no-interactive"])).resolves.toBe(0);
      const storePath = path.join(tempDir, ".synapsor/quick-demo.db");
      await fs.access(storePath);

      await expect(main(["store", "reset", "--store", "./.synapsor/quick-demo.db"])).rejects.toThrow(/--yes/);

      await fs.writeFile(`${storePath}.lease.json`, JSON.stringify({
        pid: process.pid,
        mode: "mcp",
        transport: "streamable-http",
        store_path: storePath,
        started_at: new Date().toISOString(),
      }), "utf8");
      await expect(main(["store", "reset", "--store", "./.synapsor/quick-demo.db", "--yes"])).rejects.toThrow(/Local store appears active/);

      output.length = 0;
      await expect(main(["store", "reset", "--store", "./.synapsor/quick-demo.db", "--yes", "--force"])).resolves.toBe(0);
      expect(output.join("")).toContain("Local store reset complete");
      expect(output.join("")).toContain("Source database changed: no");
      await expect(fs.access(storePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(`${storePath}.lease.json`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("prints detailed and guided quick demo variants", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-quick-demo-detail-"));
    const oldCwd = process.cwd();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    try {
      process.chdir(tempDir);
      await expect(main(["demo", "--quick", "--details"])).resolves.toBe(0);
      let text = output.join("");
      expect(text).toContain("Raw MCP shape:");
      expect(text).toContain("execute_sql(sql: string)");
      expect(text).toContain("Synapsor shape:");
      expect(text).toContain("Trusted context:");
      expect(text).toContain("Replay:");
      expect(text).toContain("wrp_quick_INV_3001");
      expect(text).toContain("ev_quick_INV_3001");
      expect(text).toContain("synapsor-runner proposals show latest --store ./.synapsor/quick-demo.db");

      output.length = 0;
      await expect(main(["demo", "--quick", "--json"])).resolves.toBe(0);
      const json = JSON.parse(output.join(""));
      expect(json.mode).toBe("fixture_only");
      expect(json.source_database_changed).toBe(false);
      expect(json.proposal_id).toBe("wrp_quick_INV_3001");

      output.length = 0;
      await expect(main(["demo", "--quick", "--guided"])).resolves.toBe(0);
      text = output.join("");
      expect(text).toContain("------------------------------------------------------------");
      expect(text).toContain("Step 1/7: Synapsor Runner quick demo");
      expect(text).toContain("Step 2/7: The risky default");
      expect(text).toContain("Step 7/7: Next paths");
      expect(text).toContain("This teaches the Synapsor safety model without Docker, a database, or an MCP client.");
      expect(text).toContain("It also creates a local fixture ledger you can inspect.");
      expect(text).toContain("- proposal: what the model requested");
      expect(text).toContain("- evidence: what data supported it");
      expect(text).toContain("- query audit: what was read");
      expect(text).toContain("- replay: what happened later");
      expect(text).toContain("Run this next:");
      expect(text).toContain("npx -y -p @synapsor/runner synapsor-runner demo inspect");
      expect(text).toContain("synapsor-runner demo inspect");
      expect(text).toContain("demo inspect shows the proposal, evidence, activity search, and replay commands.");
      expect(text).toContain("If installed globally, use:");
      expect(text).toContain("export DATABASE_URL=\"postgres://...\"");
      expect(text).toContain("Press Enter to continue...");
      expect(text).toContain("It cannot commit the write.");
      expect(text).toContain("Done. You just saw Synapsor's core boundary: business tools for the model, approval/writeback outside the model, and replay for inspection.");
    } finally {
      process.chdir(oldCwd);
    }
  }, 15_000);

  it("prints quick demo inspection menus with local and npx commands", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-demo-inspect-"));
    const oldCwd = process.cwd();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    try {
      process.chdir(tempDir);
      await expect(main(["demo", "inspect"])).resolves.toBe(0);
      let text = output.join("");
      expect(text).toContain("Quick demo inspection");
      expect(text).toContain("1. Proposal summary");
      expect(text).toContain("synapsor-runner proposals show latest --store ./.synapsor/quick-demo.db");
      expect(text).toContain("synapsor-runner evidence show ev_quick_INV_3001 --store ./.synapsor/quick-demo.db");
      expect(text).toContain("synapsor-runner activity search --object invoice:INV-3001 --store ./.synapsor/quick-demo.db");
      expect(text).toContain("synapsor-runner replay show latest --store ./.synapsor/quick-demo.db");
      await fs.access(path.join(tempDir, ".synapsor/quick-demo.db"));

      output.length = 0;
      await expect(main(["demo", "inspect", "--npx"])).resolves.toBe(0);
      text = output.join("");
      expect(text).toContain("npx -y -p @synapsor/runner synapsor-runner proposals show latest");
      expect(text).toContain("npx -y -p @synapsor/runner synapsor-runner audit --example dangerous-db-mcp");
    } finally {
      process.chdir(oldCwd);
    }
  }, 15_000);

  it("audits the built-in dangerous MCP database tool example without a checkout file", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["audit", "--example", "dangerous-db-mcp"])).resolves.toBe(0);
    const text = output.join("");
    expect(text).toContain("Synapsor MCP database risk review");
    expect(text).toContain("Target: example:dangerous-db-mcp");
    expect(text).toContain("GENERIC_SQL_TOOL");
    expect(text).toContain("MODEL_CALLABLE_COMMIT_OR_APPROVAL");
    expect(text).toContain("WRITE_WITHOUT_PROPOSAL_BOUNDARY");
    expect(text).toContain("MODEL_CONTROLLED_TRUST_SCOPE");

    output.length = 0;
    await expect(main(["audit", "--example", "dangerous-db-mcp", "--format", "json"])).resolves.toBe(0);
    expect(JSON.parse(output.join("")).target).toBe("example:dangerous-db-mcp");

    output.length = 0;
    await expect(main(["audit", "--example", "dangerous-db-mcp", "--format", "markdown"])).resolves.toBe(0);
    expect(output.join("")).toContain("# Synapsor MCP Database Risk Review");
    expect(output.join("")).toContain("## Safer Shape");
  });

  it("validates, normalizes, and bundles canonical Synapsor contracts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-contract-"));
    const contractPath = workspacePath("packages/spec/examples/guarded-writeback.contract.json");
    const normalizedPath = path.join(tempDir, "synapsor.contract.normalized.json");
    const bundleDir = path.join(tempDir, "bundle");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["contract", "validate", contractPath])).resolves.toBe(0);
    expect(output.join("")).toContain("contract valid:");

    output.length = 0;
    await expect(main(["contract", "normalize", contractPath, "--out", normalizedPath])).resolves.toBe(0);
    expect(output.join("")).toContain("wrote normalized contract:");
    const normalized = JSON.parse(await fs.readFile(normalizedPath, "utf8"));
    expect(normalized.kind).toBe("SynapsorContract");
    expect(normalized.spec_version).toBe("0.1");

    output.length = 0;
    await expect(main(["contract", "bundle", contractPath, "--out", bundleDir])).resolves.toBe(0);
    expect(output.join("")).toContain("created runner bundle:");
    expect(output.join("")).toContain("No database URLs, write credentials, tokens, or customer rows were included.");
    await fs.access(path.join(bundleDir, "synapsor.contract.json"));
    await fs.access(path.join(bundleDir, "synapsor.runner.json"));
    await fs.access(path.join(bundleDir, ".env.example"));
    await fs.access(path.join(bundleDir, "README.md"));
    for (const clientFile of [
      "claude-desktop.json",
      "cursor-project.mcp.json",
      "cursor-global.mcp.json",
      "openai-agents-stdio.ts",
      "openai-agents-streamable-http.ts",
      "generic-stdio.json",
      "generic-streamable-http.json",
    ]) {
      await fs.access(path.join(bundleDir, "mcp-client-examples", clientFile));
    }
    expect(await fs.readFile(path.join(bundleDir, "mcp-client-examples", "openai-agents-stdio.ts"), "utf8")).toContain("--alias-mode openai");
    const bundleConfig = JSON.parse(await fs.readFile(path.join(bundleDir, "synapsor.runner.json"), "utf8"));
    expect(bundleConfig.contracts).toEqual(["./synapsor.contract.json"]);
    const bundleEnv = await fs.readFile(path.join(bundleDir, ".env.example"), "utf8");
    expect(bundleEnv).toContain("SYNAPSOR_DATABASE_READ_URL=");
    expect(bundleEnv).toContain("SYNAPSOR_DATABASE_WRITE_URL=");
    expect(bundleEnv).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|synapsor_reader|O9wxy|nStZFA|bearer|token/i);
  });

  it("compiles SQL-like DSL into canonical contracts and dry-runs Cloud push", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-dsl-cloud-"));
    const dslPath = workspacePath("packages/dsl/examples/billing-late-fee.synapsor.sql");
    const contractPath = path.join(tempDir, "synapsor.contract.json");
    const output: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["dsl", "validate", dslPath])).resolves.toBe(0);
    expect(output.join("")).toContain("dsl valid:");

    output.length = 0;
    await expect(main(["dsl", "compile", dslPath, "--out", contractPath])).resolves.toBe(0);
    expect(output.join("")).toContain("wrote contract:");
    const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
    expect(contract.kind).toBe("SynapsorContract");
    expect(contract.contexts).toHaveLength(1);
    expect(contract.capabilities.map((capability: { name: string }) => capability.name)).toContain("billing.propose_late_fee_waiver");
    expect(contract.workflows?.[0]?.allowed_capabilities).toContain("billing.propose_late_fee_waiver");

    output.length = 0;
    await expect(main(["contract", "validate", contractPath])).resolves.toBe(0);
    expect(output.join("")).toContain("contract valid:");

    const runnerConfigPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(runnerConfigPath, JSON.stringify({
      version: 1,
      mode: "review",
      result_format: 2,
      storage: { sqlite_path: path.join(tempDir, ".synapsor/local.db") },
      contracts: ["./synapsor.contract.json"],
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          statement_timeout_ms: 3000,
        },
      },
    }), "utf8");
    await fs.mkdir(path.join(tempDir, ".synapsor"), { recursive: true });
    output.length = 0;
    await expect(main(["tools", "preview", "--config", runnerConfigPath, "--store", path.join(tempDir, ".synapsor/local.db")])).resolves.toBe(0);
    expect(output.join("")).toContain("billing.propose_late_fee_waiver");
    expect(output.join("")).toContain("execute_sql / raw query tools");
    expect(output.join("")).toContain("auto-approval: enabled");

    output.length = 0;
    await expect(main(["cloud", "push", contractPath, "--dry-run", "--workspace", "ws_test", "--name", "billing-late-fee"])).resolves.toBe(0);
    expect(output.join("")).toContain("Synapsor Cloud contract push preview");
    expect(output.join("")).toContain("Approval policies:");
    expect(output.join("")).toContain("Dry run only. No Cloud upload attempted.");

    output.length = 0;
    await expect(main(["cloud", "push", contractPath, "--dry-run", "--json"])).resolves.toBe(0);
    const payload = JSON.parse(output.join(""));
    expect(payload.dry_run).toBe(true);
    expect(payload.payload.contract.kind).toBe("SynapsorContract");
    expect(payload.payload.summary.capabilities).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts both DSL source extensions and emits equivalent canonical JSON", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-dsl-extensions-"));
    const source = await fs.readFile(workspacePath("packages/dsl/examples/billing-late-fee.synapsor.sql"), "utf8");
    const sqlPath = path.join(tempDir, "contract.synapsor.sql");
    const legacyPath = path.join(tempDir, "contract.synapsor");
    const sqlContractPath = path.join(tempDir, "sql.contract.json");
    const legacyContractPath = path.join(tempDir, "legacy.contract.json");
    await fs.writeFile(sqlPath, source, "utf8");
    await fs.writeFile(legacyPath, source, "utf8");

    await expect(main(["dsl", "validate", sqlPath, "--strict"])).resolves.toBe(0);
    await expect(main(["dsl", "validate", legacyPath, "--strict"])).resolves.toBe(0);
    await expect(main(["dsl", "compile", sqlPath, "--out", sqlContractPath, "--strict"])).resolves.toBe(0);
    await expect(main(["dsl", "compile", legacyPath, "--out", legacyContractPath, "--strict"])).resolves.toBe(0);
    expect(JSON.parse(await fs.readFile(sqlContractPath, "utf8"))).toEqual(JSON.parse(await fs.readFile(legacyContractPath, "utf8")));

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    await expect(main(["dsl"])).resolves.toBe(2);
    expect(output.join("")).toContain("./contract.synapsor.sql");
    expect(output.join("")).toContain("legacy .synapsor source files are supported");
  });

  it("uploads Cloud contract push to the configured control API", async () => {
    const contractPath = workspacePath("packages/spec/examples/guarded-writeback.contract.json");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    let seenRequest: { url?: string; authorization?: string; body?: Record<string, unknown> } = {};
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        seenRequest = {
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          contract_id: "act_billing_late_fee",
          contract_version_id: "act_billing_late_fee_v1",
          workspace_id: "cloud_project",
          digest: "sha256:abc123",
          status: "draft",
          summary: { contexts: 1, capabilities: 2, workflows: 1, proposal_capabilities: 1, kept_out_fields: 2, policies: 0 },
          registry_url: "/workspace/agent-contracts/act_billing_late_fee",
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
      await expect(main([
        "cloud",
        "push",
        contractPath,
        "--api-url",
        `http://127.0.0.1:${address.port}`,
        "--token",
        "secret-cloud-token",
        "--workspace",
        "cloud_project",
        "--name",
        "billing-late-fee",
        "--json",
      ])).resolves.toBe(0);
      const response = JSON.parse(output.join(""));
      expect(response.contract_id).toBe("act_billing_late_fee");
      expect(seenRequest.url).toBe("/v1/control/projects/cloud_project/agent-contracts");
      expect(seenRequest.authorization).toBe("Bearer secret-cloud-token");
      expect(seenRequest.body?.schema_version).toBe("synapsor.cloud-contract-push.v0.1");
      expect((seenRequest.body?.contract as { kind?: string }).kind).toBe("SynapsorContract");
      expect((seenRequest.body?.summary as { proposal_capabilities?: number }).proposal_capabilities).toBe(1);
      expect(seenRequest.body?.source_versions).toEqual({
        "@synapsor/spec": "1.1.0",
        "@synapsor/dsl": "1.1.0",
        "@synapsor/runner": "1.1.2",
      });
      expect(output.join("")).not.toContain("secret-cloud-token");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("surfaces Cloud validation errors without leaking the token", async () => {
    const contractPath = workspacePath("packages/spec/examples/guarded-writeback.contract.json");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const server = createServer((_request, response) => {
      response.statusCode = 422;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: false,
        error: "agent_contract_validation_failed",
        errors: [{ path: "$.capabilities[0].args.tenant_id", code: "MODEL_CONTROLLED_TRUST_ARG", message: "tenant_id cannot be model-facing" }],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
      await expect(main([
        "cloud",
        "push",
        contractPath,
        "--api-url",
        `http://127.0.0.1:${address.port}`,
        "--token",
        "do-not-print-this-token",
        "--workspace",
        "cloud_project",
      ])).rejects.toThrow(/Cloud rejected the contract.*MODEL_CONTROLLED_TRUST_ARG/i);
      expect(output.join("")).not.toContain("do-not-print-this-token");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([
    [401, "invalid_token", /token is missing, invalid, or expired/i],
    [403, "project_access_denied", /does not have permission to write this workspace/i],
    [404, "project_not_found", /Cloud API URL or workspace was not found/i],
    [409, "version_conflict", /registry conflict/i],
    [500, "internal_error", /Cloud returned HTTP 500/i],
  ])("explains Cloud push HTTP %s without leaking credentials", async (status, code, expected) => {
    const contractPath = workspacePath("packages/spec/examples/guarded-writeback.contract.json");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: false, error: code }), {
      status,
      headers: { "content-type": "application/json" },
    }));

    await expect(main([
      "cloud", "push", contractPath,
      "--api-url", "https://cloud.example.invalid",
      "--token", "never-print-this-token",
      "--workspace", "cloud_project",
    ])).rejects.toThrow(expected);
  });

  it("reports Cloud push network failure without leaking credentials", async () => {
    const contractPath = workspacePath("packages/spec/examples/guarded-writeback.contract.json");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket included never-print-this-token"));

    await expect(main([
      "cloud", "push", contractPath,
      "--api-url", "https://cloud.example.invalid",
      "--token", "never-print-this-token",
      "--workspace", "cloud_project",
    ])).rejects.toThrow(/network request failed.*network connectivity/i);
  });

  it("rejects an invalid local contract before Cloud push performs a request", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-invalid-cloud-push-"));
    const contractPath = path.join(tempDir, "invalid.contract.json");
    await fs.writeFile(contractPath, JSON.stringify({ kind: "SynapsorContract", capabilities: [] }), "utf8");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(main([
      "cloud", "push", contractPath,
      "--api-url", "https://cloud.example.invalid",
      "--token", "never-print-this-token",
      "--workspace", "cloud_project",
    ])).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts SYNAPSOR_CLOUD_WORKSPACE for Cloud push", async () => {
    const contractPath = workspacePath("packages/spec/examples/guarded-writeback.contract.json");
    vi.stubEnv("SYNAPSOR_CLOUD_WORKSPACE", "cloud_workspace_from_env");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      contract_id: "act_env",
      contract_version_id: "act_env_v1",
      digest: "sha256:env",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(main([
      "cloud", "push", contractPath,
      "--api-url", "https://cloud.example.invalid",
      "--token", "test-token",
      "--json",
    ])).resolves.toBe(0);
    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0].toString()).toContain("/projects/cloud_workspace_from_env/agent-contracts");
  });

  it("fails DSL compile strict mode when proposal safety warnings remain", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-dsl-strict-"));
    const dslPath = path.join(tempDir, "contract.synapsor");
    await fs.writeFile(dslPath, `
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  TENANT BINDING tenant_id
END

CREATE CAPABILITY support.propose_plan_credit
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.accounts
  PRIMARY KEY id
  TENANT KEY tenant_id
  LOOKUP account_id BY id
  ARG account_id STRING REQUIRED MAX LENGTH 128
  ARG amount_cents NUMBER REQUIRED
  ALLOW READ id, tenant_id, credit_requested_cents, updated_at
  PROPOSE ACTION grant_plan_credit
  ALLOW WRITE credit_requested_cents
  PATCH credit_requested_cents = ARG amount_cents
  WRITEBACK NONE
END
`, "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["dsl", "compile", dslPath, "--strict"])).resolves.toBe(1);
    expect(output.join("")).toContain("dsl warnings treated as errors");
    expect(output.join("")).toContain("NUMERIC_PATCH_BOUND_RECOMMENDED");
  });

  it("rejects non-primary-key LOOKUP through the CLI without rewriting it", async () => {
    const fixture = workspacePath("packages/dsl/fixtures/invalid/non-primary-lookup.synapsor.sql");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    await expect(main(["dsl", "validate", fixture, "--json"])).resolves.toBe(1);
    expect(output.join("")).toContain("LOOKUP_COLUMN_UNSUPPORTED");
    await expect(main(["dsl", "compile", fixture, "--strict"])).rejects.toThrow(/LOOKUP_COLUMN_UNSUPPORTED/);
  });

  it("compiles DSL-authored numeric bounds into a contract enforced by runtime proposals", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-dsl-bounds-"));
    const dslPath = path.join(tempDir, "contract.synapsor");
    const contractPath = path.join(tempDir, "synapsor.contract.json");
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(dslPath, `
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY support.propose_plan_credit
  DESCRIPTION 'Propose a support credit for a verified outage impact.'
  RETURNS HINT 'Returns the proposal id and requested credit; DB unchanged.'
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.accounts
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP account_ref BY id
  ARG account_ref STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Account object id.'
  ARG amount_cents NUMBER REQUIRED MIN 1 MAX 1000000 DESCRIPTION 'Credit amount in cents.'
  ARG reason TEXT REQUIRED MAX LENGTH 500 DESCRIPTION 'Business reason for the credit.'
  ALLOW READ id, tenant_id, credit_requested_cents, credit_reason, updated_at
  REQUIRE EVIDENCE
  MAX ROWS 1
  PROPOSE ACTION grant_plan_credit
  ALLOW WRITE credit_requested_cents, credit_reason
  PATCH credit_requested_cents = ARG amount_cents
  PATCH credit_reason = ARG reason
  BOUND credit_requested_cents 1..2500
  APPROVAL ROLE local_reviewer
  WRITEBACK NONE
END
`, "utf8");
    await expect(main(["dsl", "compile", dslPath, "--out", contractPath, "--strict"])).resolves.toBe(0);
    const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
    expect(contract.capabilities[0].proposal.numeric_bounds).toEqual({
      credit_requested_cents: { minimum: 1, maximum: 2500 },
    });
    await fs.writeFile(configPath, `${JSON.stringify({
      version: 1,
      mode: "review",
      result_format: 2,
      storage: { sqlite_path: ":memory:" },
      contracts: ["./synapsor.contract.json"],
      capabilities: [],
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "APP_POSTGRES_READ_URL",
          statement_timeout_ms: 3000,
        },
      },
    }, null, 2)}\n`, "utf8");
    const config = loadRuntimeConfigFromFile(configPath);
    const runtime = createMcpRuntime(config, {
      env: {
        SYNAPSOR_TENANT_ID: "acme",
        SYNAPSOR_PRINCIPAL: "local_reviewer",
      },
      readRow: async () => ({
        row: {
          id: "acct_3001",
          tenant_id: "acme",
          credit_requested_cents: 0,
          credit_reason: null,
          updated_at: "2026-06-21T00:00:00Z",
        },
        rowCount: 1,
      }),
      resultFormat: 2,
    });
    try {
      const result = await runtime.callTool("support.propose_plan_credit", {
        account_ref: "acct_3001",
        amount_cents: 999999,
        reason: "outage credit",
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "POLICY_VIOLATION" },
        source_database_changed: false,
      });
    } finally {
      runtime.close();
    }
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

  it("initializes from an inspected schema snapshot and reviewed flags", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-init-inspection-"));
    const oldCwd = process.cwd();
    const inspectionPath = path.join(tempDir, "schema-inspection.json");
    await fs.writeFile(inspectionPath, JSON.stringify({
      engine: "postgres",
      server_version: "PostgreSQL 16 fixture",
      current_user: "synapsor_reader",
      inspected_at: "2026-06-21T00:00:00Z",
      schemas: ["public"],
      warnings: [],
      tables: [
        {
          schema: "public",
          name: "invoices",
          type: "table",
          writable: true,
          columns: [
            { name: "id", data_type: "text", nullable: false, generated: false, ordinal_position: 1, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: true, large_or_binary: false } },
            { name: "tenant_id", data_type: "text", nullable: false, generated: false, ordinal_position: 2, suggestions: { tenant: true, conflict: false, sensitive: false, immutable: true, large_or_binary: false } },
            { name: "late_fee_cents", data_type: "integer", nullable: false, generated: false, ordinal_position: 3, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } },
            { name: "waiver_reason", data_type: "text", nullable: true, generated: false, ordinal_position: 4, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } },
            { name: "updated_at", data_type: "timestamp", nullable: false, generated: false, ordinal_position: 5, suggestions: { tenant: false, conflict: true, sensitive: false, immutable: false, large_or_binary: false } },
          ],
          primary_key: ["id"],
          unique_constraints: [],
          foreign_keys: [],
          indexes: [],
          suggestions: {
            tenant_columns: ["tenant_id"],
            conflict_columns: ["updated_at"],
            sensitive_columns: [],
            default_visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
          },
        },
      ],
    }), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    try {
      process.chdir(tempDir);
      await expect(main([
        "init",
        "--inspection-json",
        inspectionPath,
        "--from-env",
        "SYNAPSOR_DATABASE_READ_URL",
        "--table",
        "invoices",
        "--tenant-column",
        "tenant_id",
        "--namespace",
        "billing",
        "--object-name",
        "invoice",
        "--id-arg",
        "invoice_id",
        "--mode",
        "review",
        "--patch",
        "late_fee_cents=fixed:0,waiver_reason=arg:reason",
        "--patch-bounds",
        "late_fee_cents=0:5500",
      ])).resolves.toBe(0);
      const config = JSON.parse(await fs.readFile(path.join(tempDir, "synapsor.runner.json"), "utf8"));
      expect(config.result_format).toBe(2);
      expect(config.sources.local_postgres.read_url_env).toBe("SYNAPSOR_DATABASE_READ_URL");
      expect(config.sources.local_postgres.write_url_env).toBe("SYNAPSOR_DATABASE_WRITE_URL");
      expect(config.capabilities.map((capability: { name: string }) => capability.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_invoice_update",
      ]);
      expect(config.capabilities[1].patch).toEqual({
        late_fee_cents: { fixed: 0 },
        waiver_reason: { from_arg: "reason" },
      });
      expect(config.capabilities[1].numeric_bounds).toEqual({
        late_fee_cents: { minimum: 0, maximum: 5500 },
      });
      expect(output.join("")).toContain("selected public.invoices");
      expect(JSON.stringify(config)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password/i);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("uses table-derived capability names by default and supports explicit tool-name overrides", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-init-names-"));
    const oldCwd = process.cwd();
    const inspectionPath = path.join(tempDir, "schema-inspection.json");
    await fs.writeFile(inspectionPath, JSON.stringify({
      engine: "postgres",
      server_version: "PostgreSQL 16 fixture",
      current_user: "synapsor_reader",
      inspected_at: "2026-06-21T00:00:00Z",
      schemas: ["public"],
      warnings: [],
      tables: [{
        schema: "public",
        name: "support_tickets",
        type: "table",
        writable: true,
        columns: [
          { name: "id", data_type: "text", nullable: false, generated: false, ordinal_position: 1, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: true, large_or_binary: false } },
          { name: "tenant_id", data_type: "text", nullable: false, generated: false, ordinal_position: 2, suggestions: { tenant: true, conflict: false, sensitive: false, immutable: true, large_or_binary: false } },
          { name: "resolution_note", data_type: "text", nullable: true, generated: false, ordinal_position: 3, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } },
          { name: "updated_at", data_type: "timestamp", nullable: false, generated: false, ordinal_position: 4, suggestions: { tenant: false, conflict: true, sensitive: false, immutable: false, large_or_binary: false } },
        ],
        primary_key: ["id"],
        unique_constraints: [],
        foreign_keys: [],
        indexes: [],
        suggestions: {
          tenant_columns: ["tenant_id"],
          conflict_columns: ["updated_at"],
          sensitive_columns: [],
          default_visible_columns: ["id", "tenant_id", "resolution_note", "updated_at"],
        },
      }],
    }), "utf8");

    try {
      process.chdir(tempDir);
      await expect(main([
        "init",
        "--inspection-json",
        inspectionPath,
        "--from-env",
        "DATABASE_URL",
        "--table",
        "support_tickets",
        "--mode",
        "review",
        "--patch",
        "resolution_note=arg:note",
      ])).resolves.toBe(0);
      let config = JSON.parse(await fs.readFile(path.join(tempDir, "synapsor.runner.json"), "utf8"));
      expect(config.capabilities.map((capability: { name: string }) => capability.name)).toEqual([
        "support.inspect_support_ticket",
        "support.propose_support_ticket_update",
      ]);

      await expect(main([
        "init",
        "--inspection-json",
        inspectionPath,
        "--from-env",
        "DATABASE_URL",
        "--table",
        "support_tickets",
        "--mode",
        "review",
        "--patch",
        "resolution_note=arg:note",
        "--read-tool",
        "helpdesk.read_ticket",
        "--proposal-tool",
        "helpdesk.propose_ticket_note",
        "--output",
        "renamed.runner.json",
        "--force",
      ])).resolves.toBe(0);
      config = JSON.parse(await fs.readFile(path.join(tempDir, "renamed.runner.json"), "utf8"));
      expect(config.capabilities.map((capability: { name: string }) => capability.name)).toEqual([
        "helpdesk.read_ticket",
        "helpdesk.propose_ticket_note",
      ]);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("onboards from an answers file without prompts and emits a handler scaffold", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-onboard-answers-"));
    const oldCwd = process.cwd();
    const answersPath = path.join(tempDir, "answers.json");
    await fs.writeFile(answersPath, JSON.stringify({
      engine: "postgres",
      read_url_env: "DATABASE_URL",
      schema: "public",
      table: "invoices",
      primary_key: "id",
      tenant_column: "tenant_id",
      conflict_column: "updated_at",
      visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
      mode: "review",
      namespace: "billing",
      object_name: "invoice",
      id_arg: "invoice_id",
      patch: ["late_fee_cents=fixed:0", "waiver_reason=arg:reason"],
      patch_bounds: ["late_fee_cents=0:5500"],
      writeback: "http_handler",
      handler_url_env: "APP_WRITEBACK_URL",
      handler_signing_secret_env: "APP_WRITEBACK_SIGNING_SECRET",
      approval_role: "billing_lead",
    }), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      process.chdir(tempDir);
      await expect(main([
        "onboard",
        "db",
        "--answers",
        answersPath,
        "--yes",
        "--emit-handler",
        "--handler-template",
        "python-fastapi",
        "--handler-output",
        "./billing_writeback_handler.py",
      ])).resolves.toBe(0);
      const config = JSON.parse(await fs.readFile(path.join(tempDir, "synapsor.runner.json"), "utf8"));
      expect(config.mode).toBe("review");
      expect(config.result_format).toBe(2);
      expect(config.sources.local_postgres.read_url_env).toBe("DATABASE_URL");
      expect(config.sources.local_postgres.read_only).toBe(true);
      expect(config.sources.local_postgres.write_url_env).toBeUndefined();
      expect(config.capabilities.map((capability: { name: string }) => capability.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_invoice_update",
      ]);
      expect(config.capabilities[1].executor).toBe("billing_http_handler");
      expect(config.capabilities[1].patch).toEqual({
        late_fee_cents: { fixed: 0 },
        waiver_reason: { from_arg: "reason" },
      });
      expect(config.capabilities[1].numeric_bounds).toEqual({
        late_fee_cents: { minimum: 0, maximum: 5500 },
      });
      const handler = await fs.readFile(path.join(tempDir, "billing_writeback_handler.py"), "utf8");
      expect(handler).toContain("IMPORTANT: your app handler owns the final business write.");
      expect(output.join("")).toContain("config valid: synapsor.runner.json");
      expect(output.join("")).not.toContain("WRITEBACK_DISABLED");
      expect(output.join("")).toContain("created ./billing_writeback_handler.py");
      expect(JSON.stringify(config)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|handler-secret-token|hmac-secret-value/i);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("runs guided init through injectable prompts without hand-authoring full config", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-init-wizard-"));
    const oldCwd = process.cwd();
    const output: string[] = [];
    const answers = [
      "", // engine default auto
      "", // read URL env default
      "", // schema default public
      "", // table default invoices
      "", // primary key default id
      "", // tenant default tenant_id
      "", // tenant env default
      "", // principal env default
      "review",
      "", // conflict default updated_at
      "", // visible columns default inspected safe columns
      "manual",
      "late_fee_cents=fixed:0,waiver_reason=arg:reason",
      "late_fee_cents=0:5500",
      "",
      "billing",
      "invoice",
      "invoice_id",
      "", // read capability name default
      "", // proposal capability name default
      "INV-3001",
      "", // read capability description default
      "", // read returns hint default
      "", // proposal capability description default
      "", // proposal returns hint default
      "v2",
      "", // writeback path default sql_update
      "", // write URL env default
      "billing_lead",
      "yes", // edit final preview
      "id,tenant_id,late_fee_cents,updated_at",
      "billing.read_invoice_for_agent",
      "billing.propose_waiver_review",
      "yes",
    ];
    const ask = vi.fn(async () => answers.shift() ?? "");
    const readRow: DbRowReader = vi.fn(async () => ({
      row: {
        id: "INV-3001",
        tenant_id: "acme",
        late_fee_cents: 5500,
        waiver_reason: null,
        updated_at: "2026-06-21T00:00:00Z",
      },
      rowCount: 1,
    }));
    try {
      process.chdir(tempDir);
      await expect(runInitWizard(["--force"], {
        ask,
        env: {
          SYNAPSOR_DATABASE_READ_URL: "postgresql://fixture.invalid/app",
          SYNAPSOR_TENANT_ID: "acme",
          SYNAPSOR_PRINCIPAL: "local_tester",
        },
        readRow,
        stdout: { write: (chunk: string | Uint8Array) => { output.push(String(chunk)); return true; } },
        inspection: {
          engine: "postgres",
          server_version: "PostgreSQL 16 fixture",
          current_user: "synapsor_reader",
          inspected_at: "2026-06-21T00:00:00Z",
          schemas: ["public"],
          warnings: [],
          tables: [
            {
              schema: "public",
              name: "invoices",
              type: "table",
              writable: true,
              columns: [
                { name: "id", data_type: "text", nullable: false, generated: false, ordinal_position: 1, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: true, large_or_binary: false } },
                { name: "tenant_id", data_type: "text", nullable: false, generated: false, ordinal_position: 2, suggestions: { tenant: true, conflict: false, sensitive: false, immutable: true, large_or_binary: false } },
                { name: "late_fee_cents", data_type: "integer", nullable: false, generated: false, ordinal_position: 3, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } },
                { name: "waiver_reason", data_type: "text", nullable: true, generated: false, ordinal_position: 4, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } },
                { name: "updated_at", data_type: "timestamp", nullable: false, generated: false, ordinal_position: 5, suggestions: { tenant: false, conflict: true, sensitive: false, immutable: false, large_or_binary: false } },
              ],
              primary_key: ["id"],
              unique_constraints: [],
              foreign_keys: [],
              indexes: [],
              suggestions: {
                tenant_columns: ["tenant_id"],
                conflict_columns: ["updated_at"],
                sensitive_columns: [],
                default_visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
              },
            },
          ],
        },
      })).resolves.toBe(0);
      const config = JSON.parse(await fs.readFile(path.join(tempDir, "synapsor.runner.json"), "utf8"));
      expect(config.mode).toBe("review");
      expect(config.result_format).toBe(2);
      expect(config.sources.local_postgres.read_url_env).toBe("SYNAPSOR_DATABASE_READ_URL");
      expect(config.sources.local_postgres.write_url_env).toBe("SYNAPSOR_DATABASE_WRITE_URL");
      expect(config.capabilities.map((capability: { name: string }) => capability.name)).toEqual([
        "billing.read_invoice_for_agent",
        "billing.propose_waiver_review",
      ]);
      expect(config.capabilities[0].visible_columns).toEqual(["id", "tenant_id", "updated_at", "late_fee_cents"]);
      expect(config.capabilities[1].approval.required_role).toBe("billing_lead");
      expect(config.capabilities[0].description).toContain("Inspect one invoice");
      expect(config.capabilities[0].returns_hint).toContain("evidence handle");
      expect(config.capabilities[0].args.invoice_id.description).toContain("Invoice id");
      expect(config.capabilities[1].description).toContain("Create a review-required proposal");
      expect(config.capabilities[1].returns_hint).toContain("proposal id");
      expect(config.capabilities[1].patch).toEqual({
        late_fee_cents: { fixed: 0 },
        waiver_reason: { from_arg: "reason" },
      });
      expect(config.capabilities[1].numeric_bounds).toEqual({
        late_fee_cents: { minimum: 0, maximum: 5500 },
      });
      expect(JSON.parse(await fs.readFile(path.join(tempDir, ".synapsor/smoke-input.json"), "utf8"))).toEqual({ invoice_id: "INV-3001" });
      expect(output.join("")).toContain("Flow: inspect database -> create trusted context -> create capability -> expose MCP tool.");
      expect(output.join("")).toContain("Step 2: Create trusted context");
      expect(output.join("")).toContain("Step 3: Create capability");
      expect(output.join("")).toContain("result envelope: v2");
      expect(output.join("")).toContain("read capability: billing.inspect_invoice");
      expect(output.join("")).toContain("proposal capability: billing.propose_invoice_update");
      expect(output.join("")).toContain("Updated preview:");
      expect(output.join("")).toContain("visible fields: id, tenant_id, late_fee_cents, updated_at");
      expect(output.join("")).toContain("read capability: billing.read_invoice_for_agent");
      expect(output.join("")).toContain("proposal capability: billing.propose_waiver_review");
      expect(output.join("")).toContain("OpenAI Agents SDK:");
      expect(output.join("")).toContain("Smoke call ran successfully.");
      expect(output.join("")).toContain("Synapsor smoke call: ok");
      expect(output.join("")).toContain("smoke call billing.read_invoice_for_agent --input ./.synapsor/smoke-input.json");
      expect(output.join("")).toContain("trusted context: tenant from SYNAPSOR_TENANT_ID via tenant_id; principal from SYNAPSOR_PRINCIPAL");
      expect(output.join("")).toContain("not exposed: execute_sql");
      expect(readRow).toHaveBeenCalled();
      expect(JSON.stringify(config)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|handler-secret-token|hmac-secret-value/i);
      expect(ask).toHaveBeenCalled();
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("runs guided init with app-owned HTTP handler writeback", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-init-wizard-handler-"));
    const oldCwd = process.cwd();
    const output: string[] = [];
    const answers = [
      "", // engine default auto
      "", // read URL env default
      "", // schema default public
      "", // table default invoices
      "", // primary key default id
      "", // tenant default tenant_id
      "", // tenant env default
      "", // principal env default
      "review",
      "", // conflict default updated_at
      "", // visible columns default inspected safe columns
      "manual",
      "late_fee_cents=fixed:0,waiver_reason=arg:reason",
      "late_fee_cents=0:5500",
      "",
      "billing",
      "invoice",
      "invoice_id",
      "", // read capability name default
      "", // proposal capability name default
      "INV-3001",
      "", // read capability description default
      "", // read returns hint default
      "", // proposal capability description default
      "", // proposal returns hint default
      "", // result envelope default
      "http_handler",
      "BILLING_WRITEBACK_URL",
      "BILLING_WRITEBACK_TOKEN",
      "BILLING_WRITEBACK_SIGNING_SECRET",
      "yes", // write starter handler template
      "", // node-fastify default
      "", // default handler template output
      "billing_lead",
      "no", // accept preview
      "yes",
    ];
    const ask = vi.fn(async () => answers.shift() ?? "");
    try {
      process.chdir(tempDir);
      await expect(runInitWizard(["--force"], {
        ask,
        stdout: { write: (chunk: string | Uint8Array) => { output.push(String(chunk)); return true; } },
        inspection: {
          engine: "postgres",
          server_version: "PostgreSQL 16 fixture",
          current_user: "synapsor_reader",
          inspected_at: "2026-06-21T00:00:00Z",
          schemas: ["public"],
          warnings: [],
          tables: [
            {
              schema: "public",
              name: "invoices",
              type: "table",
              writable: true,
              columns: [
                { name: "id", data_type: "text", nullable: false, generated: false, ordinal_position: 1, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: true, large_or_binary: false } },
                { name: "tenant_id", data_type: "text", nullable: false, generated: false, ordinal_position: 2, suggestions: { tenant: true, conflict: false, sensitive: false, immutable: true, large_or_binary: false } },
                { name: "late_fee_cents", data_type: "integer", nullable: false, generated: false, ordinal_position: 3, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } },
                { name: "waiver_reason", data_type: "text", nullable: true, generated: false, ordinal_position: 4, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } },
                { name: "updated_at", data_type: "timestamp", nullable: false, generated: false, ordinal_position: 5, suggestions: { tenant: false, conflict: true, sensitive: false, immutable: false, large_or_binary: false } },
              ],
              primary_key: ["id"],
              unique_constraints: [],
              foreign_keys: [],
              indexes: [],
              suggestions: {
                tenant_columns: ["tenant_id"],
                conflict_columns: ["updated_at"],
                sensitive_columns: [],
                default_visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
              },
            },
          ],
        },
      })).resolves.toBe(0);
      const config = JSON.parse(await fs.readFile(path.join(tempDir, "synapsor.runner.json"), "utf8"));
      expect(config.sources.local_postgres.write_url_env).toBeUndefined();
      expect(config.sources.local_postgres.read_only).toBe(true);
      expect(config.executors).toMatchObject({
        billing_http_handler: {
          type: "http_handler",
          url_env: "BILLING_WRITEBACK_URL",
          method: "POST",
          auth: { type: "bearer_env", token_env: "BILLING_WRITEBACK_TOKEN" },
          signing_secret_env: "BILLING_WRITEBACK_SIGNING_SECRET",
          timeout_ms: 5000,
        },
      });
      expect(config.capabilities[1].executor).toBe("billing_http_handler");
      expect(config.capabilities[1].approval.required_role).toBe("billing_lead");
      const envExample = await fs.readFile(path.join(tempDir, ".env.example"), "utf8");
      expect(envExample).toContain('BILLING_WRITEBACK_URL="http://127.0.0.1:8787/synapsor/writeback"');
      expect(envExample).toContain('BILLING_WRITEBACK_TOKEN="<handler-bearer-token>"');
      expect(envExample).toContain('BILLING_WRITEBACK_SIGNING_SECRET="<handler-hmac-signing-secret>"');
      const handlerTemplate = await fs.readFile(path.join(tempDir, "synapsor-writeback-handler.mjs"), "utf8");
      expect(handlerTemplate).toContain("IMPORTANT: your app handler owns the final business write.");
      expect(handlerTemplate).toContain("cross-tenant writes");
      expect(output.join("")).toContain("writeback path: http_handler");
      expect(output.join("")).toContain("handler template: synapsor-writeback-handler.mjs");
      expect(output.join("")).toContain("IMPORTANT: your app handler owns the final business write.");
      expect(JSON.stringify(config)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|handler-secret-token|hmac-secret-value/i);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("runs guided init with a mapped recipe instead of hardcoded runtime tools", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-init-wizard-recipe-"));
    const oldCwd = process.cwd();
    const output: string[] = [];
    const answers = [
      "", // engine default auto
      "", // read URL env default
      "", // schema default public
      "", // table default invoices
      "", // primary key default id
      "", // tenant default tenant_id
      "", // tenant env default
      "", // principal env default
      "review",
      "", // conflict default updated_at
      "", // visible columns default inspected safe columns
      "recipe",
      "billing.late_fee_waiver",
      "", // map id
      "", // map tenant_id
      "", // map late_fee_cents
      "", // map waiver_reason
      "", // map updated_at
      "", // map status
      "", // recipe patch default
      "", // recipe numeric bound default
      "", // no transition guards
      "", // namespace from recipe
      "", // object name from recipe
      "", // lookup arg from recipe
      "", // read capability name from recipe
      "", // proposal capability name from recipe
      "", // optional smoke object id
      "", // read capability description default
      "", // read returns hint default
      "", // proposal capability description default
      "", // proposal returns hint default
      "", // result envelope default
      "", // writeback path default sql_update
      "", // write URL env default
      "", // approval role from recipe
      "no", // accept preview
      "yes",
    ];
    const ask = vi.fn(async () => answers.shift() ?? "");
    try {
      process.chdir(tempDir);
      await expect(runInitWizard(["--force"], {
        ask,
        stdout: { write: (chunk: string | Uint8Array) => { output.push(String(chunk)); return true; } },
        inspection: {
          engine: "postgres",
          server_version: "PostgreSQL 16 fixture",
          current_user: "synapsor_reader",
          inspected_at: "2026-06-21T00:00:00Z",
          schemas: ["public"],
          warnings: [],
          tables: [
            {
              schema: "public",
              name: "invoices",
              type: "table",
              writable: true,
              columns: [
                { name: "id", data_type: "text", nullable: false, generated: false, ordinal_position: 1, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: true, large_or_binary: false } },
                { name: "tenant_id", data_type: "text", nullable: false, generated: false, ordinal_position: 2, suggestions: { tenant: true, conflict: false, sensitive: false, immutable: true, large_or_binary: false } },
                { name: "late_fee_cents", data_type: "integer", nullable: false, generated: false, ordinal_position: 3, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } },
                { name: "waiver_reason", data_type: "text", nullable: true, generated: false, ordinal_position: 4, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } },
                { name: "status", data_type: "text", nullable: false, generated: false, ordinal_position: 5, suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } },
                { name: "updated_at", data_type: "timestamp", nullable: false, generated: false, ordinal_position: 6, suggestions: { tenant: false, conflict: true, sensitive: false, immutable: false, large_or_binary: false } },
              ],
              primary_key: ["id"],
              unique_constraints: [],
              foreign_keys: [],
              indexes: [],
              suggestions: {
                tenant_columns: ["tenant_id"],
                conflict_columns: ["updated_at"],
                sensitive_columns: [],
                default_visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "status", "updated_at"],
              },
            },
          ],
        },
      })).resolves.toBe(0);
      const config = JSON.parse(await fs.readFile(path.join(tempDir, "synapsor.runner.json"), "utf8"));
      expect(config.capabilities.map((capability: { name: string }) => capability.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_late_fee_waiver",
      ]);
      expect(config.capabilities[1].approval.required_role).toBe("billing_lead");
      expect(config.capabilities[1].numeric_bounds).toEqual({
        late_fee_cents: { minimum: 0, maximum: 10000 },
      });
      expect(output.join("")).toContain("Step 2: Create trusted context");
      expect(output.join("")).toContain("Step 3: Create capability");
      expect(output.join("")).toContain("Available recipes");
      expect(output.join("")).toContain("Mapping recipe billing.late_fee_waiver");
      expect(output.join("")).toContain("read capability: billing.inspect_invoice");
      expect(output.join("")).toContain("proposal capability: billing.propose_late_fee_waiver");
      expect(JSON.stringify(config)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret/i);
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

  it("migrates current config conservatively without widening permissions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-config-migrate-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const migratedPath = path.join(tempDir, "migrated.json");
    const config = {
      version: 1,
      mode: "review",
      storage: { sqlite_path: "./.synapsor/local.db" },
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
    };
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["config", "migrate", "--config", configPath])).resolves.toBe(0);
    expect(output.join("")).toContain("config already current");
    await expect(fs.access(migratedPath)).rejects.toThrow();

    output.length = 0;
    await expect(main(["config", "migrate", "--config", configPath, "--output", migratedPath, "--yes"])).resolves.toBe(0);
    const migrated = JSON.parse(await fs.readFile(migratedPath, "utf8"));
    expect(migrated).toEqual(config);
    expect(JSON.stringify(migrated)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret/i);
  });

  it("runs the reproducible MCP efficiency benchmark", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const expected = await fs.readFile(path.join(process.cwd(), "fixtures/benchmark/mcp-efficiency.txt"), "utf8");

    await expect(main(["benchmark", "mcp-efficiency"])).resolves.toBe(0);
    const text = output.join("");
    expect(text).toBe(expected);
  });

  it("emits JSON for the MCP efficiency benchmark", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const expected = JSON.parse(await fs.readFile(path.join(process.cwd(), "fixtures/benchmark/mcp-efficiency.json"), "utf8"));

    await expect(main(["benchmark", "mcp-efficiency", "--json"])).resolves.toBe(0);
    const report = JSON.parse(output.join(""));
    expect(report).toEqual(expected);
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

      output.length = 0;
      const reportPath = path.join(tempDir, "synapsor-doctor.md");
      await expect(main(["doctor", "--config", configPath, "--report", "--redact", "--output", reportPath])).resolves.toBe(1);
      const markdown = await fs.readFile(reportPath, "utf8");
      expect(markdown).toContain("# Synapsor Runner Doctor Report");
      expect(markdown).toContain("## Safety Boundary");
      expect(markdown).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|reader_secret/i);
    } finally {
      if (oldRead === undefined) delete process.env.APP_POSTGRES_READ_URL; else process.env.APP_POSTGRES_READ_URL = oldRead;
      if (oldTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID; else process.env.SYNAPSOR_TENANT_ID = oldTenant;
      if (oldPrincipal === undefined) delete process.env.SYNAPSOR_PRINCIPAL; else process.env.SYNAPSOR_PRINCIPAL = oldPrincipal;
    }
  });

  it("doctors shared Postgres ledger mirror wiring without leaking connection values", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-shared-ledger-doctor-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: {
        sqlite_path: path.join(tempDir, ".synapsor", "local.db"),
        shared_postgres: {
          mode: "mirror",
          url_env: "SYNAPSOR_TEST_LEDGER_URL",
          schema: "synapsor_runner",
          lock_timeout_ms: 1000,
        },
      },
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
    const oldLedgerUrl = process.env.SYNAPSOR_TEST_LEDGER_URL;
    const oldRead = process.env.APP_POSTGRES_READ_URL;
    const oldTenant = process.env.SYNAPSOR_TENANT_ID;
    const oldPrincipal = process.env.SYNAPSOR_PRINCIPAL;
    delete process.env.SYNAPSOR_TEST_LEDGER_URL;
    process.env.APP_POSTGRES_READ_URL = "postgresql://reader_secret@example.invalid/app";
    process.env.SYNAPSOR_TENANT_ID = "acme";
    process.env.SYNAPSOR_PRINCIPAL = "local_operator";
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await expect(main(["doctor", "--config", configPath, "--json"])).resolves.toBe(1);
      const text = output.join("");
      const report = JSON.parse(text);
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "shared-postgres-ledger:mirror-config",
          level: "pass",
        }),
        expect.objectContaining({
          name: "shared-postgres-ledger:url-env",
          level: "fail",
          message: expect.stringContaining("SYNAPSOR_TEST_LEDGER_URL"),
        }),
      ]));
      expect(text).not.toMatch(/postgres(?:ql)?:\/\/|reader_secret/i);
    } finally {
      if (oldLedgerUrl === undefined) delete process.env.SYNAPSOR_TEST_LEDGER_URL; else process.env.SYNAPSOR_TEST_LEDGER_URL = oldLedgerUrl;
      if (oldRead === undefined) delete process.env.APP_POSTGRES_READ_URL; else process.env.APP_POSTGRES_READ_URL = oldRead;
      if (oldTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID; else process.env.SYNAPSOR_TENANT_ID = oldTenant;
      if (oldPrincipal === undefined) delete process.env.SYNAPSOR_PRINCIPAL; else process.env.SYNAPSOR_PRINCIPAL = oldPrincipal;
    }
  });

  it("doctors HTTP handler signing and explicit reachability without leaking endpoint values", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-handler-doctor-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");
    const oldUrl = process.env.SYNAPSOR_TEST_HANDLER_URL;
    const oldToken = process.env.SYNAPSOR_TEST_HANDLER_TOKEN;
    const oldSigningSecret = process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET;
    const oldTenant = process.env.SYNAPSOR_TENANT_ID;
    const oldPrincipal = process.env.SYNAPSOR_PRINCIPAL;
    const oldRead = process.env.APP_POSTGRES_READ_URL;
    process.env.SYNAPSOR_TEST_HANDLER_URL = "http://127.0.0.1:9/writeback?token=do-not-print";
    process.env.SYNAPSOR_TEST_HANDLER_TOKEN = "handler-secret-token";
    process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET = "handler-signing-secret";
    process.env.SYNAPSOR_TENANT_ID = "acme";
    process.env.SYNAPSOR_PRINCIPAL = "local_operator";
    delete process.env.APP_POSTGRES_READ_URL;
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await expect(main(["doctor", "--config", configPath, "--json", "--check-handlers"])).resolves.toBe(1);
      const text = output.join("");
      const report = JSON.parse(text);
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "env:SYNAPSOR_TEST_HANDLER_SIGNING_SECRET", level: "pass" }),
        expect.objectContaining({ name: "executor:billing_api:handler-reachability", level: "fail" }),
      ]));
      expect(text).not.toContain("handler-secret-token");
      expect(text).not.toContain("handler-signing-secret");
      expect(text).not.toContain("do-not-print");

      const unsignedConfig = httpHandlerConfig();
      delete (unsignedConfig.executors as any).billing_api.signing_secret_env;
      await fs.writeFile(configPath, JSON.stringify(unsignedConfig), "utf8");
      output.length = 0;
      await expect(main(["doctor", "--config", configPath, "--json"])).resolves.toBe(1);
      const unsignedReport = JSON.parse(output.join(""));
      expect(unsignedReport.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "executor:billing_api:handler-signing", level: "warn" }),
      ]));
    } finally {
      if (oldUrl === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_URL; else process.env.SYNAPSOR_TEST_HANDLER_URL = oldUrl;
      if (oldToken === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_TOKEN; else process.env.SYNAPSOR_TEST_HANDLER_TOKEN = oldToken;
      if (oldSigningSecret === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET; else process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET = oldSigningSecret;
      if (oldTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID; else process.env.SYNAPSOR_TENANT_ID = oldTenant;
      if (oldPrincipal === undefined) delete process.env.SYNAPSOR_PRINCIPAL; else process.env.SYNAPSOR_PRINCIPAL = oldPrincipal;
      if (oldRead === undefined) delete process.env.APP_POSTGRES_READ_URL; else process.env.APP_POSTGRES_READ_URL = oldRead;
    }
  });

  it("reports first-run doctor checks without leaking generated MCP config secrets", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-first-run-doctor-"));
    const oldCwd = process.cwd();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      process.chdir(tempDir);
      await fs.writeFile("package.json", JSON.stringify({ name: "doctor-fixture" }), "utf8");
      await fs.mkdir(".synapsor/mcp", { recursive: true });
      await fs.writeFile(".synapsor/mcp/generic-stdio.json", JSON.stringify({
        command: "synapsor-runner",
        args: ["mcp", "serve", "--config", "./synapsor.runner.json", "--store", "./.synapsor/local.db"],
      }), "utf8");
      await fs.writeFile("synapsor.runner.json", JSON.stringify({
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
            name: "records.inspect_record",
            kind: "read",
            source: "app_postgres",
            target: {
              schema: "public",
              table: "records",
              primary_key: "id",
              tenant_key: "tenant_id",
            },
            args: {
              record_id: { type: "string", required: true, max_length: 128 },
            },
            lookup: { id_from_arg: "record_id" },
            visible_columns: ["id", "tenant_id", "updated_at"],
            evidence: "required",
            max_rows: 1,
          },
        ],
      }), "utf8");

      const code = await main(["doctor", "--first-run", "--json"]);
      expect([0, 1]).toContain(code);
      const report = JSON.parse(output.join(""));
      const names = report.checks.map((check: { name: string }) => check.name);
      expect(names).toContain("pnpm-install");
      expect(names).toContain("sqlite-store");
      expect(names.some((name: string) => name.startsWith("mcp-client-config-"))).toBe(true);
      expect(output.join("")).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|syn_wbr_/);
    } finally {
      process.chdir(oldCwd);
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

  it("probes direct SQL writeback safely when requested by doctor", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-writeback-doctor-"));
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
    delete process.env.APP_POSTGRES_READ_URL;
    process.env.APP_POSTGRES_WRITE_URL = "postgresql://writer:writer-secret@127.0.0.1:9/app";
    process.env.SYNAPSOR_TENANT_ID = "acme";
    process.env.SYNAPSOR_PRINCIPAL = "local_operator";
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await expect(main(["doctor", "--config", configPath, "--json", "--check-writeback"])).resolves.toBe(1);
      const text = output.join("");
      const report = JSON.parse(text);
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "source:app_postgres:receipt-table-probe", level: "fail" }),
        expect.objectContaining({ name: "capability:billing.propose_invoice_update:writeback-target-probe", level: "fail" }),
      ]));
      expect(text).toContain("writeback migration --engine postgres --schema synapsor");
      expect(text).toContain("writeback grants --engine postgres --schema synapsor");
      expect(text).not.toContain("writer-secret");
      expect(text).not.toContain("postgresql://");
      expect(text).not.toContain("127.0.0.1:9");
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
      protocol_version: "1.0" as const,
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

    async function expectTamperRejected(job: unknown, pattern: RegExp) {
      output.length = 0;
      await fs.writeFile(jobPath, JSON.stringify(job), "utf8");
      await expect(main(["apply", "--job", jobPath, "--config", configPath, "--dry-run"])).rejects.toThrow(pattern);
    }

    await expectTamperRejected(
      { ...baseJob, target: { ...baseJob.target, table: "accounts" } },
      /does not match any reviewed proposal capability/i,
    );

    await expectTamperRejected(
      { ...baseJob, target: { ...baseJob.target, schema: "private" } },
      /does not match any reviewed proposal capability/i,
    );

    await expectTamperRejected(
      { ...baseJob, target: { ...baseJob.target, primary_key: { column: "invoice_id", value: "INV-1" } } },
      /does not match any reviewed proposal capability/i,
    );

    await expectTamperRejected(
      { ...baseJob, target: { ...baseJob.target, tenant_guard: { column: "org_id", value: "acme" } } },
      /does not match any reviewed proposal capability/i,
    );

    await expectTamperRejected(
      { ...baseJob, conflict_guard: { kind: "version_column", column: "modified_at", expected_value: "2026-06-20T12:00:00Z" } },
      /conflict guard does not match/i,
    );

    await fs.writeFile(jobPath, JSON.stringify({
      ...baseJob,
      target: { ...baseJob.target, table: "invoices" },
      allowed_columns: ["late_fee_cents", "admin_override"],
      patch: { late_fee_cents: 0 },
    }), "utf8");
    await expect(main(["apply", "--job", jobPath, "--config", configPath, "--dry-run"])).rejects.toThrow(/widens reviewed authority/i);

    await expectTamperRejected(
      {
        ...baseJob,
        allowed_columns: ["late_fee_cents", "waiver_reason"],
        patch: { late_fee_cents: 0, admin_override: true },
      },
      /patch column not allowed: admin_override/i,
    );

    await expectTamperRejected(
      {
        ...baseJob,
        allowed_columns: ["late_fee_cents", "waiver_reason"],
        patch: { "late_fee_cents = 0; DROP TABLE invoices; --": 0 },
      },
      /fixed safe identifier/i,
    );

    await expectTamperRejected(
      { ...baseJob, lease_expires_at: new Date(Date.now() - 60_000).toISOString() },
      /lease has expired/i,
    );

    const { approval_id: _approvalId, ...withoutApproval } = baseJob;
    await expectTamperRejected(withoutApproval, /approval_id/i);

    await fs.writeFile(jobPath, JSON.stringify(baseJob), "utf8");
    await expect(main(["apply", "--job", jobPath, "--config", configPath])).rejects.toThrow(/requires --store/i);

    const storePath = path.join(tempDir, "local.db");
    const store = new ProposalStore(storePath);
    const localChangeSet = {
      ...structuredClone(changeSet),
      proposal_id: "wrp_local",
      proposal_version: 1,
      source: {
        ...changeSet.source,
        source_id: "app_postgres",
        schema: "public",
        table: "invoices",
        primary_key: { column: "id", value: "INV-1" },
      },
      scope: { tenant_id: "acme", business_object: "invoice", object_id: "INV-1" },
      guards: {
        ...changeSet.guards,
        tenant: { column: "tenant_id", value: "acme" },
        allowed_columns: ["late_fee_cents", "waiver_reason"],
        expected_version: { column: "updated_at", value: "2026-06-20T12:00:00Z" },
      },
      integrity: { proposal_hash: "sha256:proposal" },
    };
    store.createProposal(localChangeSet);
    store.approveProposal("wrp_local", { approver: "local_reviewer", proposal_hash: "sha256:proposal", proposal_version: 1 });
    store.close();

    await fs.writeFile(jobPath, JSON.stringify({ ...baseJob, approval_id: "sha256:tampered" }), "utf8");
    await expect(main(["apply", "--job", jobPath, "--config", configPath, "--dry-run", "--store", storePath]))
      .rejects.toThrow(/digest does not match local proposal/i);
  });

  it("applies a direct SQL proposal capability loaded only from a referenced contract", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-contract-direct-"));
    const { configPath, storePath } = await writeContractApplyFixture(tempDir);
    const proposalId = await createApprovedContractProposal({ configPath, storePath });
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["apply", proposalId, "--config", configPath, "--store", storePath, "--dry-run", "--json"])).resolves.toBe(0);
    expect(JSON.parse(output.join("")).status).toBe("applied");

    const store = new ProposalStore(storePath);
    try {
      expect(store.receipts(proposalId).length).toBe(1);
      expect(store.replay(proposalId).receipts.length).toBe(1);
    } finally {
      store.close();
    }
  });

  it("routes a contract-authored APP HANDLER executor proposal through a live http_handler", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-contract-handler-"));
    const { configPath, storePath } = await writeContractApplyFixture(tempDir, {
      writeback: { mode: "app_handler", executor: "billing_handler" },
      source: { write_url_env: undefined },
      executors: {
        billing_handler: {
          type: "http_handler",
          url_env: "BILLING_HANDLER_URL",
          method: "POST",
        },
      },
    });
    const proposalId = await createApprovedContractProposal({ configPath, storePath });
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "applied",
        rows_affected: 1,
        source_database_mutated: true,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test handler did not bind to a port");
    const oldHandlerUrl = process.env.BILLING_HANDLER_URL;
    process.env.BILLING_HANDLER_URL = `http://127.0.0.1:${address.port}/synapsor/writeback`;
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await expect(main(["apply", "latest", "--config", configPath, "--store", storePath, "--json"])).resolves.toBe(0);
      expect(JSON.parse(output.join("")).status).toBe("applied");
      const store = new ProposalStore(storePath);
      try {
        expect(store.receipts(proposalId)[0]?.writeback_job_id).toMatch(/^hwb_/);
      } finally {
        store.close();
      }
    } finally {
      if (oldHandlerUrl === undefined) delete process.env.BILLING_HANDLER_URL; else process.env.BILLING_HANDLER_URL = oldHandlerUrl;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("fails duplicate embedded and contract capability names before serving or applying", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-contract-duplicate-"));
    const { configPath, storePath } = await writeContractApplyFixture(tempDir, { embeddedDuplicate: true });
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    await expect(main(["config", "validate", "--config", configPath])).resolves.toBe(1);
    expect(output.join("")).toMatch(/Duplicate capability billing\.inspect_invoice/i);
    await expect(main(["tools", "list", "--config", configPath, "--store", storePath])).rejects.toThrow(/Duplicate capability billing\.inspect_invoice/i);
    await expect(main(["mcp", "serve", "--config", configPath, "--store", storePath])).rejects.toThrow(/Duplicate capability billing\.inspect_invoice/i);
    await expect(main(["propose", "billing.propose_late_fee_waiver", "--config", configPath, "--store", storePath, "--sample"])).rejects.toThrow(/Duplicate capability billing\.inspect_invoice/i);
    await expect(main(["apply", "wrp_duplicate", "--config", configPath, "--store", storePath, "--dry-run"])).rejects.toThrow(/Duplicate capability billing\.inspect_invoice/i);
  });

  it("fails broken direct SQL writeback at doctor and propose time for contract capabilities", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-contract-broken-writeback-"));
    const { configPath, storePath } = await writeContractApplyFixture(tempDir, {
      source: { write_url_env: undefined },
    });
    const oldTenant = process.env.SYNAPSOR_TENANT_ID;
    const oldPrincipal = process.env.SYNAPSOR_PRINCIPAL;
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
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "capability:billing.propose_late_fee_waiver:writeback-resolution",
          level: "fail",
        }),
      ]));
      await expect(main(["propose", "billing.propose_late_fee_waiver", "--config", configPath, "--store", storePath, "--json", JSON.stringify({
        invoice_id: "INV-3001",
        waiver_reason: "approved support waiver",
      })])).rejects.toThrow(/DIRECT SQL writeback.*no write_url_env/i);
    } finally {
      if (oldTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID; else process.env.SYNAPSOR_TENANT_ID = oldTenant;
      if (oldPrincipal === undefined) delete process.env.SYNAPSOR_PRINCIPAL; else process.env.SYNAPSOR_PRINCIPAL = oldPrincipal;
    }
  });

  it("fails doctor when a proposal capability references an unresolved approval policy", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-policy-doctor-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: path.join(tempDir, "local.db") },
      sources: {
        local_postgres: {
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
          name: "support.propose_plan_credit",
          kind: "proposal",
          source: "local_postgres",
          target: { schema: "public", table: "customers", primary_key: "id", tenant_key: "tenant_id" },
          args: {
            customer_id: { type: "string", required: true, max_length: 128 },
            credit_cents: { type: "number", required: true, minimum: 1, maximum: 50000 },
          },
          lookup: { id_from_arg: "customer_id" },
          visible_columns: ["id", "tenant_id", "plan_credit_cents", "updated_at"],
          patch: { plan_credit_cents: { from_arg: "credit_cents" } },
          allowed_columns: ["plan_credit_cents"],
          numeric_bounds: { plan_credit_cents: { minimum: 1, maximum: 50000 } },
          conflict_guard: { column: "updated_at" },
          approval: {
            mode: "policy",
            required_role: "support_reviewer",
            policy: "missing_policy",
          },
        },
      ],
      policies: [],
    }), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["doctor", "--config", configPath, "--json"])).resolves.toBe(1);
    const report = JSON.parse(output.join(""));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "capability:support.propose_plan_credit:approval-policy-resolution",
        level: "fail",
      }),
    ]));
  });

  it("allows proposal-only contract capabilities to propose but refuses local apply clearly", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-contract-proposal-only-"));
    const { configPath, storePath } = await writeContractApplyFixture(tempDir, {
      writeback: { mode: "none" },
      source: { write_url_env: undefined },
    });
    const proposalId = await createApprovedContractProposal({ configPath, storePath });
    await expect(main(["apply", proposalId, "--config", configPath, "--store", storePath, "--dry-run"])).rejects.toThrow(/not locally applyable/i);
  });

  it("resolves direct SQL writeback credentials from source write_url_env before legacy fallback", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-write-url-env-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const job = {
      protocol_version: "1.0" as const,
      job_id: "wbj_write_env",
      proposal_id: "wrp_write_env",
      approval_id: "sha256:proposal",
      source_id: "app_postgres",
      engine: "postgres" as const,
      target: {
        schema: "public",
        table: "invoices",
        primary_key: { column: "id", value: "INV-1" },
        tenant_guard: { column: "tenant_id", value: "acme" },
      },
      allowed_columns: ["late_fee_cents"],
      patch: { late_fee_cents: 0 },
      conflict_guard: { kind: "version_column" as const, column: "updated_at", expected_value: "2026-06-20T12:00:00Z" },
      idempotency_key: "idem_write_env",
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      attempt_count: 1,
    };
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
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
            invoice_id: { type: "string", required: true },
          },
          lookup: { id_from_arg: "invoice_id" },
          visible_columns: ["id", "tenant_id", "updated_at", "late_fee_cents"],
          patch: { late_fee_cents: { fixed: 0 } },
          allowed_columns: ["late_fee_cents"],
          conflict_guard: { column: "updated_at" },
        },
      ],
    }), "utf8");

    const env = {
      APP_POSTGRES_WRITE_URL: " postgresql://writer:correct@example/app ",
      SYNAPSOR_DATABASE_URL: "postgresql://legacy:wrong@example/app",
    } as NodeJS.ProcessEnv;

    await expect(resolveSqlWriteDatabaseUrl(job, configPath, env)).resolves.toBe("postgresql://writer:correct@example/app");
    delete env.APP_POSTGRES_WRITE_URL;
    await expect(resolveSqlWriteDatabaseUrl(job, configPath, env)).resolves.toBe("postgresql://legacy:wrong@example/app");
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

  it("runs top-level synapsor-runner audit through the MCP database risk review", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-audit-config-"));
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
        provider: "static_dev",
        values: { tenant_id: "acme", principal: "local_operator" },
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
          visible_columns: ["id", "tenant_id", "late_fee_cents", "updated_at"],
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

    await expect(main(["audit", configPath, "--json"])).resolves.toBe(0);
    const report = JSON.parse(output.join(""));
    expect(report.summary.tools_inspected).toBe(1);
    expect(report.findings.map((finding: { code: string }) => finding.code)).not.toContain("GENERIC_SQL_TOOL");
    expect(output.join("")).toContain("static risk review");
  });

  it("resolves audit contract references relative to the config file", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-audit-contract-path-"));
    const configDir = path.join(tempDir, "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.copyFile(
      workspacePath("packages/spec/examples/support-refund.contract.json"),
      path.join(configDir, "support.contract.json"),
    );
    const configPath = path.join(configDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: {
        support_postgres: {
          engine: "postgres",
          read_url_env: "SUPPORT_POSTGRES_READ_URL",
          write_url_env: "SUPPORT_POSTGRES_WRITE_URL",
        },
      },
      contexts: {
        support_agent_context: {
          provider: "environment",
          values: {
            tenant_id_env: "SYNAPSOR_TENANT_ID",
            principal_env: "SYNAPSOR_PRINCIPAL",
          },
        },
      },
      contracts: ["./support.contract.json"],
      capabilities: [],
    }), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["audit", configPath, "--json"])).resolves.toBe(0);
    expect(JSON.parse(output.join("")).summary.tools_inspected).toBe(2);
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

  it("prints MCP client configuration snippets without secrets", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main([
      "mcp",
      "configure",
      "--client",
      "claude",
      "--config",
      "./synapsor.runner.json",
      "--store",
      "./.synapsor/local.db",
    ])).resolves.toBe(0);

    const snippet = JSON.parse(output.join(""));
    expect(snippet.mcpServers.synapsor).toEqual({
      command: "synapsor-runner",
      args: ["mcp", "serve", "--config", "./synapsor.runner.json", "--store", "./.synapsor/local.db"],
    });
    expect(output.join("")).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret/i);
  });

  it("prints MCP client config snippets through the short mcp config alias", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main([
      "mcp",
      "config",
      "claude-desktop",
      "--config",
      "./synapsor.runner.json",
      "--store",
      "./.synapsor/local.db",
    ])).resolves.toBe(0);

    const snippet = JSON.parse(output.join(""));
    expect(snippet.mcpServers.synapsor).toEqual({
      command: "synapsor-runner",
      args: ["mcp", "serve", "--config", "./synapsor.runner.json", "--store", "./.synapsor/local.db"],
    });
    expect(output.join("")).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret/i);
  });

  it("defaults mcp config to a Claude Desktop style snippet", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main([
      "mcp",
      "config",
      "--config",
      "./synapsor.runner.json",
      "--store",
      "./.synapsor/local.db",
    ])).resolves.toBe(0);

    const snippet = JSON.parse(output.join(""));
    expect(snippet.mcpServers.synapsor).toEqual({
      command: "synapsor-runner",
      args: ["mcp", "serve", "--config", "./synapsor.runner.json", "--store", "./.synapsor/local.db"],
    });
    expect(output.join("")).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret/i);
  });

  it("prints OpenAI Agents SDK Streamable HTTP config with built-in aliases", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main([
      "mcp",
      "client-config",
      "--client",
      "openai-agents",
      "--config",
      "./synapsor.runner.json",
      "--store",
      "./.synapsor/local.db",
      "--port",
      "8766",
      "--include-instructions",
    ])).resolves.toBe(0);

    const snippet = JSON.parse(output.join(""));
    expect(snippet.transport).toBe("streamable-http");
    expect(snippet.start_server).toMatchObject({
      command: "synapsor-runner",
      env: { SYNAPSOR_RUNNER_HTTP_TOKEN: "<set-a-random-local-token>" },
    });
    expect(snippet.start_server.args).toEqual(expect.arrayContaining([
      "serve-streamable-http",
      "--alias-mode",
      "openai",
    ]));
    expect(snippet.openai_agents_sdk.python).toContain("MCPServerStreamableHttp");
    expect(snippet.openai_agents_sdk.url).toBe("http://127.0.0.1:8766/mcp");
    expect(snippet.tool_names.model_visible_with_alias_mode_openai).toBe("billing__inspect_invoice");
    expect(snippet.agent_instructions.recommended_system_prompt).toContain("propose-first pattern");
    expect(snippet.agent_instructions.recommended_system_prompt).toContain("source_database_changed: true");
    expect(snippet.agent_instructions.recommended_system_prompt).toContain("On VERSION_CONFLICT");
    expect(snippet.agent_instructions.recommended_system_prompt).toContain("Evidence handles are audit/replay handles");
    expect(snippet.agent_instructions.recommended_system_prompt).toContain("billing__inspect_invoice");
    expect(output.join("")).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret_[A-Za-z0-9]|sk-/i);

    output.length = 0;
    await expect(main([
      "mcp",
      "config",
      "openai-agents",
      "--transport",
      "streamable-http",
      "--config",
      "./synapsor.runner.json",
      "--store",
      "./.synapsor/local.db",
    ])).resolves.toBe(0);
    expect(JSON.parse(output.join("")).start_server.args).toContain("--alias-mode");
  });

  it("supports absolute MCP client snippets and smokes the configured tool boundary", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-mcp-smoke-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: storePath },
      sources: {
        app_mysql: {
          engine: "mysql",
          read_url_env: "APP_MYSQL_READ_URL",
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
          name: "clinic.inspect_appointment",
          kind: "read",
          source: "app_mysql",
          target: {
            schema: "app",
            table: "appointments",
            primary_key: "appointment_id",
            tenant_key: "clinic_id",
          },
          args: {
            appointment_id: { type: "string", required: true, max_length: 128 },
          },
          lookup: { id_from_arg: "appointment_id" },
          visible_columns: ["appointment_id", "clinic_id", "status", "updated_at"],
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

    await expect(main([
      "mcp",
      "config",
      "generic",
      "--absolute-paths",
      "--config",
      configPath,
      "--store",
      storePath,
    ])).resolves.toBe(0);
    const snippet = JSON.parse(output.join(""));
    expect(path.isAbsolute(snippet.args[3])).toBe(true);
    expect(path.isAbsolute(snippet.args[5])).toBe(true);
    expect(JSON.stringify(snippet)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret/i);

    output.length = 0;
    await expect(main(["mcp", "smoke", "--config", configPath, "--store", storePath, "--json"])).resolves.toBe(0);
    const smoke = JSON.parse(output.join(""));
    expect(smoke.ok).toBe(true);
    expect(smoke.tools).toEqual(["clinic.inspect_appointment"]);
    expect(smoke.checks.map((check: { name: string; ok: boolean }) => [check.name, check.ok])).toEqual(expect.arrayContaining([
      ["semantic tools present", true],
      ["execute_sql absent", true],
      ["approval tools absent", true],
      ["commit tools absent", true],
      ["database_url absent", true],
      ["write credentials absent", true],
    ]));

    output.length = 0;
    await expect(main(["smoke", "boundary", "--config", configPath, "--store", storePath, "--json"])).resolves.toBe(0);
    expect(JSON.parse(output.join("")).tools).toEqual(["clinic.inspect_appointment"]);

    output.length = 0;
    await expect(main(["tools", "preview", "--config", configPath, "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Exposed to MCP:");
    expect(output.join("")).toContain("clinic.inspect_appointment");
    expect(output.join("")).toContain("Alias mode: canonical");
    expect(output.join("")).toContain("Not exposed to MCP:");
    expect(output.join("")).toContain("execute_sql / raw query tools");

    output.length = 0;
    await expect(main(["tools", "preview", "--config", configPath, "--store", storePath, "--alias-mode", "openai"])).resolves.toBe(0);
    expect(output.join("")).toContain("Alias mode: openai");
    expect(output.join("")).toContain("clinic__inspect_appointment -> clinic.inspect_appointment");

    output.length = 0;
    await expect(main(["tools", "preview", "--config", configPath, "--store", storePath, "--aliases", "--json"])).resolves.toBe(0);
    const preview = JSON.parse(output.join(""));
    expect(preview.alias_mode).toBe("both");
    expect(preview.exposed_to_mcp).toEqual(["clinic.inspect_appointment", "clinic__inspect_appointment"]);
    expect(preview.alias_mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        canonicalName: "clinic.inspect_appointment",
        exposedName: "clinic__inspect_appointment",
        isAlias: true,
      }),
    ]));

    output.length = 0;
    await expect(main(["tools", "list", "--config", configPath, "--store", storePath, "--aliases", "--json"])).resolves.toBe(0);
    const listed = JSON.parse(output.join(""));
    expect(listed.alias_mode).toBe("both");
    expect(listed.exposed_to_mcp).toEqual(["clinic.inspect_appointment", "clinic__inspect_appointment"]);
  });

  it("prints review-mode up guidance without leaking secrets", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-up-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, ".synapsor/local.db");
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");
    const oldUrl = process.env.SYNAPSOR_TEST_HANDLER_URL;
    const oldToken = process.env.SYNAPSOR_TEST_HANDLER_TOKEN;
    const oldSigningSecret = process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET;
    process.env.SYNAPSOR_TEST_HANDLER_URL = "https://handler.internal/writeback?token=do-not-print";
    process.env.SYNAPSOR_TEST_HANDLER_TOKEN = "handler-secret-token";
    process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET = "handler-signing-secret";
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    try {
      await expect(main([
        "up",
        "--config",
        configPath,
        "--store",
        storePath,
        "--transport",
        "stdio",
        "--alias-mode",
        "openai",
        "--open-ui",
        "--dry-run",
      ])).resolves.toBe(0);
      const text = output.join("");
      expect(text).toContain("Synapsor Runner review-mode up");
      expect(text).toContain("Transport: stdio");
      expect(text).toContain("Serve now: no");
      expect(text).toContain("Model-facing tools:");
      expect(text).toContain("billing__waive_late_fee -> billing.waive_late_fee");
      expect(text).toContain("Writeback paths:");
      expect(text).toContain("app-owned http_handler billing_api");
      expect(text).toContain("App-owned handler requirements:");
      expect(text).toContain("url env: SYNAPSOR_TEST_HANDLER_URL (set)");
      expect(text).toContain("bearer token env: SYNAPSOR_TEST_HANDLER_TOKEN (set)");
      expect(text).toContain("signing secret env: SYNAPSOR_TEST_HANDLER_SIGNING_SECRET (set)");
      expect(text).toContain("IMPORTANT: your app handler owns the final business write.");
      expect(text).toContain("cross-tenant writes, lost updates, or duplicate writes");
      expect(text).toContain("Server guidance:");
      expect(text).toContain("stdio mode is launched by an MCP client");
      expect(text).toContain("Local review UI:");
      expect(text).toContain("Next commands:");
      expect(text).toContain("doctor --config");
      expect(text).toContain("--check-handlers");
      expect(text).not.toContain("handler-secret-token");
      expect(text).not.toContain("handler-signing-secret");
      expect(text).not.toContain("handler.internal");
      expect(text).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\//i);
    } finally {
      if (oldUrl === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_URL; else process.env.SYNAPSOR_TEST_HANDLER_URL = oldUrl;
      if (oldToken === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_TOKEN; else process.env.SYNAPSOR_TEST_HANDLER_TOKEN = oldToken;
      if (oldSigningSecret === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET; else process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET = oldSigningSecret;
    }
  });

  it("keeps up guidance-only unless --serve is requested", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-up-streamable-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, ".synapsor/local.db");
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main([
      "up",
      "--config",
      configPath,
      "--store",
      storePath,
      "--transport",
      "streamable-http",
      "--dry-run",
    ])).resolves.toBe(0);
    let text = output.join("");
    expect(text).toContain("Transport: streamable-http");
    expect(text).toContain("Serve now: no");
    expect(text).toContain("Start command:");
    expect(text).toContain("up --serve --config");

    output.length = 0;
    await expect(main([
      "up",
      "--serve",
      "--config",
      configPath,
      "--store",
      storePath,
      "--dry-run",
    ])).resolves.toBe(0);
    text = output.join("");
    expect(text).toContain("Transport: streamable-http");
    expect(text).toContain("Serve now: yes");
    expect(text).toContain("Status: dry run only; server not started.");
  });

  it("rejects up --serve with stdio because stdio is launched by the MCP client", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-up-stdio-serve-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");

    await expect(main([
      "up",
      "--serve",
      "--transport",
      "stdio",
      "--config",
      configPath,
    ])).rejects.toThrow(/up --serve starts the Streamable HTTP MCP server/);
  });

  it("refuses review-mode up when the local store has an active server lease", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-up-lease-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, ".synapsor/local.db");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");
    await fs.writeFile(`${storePath}.lease.json`, JSON.stringify({
      pid: process.pid,
      mode: "mcp",
      transport: "streamable-http",
      store_path: storePath,
      started_at: "2026-06-30T00:00:00Z",
    }), "utf8");

    await expect(main(["up", "--config", configPath, "--store", storePath, "--dry-run"]))
      .rejects.toThrow(/Local store appears active[\s\S]*--allow-concurrent-store/);
  });

  it("reclaims stale review-mode up leases whose pid is no longer active", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-up-stale-lease-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, ".synapsor/local.db");
    const leasePath = `${storePath}.lease.json`;
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");
    await fs.writeFile(leasePath, JSON.stringify({
      pid: 999999999,
      mode: "mcp",
      transport: "streamable-http",
      store_path: storePath,
      started_at: "2026-06-30T00:00:00Z",
    }), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["up", "--config", configPath, "--store", storePath, "--dry-run"]))
      .resolves.toBe(0);
    await expect(fs.stat(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(output.join("")).toContain("Synapsor Runner review-mode up");
  });

  it("prints writeback receipt table migration, grants, and doctor guidance", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-writeback-help-"));
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
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["writeback", "migration", "--engine", "postgres", "--schema", "synapsor"])).resolves.toBe(0);
    expect(output.join("")).toContain("CREATE SCHEMA IF NOT EXISTS \"synapsor\"");
    expect(output.join("")).toContain("synapsor_writeback_receipts");
    expect(output.join("")).toContain("search_path");

    output.length = 0;
    await expect(main(["writeback", "grants", "--engine", "postgres", "--schema", "synapsor", "--writer-role", "app_writer"])).resolves.toBe(0);
    expect(output.join("")).toContain("GRANT USAGE ON SCHEMA \"synapsor\" TO \"app_writer\"");
    expect(output.join("")).toContain("GRANT SELECT, INSERT, UPDATE ON TABLE \"synapsor\".synapsor_writeback_receipts TO \"app_writer\"");

    output.length = 0;
    await expect(main(["writeback", "doctor", "--config", configPath])).resolves.toBe(1);
    expect(output.join("")).toContain("writer env: APP_POSTGRES_WRITE_URL");
    expect(output.join("")).toContain("env status: missing");
    expect(output.join("")).toContain("writeback migration");
  });

  it("creates app-owned writeback handler templates without package-relative paths", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-handler-template-"));
    const oldCwd = process.cwd();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    try {
      process.chdir(tempDir);
      await expect(main(["handler", "template", "--list"])).resolves.toBe(0);
      expect(output.join("")).toContain("node-fastify");
      expect(output.join("")).toContain("python-fastapi");
      expect(output.join("")).toContain("IMPORTANT: your app handler owns the final business write.");
      output.length = 0;

      await expect(main(["handler", "template", "node-fastify"])).resolves.toBe(0);
      const nodeTemplate = await fs.readFile(path.join(tempDir, "synapsor-writeback-handler.mjs"), "utf8");
      expect(nodeTemplate).toContain("Fastify");
      expect(nodeTemplate).toContain("app-owned transaction");
      expect(nodeTemplate).toContain("IMPORTANT: your app handler owns the final business write.");
      expect(nodeTemplate).toContain("lost updates");
      expect(output.join("")).toContain("created synapsor-writeback-handler.mjs");
      expect(output.join("")).toContain("transaction/rollback");

      await expect(main(["handler", "template", "node-fastify"])).rejects.toThrow(/already exists/i);

      output.length = 0;
      await expect(main(["handler", "template", "python-fastapi", "--stdout"])).resolves.toBe(0);
      expect(output.join("")).toContain("FastAPI");
      expect(output.join("")).toContain("source_database_mutated");
      expect(output.join("")).toContain("duplicate writes");

      await expect(main(["handler", "template", "command", "--output", "handlers/apply.mjs"])).resolves.toBe(0);
      const commandTemplate = await fs.readFile(path.join(tempDir, "handlers/apply.mjs"), "utf8");
      expect(commandTemplate).toContain("#!/usr/bin/env node");
      expect(commandTemplate).toContain("idempotency");
      expect(commandTemplate).toContain("IMPORTANT: your app handler owns the final business write.");
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("lists, shows, and initializes capability recipes without secrets", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-recipes-"));
    const oldCwd = process.cwd();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    try {
      process.chdir(tempDir);
      await expect(main(["recipes", "list", "--json"])).resolves.toBe(0);
      const list = JSON.parse(output.join(""));
      expect(list.recipes.map((recipe: { id: string }) => recipe.id)).toContain("billing.late_fee_waiver");

      output.length = 0;
      await expect(main(["recipes", "show", "billing.late_fee_waiver", "--json"])).resolves.toBe(0);
      const recipe = JSON.parse(output.join(""));
      expect(recipe.semantic_tools).toEqual(["billing.inspect_invoice", "billing.propose_late_fee_waiver"]);
      expect(recipe.required_columns).toContain("updated_at");

      output.length = 0;
      await expect(main(["recipes", "init", "billing.late_fee_waiver", "--force"])).resolves.toBe(0);
      const configText = await fs.readFile(path.join(tempDir, "synapsor.runner.json"), "utf8");
      const config = JSON.parse(configText);
      expect(config.capabilities.map((capability: { name: string }) => capability.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_late_fee_waiver",
      ]);
      expect(config.capabilities[1].numeric_bounds).toMatchObject({ late_fee_cents: { minimum: 0, maximum: 10000 } });
      output.length = 0;
      await expect(main(["config", "validate", "--config", path.join(tempDir, "synapsor.runner.json")])).resolves.toBe(0);
      expect(output.join("")).toContain("config valid");
      expect(configText).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret|token/i);
      expect(await fs.readFile(path.join(tempDir, ".env.example"), "utf8")).toContain("SYNAPSOR_DATABASE_READ_URL");

      const customRecipe = {
        ...recipe,
        id: "custom.asset_review",
        title: "Custom asset review",
        semantic_tools: ["assets.inspect_asset", "assets.propose_asset_update"],
        spec: {
          ...recipe.spec,
          namespace: "assets",
          object_name: "asset",
          table: "assets",
          inspect_tool_name: "assets.inspect_asset",
          proposal_tool_name: "assets.propose_asset_update",
          lookup_arg: "asset_id",
        },
      };
      await fs.writeFile(path.join(tempDir, "custom-recipe.json"), JSON.stringify(customRecipe, null, 2));
      output.length = 0;
      await expect(main(["recipes", "show", "./custom-recipe.json", "--json"])).resolves.toBe(0);
      expect(JSON.parse(output.join("")).semantic_tools).toEqual(["assets.inspect_asset", "assets.propose_asset_update"]);
      output.length = 0;
      await expect(main(["recipes", "init", "./custom-recipe.json", "--output", "custom.runner.json", "--force"])).resolves.toBe(0);
      const customConfig = JSON.parse(await fs.readFile(path.join(tempDir, "custom.runner.json"), "utf8"));
      expect(customConfig.capabilities.map((capability: { name: string }) => capability.name)).toEqual([
        "assets.inspect_asset",
        "assets.propose_asset_update",
      ]);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("writes MCP client configuration only with explicit destination and backup", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-mcp-configure-"));
    const destination = path.join(tempDir, "cursor.json");
    await fs.writeFile(destination, JSON.stringify({
      mcpServers: {
        existing: { command: "node", args: ["server.js"] },
      },
    }, null, 2), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main([
      "mcp",
      "configure",
      "--client",
      "cursor",
      "--config",
      "./synapsor.runner.json",
      "--store",
      "./.synapsor/local.db",
      "--write",
      "--destination",
      destination,
      "--yes",
    ])).resolves.toBe(0);

    const written = JSON.parse(await fs.readFile(destination, "utf8"));
    expect(written.mcpServers.existing.command).toBe("node");
    expect(written.mcpServers.synapsor).toEqual({
      command: "synapsor-runner",
      args: ["mcp", "serve", "--config", "./synapsor.runner.json", "--store", "./.synapsor/local.db"],
    });
    const backups = (await fs.readdir(tempDir)).filter((name) => name.startsWith("cursor.json.bak."));
    expect(backups).toHaveLength(1);
    expect(output.join("")).toContain("wrote MCP cursor configuration");
    expect(JSON.stringify(written)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret/i);
  });

  it("lists, shows, approves, and exports local proposals", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-"));
    const storePath = path.join(tempDir, "local.db");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.recordEvidenceBundle({
      evidence_bundle_id: "ev_cli",
      proposal_id: "wrp_cli",
      tenant_id: "acme",
      payload: {
        capability: "billing.waive_late_fee",
        source_id: "src_pg_acme",
        target: "public.invoices",
        principal: { id: "support_agent_17" },
        query_fingerprint: "sha256:evidence",
      },
      items: [{
        kind: "external_row",
        source_id: "src_pg_acme",
        table: "public.invoices",
        primary_key: { column: "id", value: "INV-CLI" },
        visible_row: { id: "INV-CLI", tenant_id: "acme", late_fee_cents: 5500, updated_at: "2026-06-20T14:31:08Z" },
      }],
    });
    store.recordQueryAudit({
      proposal_id: "wrp_cli",
      evidence_bundle_id: "ev_cli",
      source_id: "src_pg_acme",
      query_fingerprint: "sha256:evidence",
      table_name: "public.invoices",
      row_count: 1,
      payload: {
        capability: "billing.waive_late_fee",
        statement_template: "SELECT id, tenant_id, late_fee_cents FROM public.invoices WHERE id = ? AND tenant_id = ? LIMIT 1",
        parameters_redacted: true,
      },
    });
    store.close();

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["proposals", "list", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("wrp_cli");
    output.length = 0;
    await expect(main(["proposals", "list", "--store", storePath, "--tenant", "acme", "--capability", "billing.waive_late_fee", "--object", "invoice:INV-CLI", "--status", "pending_review"])).resolves.toBe(0);
    expect(output.join("")).toContain("wrp_cli");
    output.length = 0;
    await expect(main(["proposals", "list", "--store", storePath, "--tenant", "otherco"])).resolves.toBe(0);
    expect(output.join("")).toContain("No proposals found.");
    await expect(main(["proposals", "list", "--store", storePath, "--unsupported"])).rejects.toThrow(/Unknown option/);

    output.length = 0;
    await expect(main(["proposals", "show", "latest", "--store", storePath])).resolves.toBe(0);
    let text = output.join("");
    expect(text).toContain("Proposal wrp_cli");
    expect(text).toContain("Status: pending review");
    expect(text).toContain("Source DB changed:\nno");
    expect(text).toContain("Approval:\nrequired outside MCP");
    expect(text).toContain("late_fee_cents: 5500 -> 0");
    expect(text).toContain("More detail:");
    expect(text).not.toContain("proposal hash");
    expect(text).not.toContain("proposal version");
    expect(text).not.toContain("conflict guard");
    expect(text).not.toContain("query sha256:evidence");
    expect(text).not.toContain("target: external_postgres:src_pg_acme/public.invoices/INV-CLI");
    expect(text).not.toContain("2026-06-20T14:31:09Z");

    output.length = 0;
    await expect(main(["proposals", "show", "latest", "--details", "--store", storePath])).resolves.toBe(0);
    text = output.join("");
    expect(text).toContain("Review details:");
    expect(text).toContain("principal: support_agent_17 (trusted_session)");
    expect(text).toContain("proposal hash: sha256:proposal");
    expect(text).toContain("proposal version: 1");
    expect(text).toContain("allowed columns: late_fee_cents, waiver_reason");
    expect(text).toContain("conflict guard: updated_at=2026-06-20T14:31:08Z");
    expect(text).toContain("evidence: ev_cli  query sha256:evidence");
    expect(text).toContain("Events:");
    expect(text).toContain("proposal_created");

    output.length = 0;
    await expect(main(["proposals", "show", "latest", "--json", "--store", storePath])).resolves.toBe(0);
    const proposalJson = JSON.parse(output.join(""));
    expect(proposalJson.proposal.proposal_hash).toBe("sha256:proposal");
    expect(proposalJson.proposal.change_set.guards.expected_version.column).toBe("updated_at");

    output.length = 0;
    await expect(main(["proposals", "approve", "latest", "--store", storePath, "--actor", "support_lead_1", "--yes"])).resolves.toBe(0);
    expect(output.join("")).toContain("target: external_postgres:src_pg_acme/public.invoices/INV-CLI");
    expect(output.join("")).toContain("conflict guard: updated_at=2026-06-20T14:31:08Z");
    expect(output.join("")).toContain("approved wrp_cli");

    output.length = 0;
    const jobPath = path.join(tempDir, "job.json");
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: storePath },
      sources: {
        src_pg_acme: {
          engine: "postgres",
          read_url_env: "SYNAPSOR_DATABASE_READ_URL",
          write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
        },
      },
      trusted_context: {
        provider: "static_dev",
        values: { tenant_id: "acme", principal: "support_agent_17" },
      },
      capabilities: [
        {
          name: "billing.waive_late_fee",
          kind: "proposal",
          source: "src_pg_acme",
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
          visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
          evidence: "required",
          max_rows: 1,
          patch: {
            late_fee_cents: { fixed: 0 },
            waiver_reason: { from_arg: "reason" },
          },
          allowed_columns: ["late_fee_cents", "waiver_reason"],
          conflict_guard: { column: "updated_at" },
          approval: { mode: "human", required_role: "support_lead" },
        },
      ],
    }), "utf8");
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
    await expect(main(["apply", "--job", jobPath, "--dry-run", "--store", storePath, "--config", configPath])).resolves.toBe(0);

    output.length = 0;
    await expect(main(["replay", "latest", "--store", storePath])).resolves.toBe(0);
    text = output.join("");
    expect(text).toContain("Replay replay_wrp_cli");
    expect(text).toContain("What happened:");
    expect(text).toContain("Source DB changed: no");
    expect(text).toContain("Proposed change:");
    expect(text).toContain("late_fee_cents: 5500 -> 0");
    expect(text).toContain("1 query audit record");
    expect(text).toContain("1 evidence item");
    expect(text).toContain("Next:");
    expect(text).not.toContain("proposal hash");
    expect(text).not.toContain("conflict guard");
    expect(text).not.toContain("sha256:evidence");
    output.length = 0;
    await expect(main(["replay", "show", "--replay", "replay_wrp_cli", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Replay replay_wrp_cli");
    output.length = 0;
    await expect(main(["replay", "show", "--evidence", "ev_cli", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Replay replay_wrp_cli");
    output.length = 0;
    await expect(main(["replay", "show", "latest", "--details", "--store", storePath])).resolves.toBe(0);
    text = output.join("");
    expect(text).toContain("Replay details replay_wrp_cli");
    expect(text).toContain("proposal hash: sha256:proposal");
    expect(text).toContain("conflict guard: updated_at=2026-06-20T14:31:08Z");
    expect(text).toContain("proposal_created");
    expect(text).toContain("writeback_applied");
    output.length = 0;
    await expect(main(["replay", "show", "latest", "--json", "--store", storePath])).resolves.toBe(0);
    const replayJson = JSON.parse(output.join(""));
    expect(replayJson.proposal.proposal_hash).toBe("sha256:proposal");
    expect(replayJson.query_audit[0].query_fingerprint).toBe("sha256:evidence");

    output.length = 0;
    const replayPath = path.join(tempDir, "replay.json");
    await expect(main(["replay", "export", "--proposal", "wrp_cli", "--format", "json", "--store", storePath, "--output", replayPath])).resolves.toBe(0);
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
    const replayMarkdownPath = path.join(tempDir, "replay.md");
    await expect(main(["replay", "export", "--replay", "replay_wrp_cli", "--format", "markdown", "--store", storePath, "--output", replayMarkdownPath])).resolves.toBe(0);
    const replayMarkdown = await fs.readFile(replayMarkdownPath, "utf8");
    expect(replayMarkdown).toContain("# Synapsor Replay");
    expect(replayMarkdown).toContain("## Trusted Context");
    expect(replayMarkdown).toContain("## Guarded Writeback");
    expect(replayMarkdown).toContain("This is local captured interaction replay, not external database time travel.");
    output.length = 0;
    await expect(main(["replay", "list", "--evidence", "ev_cli", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("replay_wrp_cli");
    output.length = 0;
    await expect(main(["replay", "list", "--receipt", "1", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("replay_wrp_cli");

    output.length = 0;
    await expect(main(["evidence", "show", "ev_cli", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Evidence ev_cli");
    expect(output.join("")).toContain("Captured:");
    expect(output.join("")).toContain("1 evidence item");
    expect(output.join("")).toContain("1 query audit record");
    expect(output.join("")).toContain("Next:");
    output.length = 0;
    await expect(main(["evidence", "show", "ev_cli", "--details", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Evidence bundle: ev_cli");
    expect(output.join("")).toContain("Rows captured: 1");
    expect(output.join("")).toContain("Query fingerprint: sha256:evidence");
    output.length = 0;
    await expect(main(["evidence", "list", "--tenant", "acme", "--capability", "billing.waive_late_fee", "--object", "invoice:INV-CLI", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("ev_cli");
    const evidenceJsonPath = path.join(tempDir, "evidence.json");
    await expect(main(["evidence", "export", "ev_cli", "--format", "json", "--output", evidenceJsonPath, "--store", storePath])).resolves.toBe(0);
    expect(JSON.parse(await fs.readFile(evidenceJsonPath, "utf8")).evidence_bundle_id).toBe("ev_cli");
    const evidenceMarkdownPath = path.join(tempDir, "evidence.md");
    await expect(main(["evidence", "export", "ev_cli", "--format", "markdown", "--output", evidenceMarkdownPath, "--store", storePath])).resolves.toBe(0);
    expect(await fs.readFile(evidenceMarkdownPath, "utf8")).toContain("# Evidence ev_cli");

    output.length = 0;
    await expect(main(["query-audit", "list", "--evidence", "ev_cli", "--source", "src_pg_acme", "--table", "invoices", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("audit 1");
    output.length = 0;
    await expect(main(["query-audit", "show", "1", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Query audit 1");
    expect(output.join("")).toContain("Rows returned:");
    expect(output.join("")).toContain("More detail:");
    output.length = 0;
    await expect(main(["query-audit", "show", "1", "--details", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Parameters redacted: yes");

    output.length = 0;
    await expect(main(["receipts", "list", "--proposal", "wrp_cli", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("receipt 1");
    output.length = 0;
    await expect(main(["receipts", "show", "1", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Receipt rct_000001");
    expect(output.join("")).toContain("Status: applied");
    expect(output.join("")).toContain("More detail:");
    output.length = 0;
    await expect(main(["receipts", "show", "1", "--details", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Receipt: 1");
    expect(output.join("")).toContain("Idempotency key:");

    output.length = 0;
    await expect(main(["activity", "search", "--tenant", "acme", "--object", "invoice:INV-CLI", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Found 1 local interaction");
    expect(output.join("")).toContain("proposal: wrp_cli");
    expect(output.join("")).toContain("Next:");
    output.length = 0;
    await expect(main(["activity", "search", "--evidence", "ev_cli", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("proposal: wrp_cli");
    output.length = 0;
    await expect(main(["activity", "search", "--replay", "replay_wrp_cli", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("proposal: wrp_cli");
    output.length = 0;
    await expect(main(["activity", "search", "--receipt", "1", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("proposal: wrp_cli");
  }, 15_000);

  it("inspects read-only evidence and query audit without a proposal", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-read-evidence-"));
    const storePath = path.join(tempDir, "local.db");
    const store = new ProposalStore(storePath);
    store.recordEvidenceBundle({
      evidence_bundle_id: "ev_read_only",
      tenant_id: "acme",
      payload: {
        capability: "billing.inspect_invoice",
        source_id: "src_pg_acme",
        target: "public.invoices",
        principal: { id: "support_agent_17" },
        query_fingerprint: "sha256:read-only",
      },
      items: [{
        kind: "external_row",
        source_id: "src_pg_acme",
        table: "public.invoices",
        primary_key: { column: "id", value: "INV-READ" },
        visible_row: { id: "INV-READ", tenant_id: "acme", balance_cents: 25500 },
      }],
    });
    store.recordQueryAudit({
      evidence_bundle_id: "ev_read_only",
      source_id: "src_pg_acme",
      query_fingerprint: "sha256:read-only",
      table_name: "public.invoices",
      row_count: 1,
      payload: {
        capability: "billing.inspect_invoice",
        statement_template: "SELECT id, tenant_id, balance_cents FROM public.invoices WHERE id = ? AND tenant_id = ? LIMIT 1",
        parameters_redacted: true,
      },
    });
    store.recordQueryAudit({
      source_id: "src_pg_acme",
      query_fingerprint: "sha256:audit-only",
      table_name: "public.invoices",
      row_count: 2,
      payload: {
        tenant_id: "acme",
        principal: "support_agent_17",
        capability: "billing.inspect_invoice",
        business_object: "invoice",
        object_id: "INV-AUDIT",
        primary_key_value: "INV-AUDIT",
        statement_template: "SELECT id, tenant_id FROM public.invoices WHERE tenant_id = ? LIMIT 2",
        parameters_redacted: true,
      },
    });
    store.close();

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["evidence", "show", "ev_read_only", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Evidence ev_read_only");
    expect(output.join("")).toContain("billing.inspect_invoice");
    expect(output.join("")).toContain("1 evidence item");
    expect(output.join("")).toContain("1 query audit record");

    output.length = 0;
    await expect(main(["evidence", "list", "--tenant", "acme", "--capability", "billing.inspect_invoice", "--source", "src_pg_acme", "--table", "invoices", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("ev_read_only");

    output.length = 0;
    await expect(main(["query-audit", "list", "--evidence", "ev_read_only", "--source", "src_pg_acme", "--table", "invoices", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("audit 1");

    output.length = 0;
    await expect(main(["activity", "search", "--tenant", "acme", "--capability", "billing.inspect_invoice", "--source", "src_pg_acme", "--table", "invoices", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Found 2 local interactions");
    expect(output.join("")).toContain("kind: evidence");
    expect(output.join("")).toContain("evidence: ev_read_only");
    expect(output.join("")).toContain("kind: query-audit");
    expect(output.join("")).toContain("query audit: 2");
    output.length = 0;
    await expect(main(["activity", "search", "--evidence", "ev_read_only", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Found 1 local interaction");
    expect(output.join("")).toContain("kind: evidence");
    expect(output.join("")).toContain("evidence: ev_read_only");
    output.length = 0;
    await expect(main(["activity", "search", "--query-fingerprint", "sha256:audit-only", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Found 1 local interaction");
    expect(output.join("")).toContain("kind: query-audit");
    expect(output.join("")).toContain("query audit: 2");
  });

  it("prints a reviewer-friendly apply summary for proposal apply", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-apply-summary-"));
    const storePath = path.join(tempDir, "local.db");
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.approveProposal("wrp_cli", { approver: "support_lead_1", proposal_hash: "sha256:proposal", proposal_version: 1 });
    store.close();
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: storePath },
      sources: {
        src_pg_acme: {
          engine: "postgres",
          read_url_env: "SYNAPSOR_DATABASE_READ_URL",
          write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
        },
      },
      trusted_context: {
        provider: "static_dev",
        values: { tenant_id: "acme", principal: "support_agent_17" },
      },
      capabilities: [
        {
          name: "billing.waive_late_fee",
          kind: "proposal",
          source: "src_pg_acme",
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
          visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
          evidence: "required",
          max_rows: 1,
          patch: {
            late_fee_cents: { fixed: 0 },
            waiver_reason: { from_arg: "reason" },
          },
          allowed_columns: ["late_fee_cents", "waiver_reason"],
          conflict_guard: { column: "updated_at" },
          approval: { mode: "human", required_role: "support_lead" },
        },
      ],
    }), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["apply", "latest", "--dry-run", "--store", storePath, "--config", configPath])).resolves.toBe(0);
    const text = output.join("");
    expect(text).toContain("Guarded writeback dry run passed.");
    expect(text).toContain("* proposal approved: yes");
    expect(text).toContain("* primary key matched: yes");
    expect(text).toContain("* tenant guard matched: yes");
    expect(text).toContain("* allowed columns only: yes");
    expect(text).toContain("* conflict guard passed: yes");
    expect(text).toContain("* affected rows: 0");
    expect(text).toContain("* idempotency key: wrp_cli:INV-CLI");
    expect(text).toContain("Receipt:");
    expect(text).toContain("Replay:");
    expect(text).toContain("synapsor-runner replay wrp_cli");
  });

  it("enforces a signed approver role and binds the verified identity into approval and apply history", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-signed-identity-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    const publicPath = path.join(tempDir, "alice.pub.pem");
    const privatePath = path.join(tempDir, "alice.pem");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
    await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    const config = httpHandlerConfig() as any;
    config.capabilities.find((capability: any) => capability.kind === "proposal").approval.required_approvals = 2;
    config.operator_identity = {
      provider: "signed_key",
      apply_roles: ["writeback_operator"],
      operators: {
        alice: { public_key_path: "./alice.pub.pem", roles: ["support_lead", "writeback_operator"] },
        bob: { public_key_path: "./alice.pub.pem", roles: ["observer"] },
        carol: { public_key_path: "./alice.pub.pem", roles: ["support_lead"] },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    const store = new ProposalStore(storePath);
    const quorumChangeSet = structuredClone(changeSet) as typeof changeSet & { approval: typeof changeSet.approval & { required_approvals: number } };
    quorumChangeSet.approval.required_approvals = 2;
    store.createProposal(quorumChangeSet);
    store.close();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const logs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    });

    await expect(main([
      "proposals", "approve", "wrp_cli", "--yes",
      "--config", configPath,
      "--store", storePath,
      "--identity", "bob",
      "--identity-key", privatePath,
    ])).rejects.toThrow(/lacks required role support_lead/);
    const deniedStore = new ProposalStore(storePath);
    expect(deniedStore.getProposal("wrp_cli")?.state).toBe("pending_review");
    expect(deniedStore.approvals("wrp_cli")).toEqual([]);
    deniedStore.close();

    await expect(main([
      "proposals", "approve", "wrp_cli", "--yes",
      "--config", configPath,
      "--store", storePath,
      "--identity", "alice",
      "--identity-key", privatePath,
      "--reason", "reviewed evidence",
    ])).resolves.toBe(0);

    const awaitingQuorum = new ProposalStore(storePath);
    expect(awaitingQuorum.getProposal("wrp_cli")?.state).toBe("pending_review");
    expect(awaitingQuorum.approvalProgress("wrp_cli")).toMatchObject({ approved: 1, required: 2, complete: false });
    awaitingQuorum.close();
    expect(output.join("")).toContain("(1/2)");
    await expect(main([
      "apply", "wrp_cli", "--dry-run",
      "--config", configPath,
      "--store", storePath,
      "--identity", "alice",
      "--identity-key", privatePath,
    ])).rejects.toThrow(/not approved|pending_review/i);
    await expect(main([
      "proposals", "approve", "wrp_cli", "--yes",
      "--config", configPath,
      "--store", storePath,
      "--identity", "carol",
      "--identity-key", privatePath,
      "--reason", "second reviewer confirmed evidence",
    ])).resolves.toBe(0);

    vi.stubEnv("SYNAPSOR_TEST_HANDLER_URL", "https://handler.internal/writeback");
    vi.stubEnv("SYNAPSOR_TEST_HANDLER_TOKEN", "handler-secret-token");
    vi.stubEnv("SYNAPSOR_TEST_HANDLER_SIGNING_SECRET", "handler-signing-secret");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      status: "applied",
      rows_affected: 1,
      source_database_mutated: true,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(main([
      "apply", "wrp_cli",
      "--config", configPath,
      "--store", storePath,
      "--identity", "alice",
      "--identity-key", privatePath,
      "--json",
    ])).resolves.toBe(0);

    const verified = new ProposalStore(storePath);
    const approval = verified.approvals("wrp_cli")[0];
    expect(approval).toMatchObject({
      approver: "alice",
      status: "approved",
      identity: {
        provider: "signed_key",
        verified: true,
        subject: "alice",
        roles: ["support_lead", "writeback_operator"],
        decision: { action: "approve", proposal_id: "wrp_cli", reason: "reviewed evidence" },
      },
    });
    expect(approval?.signature).toMatch(/\S+/);
    expect(approval?.decision_hash).toMatch(/^sha256:/);
    expect(verified.approvals("wrp_cli").map((decision) => decision.approver)).toEqual(["alice", "carol"]);
    expect(verified.approvalProgress("wrp_cli")).toMatchObject({ approved: 2, required: 2, complete: true });
    expect(verified.events("wrp_cli")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "writeback_authorized", actor: "alice" }),
    ]));
    verified.close();
    const structured = logs.map((line) => JSON.parse(line));
    expect(structured).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "operator_decision", action: "approve", subject: "alice", identity_verified: true }),
      expect.objectContaining({ event: "operator_decision", action: "apply", subject: "alice", identity_verified: true }),
      expect.objectContaining({ event: "writeback_outcome", status: "applied", capability: "billing.waive_late_fee", tenant: "acme" }),
    ]));
    expect(logs.join("")).not.toMatch(/handler-secret-token|handler-signing-secret|BEGIN PRIVATE KEY|https:\/\/handler\.internal/i);
  });

  it("enforces signed apply roles through batch and supervised worker paths", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-apply-role-paths-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    const publicPath = path.join(tempDir, "reviewer.pub.pem");
    const privatePath = path.join(tempDir, "reviewer.pem");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
    await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    const config = httpHandlerConfig() as any;
    config.operator_identity = {
      provider: "signed_key",
      apply_roles: ["writeback_operator"],
      operators: {
        reviewer: { public_key_path: "./reviewer.pub.pem", roles: ["support_lead"] },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    const store = new ProposalStore(storePath);
    for (const [proposalId, objectId] of [["wrp_batch_role", "INV-BATCH-ROLE"], ["wrp_worker_role", "INV-WORKER-ROLE"]]) {
      const proposal = structuredClone(changeSet) as any;
      proposal.proposal_id = proposalId;
      proposal.scope.object_id = objectId;
      proposal.source.primary_key.value = objectId;
      proposal.integrity.proposal_hash = `sha256:${proposalId}`;
      store.createProposal(proposal);
    }
    store.close();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const proposalId of ["wrp_batch_role", "wrp_worker_role"]) {
      await expect(main([
        "proposals", "approve", proposalId, "--yes", "--config", configPath, "--store", storePath,
        "--identity", "reviewer", "--identity-key", privatePath,
      ])).resolves.toBe(0);
    }

    await expect(main([
      "apply", "--all-approved", "--yes", "--max", "1", "--config", configPath, "--store", storePath,
      "--identity", "reviewer", "--identity-key", privatePath, "--json",
    ])).resolves.toBe(1);
    const afterBatch = new ProposalStore(storePath);
    expect(afterBatch.getProposal("wrp_batch_role")?.state).toBe("approved");
    expect(afterBatch.receipts("wrp_batch_role")).toEqual([]);
    afterBatch.close();

    await expect(main([
      "worker", "run", "--once", "--yes", "--max-attempts", "1", "--config", configPath, "--store", storePath,
      "--worker-id", "role_worker", "--identity", "reviewer", "--identity-key", privatePath,
    ])).resolves.toBe(0);
    const afterWorker = new ProposalStore(storePath);
    const deadLetters = afterWorker.listWorkerQueue("dead_letter");
    expect(deadLetters).toEqual(expect.arrayContaining([
      expect.objectContaining({ proposal_id: expect.any(String), status: "dead_letter" }),
    ]));
    expect(afterWorker.receipts("wrp_batch_role")).toEqual([]);
    expect(afterWorker.receipts("wrp_worker_role")).toEqual([]);
    afterWorker.close();
  });

  it("refuses writeback when a stored signed approval record was tampered", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-tampered-approval-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    const publicPath = path.join(tempDir, "alice.pub.pem");
    const privatePath = path.join(tempDir, "alice.pem");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
    await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    const config = httpHandlerConfig() as any;
    config.operator_identity = {
      provider: "signed_key",
      apply_roles: ["writeback_operator"],
      operators: {
        alice: { public_key_path: "./alice.pub.pem", roles: ["support_lead", "writeback_operator"] },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.close();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(main([
      "proposals", "approve", "wrp_cli", "--yes", "--config", configPath, "--store", storePath,
      "--identity", "alice", "--identity-key", privatePath,
    ])).resolves.toBe(0);
    const tamper = new ProposalStore(storePath);
    tamper.db.prepare("UPDATE approvals SET signature = 'tampered' WHERE proposal_id = ?").run("wrp_cli");
    tamper.close();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(main([
      "apply", "wrp_cli", "--config", configPath, "--store", storePath,
      "--identity", "alice", "--identity-key", privatePath,
    ])).rejects.toThrow(/failed integrity checks/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires verified operator identity for dead-letter requeue and discard", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-dead-letter-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    const publicPath = path.join(tempDir, "operator.pub.pem");
    const privatePath = path.join(tempDir, "operator.pem");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
    await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    const config = httpHandlerConfig() as any;
    config.operator_identity = {
      provider: "signed_key",
      apply_roles: ["writeback_operator"],
      operators: { alice: { public_key_path: "./operator.pub.pem", roles: ["writeback_operator"] } },
    };
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.approveProposal("wrp_cli", { approver: "support_lead", proposal_hash: "sha256:proposal", proposal_version: 1 });
    store.enqueueApprovedForWorker({ maxAttempts: 1 });
    store.claimWorkerItem({ workerId: "worker_a" });
    store.deadLetterWorkerItem({ proposalId: "wrp_cli", workerId: "worker_a", errorCode: "HANDLER_TIMEOUT" });
    store.close();

    await expect(main([
      "worker", "dead-letter", "requeue", "wrp_cli", "--retry-budget", "2", "--yes",
      "--config", configPath, "--store", storePath,
    ])).rejects.toThrow(/signed operator identity|verified signed_key or jwt_oidc/);
    await expect(main([
      "worker", "dead-letter", "requeue", "wrp_cli", "--retry-budget", "2", "--yes",
      "--config", configPath, "--store", storePath, "--identity", "alice", "--identity-key", privatePath,
    ])).resolves.toBe(0);

    const requeued = new ProposalStore(storePath);
    expect(requeued.getWorkerQueueItem("wrp_cli")).toMatchObject({ status: "queued", max_attempts: 2 });
    requeued.claimWorkerItem({ workerId: "worker_b" });
    requeued.deadLetterWorkerItem({ proposalId: "wrp_cli", workerId: "worker_b", errorCode: "POLICY_REJECTED" });
    requeued.close();
    await expect(main([
      "worker", "dead-letter", "discard", "wrp_cli", "--reason", "operator closed terminal item", "--yes",
      "--config", configPath, "--store", storePath, "--identity", "alice", "--identity-key", privatePath,
    ])).resolves.toBe(0);
    const discarded = new ProposalStore(storePath);
    expect(discarded.getWorkerQueueItem("wrp_cli")?.status).toBe("discarded");
    expect(discarded.events("wrp_cli").map((event) => event.kind)).toEqual(expect.arrayContaining([
      "writeback_dead_letter_requeued",
      "writeback_dead_letter_discarded",
    ]));
    discarded.close();
  });

  it("exports durable operational counters by trusted tenant and capability", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-metrics-"));
    const storePath = path.join(tempDir, "local.db");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.approveProposal("wrp_cli", {
      approver: "support_lead",
      proposal_hash: "sha256:proposal",
      proposal_version: 1,
    });
    const job = store.createWritebackJobFromProposal("wrp_cli");
    store.recordExecutionReceipt({
      schema_version: "synapsor.execution-receipt.v1",
      writeback_job_id: job.writeback_job_id,
      proposal_id: "wrp_cli",
      runner_id: "runner_metrics",
      status: "applied",
      rows_affected: 1,
      idempotency_key: job.idempotency_key,
      source_database_mutated: true,
      executed_at: "2026-07-12T04:00:00.000Z",
      receipt_hash: "sha256:metrics-receipt",
    });
    store.close();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["metrics", "show", "--store", storePath])).resolves.toBe(0);
    const prometheus = output.join("");
    expect(prometheus).toContain('synapsor_proposals_total{tenant="acme",capability="billing.waive_late_fee"} 1');
    expect(prometheus).toContain('synapsor_approvals_total{tenant="acme",capability="billing.waive_late_fee"} 1');
    expect(prometheus).toContain('synapsor_applies_total{tenant="acme",capability="billing.waive_late_fee"} 1');
    expect(prometheus).toContain("# EOF");

    output.length = 0;
    await expect(main([
      "metrics", "show", "--store", storePath, "--tenant", "acme", "--capability", "billing.waive_late_fee", "--json",
    ])).resolves.toBe(0);
    expect(JSON.parse(output.join(""))).toEqual({
      metrics: [{
        tenant_id: "acme",
        capability: "billing.waive_late_fee",
        proposals: 1,
        approvals: 1,
        rejections: 0,
        applies: 1,
        conflicts: 0,
        failures: 0,
      }],
    });
  });

  it("keeps object-filtered activity receipts scoped to the requested business object", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-activity-object-"));
    const storePath = path.join(tempDir, "local.db");
    const store = new ProposalStore(storePath);
    const seedApplied = (proposalId: string, objectType: string, objectId: string, tenant: string, action: string) => {
      const proposal = structuredClone(changeSet) as any;
      proposal.proposal_id = proposalId;
      proposal.action = action;
      proposal.scope = { tenant_id: tenant, business_object: objectType, object_id: objectId };
      proposal.source.table = objectType;
      proposal.source.primary_key.value = objectId;
      proposal.guards.tenant.value = tenant;
      proposal.integrity.proposal_hash = `sha256:${proposalId}`;
      proposal.evidence.bundle_id = `ev_${proposalId}`;
      store.createProposal(proposal);
      store.approveProposal(proposalId, { approver: "reviewer", proposal_hash: proposal.integrity.proposal_hash, proposal_version: 1 });
      const job = store.createWritebackJobFromProposal(proposalId);
      store.recordExecutionReceipt({
        schema_version: "synapsor.execution-receipt.v1",
        writeback_job_id: job.writeback_job_id,
        proposal_id: proposalId,
        runner_id: "runner_activity",
        status: "applied",
        rows_affected: 1,
        idempotency_key: job.idempotency_key,
        source_database_mutated: true,
        executed_at: "2026-07-12T04:00:00.000Z",
        receipt_hash: `sha256:receipt-${proposalId}`,
      });
    };
    seedApplied("wrp_wo_1001", "work_orders", "wo_1001", "acme", "fleet.propose_repair");
    seedApplied("wrp_wo_1002", "work_orders", "wo_1002", "acme", "fleet.propose_repair");
    seedApplied("wrp_part_101", "parts", "part_101", "acme", "inventory.propose_restock");
    seedApplied("wrp_part_103", "parts", "part_103", "globex", "inventory.propose_restock");
    store.close();

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    await expect(main(["activity", "search", "--object", "work_orders:wo_1002", "--store", storePath, "--json"])).resolves.toBe(0);
    const interactions = JSON.parse(output.join("")).interactions as Array<Record<string, unknown>>;
    expect(interactions.length).toBeGreaterThan(0);
    expect(interactions.every((item) => item.object === "work_orders:wo_1002")).toBe(true);
    expect(interactions.every((item) => item.proposal === "wrp_wo_1002")).toBe(true);

    output.length = 0;
    await expect(main(["activity", "search", "--object", "work_orders:wo_1002", "--store", storePath])).resolves.toBe(0);
    const text = output.join("");
    expect(text).toContain("wrp_wo_1002");
    expect(text).not.toMatch(/wrp_wo_1001|wrp_part_101|wrp_part_103/);

    output.length = 0;
    await expect(main([
      "activity", "search", "--tenant", "globex", "--capability", "inventory.propose_restock",
      "--object", "parts:part_103", "--store", storePath, "--json",
    ])).resolves.toBe(0);
    const combined = JSON.parse(output.join("")).interactions as Array<Record<string, unknown>>;
    expect(combined.length).toBeGreaterThan(0);
    expect(combined.every((item) => item.object === "parts:part_103" && item.tenant === "globex" && item.capability === "inventory.propose_restock")).toBe(true);
  });

  it("explains how to create or pass a local store when latest cannot resolve", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-missing-store-"));
    const missingStorePath = path.join(tempDir, ".synapsor", "local.db");

    await expect(main(["proposals", "show", "latest", "--store", missingStorePath]))
      .rejects.toThrow(/No local Synapsor proposal store was found[\s\S]*synapsor-runner demo[\s\S]*--store \/path\/to\/local\.db/);
  });

  it("applies approved proposals through an HTTP handler executor and handles safe duplicate retries", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-http-handler-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.approveProposal("wrp_cli", { approver: "support_lead", proposal_hash: "sha256:proposal", proposal_version: 1 });
    store.close();
    const oldUrl = process.env.SYNAPSOR_TEST_HANDLER_URL;
    const oldToken = process.env.SYNAPSOR_TEST_HANDLER_TOKEN;
    const oldSigningSecret = process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET;
    process.env.SYNAPSOR_TEST_HANDLER_URL = "https://handler.internal/writeback";
    process.env.SYNAPSOR_TEST_HANDLER_TOKEN = "handler-secret-token";
    process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET = "handler-signing-secret";
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      status: "applied",
      rows_affected: 1,
      previous_version: "2026-06-20T14:31:08Z",
      new_version: "2026-06-20T14:45:00Z",
      source_database_mutated: true,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    try {
      await expect(main(["apply", "--proposal", "wrp_cli", "--config", configPath, "--store", storePath, "--runner", "runner_http", "--json"])).resolves.toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://handler.internal/writeback");
      expect((init as RequestInit).method).toBe("POST");
      expect((init as RequestInit).headers).toMatchObject({
        authorization: "Bearer handler-secret-token",
        "idempotency-key": "wrp_cli:INV-CLI",
        "x-synapsor-proposal-id": "wrp_cli",
      });
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["x-synapsor-issued-at"]).toEqual(expect.any(String));
      const request = JSON.parse(String((init as RequestInit).body));
      expect(request).toMatchObject({
        protocol_version: "1.0",
        schema_version: "synapsor.handler-writeback.v1",
        proposal_id: "wrp_cli",
        idempotency_key: "wrp_cli:INV-CLI",
        issued_at: headers["x-synapsor-issued-at"],
        patch: { late_fee_cents: 0, waiver_reason: "customer requested review" },
      });
      expect(headers["x-synapsor-signature"]).toBe(`sha256=${crypto.createHmac("sha256", "handler-signing-secret").update(String((init as RequestInit).body)).digest("hex")}`);
      expect(request).not.toHaveProperty("sql");
      expect(output.join("")).not.toContain("handler-secret-token");
      expect(output.join("")).not.toContain("handler.internal");

      output.length = 0;
      await expect(main(["apply", "--proposal", "wrp_cli", "--config", configPath, "--store", storePath, "--runner", "runner_http", "--json"])).resolves.toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(output.join("")).status).toBe("already_applied");

      const replayStore = new ProposalStore(storePath);
      const replay = replayStore.replay("wrp_cli");
      replayStore.close();
      expect(replay.receipts[0]!.receipt).toMatchObject({
        schema_version: "synapsor.execution-receipt.v1",
        proposal_id: "wrp_cli",
        status: "applied",
        rows_affected: 1,
        source_database_mutated: true,
      });
    } finally {
      if (oldUrl === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_URL; else process.env.SYNAPSOR_TEST_HANDLER_URL = oldUrl;
      if (oldToken === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_TOKEN; else process.env.SYNAPSOR_TEST_HANDLER_TOKEN = oldToken;
      if (oldSigningSecret === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET; else process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET = oldSigningSecret;
    }
  });

  it("batch-applies approved proposals independently with filters and a final summary", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-batch-apply-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");
    const store = new ProposalStore(storePath);
    const createApproved = (id: string, objectId: string, tenantId: string, createdAt: string) => {
      const proposal = structuredClone(changeSet) as any;
      proposal.proposal_id = id;
      proposal.scope.object_id = objectId;
      proposal.scope.tenant_id = tenantId;
      proposal.source.primary_key.value = objectId;
      proposal.guards.tenant.value = tenantId;
      proposal.integrity.proposal_hash = `sha256:${id}`;
      proposal.created_at = createdAt;
      store.createProposal(proposal);
      store.approveProposal(id, { approver: "support_lead", proposal_hash: proposal.integrity.proposal_hash, proposal_version: 1 });
    };
    createApproved("wrp_batch_1", "INV-BATCH-1", "acme", "2026-07-12T01:00:00.000Z");
    createApproved("wrp_batch_2", "INV-BATCH-2", "acme", "2026-07-12T02:00:00.000Z");
    createApproved("wrp_batch_3", "INV-BATCH-3", "globex", "2026-07-12T03:00:00.000Z");
    store.close();
    vi.stubEnv("SYNAPSOR_TEST_HANDLER_URL", "https://handler.internal/writeback");
    vi.stubEnv("SYNAPSOR_TEST_HANDLER_TOKEN", "handler-secret-token");
    vi.stubEnv("SYNAPSOR_TEST_HANDLER_SIGNING_SECRET", "handler-signing-secret");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const request = JSON.parse(String((init as RequestInit).body));
      const conflict = request.target.primary_key.value === "INV-BATCH-2";
      return new Response(JSON.stringify({
        status: conflict ? "conflict" : "applied",
        rows_affected: conflict ? 0 : 1,
        source_database_mutated: !conflict,
        safe_error_code: conflict ? "VERSION_CONFLICT" : undefined,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await expect(main([
      "apply", "--all-approved", "--yes",
      "--config", configPath,
      "--store", storePath,
      "--tenant", "acme",
      "--capability", "billing.waive_late_fee",
      "--max", "2",
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(output.join("")).toContain("APPLIED wrp_batch_1");
    expect(output.join("")).toContain("CONFLICT wrp_batch_2");
    expect(output.join("")).toContain("Summary: 1 applied / 1 conflict / 0 skipped (2 selected)");
    const after = new ProposalStore(storePath);
    expect(after.getProposal("wrp_batch_1")?.state).toBe("applied");
    expect(after.getProposal("wrp_batch_2")?.state).toBe("conflict");
    expect(after.getProposal("wrp_batch_3")?.state).toBe("approved");
    after.close();

    output.length = 0;
    await expect(main(["apply", "--all-approved", "--yes", "--config", configPath, "--store", storePath, "--tenant", "acme"])).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(output.join("")).toContain("No approved or pending-worker proposals matched.");
  });

  it("batch-applies policy-approved proposals through an existing runtime-store bridge", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-runtime-store-batch-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "bridge.db");
    const config = httpHandlerConfig() as any;
    config.storage = {
      sqlite_path: storePath,
      shared_postgres: {
        mode: "runtime_store",
        url_env: "SYNAPSOR_TEST_LEDGER_URL",
        schema: "synapsor_runner",
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");

    const store = new ProposalStore(storePath);
    const proposal = structuredClone(changeSet) as any;
    proposal.proposal_id = "wrp_runtime_batch_policy";
    proposal.integrity.proposal_hash = "sha256:runtime-batch-policy";
    store.createProposal(proposal);
    const decision = store.approveProposalByPolicy(proposal.proposal_id, {
      policy: "billing_auto_approval",
      proposal_hash: proposal.integrity.proposal_hash,
      proposal_version: 1,
      reason: "within reviewed aggregate limits",
    });
    expect(decision.approved).toBe(true);
    expect(store.getProposal(proposal.proposal_id)?.state).toBe("approved");
    store.close();

    vi.stubEnv("SYNAPSOR_TEST_HANDLER_URL", "https://handler.internal/writeback");
    vi.stubEnv("SYNAPSOR_TEST_HANDLER_TOKEN", "handler-secret-token");
    vi.stubEnv("SYNAPSOR_TEST_HANDLER_SIGNING_SECRET", "handler-signing-secret");
    vi.stubEnv("SYNAPSOR_TEST_LEDGER_URL", "");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      status: "applied",
      rows_affected: 1,
      source_database_mutated: true,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(main([
      "apply", "--all-approved", "--yes", "--json",
      "--config", configPath,
      "--store", storePath,
      "--runtime-store-bridge",
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output.join(""))).toMatchObject({
      selected: 1,
      applied: 1,
      conflict: 0,
      skipped: 0,
      results: [{
        proposal_id: proposal.proposal_id,
        status: "applied",
        detail: "proposal state: applied",
      }],
    });
    const after = new ProposalStore(storePath);
    expect(after.getProposal(proposal.proposal_id)?.state).toBe("applied");
    expect(after.receipts(proposal.proposal_id)).toHaveLength(1);
    after.close();
  });

  it("supervises transient handler failures with bounded retry and durable completion", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-worker-retry-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.approveProposal("wrp_cli", { approver: "support_lead", proposal_hash: "sha256:proposal", proposal_version: 1 });
    store.close();
    vi.stubEnv("SYNAPSOR_TEST_HANDLER_URL", "https://handler.internal/writeback");
    vi.stubEnv("SYNAPSOR_TEST_HANDLER_TOKEN", "handler-secret-token");
    vi.stubEnv("SYNAPSOR_TEST_HANDLER_SIGNING_SECRET", "handler-signing-secret");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "failed", safe_error_code: "HANDLER_HTTP_503" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "applied", rows_affected: 1, source_database_mutated: true }), { status: 200 }));

    const workerArgs = [
      "worker", "run", "--once", "--yes",
      "--config", configPath,
      "--store", storePath,
      "--worker-id", "worker_test",
      "--max-attempts", "2",
      "--retry-base-ms", "1",
      "--retry-max-ms", "1",
    ];
    await expect(main(workerArgs)).resolves.toBe(0);
    const failed = new ProposalStore(storePath);
    expect(failed.getProposal("wrp_cli")?.state).toBe("failed");
    expect(failed.listWorkerQueue()).toEqual([expect.objectContaining({ status: "retry_wait", attempts: 1, last_error_code: "HANDLER_HTTP_503" })]);
    failed.close();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(main(workerArgs)).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(requests.map((request) => request.writeback_job_id)).toEqual(["hwb_wrp_cli", "hwb_wrp_cli_a2"]);
    expect(requests.map((request) => request.idempotency_key)).toEqual(["wrp_cli:INV-CLI", "wrp_cli:INV-CLI"]);
    const completed = new ProposalStore(storePath);
    expect(completed.getProposal("wrp_cli")?.state).toBe("applied");
    expect(completed.listWorkerQueue()).toEqual([expect.objectContaining({ status: "completed", attempts: 2 })]);
    expect(completed.receipts("wrp_cli").map((receipt) => receipt.status)).toEqual(["failed", "applied"]);
    completed.close();
  });

  it("refuses to call HTTP handlers for unapproved proposals", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-http-handler-unapproved-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.close();
    const oldUrl = process.env.SYNAPSOR_TEST_HANDLER_URL;
    const oldToken = process.env.SYNAPSOR_TEST_HANDLER_TOKEN;
    const oldSigningSecret = process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET;
    process.env.SYNAPSOR_TEST_HANDLER_URL = "https://handler.internal/writeback";
    process.env.SYNAPSOR_TEST_HANDLER_TOKEN = "handler-secret-token";
    process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET = "handler-signing-secret";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "applied" }), { status: 200 }));
    try {
      await expect(main(["apply", "--proposal", "wrp_cli", "--config", configPath, "--store", storePath]))
        .rejects.toThrow(/not approved for handler writeback/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (oldUrl === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_URL; else process.env.SYNAPSOR_TEST_HANDLER_URL = oldUrl;
      if (oldToken === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_TOKEN; else process.env.SYNAPSOR_TEST_HANDLER_TOKEN = oldToken;
      if (oldSigningSecret === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET; else process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET = oldSigningSecret;
    }
  });

  it("records failed receipts for HTTP handler non-2xx and timeout outcomes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-http-handler-failures-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");
    const oldUrl = process.env.SYNAPSOR_TEST_HANDLER_URL;
    const oldToken = process.env.SYNAPSOR_TEST_HANDLER_TOKEN;
    const oldSigningSecret = process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET;
    process.env.SYNAPSOR_TEST_HANDLER_URL = "https://handler.internal/writeback";
    process.env.SYNAPSOR_TEST_HANDLER_TOKEN = "handler-secret-token";
    process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET = "handler-signing-secret";
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const httpStorePath = path.join(tempDir, "http-failed.db");
      const httpStore = new ProposalStore(httpStorePath);
      httpStore.createProposal(changeSet);
      httpStore.approveProposal("wrp_cli", { approver: "support_lead", proposal_hash: "sha256:proposal", proposal_version: 1 });
      httpStore.close();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "nope" }), { status: 503 }));
      await expect(main(["apply", "--proposal", "wrp_cli", "--config", configPath, "--store", httpStorePath, "--json"])).resolves.toBe(1);
      expect(JSON.parse(output.join(""))).toMatchObject({ status: "failed", safe_error_code: "HANDLER_HTTP_503" });
      const failedStore = new ProposalStore(httpStorePath);
      expect(failedStore.replay("wrp_cli").receipts[0]!.receipt.safe_error_code).toBe("HANDLER_HTTP_503");
      failedStore.close();

      output.length = 0;
      const timeoutStorePath = path.join(tempDir, "timeout-failed.db");
      const timeoutStore = new ProposalStore(timeoutStorePath);
      timeoutStore.createProposal({ ...structuredClone(changeSet), proposal_id: "wrp_cli_timeout", integrity: { proposal_hash: "sha256:proposal-timeout" } });
      timeoutStore.approveProposal("wrp_cli_timeout", { approver: "support_lead", proposal_hash: "sha256:proposal-timeout", proposal_version: 1 });
      timeoutStore.close();
      fetchMock.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
      await expect(main(["apply", "--proposal", "wrp_cli_timeout", "--config", configPath, "--store", timeoutStorePath, "--json"])).resolves.toBe(1);
      expect(JSON.parse(output.join(""))).toMatchObject({ status: "failed", safe_error_code: "HANDLER_TIMEOUT" });
    } finally {
      if (oldUrl === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_URL; else process.env.SYNAPSOR_TEST_HANDLER_URL = oldUrl;
      if (oldToken === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_TOKEN; else process.env.SYNAPSOR_TEST_HANDLER_TOKEN = oldToken;
      if (oldSigningSecret === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET; else process.env.SYNAPSOR_TEST_HANDLER_SIGNING_SECRET = oldSigningSecret;
    }
  }, 15_000);

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

  it("records and compares human actions for shadow proposals", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-shadow-report-"));
    const storePath = path.join(tempDir, "local.db");
    const patchPath = path.join(tempDir, "human-action.json");
    const store = new ProposalStore(storePath);
    store.createProposal(shadowChangeSet());
    store.close();
    await fs.writeFile(patchPath, JSON.stringify({
      late_fee_cents: 0,
      waiver_reason: "customer requested review",
    }), "utf8");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["shadow", "list", "--store", storePath, "--json"])).resolves.toBe(0);
    expect(JSON.parse(output.join("")).proposals[0].proposal_id).toBe("wrp_cli_shadow");

    output.length = 0;
    await expect(main([
      "shadow",
      "record-human-action",
      "wrp_cli_shadow",
      "--patch",
      patchPath,
      "--store",
      storePath,
      "--actor",
      "support_lead",
      "--notes",
      "matched human action",
      "--json",
    ])).resolves.toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      proposal_id: "wrp_cli_shadow",
      actor: "support_lead",
    });

    output.length = 0;
    await expect(main(["shadow", "compare", "wrp_cli_shadow", "--store", storePath, "--json"])).resolves.toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      proposal_id: "wrp_cli_shadow",
      status: "exact_match",
      matching_columns: ["late_fee_cents", "waiver_reason"],
    });

    output.length = 0;
    await expect(main(["shadow", "report", "--store", storePath, "--json"])).resolves.toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      total_shadow_proposals: 1,
      with_human_action: 1,
      exact_matches: 1,
      mismatches: 0,
    });
  });
});

function httpHandlerConfig(): Record<string, unknown> {
  return {
    version: 1,
    mode: "review",
    storage: { sqlite_path: "./.synapsor/local.db" },
    sources: {
      src_pg_acme: {
        engine: "postgres",
        read_url_env: "APP_POSTGRES_READ_URL",
        statement_timeout_ms: 3000,
      },
    },
    trusted_context: {
      provider: "environment",
      values: {
        tenant_id_env: "SYNAPSOR_TENANT_ID",
        principal_env: "SYNAPSOR_PRINCIPAL",
      },
    },
    executors: {
      billing_api: {
        type: "http_handler",
        url_env: "SYNAPSOR_TEST_HANDLER_URL",
        method: "POST",
        auth: {
          type: "bearer_env",
          token_env: "SYNAPSOR_TEST_HANDLER_TOKEN",
        },
        signing_secret_env: "SYNAPSOR_TEST_HANDLER_SIGNING_SECRET",
        timeout_ms: 100,
      },
    },
    capabilities: [
      {
        name: "billing.waive_late_fee",
        kind: "proposal",
        source: "src_pg_acme",
        executor: "billing_api",
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
        approval: { mode: "human", required_role: "support_lead" },
      },
    ],
  };
}

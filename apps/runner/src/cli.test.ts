import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { main, runInitWizard } from "./cli.js";

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

  it("prints product help for the public synapsor command surface", async () => {
    const commands = [
      ["--help"],
      ["inspect", "--help"],
      ["init", "--help"],
      ["init", "--wizard", "--help"],
      ["mcp", "--help"],
      ["mcp", "serve", "--help"],
      ["mcp", "config", "--help"],
      ["propose", "--help"],
      ["audit", "--help"],
      ["proposals", "--help"],
      ["apply", "--help"],
      ["replay", "--help"],
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
    expect(output.join("")).toContain("propose");
    expect(output.join("")).toContain("audit");
  });

  it("prints the 15-second quick demo without requiring Docker", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["demo", "--quick"])).resolves.toBe(0);
    const text = output.join("");
    expect(text).toContain("Raw MCP shape");
    expect(text).toContain("execute_sql(sql: string)");
    expect(text).toContain("Synapsor shape");
    expect(text).toContain("billing.propose_late_fee_waiver");
    expect(text).toContain("Source DB changed:");
    expect(text).toContain("no");
    expect(text).toContain("synapsor audit examples/dangerous-mcp-tools.json");
  });

  it("audits the bundled dangerous MCP database tool manifest", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["audit", "examples/dangerous-mcp-tools.json"])).resolves.toBe(0);
    const text = output.join("");
    expect(text).toContain("Synapsor MCP database risk review");
    expect(text).toContain("GENERIC_SQL_TOOL");
    expect(text).toContain("MODEL_CALLABLE_COMMIT_OR_APPROVAL");
    expect(text).toContain("WRITE_WITHOUT_PROPOSAL_BOUNDARY");
    expect(text).toContain("MODEL_CONTROLLED_TRUST_SCOPE");
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
        "--namespace",
        "billing",
        "--object-name",
        "invoice",
        "--mode",
        "review",
        "--patch-fixed",
        "late_fee_cents=0",
        "--patch-from-arg",
        "waiver_reason=reason",
        "--numeric-bound",
        "late_fee_cents=0:5500",
      ])).resolves.toBe(0);
      const config = JSON.parse(await fs.readFile(path.join(tempDir, "synapsor.runner.json"), "utf8"));
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
      "", // tenant env default
      "", // principal env default
      "", // write URL env default
      "billing_lead",
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
      expect(config.mode).toBe("review");
      expect(config.sources.local_postgres.read_url_env).toBe("SYNAPSOR_DATABASE_READ_URL");
      expect(config.sources.local_postgres.write_url_env).toBe("SYNAPSOR_DATABASE_WRITE_URL");
      expect(config.capabilities.map((capability: { name: string }) => capability.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_invoice_update",
      ]);
      expect(config.capabilities[1].approval.required_role).toBe("billing_lead");
      expect(config.capabilities[1].patch).toEqual({
        late_fee_cents: { fixed: 0 },
        waiver_reason: { from_arg: "reason" },
      });
      expect(config.capabilities[1].numeric_bounds).toEqual({
        late_fee_cents: { minimum: 0, maximum: 5500 },
      });
      expect(output.join("")).toContain("not exposed: execute_sql");
      expect(JSON.stringify(config)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret/i);
      expect(ask).toHaveBeenCalled();
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
      "", // tenant env default
      "", // principal env default
      "", // write URL env default
      "", // approval role from recipe
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
      expect(output.join("")).toContain("Available recipes");
      expect(output.join("")).toContain("Mapping recipe billing.late_fee_waiver");
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
    } finally {
      if (oldRead === undefined) delete process.env.APP_POSTGRES_READ_URL; else process.env.APP_POSTGRES_READ_URL = oldRead;
      if (oldTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID; else process.env.SYNAPSOR_TENANT_ID = oldTenant;
      if (oldPrincipal === undefined) delete process.env.SYNAPSOR_PRINCIPAL; else process.env.SYNAPSOR_PRINCIPAL = oldPrincipal;
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
        command: "synapsor",
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

  it("runs top-level synapsor audit through the MCP database risk review", async () => {
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
      "claude-desktop",
      "--config",
      "./synapsor.runner.json",
      "--store",
      "./.synapsor/local.db",
    ])).resolves.toBe(0);

    const snippet = JSON.parse(output.join(""));
    expect(snippet.mcpServers.synapsor).toEqual({
      command: "synapsor",
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
      command: "synapsor",
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
      command: "synapsor",
      args: ["mcp", "serve", "--config", "./synapsor.runner.json", "--store", "./.synapsor/local.db"],
    });
    expect(output.join("")).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret/i);
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
    await expect(main(["tools", "preview", "--config", configPath, "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("Exposed to MCP:");
    expect(output.join("")).toContain("clinic.inspect_appointment");
    expect(output.join("")).toContain("Not exposed to MCP:");
    expect(output.join("")).toContain("execute_sql / raw query tools");
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
      command: "synapsor",
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
    store.close();

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["proposals", "list", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("wrp_cli");

    output.length = 0;
    await expect(main(["proposals", "show", "latest", "--store", storePath])).resolves.toBe(0);
    expect(output.join("")).toContain("source database changed: no");
    expect(output.join("")).toContain("late_fee_cents");
    expect(output.join("")).toContain("principal: support_agent_17 (trusted_session)");
    expect(output.join("")).toContain("approval: pending required role support_lead");
    expect(output.join("")).toContain("allowed columns: late_fee_cents, waiver_reason");
    expect(output.join("")).toContain("conflict guard: updated_at=2026-06-20T14:31:08Z");
    expect(output.join("")).toContain("evidence: ev_cli  query sha256:evidence");
    expect(output.join("")).toContain("writeback: not_applied via trusted_worker_required");

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
          name: "billing.propose_late_fee_waiver",
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
    expect(output.join("")).toContain("replay_wrp_cli");

    output.length = 0;
    const replayPath = path.join(tempDir, "replay.json");
    await expect(main(["replay", "export", "latest", "--store", storePath, "--output", replayPath])).resolves.toBe(0);
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
    process.env.SYNAPSOR_TEST_HANDLER_URL = "https://handler.internal/writeback";
    process.env.SYNAPSOR_TEST_HANDLER_TOKEN = "handler-secret-token";
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
      await expect(main(["apply", "--proposal", "wrp_cli", "--config", configPath, "--store", storePath, "--runner", "runner_http"])).resolves.toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://handler.internal/writeback");
      expect((init as RequestInit).method).toBe("POST");
      expect((init as RequestInit).headers).toMatchObject({
        authorization: "Bearer handler-secret-token",
        "idempotency-key": "wrp_cli:INV-CLI",
      });
      const request = JSON.parse(String((init as RequestInit).body));
      expect(request).toMatchObject({
        schema_version: "synapsor.handler-writeback.v1",
        proposal_id: "wrp_cli",
        idempotency_key: "wrp_cli:INV-CLI",
        patch: { late_fee_cents: 0, waiver_reason: "customer requested review" },
      });
      expect(request).not.toHaveProperty("sql");
      expect(output.join("")).not.toContain("handler-secret-token");
      expect(output.join("")).not.toContain("handler.internal");

      output.length = 0;
      await expect(main(["apply", "--proposal", "wrp_cli", "--config", configPath, "--store", storePath, "--runner", "runner_http"])).resolves.toBe(0);
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
    }
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
    process.env.SYNAPSOR_TEST_HANDLER_URL = "https://handler.internal/writeback";
    process.env.SYNAPSOR_TEST_HANDLER_TOKEN = "handler-secret-token";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "applied" }), { status: 200 }));
    try {
      await expect(main(["apply", "--proposal", "wrp_cli", "--config", configPath, "--store", storePath]))
        .rejects.toThrow(/not approved for handler writeback/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (oldUrl === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_URL; else process.env.SYNAPSOR_TEST_HANDLER_URL = oldUrl;
      if (oldToken === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_TOKEN; else process.env.SYNAPSOR_TEST_HANDLER_TOKEN = oldToken;
    }
  });

  it("records failed receipts for HTTP handler non-2xx and timeout outcomes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-http-handler-failures-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify(httpHandlerConfig()), "utf8");
    const oldUrl = process.env.SYNAPSOR_TEST_HANDLER_URL;
    const oldToken = process.env.SYNAPSOR_TEST_HANDLER_TOKEN;
    process.env.SYNAPSOR_TEST_HANDLER_URL = "https://handler.internal/writeback";
    process.env.SYNAPSOR_TEST_HANDLER_TOKEN = "handler-secret-token";
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
      await expect(main(["apply", "--proposal", "wrp_cli", "--config", configPath, "--store", httpStorePath])).resolves.toBe(1);
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
      await expect(main(["apply", "--proposal", "wrp_cli_timeout", "--config", configPath, "--store", timeoutStorePath])).resolves.toBe(1);
      expect(JSON.parse(output.join(""))).toMatchObject({ status: "failed", safe_error_code: "HANDLER_TIMEOUT" });
    } finally {
      if (oldUrl === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_URL; else process.env.SYNAPSOR_TEST_HANDLER_URL = oldUrl;
      if (oldToken === undefined) delete process.env.SYNAPSOR_TEST_HANDLER_TOKEN; else process.env.SYNAPSOR_TEST_HANDLER_TOKEN = oldToken;
    }
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

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { configCommand } from "./config-inspect.js";


afterEach(() => {
  vi.restoreAllMocks();
});


describe("production config initialization", () => {
  it("shows and atomically updates model-facing authority metadata without changing authority", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-model-output-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    captureStdout();
    await configCommand([
      "init", "--output", configPath, "--engine", "postgres", "--json",
    ]);
    vi.restoreAllMocks();

    const initial = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(initial.model_output).toEqual({ authority_metadata: "semantic" });
    await fs.chmod(configPath, 0o640);

    const stdout = captureStdout();
    await expect(configCommand([
      "model-output", "--authority-metadata", "exact", "--config", configPath, "--json",
    ])).resolves.toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      authority_metadata: "exact",
      changed: true,
      model_receives_exact_authority_metadata: true,
      operator_evidence_changed: false,
      restart_required: true,
    });
    const exact = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o640);
    expect(exact.model_output).toEqual({ authority_metadata: "exact" });
    expect(exact.sources).toEqual(initial.sources);
    expect(exact.trusted_context).toEqual(initial.trusted_context);

    stdout.length = 0;
    await expect(configCommand([
      "model-output", "--config", configPath, "--json",
    ])).resolves.toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      authority_metadata: "exact",
      changed: false,
      restart_required: false,
    });

    await expect(configCommand([
      "model-output", "--authority-metadata", "verbose", "--config", configPath,
    ])).rejects.toThrow(/must be semantic or exact/i);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(exact);
  });

  it("backs up and replaces an existing config only when --force is explicit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-force-"));
    const output = path.join(tempDir, "synapsor.runner.json");
    const original = "{\n  \"operator_note\": \"preserve this exact file\"\n}\n";
    await fs.writeFile(output, original);

    await expect(configCommand([
      "init", "--output", output, "--engine", "mysql", "--json",
    ])).rejects.toThrow(/already exists.*--force/i);
    expect(await fs.readFile(output, "utf8")).toBe(original);

    const stdout = captureStdout();
    await expect(configCommand([
      "init", "--output", output, "--engine", "mysql", "--read-url-env", "APP_DATABASE_URL",
      "--force", "--json",
    ])).resolves.toBe(0);

    const result = JSON.parse(stdout.join(""));
    expect(result.backup_path).toMatch(/synapsor\.runner\.json\.bak\./u);
    expect(await fs.readFile(result.backup_path, "utf8")).toBe(original);
    expect(JSON.parse(await fs.readFile(output, "utf8"))).toMatchObject({
      sources: {
        local_mysql: {
          engine: "mysql",
          read_url_env: "APP_DATABASE_URL",
        },
      },
      capabilities: [],
    });

    stdout.length = 0;
    await expect(configCommand([
      "init", "--output", output, "--engine", "mysql", "--force",
    ])).resolves.toBe(0);
    expect(stdout.join("")).toContain("Backup of replaced config:");
  });

  it("requires an explicit engine when no reviewed production draft exists", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-engine-"));
    const output = path.join(tempDir, "synapsor.runner.json");

    await expect(configCommand(productionArgs({ tempDir, output })))
      .rejects.toThrow(/requires --engine postgres\|mysql.*does not infer.*credential value/i);
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps offline config generation silent when the source environment variable is unset", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-offline-"));
    const output = path.join(tempDir, "synapsor.runner.json");
    const inspectDatabaseFn = vi.fn();
    const stdout = captureStdout();

    await expect(configCommand(
      productionArgs({ tempDir, output, engine: "postgres" }),
      { env: {}, inspectDatabaseFn },
    )).resolves.toBe(0);

    expect(inspectDatabaseFn).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join(""))).not.toHaveProperty("binding_verification");
  });

  it.each(["postgres", "mysql"] as const)(
    "verifies eligible bindings without persisting the %s credential",
    async (engine) => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `synapsor-config-${engine}-`));
      const output = path.join(tempDir, "synapsor.runner.json");
      const secretUrl = engine === "postgres"
        ? "postgresql://reader:do-not-write@db.example.test/app"
        : "mysql://reader:do-not-write@db.example.test/app";
      const env = { TEST_SOURCE_DATABASE_URL: secretUrl };
      const inspectDatabaseFn = vi.fn(async () => schemaInspection(engine, [
        inspectedColumn("id", false, "bigint"),
        inspectedColumn("tenant_id", false, "text"),
        inspectedColumn("rep", false, "text"),
      ]));
      const stdout = captureStdout();

      await expect(configCommand(
        productionArgs({ tempDir, output, engine, principalBinding: "rep" }),
        { env, inspectDatabaseFn },
      )).resolves.toBe(0);

      expect(inspectDatabaseFn).toHaveBeenCalledWith(expect.objectContaining({
        engine,
        databaseUrlEnv: "TEST_SOURCE_DATABASE_URL",
        env,
      }));
      const result = JSON.parse(stdout.join(""));
      expect(result.binding_verification).toMatchObject({
        status: "verified",
        engine,
        read_url_env: "TEST_SOURCE_DATABASE_URL",
        credential_value_read: true,
        source_rows_read: false,
        checks: [
          expect.objectContaining({ option: "--tenant-binding", column: "tenant_id", status: "verified" }),
          expect.objectContaining({ option: "--principal-binding", column: "rep", status: "verified" }),
        ],
      });
      expect(stdout.join("")).not.toContain(secretUrl);
      expect(await fs.readFile(output, "utf8")).not.toContain(secretUrl);
    },
  );

  it("warns and still writes zero-authority config when a binding is missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-binding-warning-"));
    const output = path.join(tempDir, "synapsor.runner.json");
    const stdout = captureStdout();

    await expect(configCommand(
      productionArgs({
        tempDir,
        output,
        engine: "postgres",
        tenantBinding: "not_a_real_column",
        principalBinding: undefined,
      }),
      {
        env: { TEST_SOURCE_DATABASE_URL: "postgresql://reader:secret@db.example.test/app" },
        inspectDatabaseFn: async () => schemaInspection("postgres", [inspectedColumn("id", false, "bigint")]),
      },
    )).resolves.toBe(0);

    const result = JSON.parse(stdout.join(""));
    expect(result.binding_verification).toMatchObject({
      status: "warning",
      checks: [expect.objectContaining({
        option: "--tenant-binding",
        column: "not_a_real_column",
        status: "missing",
        message: expect.stringMatching(/does not match any column/i),
      })],
    });
    await expect(fs.stat(output)).resolves.toBeDefined();
  });

  it("renders one actionable warning in the human config-init output", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-binding-human-warning-"));
    const output = path.join(tempDir, "synapsor.runner.json");
    const stdout = captureStdout();
    const args = productionArgs({
      tempDir,
      output,
      engine: "mysql",
      tenantBinding: "missing_tenant",
      principalBinding: null,
    }).filter((arg) => arg !== "--json");

    await expect(configCommand(args, {
      env: { TEST_SOURCE_DATABASE_URL: "mysql://reader:secret@db.example.test/app" },
      inspectDatabaseFn: async () => schemaInspection("mysql", [inspectedColumn("id", false, "bigint")]),
    })).resolves.toBe(0);

    const rendered = stdout.join("");
    expect(rendered).toContain("value was read only for schema binding verification and was not written");
    expect(rendered).toContain("WARNING  --tenant-binding missing_tenant does not match any column");
    expect(rendered.match(/--tenant-binding missing_tenant does not match any column/g)).toHaveLength(1);
    expect(rendered).not.toContain("mysql://reader:secret");
  });

  it("makes missing or ineligible bindings fatal with --verify-bindings", async () => {
    const missingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-binding-strict-missing-"));
    const missingOutput = path.join(missingRoot, "synapsor.runner.json");
    await expect(configCommand(
      [...productionArgs({
        tempDir: missingRoot,
        output: missingOutput,
        engine: "mysql",
        tenantBinding: "not_a_real_column",
        principalBinding: undefined,
      }), "--verify-bindings"],
      {
        env: { TEST_SOURCE_DATABASE_URL: "mysql://reader:secret@db.example.test/app" },
        inspectDatabaseFn: async () => schemaInspection("mysql", [inspectedColumn("id", false, "bigint")]),
      },
    )).rejects.toThrow(/--verify-bindings failed.*--tenant-binding not_a_real_column.*does not match/is);
    await expect(fs.stat(missingOutput)).rejects.toMatchObject({ code: "ENOENT" });

    const nullableRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-binding-strict-nullable-"));
    const nullableOutput = path.join(nullableRoot, "synapsor.runner.json");
    await expect(configCommand(
      [...productionArgs({
        tempDir: nullableRoot,
        output: nullableOutput,
        engine: "postgres",
        principalBinding: undefined,
      }), "--verify-bindings"],
      {
        env: { TEST_SOURCE_DATABASE_URL: "postgresql://reader:secret@db.example.test/app" },
        inspectDatabaseFn: async () => schemaInspection("postgres", [inspectedColumn("tenant_id", true, "text")]),
      },
    )).rejects.toThrow(/--tenant-binding tenant_id.*nullable.*non-null scalar/is);
    await expect(fs.stat(nullableOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("warns on an unreachable configured source unless verification is required", async () => {
    const warningRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-binding-unreachable-"));
    const warningOutput = path.join(warningRoot, "synapsor.runner.json");
    const stdout = captureStdout();
    const inspectDatabaseFn = vi.fn(async () => {
      throw new Error("driver detail must not be rendered");
    });

    await expect(configCommand(
      productionArgs({ tempDir: warningRoot, output: warningOutput, engine: "postgres" }),
      {
        env: { TEST_SOURCE_DATABASE_URL: "postgresql://reader:secret@db.example.test/app" },
        inspectDatabaseFn,
      },
    )).resolves.toBe(0);
    const warningResult = JSON.parse(stdout.join(""));
    expect(warningResult.binding_verification).toMatchObject({
      status: "warning",
      warnings: [expect.stringMatching(/schema inspection.*did not complete.*inspect --engine postgres/is)],
    });
    expect(stdout.join("")).not.toContain("driver detail must not be rendered");

    const strictRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-binding-unreachable-strict-"));
    const strictOutput = path.join(strictRoot, "synapsor.runner.json");
    await expect(configCommand(
      [...productionArgs({ tempDir: strictRoot, output: strictOutput, engine: "postgres" }), "--verify-bindings"],
      {
        env: { TEST_SOURCE_DATABASE_URL: "postgresql://reader:secret@db.example.test/app" },
        inspectDatabaseFn,
      },
    )).rejects.toThrow(/--verify-bindings failed.*schema inspection.*did not complete/is);
    await expect(fs.stat(strictOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a reachable source when --verify-bindings is explicit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-binding-no-env-"));
    const output = path.join(tempDir, "synapsor.runner.json");

    await expect(configCommand(
      [...productionArgs({ tempDir, output, engine: "postgres" }), "--verify-bindings"],
      { env: {}, inspectDatabaseFn: vi.fn() },
    )).rejects.toThrow(/cannot verify --tenant-binding tenant_id.*TEST_SOURCE_DATABASE_URL is not set/i);
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});


function productionArgs(input: {
  tempDir: string;
  output: string;
  engine?: "postgres" | "mysql";
  tenantBinding?: string | null;
  principalBinding?: string | null;
}): string[] {
  return [
    "init",
    "--production-explore",
    "--project-root", input.tempDir,
    "--output", input.output,
    ...(input.engine ? ["--engine", input.engine] : []),
    "--read-url-env", "TEST_SOURCE_DATABASE_URL",
    "--tenant-claim", "tenant_id",
    "--principal-claim", "sub",
    ...(input.tenantBinding === null
      ? []
      : ["--tenant-binding", input.tenantBinding ?? "tenant_id"]),
    ...(input.principalBinding ? ["--principal-binding", input.principalBinding] : []),
    "--issuer", "https://identity.example.test",
    "--audience", "https://runner.example.test/mcp",
    "--accounting-namespace", "clinic.production",
    "--json",
  ];
}

function captureStdout(): string[] {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return chunks;
}

function inspectedColumn(
  name: string,
  nullable: boolean,
  dataType: string,
): SchemaInspection["tables"][number]["columns"][number] {
  return {
    name,
    data_type: dataType,
    nullable,
    generated: false,
    identity: false,
    ordinal_position: 1,
    suggestions: {
      tenant: name === "tenant_id",
      conflict: false,
      sensitive: false,
      immutable: name === "id",
      large_or_binary: false,
    },
  };
}

function schemaInspection(
  engine: "postgres" | "mysql",
  columns: SchemaInspection["tables"][number]["columns"],
): SchemaInspection {
  return {
    engine,
    server_version: engine === "postgres" ? "PostgreSQL 16.14" : "8.4.9",
    current_user: "app_reader",
    inspected_at: "2026-08-14T00:00:00.000Z",
    schemas: [engine === "postgres" ? "public" : "clinicdb"],
    tables: [{
      schema: engine === "postgres" ? "public" : "clinicdb",
      name: "orders",
      type: "table",
      writable: false,
      columns,
      primary_key: ["id"],
      unique_constraints: [],
      foreign_keys: [],
      indexes: [],
      suggestions: {
        tenant_columns: columns.filter((column) => column.name === "tenant_id").map((column) => column.name),
        conflict_columns: [],
        sensitive_columns: [],
        default_visible_columns: columns.map((column) => column.name),
      },
    }],
    warnings: [],
  };
}

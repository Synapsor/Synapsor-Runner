import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  tools,
} from "./writeback-setup.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

describe("tools analytics catalog", () => {
  it("prints deterministic machine-readable metadata without physical scope or kept-out fields", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-tools-catalog-"));
    temporaryRoots.push(root);
    const configPath = path.join(root, "synapsor.runner.json");
    const digest = `sha256:${"a".repeat(64)}`;
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      sources: {
        app_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          read_only: true,
        },
      },
      trusted_context: {
        provider: "environment",
        values: {
          tenant_id_env: "SYNAPSOR_TENANT_ID",
          principal_env: "SYNAPSOR_PRINCIPAL",
        },
      },
      capabilities: [{
        name: "operations.open_incident_count",
        description: "Count reviewed open incidents.",
        kind: "aggregate_read",
        source: "app_postgres",
        target: {
          schema: "private_app",
          table: "incidents",
          primary_key: "id",
          tenant_key: "workspace_scope_id",
          principal_scope_key: "assigned_to",
        },
        args: {},
        lookup: { id_from_arg: "unused" },
        visible_columns: [],
        kept_out_fields: ["customer_email", "internal_notes"],
        aggregate: {
          function: "count",
          count_mode: "rows",
          selection: { all: [{ column: "status", operator: "eq", value: "open" }] },
          minimum_group_size: 5,
        },
        contract_provenance: { digest, version: "1.0.0" },
      }],
    }, null, 2));
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(tools([
      "catalog",
      "--config",
      configPath,
      "--result-format",
      "v2",
      "--json",
    ])).resolves.toBe(0);
    const catalog = JSON.parse(output.join(""));
    expect(catalog).toMatchObject({
      schema_version: "synapsor.analytics-catalog.v1",
      result_format: 2,
      capabilities: [{
        capability: "operations.open_incident_count",
        origin: "authored",
        contract: { digest },
        measures: [{ name: "value", function: "count", scalar_type: "integer" }],
        suppression: { minimum_cohort_size: 5 },
      }],
    });
    expect(JSON.stringify(catalog)).not.toMatch(
      /private_app|workspace_scope_id|assigned_to|customer_email|internal_notes|DATABASE_URL|SELECT\s/i,
    );
  });

  it("refuses an unknown result format", async () => {
    await expect(tools([
      "catalog",
      "--config",
      "/tmp/not-read-because-format-is-checked-first.json",
      "--result-format",
      "v3",
    ])).rejects.toThrow(/result-format must be v1 or v2/i);
  });
});

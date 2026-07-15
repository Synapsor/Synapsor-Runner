import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatContractTestReport, loadContractTestManifest, runContractTests } from "./contract-testing.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("adopter contract tests", () => {
  it("rejects unknown fields, assertion kinds, and duplicate ids", async () => {
    const directory = await temporaryDirectory();
    const manifest = path.join(directory, "tests.json");
    await fs.writeFile(manifest, JSON.stringify({ version: 1, surprise: true, tests: [{ id: "one", kind: "tool_allow", capability: "support.inspect" }] }));
    await expect(loadContractTestManifest(manifest)).rejects.toThrow("CONTRACT_TEST_UNKNOWN_FIELD");

    await fs.writeFile(manifest, JSON.stringify({ version: 1, tests: [{ id: "one", kind: "invented", capability: "support.inspect" }] }));
    await expect(loadContractTestManifest(manifest)).rejects.toThrow("CONTRACT_TEST_KIND_UNSUPPORTED");

    await fs.writeFile(manifest, JSON.stringify({ version: 1, tests: [
      { id: "one", kind: "hide_fields", capability: "support.inspect", fields: ["secret"] },
      { id: "one", kind: "hide_fields", capability: "support.inspect", fields: ["secret"] },
    ] }));
    await expect(loadContractTestManifest(manifest)).rejects.toThrow("CONTRACT_TEST_ID_DUPLICATE");
  });

  it("runs static visibility, argument, transition, and set-cap assertions against the exact contract", async () => {
    const fixture = await writeFixture();
    await fs.writeFile(fixture.manifestPath, JSON.stringify({ version: 1, tests: [
      { id: "hidden", kind: "hide_fields", capability: "support.propose", fields: ["private_notes"] },
      { id: "arg-bound", kind: "argument_constraint", capability: "support.propose", argument: "amount", expected: { minimum: 1, maximum: 25 } },
      { id: "transition", kind: "transition_guard", capability: "support.propose", expected: { status: { allowed: { open: ["closed"] } } } },
      { id: "set-cap", kind: "set_cap", capability: "support.propose", expected: { max_rows: 2, aggregate_bounds: [{ column: "amount", measure: "before", maximum: 50 }] } },
    ] }, null, 2));

    const report = await runContractTests({ ...fixture, live: false });
    expect(report.ok, JSON.stringify(report.tests, null, 2)).toBe(true);
    expect(report.summary).toEqual({ passed: 4, failed: 0, total: 4 });
    expect(JSON.parse(formatContractTestReport(report, "json"))).toEqual(report);
    expect(formatContractTestReport(report, "junit")).toContain('tests="4" failures="0"');
  });

  it("proves approval and writeback controls stay outside the model-facing tool surface", async () => {
    const fixture = await writeFixture();
    const manifest = path.join(path.dirname(fixture.contractPath), "operator-boundary.json");
    await fs.writeFile(manifest, JSON.stringify({ version: 1, tests: [{
      id: "operator-controls-outside-mcp",
      kind: "operator_boundary",
      capability: "support.propose",
    }] }));
    const report = await runContractTests({
      manifestPath: manifest,
      contractPath: fixture.contractPath,
      configPath: fixture.configPath,
      live: false,
    });
    expect(report).toMatchObject({ ok: true, summary: { passed: 1, failed: 0 } });
  });

  it("fails static mismatches with stable assertion codes", async () => {
    const fixture = await writeFixture();
    await fs.writeFile(fixture.manifestPath, JSON.stringify({ version: 1, tests: [
      { id: "leak", kind: "hide_fields", capability: "support.propose", fields: ["id"] },
      { id: "wrong-cap", kind: "set_cap", capability: "support.propose", expected: { max_rows: 9 } },
    ] }));
    const report = await runContractTests({ ...fixture, live: false });
    expect(report.ok).toBe(false);
    expect(report.tests.map((test) => test.code)).toEqual(["HIDDEN_FIELD_EXPOSED", "SET_CAP_MISMATCH"]);
  });

  it("refuses live tests against a remote or non-disposable database by default", async () => {
    const fixture = await writeFixture();
    await fs.writeFile(fixture.manifestPath, JSON.stringify({ version: 1, tests: [{
      id: "allow",
      kind: "tool_allow",
      capability: "support.propose",
      args: { id: "C-1", amount: 10 },
      trusted_context: { tenant_id: "tenant-a", principal: "reviewer" },
    }] }));
    await expect(runContractTests({
      ...fixture,
      live: true,
      env: { TEST_DATABASE_URL: "postgresql://user:pass@db.example.com:5432/production" },
    })).rejects.toThrow("CONTRACT_TEST_REMOTE_DATABASE_REFUSED");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-contract-testing-unit-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeFixture(): Promise<{ manifestPath: string; contractPath: string; configPath: string }> {
  const directory = await temporaryDirectory();
  const contractPath = path.join(directory, "contract.json");
  const configPath = path.join(directory, "runner.json");
  const manifestPath = path.join(directory, "tests.json");
  await fs.writeFile(contractPath, JSON.stringify({
    spec_version: "0.1",
    kind: "SynapsorContract",
    contexts: [{
      name: "trusted",
      tenant_binding: "tenant_id",
      principal_binding: "principal",
      bindings: [
        { name: "tenant_id", source: "environment", key: "TENANT", required: true },
        { name: "principal", source: "environment", key: "PRINCIPAL", required: true },
      ],
    }],
    resources: [],
    capabilities: [{
      name: "support.propose",
      kind: "proposal",
      context: "trusted",
      source: "source",
      subject: { schema: "public", table: "cases", primary_key: "id", tenant_key: "tenant_id", conflict_key: "updated_at" },
      args: {
        id: { type: "string", required: true, max_length: 64 },
        amount: { type: "number", required: true, minimum: 1, maximum: 25 },
      },
      lookup: { id_from_arg: "id" },
      visible_fields: ["id", "tenant_id", "status", "amount", "updated_at"],
      kept_out_fields: ["private_notes"],
      evidence: { required: true, query_audit: true },
      max_rows: 1,
      proposal: {
        action: "close_cases",
        allowed_fields: ["status", "amount"],
        patch: { status: { fixed: "closed" }, amount: { from_arg: "amount" } },
        transition_guards: { status: { allowed: { open: ["closed"] } } },
        operation: {
          kind: "update",
          cardinality: "set",
          max_rows: 2,
          selection: { all: [{ column: "status", operator: "eq", value: "open" }] },
          aggregate_bounds: [{ column: "amount", measure: "before", maximum: 50 }],
          version_advance: { column: "updated_at", strategy: "integer_increment" },
        },
        conflict_guard: { column: "updated_at" },
        approval: { mode: "human", required_role: "reviewer" },
        writeback: { mode: "direct_sql" },
      },
    }],
    workflows: [],
    policies: [],
  }, null, 2));
  await fs.writeFile(configPath, JSON.stringify({
    version: 1,
    mode: "review",
    storage: { sqlite_path: "./local.db" },
    contracts: ["./contract.json"],
    sources: { source: { engine: "postgres", read_url_env: "TEST_DATABASE_URL", write_url_env: "TEST_DATABASE_URL", statement_timeout_ms: 3000 } },
  }, null, 2));
  return { manifestPath, contractPath, configPath };
}

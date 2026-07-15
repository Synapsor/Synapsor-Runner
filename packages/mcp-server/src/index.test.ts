import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { get as httpsGet, type RequestOptions } from "node:https";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { ProposalStore, type ProposalRuntimeStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  createMcpRuntime,
  createSynapsorMcpServer,
  checkRunnerReadiness,
  loadRuntimeConfigFromFile,
  McpRuntimeError,
  openaiToolNameAlias,
  serveStdio,
  startHttpMcpServer,
  startStreamableHttpMcpServer,
  type RuntimeConfig,
} from "./index.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

const config: RuntimeConfig = {
  version: 1,
  mode: "review",
  storage: { sqlite_path: ":memory:" },
  sources: {
    app_postgres: {
      engine: "postgres",
      read_url_env: "APP_POSTGRES_READ_URL",
      write_url_env: "APP_POSTGRES_WRITE_URL",
      statement_timeout_ms: 3000,
    },
  },
  trusted_context: {
    provider: "static_dev",
    values: {
      tenant_id: "acme",
      principal: "support_agent_17",
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
      visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
      evidence: "required",
      max_rows: 1,
    },
    {
      name: "billing.propose_late_fee_waiver",
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
};

const fixtureRow = {
  id: "INV-3001",
  tenant_id: "acme",
  late_fee_cents: 5500,
  waiver_reason: null,
  updated_at: "2026-06-20T14:31:08Z",
};

function aggregateReadConfig(): RuntimeConfig {
  const cloned = structuredClone(config);
  cloned.capabilities = [{
    name: "billing.sum_overdue_balance",
    kind: "aggregate_read",
    source: "app_postgres",
    target: {
      schema: "public",
      table: "invoices",
      primary_key: "id",
      tenant_key: "tenant_id",
    },
    args: {},
    lookup: { id_from_arg: "id" },
    visible_columns: [],
    evidence: "required",
    aggregate: {
      function: "sum",
      column: "balance_cents",
      selection: { all: [{ column: "status", operator: "eq", value: "overdue" }] },
      minimum_group_size: 5,
    },
  }];
  return cloned;
}

function runtimeStoreAdapter(backing: ProposalStore): ProposalRuntimeStore {
  return {
    close: () => backing.close(),
    recordEvidenceBundle: (input) => backing.recordEvidenceBundle(input),
    recordQueryAudit: (input) => backing.recordQueryAudit(input),
    findActiveProposal: (input) => backing.findActiveProposal(input),
    createProposal: (input) => backing.createProposal(input),
    approveProposalByPolicy: (proposalId, options) => backing.approveProposalByPolicy(proposalId, options),
    getProposal: (proposalId) => backing.getProposal(proposalId),
    events: (proposalId) => backing.events(proposalId),
    receipts: (proposalId) => backing.receipts(proposalId),
    getEvidenceBundle: (evidenceBundleId) => backing.getEvidenceBundle(evidenceBundleId),
    replay: (proposalId) => backing.replay(proposalId),
  };
}

function autoApprovalConfig(): RuntimeConfig {
  const cloned = structuredClone(config);
  const proposal = cloned.capabilities?.[1];
  if (!proposal) throw new Error("proposal fixture missing");
  proposal.args = {
    invoice_id: { type: "string", required: true, max_length: 128 },
    credit_cents: { type: "number", required: true, minimum: 1, maximum: 50000 },
    reason: { type: "string", required: true, max_length: 500 },
  };
  proposal.patch = {
    late_fee_cents: { from_arg: "credit_cents" },
    waiver_reason: { from_arg: "reason" },
  };
  proposal.allowed_columns = ["late_fee_cents", "waiver_reason"];
  proposal.numeric_bounds = {
    late_fee_cents: { minimum: 0, maximum: 50000 },
  };
  proposal.approval = {
    mode: "policy",
    required_role: "support_lead",
    policy: "billing_propose_late_fee_waiver_auto_approval",
  };
  cloned.policies = [
    {
      name: "billing_propose_late_fee_waiver_auto_approval",
      kind: "approval",
      mode: "green",
      rules: [{ field: "late_fee_cents", max: 2500 }],
    },
  ];
  return cloned;
}

function boundedSetUpdateConfig(maxRows = 2, aggregateMaximum = 10_000): RuntimeConfig {
  const cloned = structuredClone(config);
  cloned.capabilities = [{
    name: "billing.close_overdue_invoices",
    kind: "proposal",
    source: "app_postgres",
    target: { schema: "public", table: "invoices", primary_key: "id", tenant_key: "tenant_id" },
    args: { reason: { type: "string", required: true, max_length: 500 } },
    lookup: { id_from_arg: "reason" },
    visible_columns: ["id", "tenant_id", "status", "balance_cents", "close_reason", "version"],
    evidence: "required",
    patch: { status: { fixed: "closed" }, close_reason: { from_arg: "reason" } },
    allowed_columns: ["status", "close_reason"],
    operation: {
      kind: "update",
      cardinality: "set",
      selection: { all: [{ column: "status", operator: "eq", value: "overdue" }] },
      max_rows: maxRows,
      aggregate_bounds: [{ column: "balance_cents", measure: "before", maximum: aggregateMaximum }],
      version_advance: { column: "version", strategy: "integer_increment" },
    },
    conflict_guard: { column: "version" },
    approval: { mode: "human", required_role: "billing_reviewer" },
    writeback: { mode: "direct_sql" },
  }];
  return cloned;
}

function boundedBatchInsertConfig(maxRows = 2, aggregateMaximum = 5_000): RuntimeConfig {
  const cloned = structuredClone(config);
  cloned.capabilities = [{
    name: "billing.create_credits",
    kind: "proposal",
    source: "app_postgres",
    target: { schema: "public", table: "account_credits", primary_key: "id", tenant_key: "tenant_id" },
    args: {
      items: {
        type: "object_array",
        required: true,
        max_items: maxRows,
        fields: {
          id: { type: "string", required: true, max_length: 128 },
          external_id: { type: "string", required: true, max_length: 128 },
          amount_cents: { type: "number", required: true, minimum: 1, maximum: 2_500 },
          reason: { type: "string", required: true, max_length: 500 },
        },
      },
    },
    lookup: { id_from_arg: "items" },
    visible_columns: ["id", "tenant_id", "external_id", "amount_cents", "reason"],
    evidence: "required",
    patch: { amount_cents: { from_item: "amount_cents" }, reason: { from_item: "reason" } },
    allowed_columns: ["amount_cents", "reason"],
    numeric_bounds: { amount_cents: { minimum: 1, maximum: 2_500 } },
    operation: {
      kind: "insert",
      cardinality: "set",
      batch: { items_from_arg: "items" },
      max_rows: maxRows,
      aggregate_bounds: [{ column: "amount_cents", measure: "after", maximum: aggregateMaximum }],
      deduplication: { components: [
        { column: "tenant_id", source: "trusted_tenant" },
        { column: "id", source: "item_field", item_field: "id" },
        { column: "external_id", source: "item_field", item_field: "external_id" },
      ] },
    },
    approval: { mode: "human", required_role: "billing_reviewer" },
    writeback: { mode: "direct_sql" },
  }];
  return cloned;
}

describe("local Synapsor MCP runtime", () => {
  it("closes the stdio runtime when client input ends", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const serving = serveStdio({ config, storePath: ":memory:", stdin: input, stdout: output });
    await new Promise((resolve) => setImmediate(resolve));
    input.end();
    await expect(Promise.race([
      serving,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("stdio shutdown timed out")), 1000)),
    ])).resolves.toBeUndefined();
  });

  it("checks default direct-SQL writeback only when review mode can commit", async () => {
    const unavailable = "postgresql://runner:redacted@127.0.0.1:1/unavailable";
    const report = await checkRunnerReadiness(config, {
      APP_POSTGRES_READ_URL: unavailable,
      APP_POSTGRES_WRITE_URL: unavailable,
    }, 50);
    expect(report.components.map((component) => component.name)).toEqual([
      "config",
      "source:app_postgres",
      "writeback:app_postgres",
    ]);
    expect(report.components.find((component) => component.name === "writeback:app_postgres"))
      .toMatchObject({ ok: false, code: "WRITEBACK_UNAVAILABLE" });

    const readOnly = await checkRunnerReadiness({ ...config, mode: "read_only" }, {
      APP_POSTGRES_READ_URL: unavailable,
      APP_POSTGRES_WRITE_URL: unavailable,
    }, 50);
    expect(readOnly.components.map((component) => component.name)).toEqual([
      "config",
      "source:app_postgres",
    ]);
  });

  it("rejects a claims-mode runner that references an environment-bound contract", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-context-provider-conflict-"));
    const contractPath = path.join(tempDir, "synapsor.contract.json");
    const configPath = path.join(tempDir, "synapsor.runner.json");
    fs.copyFileSync(path.resolve(testDir, "../../spec/examples/guarded-writeback.contract.json"), contractPath);
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "APP_POSTGRES_READ_URL",
          write_url_env: "APP_POSTGRES_WRITE_URL",
        },
      },
      trusted_context: {
        provider: "http_claims",
        values: { tenant_id_key: "tenant_id", principal_key: "sub" },
      },
      session_auth: {
        provider: "jwt_hs256",
        secret_env: "SYNAPSOR_SESSION_JWT_SECRET",
        issuer: "https://identity.example",
        audience: "synapsor-runner",
      },
      contracts: ["./synapsor.contract.json"],
      capabilities: [],
    }));

    expect(() => loadRuntimeConfigFromFile(configPath)).toThrow(/TRUSTED_CONTEXT_PROVIDER_CONFLICT[\s\S]*billing\.inspect_invoice[\s\S]*HTTP_CLAIM tenant_id/);
  });

  it("loads semantic tools from canonical contract references", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-contract-runtime-"));
    const sourceContract = path.resolve(testDir, "../../spec/examples/guarded-writeback.contract.json");
    const contractPath = path.join(tempDir, "synapsor.contract.json");
    const configPath = path.join(tempDir, "synapsor.runner.json");
    fs.copyFileSync(sourceContract, contractPath);
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      result_format: 2,
      storage: { sqlite_path: ":memory:" },
      contracts: ["./synapsor.contract.json"],
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "APP_POSTGRES_READ_URL",
          write_url_env: "APP_POSTGRES_WRITE_URL",
          statement_timeout_ms: 3000,
        },
      },
    }, null, 2));
    const loaded = loadRuntimeConfigFromFile(configPath);
    const runtime = createMcpRuntime(loaded, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      expect(loaded.capabilities?.map((capability) => capability.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_late_fee_waiver",
      ]);
      expect(runtime.listTools().map((tool) => tool.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_late_fee_waiver",
      ]);
    } finally {
      runtime.close();
    }
  });

  it("loads conformance contract fixtures into runner tools", () => {
    const conformanceRoot = path.resolve(testDir, "../../spec/fixtures/conformance");
    for (const fixtureName of fs.readdirSync(conformanceRoot)) {
      const sourceContract = path.join(conformanceRoot, fixtureName, "contract.json");
      if (!fs.existsSync(sourceContract)) continue;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `synapsor-conformance-${fixtureName}-`));
      fs.copyFileSync(sourceContract, path.join(tempDir, "synapsor.contract.json"));
      const configPath = path.join(tempDir, "synapsor.runner.json");
      fs.writeFileSync(configPath, JSON.stringify({
        version: 1,
        mode: "review",
        storage: { sqlite_path: ":memory:" },
        contracts: ["./synapsor.contract.json"],
        sources: {
          local_postgres: {
            engine: "postgres",
            read_url_env: "APP_POSTGRES_READ_URL",
            write_url_env: "APP_POSTGRES_WRITE_URL",
            statement_timeout_ms: 3000,
          },
        },
      }, null, 2));
      const loaded = loadRuntimeConfigFromFile(configPath);
      const runtime = createMcpRuntime(loaded, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
      try {
        expect(runtime.listTools().length, fixtureName).toBeGreaterThan(0);
        expect(runtime.listTools().some((tool) => /execute_sql|run_query|approve|commit/i.test(tool.name)), fixtureName).toBe(false);
      } finally {
        runtime.close();
      }
    }
  });

  it("executes the bounded-set R1 predicate-abuse fixture and keeps R7 human approval fixed", async () => {
    const fixtureRoot = path.resolve(testDir, "../../spec/fixtures/conformance/bounded-set-threats");
    const scenario = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "scenarios.json"), "utf8"));
    const expected = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "expected.outcomes.json"), "utf8"));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-bounded-set-threats-"));
    fs.copyFileSync(path.join(fixtureRoot, "contract.json"), path.join(tempDir, "synapsor.contract.json"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: ":memory:" },
      contracts: ["./synapsor.contract.json"],
      sources: { local_postgres: { engine: "postgres", read_url_env: "APP_POSTGRES_READ_URL", write_url_env: "APP_POSTGRES_WRITE_URL" } },
    }));
    const loaded = loadRuntimeConfigFromFile(configPath);
    const capability = loaded.capabilities?.find((item) => item.name === "billing.close_overdue_invoices");
    expect(expected.selection_is_contract_fixed).toBe(true);
    expect(expected.human_approval_required).toBe(true);
    expect(capability?.operation?.selection).toEqual({ all: [{ column: "status", operator: "eq", value: "overdue" }] });
    expect(capability?.approval?.mode).toBe("human");

    const runtime = createMcpRuntime(loaded, {
      env: { SYNAPSOR_TENANT_ID: "acme", SYNAPSOR_PRINCIPAL: "support_agent" },
      readRow: async () => ({ row: {}, rows: [], rowCount: 0 }),
    });
    try {
      await expect(runtime.callTool("billing.close_overdue_invoices", scenario.r1_fixed_selection.model_args))
        .rejects.toMatchObject({ code: scenario.r1_fixed_selection.expected });
    } finally {
      await runtime.close();
    }
  });

  it("enforces numeric bounds from contract-referenced proposal capabilities", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-numeric-bounds-"));
    const sourceContract = path.resolve(testDir, "../../spec/fixtures/conformance/numeric-bounds/contract.json");
    const scenario = JSON.parse(fs.readFileSync(path.resolve(testDir, "../../spec/fixtures/conformance/numeric-bounds/scenario.json"), "utf8"));
    const expected = JSON.parse(fs.readFileSync(path.resolve(testDir, "../../spec/fixtures/conformance/numeric-bounds/expected.rejection.json"), "utf8"));
    fs.copyFileSync(sourceContract, path.join(tempDir, "synapsor.contract.json"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    fs.writeFileSync(configPath, JSON.stringify({
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
          write_url_env: "APP_POSTGRES_WRITE_URL",
          statement_timeout_ms: 3000,
        },
      },
    }, null, 2));
    const loaded = loadRuntimeConfigFromFile(configPath);
    const runtime = createMcpRuntime(loaded, {
      env: {
        SYNAPSOR_TENANT_ID: scenario.trusted_context.tenant_id,
        SYNAPSOR_PRINCIPAL: scenario.trusted_context.principal,
      },
      readRow: async () => ({ row: scenario.source_row, rowCount: 1 }),
      resultFormat: 2,
    });
    try {
      const result = await runtime.callTool(scenario.invoke.capability, scenario.invoke.args);
      expect(result).toMatchObject(expected);
    } finally {
      runtime.close();
    }
  });

  it("exercises the auto-approval conformance fixture scenarios", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-auto-approval-"));
    const fixtureRoot = path.resolve(testDir, "../../spec/fixtures/conformance/auto-approval");
    const scenario = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "scenario.json"), "utf8"));
    const expected = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "expected.outcome.json"), "utf8"));
    fs.copyFileSync(path.join(fixtureRoot, "contract.json"), path.join(tempDir, "synapsor.contract.json"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: ":memory:" },
      contracts: ["./synapsor.contract.json"],
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "APP_POSTGRES_READ_URL",
          write_url_env: "APP_POSTGRES_WRITE_URL",
          statement_timeout_ms: 3000,
        },
      },
    }, null, 2));

    for (const item of scenario.cases) {
      const loaded = loadRuntimeConfigFromFile(configPath);
      const runtime = createMcpRuntime(loaded, {
        env: {
          SYNAPSOR_TENANT_ID: scenario.trusted_context.tenant_id,
          SYNAPSOR_PRINCIPAL: scenario.trusted_context.principal,
        },
        readRow: async () => ({ row: item.source_row, rowCount: 1 }),
      });
      try {
        const result = await runtime.callTool(item.invoke.capability, item.invoke.args);
        const proposal = await runtime.store.getProposal(String(result.proposal_id));
        const expectedCase = expected[item.name];
        expect({
          ok: true,
          proposal_status: proposal?.state,
          approval: result.approval,
          source_database_changed: result.source_database_changed,
        }).toMatchObject({
          ok: expectedCase.ok,
          proposal_status: expectedCase.proposal_status,
          approval: Object.fromEntries(Object.entries(expectedCase.approval).filter(([key]) => key !== "actor")),
          source_database_changed: expectedCase.source_database_changed,
        });
        if (expectedCase.approval.actor) {
          expect(await runtime.store.events(String(result.proposal_id))).toEqual(expect.arrayContaining([
            expect.objectContaining({
              kind: "proposal_approved",
              actor: expectedCase.approval.actor,
            }),
          ]));
        }
      } finally {
        runtime.close();
      }
    }
  });

  it("enforces aggregate policy-limit conformance atomically", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-aggregate-policy-"));
    const fixtureRoot = path.resolve(testDir, "../../spec/fixtures/conformance/aggregate-policy-limits");
    const scenario = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "scenario.json"), "utf8"));
    const expected = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "expected.outcome.json"), "utf8"));
    fs.copyFileSync(path.join(fixtureRoot, "contract.json"), path.join(tempDir, "synapsor.contract.json"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: ":memory:" },
      contracts: ["./synapsor.contract.json"],
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "APP_POSTGRES_READ_URL",
          write_url_env: "APP_POSTGRES_WRITE_URL",
          statement_timeout_ms: 3000,
        },
      },
    }));
    const runtime = createMcpRuntime(loadRuntimeConfigFromFile(configPath), {
      env: {
        SYNAPSOR_TENANT_ID: scenario.trusted_context.tenant_id,
        SYNAPSOR_PRINCIPAL: scenario.trusted_context.principal,
      },
      readRow: async ({ args }) => ({
        row: {
          id: args.customer_id,
          tenant_id: scenario.trusted_context.tenant_id,
          plan_credit_cents: 0,
          credit_reason: null,
          updated_at: "2026-07-12T00:00:00.000Z",
        },
        rowCount: 1,
      }),
    });
    try {
      const results: Array<Record<string, any>> = [];
      for (const item of scenario.cases) {
        const result = await runtime.callTool("support.propose_plan_credit", {
          customer_id: item.customer_id,
          credit_cents: item.credit_cents,
          reason: "conformance test",
        });
        results.push(result);
        expect((await runtime.store.getProposal(String(result.proposal_id)))?.state).toBe(item.expected_state);
      }
      const approvedResults = [];
      for (const result of results) {
        if ((await runtime.store.getProposal(String(result.proposal_id)))?.state === "approved") approvedResults.push(result);
      }
      expect(approvedResults).toHaveLength(expected.approved_before_limit);
      const deferred = results.at(-1)!;
      expect(deferred).toMatchObject({
        source_database_changed: expected.source_database_changed,
        approval: {
          fallback: "human_review",
          tripped_limits: [
            expect.objectContaining({ kind: "count", ...expected.count_limit }),
            expect.objectContaining({ kind: "total", ...expected.total_limit }),
          ],
        },
      });
      expect(await runtime.store.events(String(deferred.proposal_id))).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: expected.deferred_event }),
      ]));
    } finally {
      runtime.close();
    }
  });

  it("still rejects pure-contract configs when contracts are missing or empty", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-empty-contract-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: ":memory:" },
      contracts: ["./missing.contract.json"],
      capabilities: [],
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "APP_POSTGRES_READ_URL",
          write_url_env: "APP_POSTGRES_WRITE_URL",
        },
      },
    }, null, 2));
    expect(() => loadRuntimeConfigFromFile(configPath)).toThrow(/missing\.contract\.json/);

    fs.writeFileSync(path.join(tempDir, "empty.contract.json"), JSON.stringify({
      spec_version: "0.1",
      kind: "SynapsorContract",
      contexts: [
        {
          name: "local_operator",
          bindings: [{ name: "tenant_id", source: "environment", key: "SYNAPSOR_TENANT_ID" }],
          tenant_binding: "tenant_id",
        },
      ],
      capabilities: [],
    }, null, 2));
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: ":memory:" },
      contracts: ["./empty.contract.json"],
      capabilities: [],
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "APP_POSTGRES_READ_URL",
          write_url_env: "APP_POSTGRES_WRITE_URL",
        },
      },
    }, null, 2));
    expect(() => loadRuntimeConfigFromFile(configPath)).toThrow(/CAPABILITIES_REQUIRED|capabilities/i);
  });

  it("lists semantic tools without raw SQL or approval tools", () => {
    const runtime = createMcpRuntime(config, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      const tools = runtime.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_late_fee_waiver",
      ]);
      expect(tools.some((tool) => /execute_sql|run_query|approve|commit/i.test(tool.name))).toBe(false);
      expect(tools.every((tool) => tool.annotations.raw_sql_exposed === false)).toBe(true);
      expect(() => createSynapsorMcpServer(runtime)).not.toThrow();
    } finally {
      runtime.close();
    }
  });

  it("surfaces author-supplied tool, argument, and returns descriptions", () => {
    const describedConfig = structuredClone(config);
    const capability = describedConfig.capabilities?.[0];
    if (!capability) throw new Error("capability fixture missing");
    capability.description = "Inspect one invoice in the trusted tenant before proposing a waiver.";
    capability.returns_hint = "Returns invoice status, late fee, waiver facts, and an audit evidence handle.";
    const invoiceIdArg = capability.args.invoice_id;
    if (!invoiceIdArg) throw new Error("invoice id arg fixture missing");
    invoiceIdArg.description = "Invoice id, e.g. INV-3001.";
    const runtime = createMcpRuntime(describedConfig, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      const [tool] = runtime.listTools();
      if (!tool) throw new Error("tool fixture missing");
      expect(tool.description).toContain("Inspect one invoice in the trusted tenant");
      expect(tool.description).toContain("Returns invoice status");
      expect(tool.description).toContain("audit/replay handles");
      expect(tool.input_schema.invoice_id).toMatchObject({
        description: "Invoice id, e.g. INV-3001.",
      });
    } finally {
      runtime.close();
    }
  });

  it("returns result envelope v2 for read success", async () => {
    const runtime = createMcpRuntime({ ...config, result_format: 2 }, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      const result = await runtime.callTool("billing.inspect_invoice", { invoice_id: "INV-3001" });
      expect(result).toMatchObject({
        ok: true,
        action: "billing.inspect_invoice",
        kind: "read",
        proposal: null,
        error: null,
        source_database_changed: false,
        _meta: {
          tenant_id: "acme",
          principal: "support_agent_17",
          canonical_capability: "billing.inspect_invoice",
        },
      });
      expect(typeof result.summary).toBe("string");
      expect(result.data).toMatchObject({ id: "INV-3001", late_fee_cents: 5500 });
      expect(result.evidence).toMatchObject({
        note: expect.stringContaining("you do not need to act"),
      });
      expect(result).not.toHaveProperty("status");
    } finally {
      runtime.close();
    }
  });

  it("enforces operational fixed-window limits from trusted tenant context", async () => {
    const limited = structuredClone(config);
    limited.result_format = 2;
    limited.rate_limits = {
      default: { requests: 2, window_seconds: 60 },
      capabilities: { "billing.propose_late_fee_waiver": { requests: 1, window_seconds: 60 } },
    };
    let clock = 1_700_000_000_000;
    const runtime = createMcpRuntime(limited, {
      clock: () => clock,
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    });
    try {
      await expect(runtime.callTool("billing.inspect_invoice", { invoice_id: "INV-1" })).resolves.toMatchObject({ ok: true });
      await expect(runtime.callTool("billing.inspect_invoice", { invoice_id: "INV-2" })).resolves.toMatchObject({ ok: true });
      const rejected = await runtime.callTool("billing.inspect_invoice", { invoice_id: "INV-3" });
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: "RATE_LIMITED", retryable: true, retry_after_ms: 40000 },
        source_database_changed: false,
      });
      expect(runtime.rateLimitMetrics()).toEqual([{ tenant: "acme", capability: "billing.inspect_invoice", rejected: 1 }]);
      clock += 60_000;
      await expect(runtime.callTool("billing.inspect_invoice", { invoice_id: "INV-4" })).resolves.toMatchObject({ ok: true });
    } finally {
      await runtime.close();
    }
  });

  it("keeps retry_after_ms in the legacy MCP rate-limit envelope", async () => {
    const limited = structuredClone(config);
    limited.rate_limits = { default: { requests: 1, window_seconds: 60 } };
    const server = await startHttpMcpServer({
      config: limited,
      port: 0,
      devNoAuth: true,
      log: false,
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    });
    try {
      await httpRpc(server.port, undefined, "tools/call", { name: "billing.inspect_invoice", arguments: { invoice_id: "INV-1" } });
      const rejected = await httpRpc(server.port, undefined, "tools/call", { name: "billing.inspect_invoice", arguments: { invoice_id: "INV-2" } });
      const payload = await rejected.json() as { result: { structuredContent: Record<string, unknown> } };
      expect(payload.result.structuredContent).toMatchObject({
        ok: false,
        code: "RATE_LIMITED",
        retry_after_ms: expect.any(Number),
      });
    } finally {
      await server.close();
    }
  });

  it("trims trusted context env values at the binding layer", async () => {
    const seen: Array<{ tenant: string; principal: string }> = [];
    const runtime = createMcpRuntime(config, {
      env: {
        APP_POSTGRES_READ_URL: " postgresql://reader@example/app ",
        SYNAPSOR_TENANT_ID: " acme ",
        SYNAPSOR_PRINCIPAL: " support_agent_17 ",
      } as NodeJS.ProcessEnv,
      readRow: async (input) => {
        seen.push({
          tenant: input.context.tenant_id,
          principal: input.context.principal,
        });
        return { row: fixtureRow, rowCount: 1 };
      },
    });
    try {
      const result = await runtime.callTool("billing.inspect_invoice", { invoice_id: "INV-3001" });
      expect(result.trusted_context).toMatchObject({
        tenant_id: "acme",
        principal: "support_agent_17",
      });
      expect(seen[0]).toMatchObject({
        tenant: "acme",
        principal: "support_agent_17",
      });
    } finally {
      runtime.close();
    }
  });

  it("returns result envelope v2 for proposal success", async () => {
    const runtime = createMcpRuntime({ ...config, result_format: 2 }, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      const result = await runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        reason: "approved support waiver",
      });
      expect(result).toMatchObject({
        ok: true,
        action: "billing.propose_late_fee_waiver",
        kind: "proposal",
        data: null,
        error: null,
        source_database_changed: false,
        proposal: {
          state: "review_required",
          target: "invoices:INV-3001",
          approval_required: true,
          writeback: {
            mode: "direct_update",
            operation: "update",
            applied: false,
          },
        },
        _meta: {
          tenant_id: "acme",
          canonical_capability: "billing.propose_late_fee_waiver",
        },
      });
      expect(result.proposal).toMatchObject({
        diff: {
          late_fee_cents: { before: 5500, proposed: 0 },
        },
      });
    } finally {
      runtime.close();
    }
  });

  it("reports operation-aware direct writeback modes in result envelope v2", async () => {
    for (const [operation, expectedMode] of [["insert", "direct_insert"], ["delete", "direct_delete"]] as const) {
      const operationConfig = structuredClone(config);
      const capability = operationConfig.capabilities?.[1];
      if (!capability) throw new Error("proposal fixture missing");
      capability.operation = operation === "insert"
        ? { kind: "insert", deduplication: { components: [
          { column: "tenant_id", source: "trusted_tenant" },
          { column: "request_id", source: "proposal_id" },
        ] } }
        : { kind: "delete" };
      if (operation === "insert") {
        capability.target = { ...capability.target, table: "credits" };
        capability.lookup = { id_from_arg: "invoice_id" };
      } else {
        capability.patch = {};
        capability.allowed_columns = [];
        capability.approval = { mode: "human", required_role: "billing_reviewer" };
      }
      const runtime = createMcpRuntime({ ...operationConfig, result_format: 2 }, {
        readRow: async () => operation === "insert" ? { row: {}, rowCount: 0 } : { row: fixtureRow, rowCount: 1 },
      });
      try {
        const result = await runtime.callTool("billing.propose_late_fee_waiver", {
          invoice_id: "INV-3001",
          reason: "reviewed operation",
        });
        expect(result.proposal).toMatchObject({
          writeback: { mode: expectedMode, operation, applied: false },
        });
      } finally {
        await runtime.close();
      }
    }
  });

  it("returns a semantic duplicate error and permits a successor after conflict", async () => {
    let reads = 0;
    const store = new ProposalStore();
    const runtime = createMcpRuntime({ ...config, result_format: 2 }, {
      store,
      readRow: async () => {
        reads += 1;
        return { row: fixtureRow, rowCount: 1 };
      },
    });
    try {
      const args = { invoice_id: "INV-3001", reason: "approved support waiver" };
      const first = await runtime.callTool("billing.propose_late_fee_waiver", args);
      const duplicate = await runtime.callTool("billing.propose_late_fee_waiver", args);
      const existing = store.listProposals()[0];
      if (!existing) throw new Error("proposal fixture missing");
      expect(duplicate).toMatchObject({
        ok: false,
        error: {
          code: "PROPOSAL_ALREADY_EXISTS",
          retryable: false,
          message: expect.stringContaining(existing.proposal_id),
        },
      });
      expect(store.listProposals()).toHaveLength(1);
      expect(reads).toBe(2);

      store.db.prepare("UPDATE proposals SET state = 'conflict' WHERE proposal_id = ?").run(existing.proposal_id);
      const successor = await runtime.callTool("billing.propose_late_fee_waiver", args);
      expect(first).toMatchObject({ ok: true });
      expect(successor).toMatchObject({ ok: true });
      expect(store.listProposals()).toHaveLength(2);
      expect(store.getProposal(existing.proposal_id)?.state).toBe("conflict");
    } finally {
      runtime.close();
    }
  });

  it("returns safe result envelope v2 errors without raw infra strings", async () => {
    const logs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    });
    const runtime = createMcpRuntime({ ...config, result_format: 2 }, {
      readRow: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5433");
      },
    });
    try {
      const result = await runtime.callTool("billing.inspect_invoice", { invoice_id: "INV-3001" });
      expect(result).toMatchObject({
        ok: false,
        action: "billing.inspect_invoice",
        kind: "read",
        data: null,
        proposal: null,
        error: {
          code: "TEMPORARILY_UNAVAILABLE",
          retryable: true,
        },
        source_database_changed: false,
        _meta: {
          canonical_capability: "billing.inspect_invoice",
        },
      });
      expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
      expect(JSON.stringify(result)).not.toContain("127.0.0.1");
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
        event: "tool_rejected",
        capability: "billing.inspect_invoice",
        tenant: "acme",
        error_code: "TEMPORARILY_UNAVAILABLE",
        runtime_code: "UNCLASSIFIED",
        retryable: true,
        source_database_changed: false,
      });
      expect(logs.join("")).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|postgres(?:ql)?:\/\//i);
    } finally {
      runtime.close();
      vi.restoreAllMocks();
    }
  });

  it.each([
    {
      name: "PostgreSQL connection saturation",
      error: () => new Error("query failed", {
        cause: Object.assign(new Error("too many clients already at db.internal:5432"), { code: "53300" }),
      }),
      runtimeCode: "POSTGRES_53300",
      retryAfterMs: 1000,
    },
    {
      name: "MySQL connection saturation",
      error: () => Object.assign(new Error("too many connections at mysql.internal:3306"), {
        code: "ER_CON_COUNT_ERROR",
        errno: 1040,
        sqlState: "08004",
      }),
      runtimeCode: "MYSQL_ER_CON_COUNT_ERROR",
      retryAfterMs: 1000,
    },
    {
      name: "Runner source pool timeout",
      error: () => new McpRuntimeError("SOURCE_POOL_TIMEOUT", "source connection queue timed out", { retry_after_ms: 2750 }),
      runtimeCode: "SOURCE_POOL_TIMEOUT",
      retryAfterMs: 2750,
    },
    {
      name: "PostgreSQL statement timeout",
      error: () => Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
      runtimeCode: "POSTGRES_57014",
      retryAfterMs: 1000,
    },
    {
      name: "MySQL statement timeout",
      error: () => Object.assign(new Error("query execution was interrupted"), { code: "ER_QUERY_TIMEOUT", errno: 3024 }),
      runtimeCode: "MYSQL_ER_QUERY_TIMEOUT",
      retryAfterMs: 1000,
    },
  ])("classifies $name as safely retryable", async ({ error, runtimeCode, retryAfterMs }) => {
    const logs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    });
    const runtime = createMcpRuntime({ ...config, result_format: 2 }, {
      readRow: async () => { throw error(); },
    });
    try {
      const result = await runtime.callTool("billing.inspect_invoice", { invoice_id: "INV-3001" });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "TEMPORARILY_UNAVAILABLE",
          retryable: true,
          retry_after_ms: retryAfterMs,
        },
        source_database_changed: false,
      });
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
        event: "tool_rejected",
        error_code: "TEMPORARILY_UNAVAILABLE",
        runtime_code: runtimeCode,
        retry_after_ms: retryAfterMs,
        retryable: true,
        source_database_changed: false,
      });
      expect(`${JSON.stringify(result)}${logs.join("")}`).not.toMatch(/db\.internal|mysql\.internal|too many clients|too many connections/i);
    } finally {
      runtime.close();
      vi.restoreAllMocks();
    }
  });

  it("keeps non-transient database failures non-retryable and redacted", async () => {
    const logs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    });
    const runtime = createMcpRuntime({ ...config, result_format: 2 }, {
      readRow: async () => {
        throw Object.assign(new Error("database constraint violation at db.internal containing secret-row-value"), { code: "23505" });
      },
    });
    try {
      const result = await runtime.callTool("billing.inspect_invoice", { invoice_id: "INV-3001" });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "INTERNAL",
          retryable: false,
        },
        source_database_changed: false,
      });
      expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
        runtime_code: "UNCLASSIFIED",
        retryable: false,
      });
      expect(`${JSON.stringify(result)}${logs.join("")}`).not.toMatch(/db\.internal|secret-row-value|23505/i);
    } finally {
      runtime.close();
      vi.restoreAllMocks();
    }
  });

  it("returns a safe unavailable envelope when the local store disappears while active", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-mcp-store-missing-"));
    const storePath = path.join(tempDir, "local.db");
    const runtime = createMcpRuntime({ ...config, result_format: 2, storage: { sqlite_path: storePath } }, {
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    });
    try {
      expect(fs.existsSync(storePath)).toBe(true);
      fs.unlinkSync(storePath);
      const result = await runtime.callTool("billing.inspect_invoice", { invoice_id: "INV-3001" });
      expect(result).toMatchObject({
        ok: false,
        action: "billing.inspect_invoice",
        error: {
          code: "TEMPORARILY_UNAVAILABLE",
          retryable: true,
        },
        source_database_changed: false,
      });
      expect(JSON.stringify(result)).not.toContain(storePath);
      await expect(runtime.readResource("synapsor://evidence/ev_missing")).rejects.toThrow(/local Synapsor store is temporarily unavailable/i);
    } finally {
      runtime.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns evidence-backed read output and inspectable evidence resource", async () => {
    const runtime = createMcpRuntime(config, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      const result = await runtime.callTool("billing.inspect_invoice", { invoice_id: "INV-3001" });
      expect(result.status).toBe("ok");
      expect(result.source_database_mutated).toBe(false);
      expect(result.trusted_context).toMatchObject({ tenant_id: "acme", principal: "support_agent_17" });
      expect(String(result.evidence_resource)).toMatch(/^synapsor:\/\/evidence\//);
      const evidence = await runtime.readResource(String(result.evidence_resource));
      expect(evidence).toMatchObject({
        evidence_bundle_id: result.evidence_bundle_id,
        tenant_id: "acme",
      });
    } finally {
      runtime.close();
    }
  });

  it("returns only a reviewed aggregate scalar and records no source member rows", async () => {
    const readRow = vi.fn(async (input: any) => {
      expect(input.args).toEqual({});
      expect(input.context).toMatchObject({ tenant_id: "acme", principal: "support_agent_17" });
      expect(input.capability.aggregate?.selection).toEqual({ all: [{ column: "status", operator: "eq", value: "overdue" }] });
      return { row: { aggregate_value: "7500", group_size: "6" }, rows: [{ aggregate_value: "7500", group_size: "6" }], rowCount: 1 };
    });
    const runtime = createMcpRuntime(aggregateReadConfig(), { readRow });
    try {
      expect(runtime.listTools()).toEqual([
        expect.objectContaining({
          name: "billing.sum_overdue_balance",
          kind: "aggregate_read",
          annotations: expect.objectContaining({ readOnlyHint: true, idempotentHint: true }),
        }),
      ]);
      const result = await runtime.callTool("billing.sum_overdue_balance", {});
      expect(result).toMatchObject({
        status: "ok",
        data: {
          function: "sum",
          column: "balance_cents",
          suppressed: false,
          minimum_group_size: 5,
          value: 7500,
          member_rows_included: false,
        },
        source_database_changed: false,
      });
      expect(readRow).toHaveBeenCalledTimes(1);

      const evidence = await runtime.readResource(String(result.evidence_resource));
      expect(evidence).toMatchObject({
        tenant_id: "acme",
        items: [],
        payload: {
          aggregate_result: 7500,
          member_rows_included: false,
        },
      });
      expect(JSON.stringify(evidence)).not.toContain("INV-");
      expect(JSON.stringify(evidence)).not.toContain("customer_email");
    } finally {
      await runtime.close();
    }
  });

  it("suppresses small aggregate groups without exposing the scalar or member count", async () => {
    const runtime = createMcpRuntime(aggregateReadConfig(), {
      readRow: async () => ({
        row: { aggregate_value: 999_999, group_size: 2 },
        rows: [{ aggregate_value: 999_999, group_size: 2 }],
        rowCount: 1,
      }),
    });
    try {
      const result = await runtime.callTool("billing.sum_overdue_balance", {});
      expect(result).toMatchObject({
        status: "suppressed",
        data: { suppressed: true, value: null, minimum_group_size: 5, member_rows_included: false },
      });
      expect(result.data).not.toHaveProperty("group_size");
      const evidence = await runtime.readResource(String(result.evidence_resource));
      expect(evidence).toMatchObject({ items: [], payload: { suppressed: true, member_rows_included: false } });
      expect(evidence.payload).not.toHaveProperty("aggregate_result");
      expect(evidence.payload).not.toHaveProperty("group_size");
      expect(JSON.stringify({ result, evidence })).not.toContain("999999");
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when an aggregate adapter returns source rows instead of one scalar envelope", async () => {
    const runtime = createMcpRuntime(aggregateReadConfig(), {
      readRow: async () => ({ row: { aggregate_value: 10, group_size: 5 }, rows: [{ id: "INV-1" }, { id: "INV-2" }], rowCount: 2 }),
    });
    try {
      await expect(runtime.callTool("billing.sum_overdue_balance", {})).rejects.toMatchObject({ code: "AGGREGATE_RESULT_SHAPE_INVALID" });
    } finally {
      await runtime.close();
    }
  });

  it("creates an exact proposal without mutating the source and exposes proposal/replay resources", async () => {
    const row = { ...fixtureRow, updated_at: "2026-07-12 04:09:40.17513+00" };
    const runtime = createMcpRuntime(config, { readRow: async () => ({ row, rowCount: 1 }) });
    try {
      const result = await runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        reason: "approved support waiver",
      });
      expect(result.status).toBe("review_required");
      expect(result.source_database_mutated).toBe(false);
      expect(result.diff).toMatchObject({
        late_fee_cents: { before: 5500, proposed: 0 },
        waiver_reason: { before: null, proposed: "approved support waiver" },
      });

      const proposal = await runtime.readResource(String(result.proposal_resource));
      expect(proposal).toHaveProperty("proposal");
      const storedProposal = proposal.proposal as { state: string; change_set: { guards: { expected_version: { value: string } } } };
      expect(storedProposal.state).toBe("pending_review");
      expect(storedProposal.change_set.guards.expected_version.value).toBe("2026-07-12 04:09:40.175130+00");

      const replay = await runtime.readResource(String(result.replay_resource));
      expect(replay).toHaveProperty("replay_id", result.replay_resource?.toString().replace("synapsor://replay/", ""));
    } finally {
      runtime.close();
    }
  });

  it("creates a v2 INSERT proposal with Runner-supplied tenant and dedup identity", async () => {
    const insertConfig = structuredClone(config);
    insertConfig.capabilities = [{
      name: "billing.propose_credit_insert",
      kind: "proposal",
      source: "app_postgres",
      target: { schema: "public", table: "credits", primary_key: "id", tenant_key: "tenant_id" },
      args: { amount_cents: { type: "number", required: true, minimum: 1, maximum: 2500 } },
      lookup: { id_from_arg: "amount_cents" },
      visible_columns: ["id", "tenant_id", "request_id", "amount_cents", "version"],
      evidence: "required",
      max_rows: 1,
      patch: { amount_cents: { from_arg: "amount_cents" } },
      allowed_columns: ["amount_cents"],
      numeric_bounds: { amount_cents: { minimum: 1, maximum: 2500 } },
      operation: {
        kind: "insert",
        deduplication: { components: [
          { column: "tenant_id", source: "trusted_tenant" },
          { column: "request_id", source: "proposal_id" },
        ] },
      },
      approval: { mode: "human", required_role: "support_lead" },
      writeback: { mode: "direct_sql" },
    }];
    const readRow = vi.fn(async () => ({ row: {}, rowCount: 0 }));
    const runtime = createMcpRuntime(insertConfig, { readRow });
    try {
      const result = await runtime.callTool("billing.propose_credit_insert", { amount_cents: 500 });
      expect(readRow).not.toHaveBeenCalled();
      const proposal = await runtime.store.getProposal(String(result.proposal_id));
      expect(proposal?.change_set).toMatchObject({
        schema_version: "synapsor.change-set.v2",
        operation: "single_row_insert",
        before: {},
        patch: { amount_cents: 500 },
        guards: { deduplication: { components: [
          { column: "tenant_id", source: "trusted_tenant", value: "acme" },
          { column: "request_id", source: "proposal_id", value: result.proposal_id },
        ] } },
      });
      expect(result.source_database_mutated).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("creates a v2 DELETE tombstone proposal that requires human approval", async () => {
    const deleteConfig = structuredClone(config);
    const capability = deleteConfig.capabilities?.[1];
    if (!capability) throw new Error("proposal fixture missing");
    capability.operation = { kind: "delete" };
    capability.patch = {};
    capability.allowed_columns = [];
    capability.approval = { mode: "human", required_role: "support_lead" };
    const runtime = createMcpRuntime(deleteConfig, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      const result = await runtime.callTool("billing.propose_late_fee_waiver", { invoice_id: "INV-3001", reason: "unused" });
      const proposal = await runtime.store.getProposal(String(result.proposal_id));
      expect(proposal?.state).toBe("pending_review");
      expect(proposal?.change_set).toMatchObject({
        schema_version: "synapsor.change-set.v2",
        operation: "single_row_delete",
        patch: {},
        after: {},
      });
      expect(result.diff).toMatchObject({ id: { before: "INV-3001", proposed: null } });
    } finally {
      await runtime.close();
    }
  });

  it("freezes the exact bounded set in a v3 proposal with per-member guards", async () => {
    const rows = [
      { id: "INV-2", tenant_id: "acme", status: "overdue", balance_cents: 2_000, close_reason: null, version: 7 },
      { id: "INV-1", tenant_id: "acme", status: "overdue", balance_cents: 1_000, close_reason: null, version: 3 },
    ];
    const runtime = createMcpRuntime(boundedSetUpdateConfig(), {
      readRow: async () => ({ row: rows[0]!, rows, rowCount: rows.length }),
    });
    try {
      const result = await runtime.callTool("billing.close_overdue_invoices", { reason: "reviewed collections close" });
      const proposal = await runtime.store.getProposal(String(result.proposal_id));
      expect(proposal?.state).toBe("pending_review");
      expect(proposal?.change_set).toMatchObject({
        schema_version: "synapsor.change-set.v3",
        operation: "set_update",
        approval: { status: "pending", mode: "human" },
        frozen_set: {
          max_rows: 2,
          row_count: 2,
          aggregate_bounds: [{ column: "balance_cents", measure: "before", maximum: 10_000, actual: 3_000 }],
          members: [
            {
              primary_key: { column: "id", value: "INV-1" },
              expected_version: { column: "version", value: 3 },
              before: { status: "overdue", version: 3 },
              after: { status: "closed", close_reason: "reviewed collections close", version: 4 },
            },
            {
              primary_key: { column: "id", value: "INV-2" },
              expected_version: { column: "version", value: 7 },
              after: { version: 8 },
            },
          ],
        },
      });
      expect(result).toMatchObject({
        status: "review_required",
        approval_required: true,
        source_database_mutated: false,
        diff: { affected_rows: { before: 2, proposed: 2 } },
      });
      if (proposal?.change_set.schema_version !== "synapsor.change-set.v3") throw new Error("expected v3 bounded-set proposal");
      expect(proposal.change_set.frozen_set.set_digest).toBe(canonicalJsonDigest({
        operation: proposal.change_set.operation,
        members: proposal.change_set.frozen_set.members,
        aggregate_bounds: proposal.change_set.frozen_set.aggregate_bounds,
      }));
    } finally {
      await runtime.close();
    }
  });

  it("rejects bounded-set cap and aggregate overflow before proposal persistence", async () => {
    const capStore = new ProposalStore();
    const capRows = [
      { id: "INV-1", tenant_id: "acme", status: "overdue", balance_cents: 100, close_reason: null, version: 1 },
      { id: "INV-2", tenant_id: "acme", status: "overdue", balance_cents: 100, close_reason: null, version: 1 },
      { id: "INV-3", tenant_id: "acme", status: "overdue", balance_cents: 100, close_reason: null, version: 1 },
    ];
    const capRuntime = createMcpRuntime(boundedSetUpdateConfig(2), {
      store: capStore,
      readRow: async () => ({ row: capRows[0]!, rows: capRows, rowCount: capRows.length }),
    });
    try {
      await expect(capRuntime.callTool("billing.close_overdue_invoices", { reason: "too many" }))
        .rejects.toMatchObject({ code: "SET_ROW_CAP_EXCEEDED" });
      expect(capStore.listProposals()).toEqual([]);
    } finally {
      await capRuntime.close();
    }

    const aggregateStore = new ProposalStore();
    const aggregateRows = capRows.slice(0, 2).map((row) => ({ ...row, balance_cents: 600 }));
    const aggregateRuntime = createMcpRuntime(boundedSetUpdateConfig(2, 1_000), {
      store: aggregateStore,
      readRow: async () => ({ row: aggregateRows[0]!, rows: aggregateRows, rowCount: aggregateRows.length }),
    });
    try {
      await expect(aggregateRuntime.callTool("billing.close_overdue_invoices", { reason: "too valuable" }))
        .rejects.toMatchObject({ code: "SET_AGGREGATE_BOUND_EXCEEDED" });
      expect(aggregateStore.listProposals()).toEqual([]);
    } finally {
      await aggregateRuntime.close();
    }
  });

  it("freezes exact reviewed batch items with trusted tenant and deterministic identities", async () => {
    const runtime = createMcpRuntime(boundedBatchInsertConfig());
    try {
      const result = await runtime.callTool("billing.create_credits", {
        items: [
          { id: "CR-2", external_id: "ext-2", amount_cents: 1_500, reason: "second" },
          { id: "CR-1", external_id: "ext-1", amount_cents: 500, reason: "first" },
        ],
      });
      const proposal = await runtime.store.getProposal(String(result.proposal_id));
      expect(proposal?.state).toBe("pending_review");
      expect(proposal?.change_set).toMatchObject({
        schema_version: "synapsor.change-set.v3",
        operation: "batch_insert",
        frozen_set: {
          row_count: 2,
          aggregate_bounds: [{ column: "amount_cents", measure: "after", maximum: 5_000, actual: 2_000 }],
          members: [
            {
              primary_key: { column: "id", value: "CR-1" },
              before: {},
              after: { id: "CR-1", tenant_id: "acme", external_id: "ext-1", amount_cents: 500, reason: "first" },
            },
            {
              primary_key: { column: "id", value: "CR-2" },
              after: { id: "CR-2", tenant_id: "acme", external_id: "ext-2", amount_cents: 1_500, reason: "second" },
            },
          ],
        },
      });
      expect(result).toMatchObject({ status: "review_required", approval_required: true, source_database_mutated: false });
    } finally {
      await runtime.close();
    }
  });

  it("reauthorizes proposal, evidence, and replay resources by tenant and principal", async () => {
    const claimsConfig = structuredClone(config);
    claimsConfig.trusted_context = {
      provider: "http_claims",
      values: { tenant_id_key: "tenant_id", principal_key: "sub" },
    };
    claimsConfig.session_auth = {
      provider: "jwt_hs256",
      secret_env: "SYNAPSOR_SESSION_JWT_SECRET",
      issuer: "https://identity.example",
      audience: "synapsor-runner",
    };
    const backing = new ProposalStore();
    const sharedStore = runtimeStoreAdapter(backing);
    const replay = vi.spyOn(sharedStore, "replay");
    const owner = createMcpRuntime(claimsConfig, {
      store: sharedStore,
      trustedContext: { tenant_id: "acme", principal: "alice", provenance: "http_claims" },
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    });
    const wrongTenant = createMcpRuntime(claimsConfig, {
      store: sharedStore,
      trustedContext: { tenant_id: "globex", principal: "alice", provenance: "http_claims" },
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    });
    const wrongPrincipal = createMcpRuntime(claimsConfig, {
      store: sharedStore,
      trustedContext: { tenant_id: "acme", principal: "mallory", provenance: "http_claims" },
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    });
    try {
      const result = await owner.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        reason: "approved support waiver",
      });
      const resources = [
        String(result.proposal_resource),
        String(result.evidence_resource),
        String(result.replay_resource),
      ];

      for (const uri of resources) {
        await expect(wrongTenant.readResource(uri)).rejects.toMatchObject({
          code: "RESOURCE_NOT_FOUND",
          message: "Synapsor resource not found.",
        });
        await expect(wrongPrincipal.readResource(uri)).rejects.toMatchObject({
          code: "RESOURCE_NOT_FOUND",
          message: "Synapsor resource not found.",
        });
      }
      await expect(owner.readResource("synapsor://evidence/ev_missing")).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        message: "Synapsor resource not found.",
      });
      expect(replay).not.toHaveBeenCalled();

      await expect(owner.readResource(String(result.proposal_resource))).resolves.toHaveProperty("proposal");
      await expect(owner.readResource(String(result.evidence_resource))).resolves.toHaveProperty("evidence_bundle_id", result.evidence_bundle_id);
      await expect(owner.readResource(String(result.replay_resource))).resolves.toHaveProperty("proposal.proposal_id", result.proposal_id);
      expect(replay).toHaveBeenCalledTimes(1);

      const compensation = JSON.parse(fs.readFileSync(
        path.resolve(testDir, "../../../fixtures/protocol/compensation-change-set.update.v1.json"),
        "utf8",
      ));
      compensation.proposal_id = "wrp_revert_authorized";
      compensation.action = "billing.propose_late_fee_waiver";
      compensation.principal = { id: "alice", source: "trusted_session" };
      compensation.scope = { tenant_id: "acme", business_object: "invoices", object_id: "INV-REVERT" };
      compensation.source = {
        kind: "external_postgres",
        source_id: "app_postgres",
        schema: "public",
        table: "invoices",
        primary_key: { column: "id", value: "INV-REVERT" },
      };
      compensation.compensation.descriptor.target = {
        source_id: "app_postgres",
        schema: "public",
        table: "invoices",
        primary_key_column: "id",
      };
      compensation.compensation.descriptor.tenant_guard = { column: "tenant_id", value: "acme" };
      compensation.compensation.descriptor.allowed_columns = ["late_fee_cents"];
      compensation.compensation.descriptor.members = [{
        primary_key: { column: "id", value: "INV-REVERT" },
        expected_state: { late_fee_cents: 0, version: 8 },
        restore_values: { late_fee_cents: 5500 },
      }];
      compensation.guards = { tenant: { column: "tenant_id", value: "acme" }, allowed_columns: ["late_fee_cents"] };
      compensation.evidence = { bundle_id: "ev_revert_authorized", query_fingerprint: "sha256:revert-authorization", items: [] };
      compensation.integrity = { proposal_hash: "sha256:revert-authorization" };
      backing.createProposal(compensation);
      backing.recordEvidenceBundle({
        evidence_bundle_id: "ev_revert_authorized",
        proposal_id: compensation.proposal_id,
        tenant_id: "acme",
        payload: { source_database_changed: false },
      });

      const compensationResources = [
        "synapsor://proposals/wrp_revert_authorized",
        "synapsor://evidence/ev_revert_authorized",
        "synapsor://replay/replay_wrp_revert_authorized",
      ];
      for (const uri of compensationResources) {
        await expect(wrongTenant.readResource(uri)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
        await expect(wrongPrincipal.readResource(uri)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
        await expect(owner.readResource(uri)).resolves.toBeDefined();
      }
      expect(owner.listTools().map((tool) => tool.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_late_fee_waiver",
      ]);
    } finally {
      await owner.close();
      await wrongTenant.close();
      await wrongPrincipal.close();
      backing.close();
    }
  });

  it("runs proposal flow through the runtime store contract, not the concrete SQLite store type", async () => {
    const backing = new ProposalStore();
    const runtime = createMcpRuntime(config, {
      store: runtimeStoreAdapter(backing),
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    });
    try {
      const result = await runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        reason: "approved support waiver",
      });
      expect(result.status).toBe("review_required");
      expect(backing.listProposals()).toHaveLength(1);
      await expect(runtime.readResource(String(result.proposal_resource))).resolves.toHaveProperty("proposal");
      await expect(runtime.readResource(String(result.evidence_resource))).resolves.toHaveProperty("evidence_bundle_id", result.evidence_bundle_id);
    } finally {
      runtime.close();
    }
  });

  it("requires the configured Postgres runtime-store URL env before serving", () => {
    const sharedRuntimeStoreConfig = structuredClone(config);
    sharedRuntimeStoreConfig.storage = {
      shared_postgres: {
        mode: "runtime_store",
        url_env: "SYNAPSOR_LEDGER_DATABASE_URL",
        schema: "synapsor_runner",
        lock_timeout_ms: 1000,
      },
    };
    expect(() => createMcpRuntime(sharedRuntimeStoreConfig, {
      env: {},
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    })).toThrowError(expect.objectContaining({
      code: "POSTGRES_RUNTIME_STORE_URL_MISSING",
    }));
  });

  it("auto-approves proposals under the reviewed approval policy threshold", async () => {
    const store = new ProposalStore();
    const runtime = createMcpRuntime(autoApprovalConfig(), { store, readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      const result = await runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        credit_cents: 2500,
        reason: "documented outage credit",
      });

      expect(result).toMatchObject({
        status: "approved",
        approval: {
          mode: "policy",
          policy: "billing_propose_late_fee_waiver_auto_approval",
        },
        approval_required: false,
        source_database_mutated: false,
      });
      const proposal = store.getProposal(String(result.proposal_id));
      expect(proposal?.state).toBe("approved");
      expect(store.events(String(result.proposal_id))).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "proposal_approved",
          actor: "policy:billing_propose_late_fee_waiver_auto_approval",
        }),
      ]));
      expect(() => store.approveProposal(String(result.proposal_id), {
        approver: "support_lead",
        proposal_hash: String(result.proposal_hash),
        proposal_version: Number(result.proposal_version),
      })).toThrow(/PROPOSAL_NOT_PENDING_REVIEW|is approved/);
    } finally {
      runtime.close();
    }
  });

  it("falls back to human review when a reviewed aggregate limit trips", async () => {
    const limited = autoApprovalConfig();
    if (!limited.policies?.[0]) throw new Error("approval policy fixture missing");
    limited.policies[0].limits = [
      { kind: "count", max: 1, period: "day", scope: "tenant_policy" },
      { kind: "total", field: "late_fee_cents", max: 3000, period: "day", scope: "tenant_policy" },
    ];
    const runtime = createMcpRuntime(limited, {
      readRow: async ({ args }) => ({ row: { ...fixtureRow, id: String(args.invoice_id) }, rowCount: 1 }),
    });
    try {
      const first = await runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-LIMIT-1",
        credit_cents: 2000,
        reason: "first reviewed credit",
      });
      expect(first.status).toBe("approved");

      const second = await runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-LIMIT-2",
        credit_cents: 1500,
        reason: "aggregate ceiling reached",
      });

      expect(second).toMatchObject({
        status: "review_required",
        approval_required: true,
        approval: {
          mode: "policy",
          policy: "billing_propose_late_fee_waiver_auto_approval",
          fallback: "human_review",
          tripped_limits: [
            expect.objectContaining({ kind: "count", observed: 1, projected: 2, max: 1 }),
            expect.objectContaining({ kind: "total", observed: 2000, proposed: 1500, projected: 3500, max: 3000 }),
          ],
        },
      });
      expect((await runtime.store.getProposal(String(second.proposal_id)))?.state).toBe("pending_review");
      expect(await runtime.store.events(String(second.proposal_id))).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "policy_auto_approval_deferred",
          payload: expect.objectContaining({ fallback: "human_review" }),
        }),
      ]));
    } finally {
      runtime.close();
    }
  });

  it("leaves proposals over the approval policy threshold pending review", async () => {
    const runtime = createMcpRuntime(autoApprovalConfig(), { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      const result = await runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        credit_cents: 2501,
        reason: "larger credit needs review",
      });

      expect(result).toMatchObject({
        status: "review_required",
        approval: {
          mode: "policy",
          policy: "billing_propose_late_fee_waiver_auto_approval",
        },
        approval_required: true,
      });
      expect((await runtime.store.getProposal(String(result.proposal_id)))?.state).toBe("pending_review");
    } finally {
      runtime.close();
    }
  });

  it("leaves policy proposals pending when any numeric patch field is uncovered", async () => {
    const uncovered = autoApprovalConfig();
    const proposal = uncovered.capabilities?.[1];
    if (!proposal) throw new Error("proposal fixture missing");
    proposal.args.extra_credit_cents = { type: "number", required: true, minimum: 0, maximum: 100 };
    proposal.patch = {
      ...proposal.patch,
      extra_credit_cents: { from_arg: "extra_credit_cents" },
    };
    proposal.allowed_columns = [...(proposal.allowed_columns ?? []), "extra_credit_cents"];
    const runtime = createMcpRuntime(uncovered, {
      readRow: async () => ({ row: { ...fixtureRow, extra_credit_cents: 0 }, rowCount: 1 }),
    });
    try {
      const result = await runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        credit_cents: 2500,
        extra_credit_cents: 1,
        reason: "contains an uncovered numeric patch",
      });
      expect(result.status).toBe("review_required");
      expect((await runtime.store.getProposal(String(result.proposal_id)))?.state).toBe("pending_review");
    } finally {
      runtime.close();
    }
  });

  it("respects the local disable_auto_approval override", async () => {
    const disabled = autoApprovalConfig();
    disabled.approvals = { disable_auto_approval: true };
    const runtime = createMcpRuntime(disabled, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      const result = await runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        credit_cents: 2500,
        reason: "operator disabled policy approval",
      });
      expect(result.status).toBe("review_required");
      expect((await runtime.store.events(String(result.proposal_id))).some((event) => event.actor.startsWith("policy:"))).toBe(false);
    } finally {
      runtime.close();
    }
  });

  it("rejects proposal patches outside reviewed numeric bounds", async () => {
    const guardedConfig = structuredClone(config);
    const proposal = guardedConfig.capabilities?.[1];
    if (!proposal) throw new Error("proposal fixture missing");
    proposal.patch = {
      late_fee_cents: { fixed: 100000 },
      waiver_reason: { from_arg: "reason" },
    };
    proposal.numeric_bounds = {
      late_fee_cents: { minimum: 0, maximum: 5000 },
    };
    const runtime = createMcpRuntime(guardedConfig, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      await expect(runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        reason: "oversized waiver",
      })).rejects.toMatchObject({ code: "PATCH_ABOVE_MAXIMUM" });
    } finally {
      runtime.close();
    }
  });

  it("rejects proposal status transitions outside reviewed transition guards", async () => {
    const guardedConfig = structuredClone(config);
    const proposal = guardedConfig.capabilities?.[1];
    if (!proposal) throw new Error("proposal fixture missing");
    proposal.args = {
      invoice_id: { type: "string", required: true, max_length: 128 },
      next_status: { type: "string", required: true, enum: ["pending_review", "closed"] },
    };
    proposal.visible_columns = ["id", "tenant_id", "status", "updated_at"];
    proposal.patch = {
      status: { from_arg: "next_status" },
    };
    proposal.allowed_columns = ["status"];
    proposal.transition_guards = {
      status: {
        allowed: {
          open: ["pending_review"],
          pending_review: ["closed"],
        },
      },
    };
    const runtime = createMcpRuntime(guardedConfig, {
      readRow: async () => ({ row: { ...fixtureRow, status: "open" }, rowCount: 1 }),
    });
    try {
      const accepted = await runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        next_status: "pending_review",
      });
      expect(accepted.status).toBe("review_required");
      await expect(runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        next_status: "closed",
      })).rejects.toMatchObject({ code: "PATCH_TRANSITION_NOT_ALLOWED" });
    } finally {
      runtime.close();
    }
  });

  it("disables proposal tools in read-only mode", async () => {
    const runtime = createMcpRuntime({ ...config, mode: "read_only" }, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      expect(runtime.listTools().map((tool) => tool.name)).toEqual(["billing.inspect_invoice"]);
      expect(() => createSynapsorMcpServer(runtime)).not.toThrow();
      await expect(runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        reason: "approved support waiver",
      })).rejects.toMatchObject({
        code: "PROPOSALS_DISABLED",
      });
    } finally {
      runtime.close();
    }
  });

  it("records shadow proposals for replay without permitting writeback", async () => {
    const store = new ProposalStore();
    const runtime = createMcpRuntime({ ...config, mode: "shadow" }, { store, readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      const result = await runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        reason: "approved support waiver",
      });
      expect(result.status).toBe("shadow_proposal_created");
      expect(result.source_database_mutated).toBe(false);

      const proposalResource = await runtime.readResource(String(result.proposal_resource));
      const proposal = proposalResource.proposal as { proposal_id: string; change_set: { mode: string }; source_database_mutated: boolean };
      expect(proposal.change_set.mode).toBe("shadow");
      expect(proposal.source_database_mutated).toBe(false);
      expect(() => store.approveProposal(proposal.proposal_id, {
        approver: "support_lead_1",
        proposal_hash: String(result.proposal_hash),
        proposal_version: Number(result.proposal_version),
      })).toThrow(/shadow proposal/);
    } finally {
      runtime.close();
    }
  });

  it("rejects model attempts to supply trusted context", async () => {
    const runtime = createMcpRuntime(config, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      await expect(runtime.callTool("billing.inspect_invoice", {
        invoice_id: "INV-3001",
        tenant_id: "otherco",
      })).rejects.toMatchObject(new McpRuntimeError("MODEL_CANNOT_OVERRIDE_BINDING", "tenant_id is trusted context and cannot be supplied as a model argument."));
    } finally {
      runtime.close();
    }
  });

  it("resolves explicit named contexts before global trusted_context", async () => {
    const namedContextConfig = structuredClone(config);
    namedContextConfig.trusted_context = {
      provider: "static_dev",
      values: {
        tenant_id: "wrong_global_tenant",
        principal: "wrong_global_principal",
      },
    };
    namedContextConfig.contexts = {
      local_support_operator: {
        provider: "environment",
        values: {
          tenant_id_env: "TEST_NAMED_TENANT",
          principal_env: "TEST_NAMED_PRINCIPAL",
        },
      },
    };
    for (const capability of namedContextConfig.capabilities ?? []) {
      capability.context = "local_support_operator";
    }
    const runtime = createMcpRuntime(namedContextConfig, {
      env: {
        TEST_NAMED_TENANT: "acme_named",
        TEST_NAMED_PRINCIPAL: "named_operator",
      },
      readRow: async (input) => ({
        row: {
          ...fixtureRow,
          tenant_id: input.context.tenant_id,
        },
        rowCount: 1,
      }),
    });
    try {
      const result = await runtime.callTool("billing.inspect_invoice", { invoice_id: "INV-3001" });
      expect(result.trusted_context).toMatchObject({
        tenant_id: "acme_named",
        principal: "named_operator",
        provenance: "environment",
      });
    } finally {
      runtime.close();
    }
  });

  it("delegates cloud mode tool calls to Synapsor Cloud adapter APIs", async () => {
    const calls: Array<{ adapterId: string; toolName: string; input: Record<string, unknown>; session?: Record<string, unknown> }> = [];
    const runtime = createMcpRuntime({
      version: 1,
      mode: "cloud",
      storage: { sqlite_path: ":memory:" },
      trusted_context: { provider: "cloud_session" },
      cloud: {
        base_url_env: "SYNAPSOR_CLOUD_BASE_URL",
        runner_token_env: "SYNAPSOR_RUNNER_TOKEN",
        adapter_id: "mcp.billing",
        session: { tenant_id: "acme" },
      },
    }, {
      env: {
        SYNAPSOR_CLOUD_BASE_URL: "https://api.synapsor.example",
        SYNAPSOR_RUNNER_TOKEN: "syn_wbr_test",
      } as NodeJS.ProcessEnv,
      controlPlaneClient: {
        adapterTools: async () => ({
          adapter_id: "mcp.billing",
          tools: [],
        }),
        callAdapterTool: async (
          adapterId: string,
          toolName: string,
          input: Record<string, unknown>,
          options: { session?: Record<string, unknown> },
        ) => {
          calls.push({ adapterId, toolName, input, session: options.session });
          return {
            ok: true,
            tool_name: toolName,
            response: {
              status: "review_required",
              proposal_id: "wrp_cloud_1",
              source_database_mutated: false,
            },
          };
        },
      },
      cloudTools: [
        {
          name: "billing.propose_late_fee_waiver",
          title: "billing.propose_late_fee_waiver",
          description: "Cloud-reviewed proposal tool.",
          kind: "proposal",
          input_schema: {
            type: "object",
            required: ["invoice_id"],
            properties: { invoice_id: { type: "string" } },
          },
          annotations: { readOnlyHint: false, raw_sql_exposed: false },
        },
      ],
    });
    try {
      expect(runtime.listTools().map((tool) => tool.name)).toEqual(["billing.propose_late_fee_waiver"]);
      const result = await runtime.callTool("billing.propose_late_fee_waiver", { invoice_id: "INV-3001" });
      expect(result).toMatchObject({
        mode: "cloud",
        adapter_id: "mcp.billing",
        status: "review_required",
        source_database_mutated: false,
      });
      expect(calls).toEqual([
        {
          adapterId: "mcp.billing",
          toolName: "billing.propose_late_fee_waiver",
          input: { invoice_id: "INV-3001" },
          session: { tenant_id: "acme" },
        },
      ]);
      await expect(runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        tenant_id: "otherco",
      })).rejects.toMatchObject({ code: "MODEL_CANNOT_OVERRIDE_BINDING" });
    } finally {
      runtime.close();
    }
  });

  it("refuses unsafe HTTP MCP auth configurations", async () => {
    await expect(startHttpMcpServer({
      config,
      storePath: ":memory:",
      port: 0,
      env: {},
      log: false,
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    })).rejects.toMatchObject({ code: "HTTP_AUTH_TOKEN_MISSING" });

    await expect(startHttpMcpServer({
      config,
      storePath: ":memory:",
      host: "0.0.0.0",
      port: 0,
      env: {},
      devNoAuth: true,
      log: false,
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    })).rejects.toMatchObject({ code: "HTTP_DEV_NO_AUTH_UNSAFE_HOST" });

    await expect(startStreamableHttpMcpServer({
      config,
      storePath: ":memory:",
      port: 0,
      env: {},
      log: false,
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    })).rejects.toMatchObject({ code: "HTTP_AUTH_TOKEN_MISSING" });

    await expect(startStreamableHttpMcpServer({
      config,
      storePath: ":memory:",
      host: "0.0.0.0",
      port: 0,
      env: {},
      devNoAuth: true,
      log: false,
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    })).rejects.toMatchObject({ code: "HTTP_DEV_NO_AUTH_UNSAFE_HOST" });
  });

  it("serves authenticated HTTP MCP tools, calls, and resources without exposing secrets", async () => {
    const token = "test-http-token";
    const databaseUrl = "postgresql://reader:secret@db.example/app";
    const server = await startHttpMcpServer({
      config,
      storePath: ":memory:",
      port: 0,
      env: {
        SYNAPSOR_RUNNER_HTTP_TOKEN: token,
        APP_POSTGRES_READ_URL: databaseUrl,
      },
      log: false,
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    });
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(health.status).toBe(200);
      const healthPayload = await health.json() as Record<string, unknown>;
      expect(healthPayload).toMatchObject({
        ok: true,
        status: "live",
        transport: "http",
      });
      expect(healthPayload).not.toHaveProperty("tools");
      expect(healthPayload).not.toHaveProperty("mode");
      expect(JSON.stringify(healthPayload)).not.toContain(token);
      expect(JSON.stringify(healthPayload)).not.toContain(databaseUrl);

      const unauthorized = await httpRpc(server.port, undefined, "tools/list", {});
      expect(unauthorized.status).toBe(401);
      const wrongToken = await httpRpc(server.port, "wrong-token", "tools/list", {});
      expect(wrongToken.status).toBe(401);

      const listed = await httpRpc(server.port, token, "tools/list", {});
      expect(listed.status).toBe(200);
      const listedPayload = await listed.json() as { result: { tools: Array<{ name: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }> } };
      expect(listedPayload.result.tools.map((tool) => tool.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_late_fee_waiver",
      ]);
      const serializedTools = JSON.stringify(listedPayload);
      const modelFacingToolShape = JSON.stringify(listedPayload.result.tools.map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        description: tool.description,
      })));
      expect(modelFacingToolShape).not.toMatch(/execute_sql|raw_sql|approve|commit|writeback|database_url|write_credentials/i);
      expect(serializedTools).not.toContain(token);
      expect(serializedTools).not.toContain(databaseUrl);
      expect(listedPayload.result.tools.every((tool) => tool.annotations?.raw_sql_exposed === false)).toBe(true);
      expect(listedPayload.result.tools.every((tool) => tool._meta?.["synapsor.database_credentials_exposed"] === false)).toBe(true);

      const called = await httpRpc(server.port, token, "tools/call", {
        name: "billing.inspect_invoice",
        arguments: { invoice_id: "INV-3001" },
      });
      expect(called.status).toBe(200);
      const calledPayload = await called.json() as {
        result: {
          structuredContent: {
            status: string;
            source_database_mutated: boolean;
            evidence_resource: string;
            trusted_context: { tenant_id: string; principal: string };
          };
        };
      };
      expect(calledPayload.result.structuredContent).toMatchObject({
        status: "ok",
        source_database_mutated: false,
        trusted_context: { tenant_id: "acme", principal: "support_agent_17" },
      });

      const evidence = await httpRpc(server.port, token, "resources/read", {
        uri: calledPayload.result.structuredContent.evidence_resource,
      });
      expect(evidence.status).toBe(200);
      const evidencePayload = await evidence.json() as { result: { contents: Array<{ text: string }> } };
      expect(evidencePayload.result.contents[0]?.text).toContain("INV-3001");

      const override = await httpRpc(server.port, token, "tools/call", {
        name: "billing.inspect_invoice",
        arguments: { invoice_id: "INV-3001", tenant_id: "otherco" },
      });
      expect(override.status).toBe(200);
      const overrideText = await override.text();
      expect(overrideText).toContain("MODEL_CANNOT_OVERRIDE_BINDING");
      expect(overrideText).not.toContain(token);
      expect(overrideText).not.toContain(databaseUrl);
      expect(overrideText).not.toMatch(/postgresql:\/\/reader/);
    } finally {
      await server.close();
    }
  });

  it("keeps liveness dependency-free and reports readiness recovery on both HTTP transports", async () => {
    let ready = false;
    const readinessCheck = async () => ({
      ok: ready,
      status: ready ? "ready" as const : "not_ready" as const,
      components: [{ name: "source:app_postgres", ok: ready, code: ready ? "SOURCE_READY" : "SOURCE_UNAVAILABLE", latency_ms: 1 }],
    });
    for (const start of [startHttpMcpServer, startStreamableHttpMcpServer]) {
      ready = false;
      const server = await start({
        config,
        storePath: ":memory:",
        port: 0,
        devNoAuth: true,
        log: false,
        readinessCheck,
        readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
      });
      try {
        const health = await fetch(server.url.replace(/\/mcp$/, "/healthz"));
        expect(health.status).toBe(200);
        await expect(health.json()).resolves.toMatchObject({ ok: true, status: "live" });
        const unavailable = await fetch(server.url.replace(/\/mcp$/, "/readyz"));
        expect(unavailable.status).toBe(503);
        await expect(unavailable.json()).resolves.toEqual({
          ok: false,
          status: "not_ready",
          components: [{ name: "source:app_postgres", ok: false, code: "SOURCE_UNAVAILABLE", latency_ms: 1 }],
        });
        ready = true;
        const recovered = await fetch(server.url.replace(/\/mcp$/, "/readyz"));
        expect(recovered.status).toBe(200);
        await expect(recovered.json()).resolves.toMatchObject({ ok: true, status: "ready" });
      } finally {
        await server.close();
      }
    }
  });

  it("exposes bounded metrics only through the separately authorized endpoint", async () => {
    const metricsConfig = structuredClone(config);
    metricsConfig.metrics = { enabled: true, token_env: "SYNAPSOR_METRICS_TOKEN" };
    const mcpToken = "model-facing-token";
    const metricsToken = "operator-metrics-token";
    const server = await startHttpMcpServer({
      config: metricsConfig,
      storePath: ":memory:",
      port: 0,
      env: {
        SYNAPSOR_RUNNER_HTTP_TOKEN: mcpToken,
        SYNAPSOR_METRICS_TOKEN: metricsToken,
        APP_POSTGRES_READ_URL: "postgresql://reader:redacted@db.invalid/app",
      },
      log: false,
      readinessCheck: async () => ({ ok: true, status: "ready", components: [{ name: "config", ok: true, code: "CONFIG_READY", latency_ms: 0 }] }),
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    });
    try {
      await httpRpc(server.port, mcpToken, "tools/call", {
        name: "billing.propose_late_fee_waiver",
        arguments: { invoice_id: "INV-3001", reason: "reviewed customer request" },
      });
      expect((await fetch(`http://127.0.0.1:${server.port}/metrics`)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${server.port}/metrics`, {
        headers: { authorization: `Bearer ${mcpToken}` },
      })).status).toBe(401);
      const response = await fetch(`http://127.0.0.1:${server.port}/metrics`, {
        headers: { authorization: `Bearer ${metricsToken}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/openmetrics-text");
      const body = await response.text();
      expect(body).toContain("synapsor_ready 1");
      expect(body).toContain('synapsor_proposals_total{tenant="acme",capability="billing.propose_late_fee_waiver"} 1');
      expect(body).toContain("# EOF");
      expect(body).not.toContain("INV-3001");
      expect(body).not.toContain("support_agent_17");
      expect(body).not.toContain(metricsToken);
      expect(body).not.toContain(mcpToken);
    } finally {
      await server.close();
    }

    const unsafeConfig = structuredClone(config);
    unsafeConfig.metrics = { enabled: true };
    await expect(startHttpMcpServer({
      config: unsafeConfig,
      host: "0.0.0.0",
      port: 0,
      env: { SYNAPSOR_RUNNER_HTTP_TOKEN: mcpToken },
      log: false,
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    })).rejects.toMatchObject({ code: "METRICS_AUTH_REQUIRED" });
  });

  it("serves spec-compatible Streamable HTTP MCP sessions with the official client transport", async () => {
    const token = "test-streamable-http-token";
    const databaseUrl = "postgresql://reader:secret@db.example/app";
    const server = await startStreamableHttpMcpServer({
      config,
      storePath: ":memory:",
      port: 0,
      env: {
        SYNAPSOR_RUNNER_HTTP_TOKEN: token,
        APP_POSTGRES_READ_URL: databaseUrl,
      },
      log: false,
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    });
    const client = new Client({ name: "synapsor-runner-test", version: "0.0.0" });
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({
        ok: true,
        status: "live",
        transport: "streamable-http",
      });

      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_late_fee_waiver",
      ]);
      const serializedTools = JSON.stringify(listed.tools);
      const modelFacingToolShape = JSON.stringify(listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })));
      expect(modelFacingToolShape).not.toMatch(/execute_sql|raw_sql|approve|commit|writeback|database_url|write_credentials/i);
      expect(listed.tools.every((tool) => tool._meta?.["synapsor.raw_sql_exposed"] === false)).toBe(true);
      expect(listed.tools.every((tool) => tool._meta?.["synapsor.approval_tool"] === false)).toBe(true);
      expect(serializedTools).not.toContain(token);
      expect(serializedTools).not.toContain(databaseUrl);
      expect(transport.sessionId).toMatch(/\S+/);

      const result = await client.callTool({
        name: "billing.inspect_invoice",
        arguments: { invoice_id: "INV-3001" },
      });
      const structuredContent = result.structuredContent as {
        status: string;
        source_database_mutated: boolean;
        evidence_resource: string;
        trusted_context: { tenant_id: string; principal: string };
      };
      expect(structuredContent).toMatchObject({
        status: "ok",
        source_database_mutated: false,
        trusted_context: { tenant_id: "acme", principal: "support_agent_17" },
      });

      const evidence = await client.readResource({ uri: structuredContent.evidence_resource });
      const firstEvidenceContent = evidence.contents[0];
      expect(firstEvidenceContent && "text" in firstEvidenceContent ? firstEvidenceContent.text : "").toContain("INV-3001");
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(result)).not.toContain(databaseUrl);

      const proposalArgs = { invoice_id: "INV-3001", reason: "reviewed waiver" };
      const proposed = await client.callTool({
        name: "billing.propose_late_fee_waiver",
        arguments: proposalArgs,
      });
      expect(proposed.structuredContent).toMatchObject({ status: "review_required", source_database_mutated: false });
      const duplicate = await client.callTool({
        name: "billing.propose_late_fee_waiver",
        arguments: proposalArgs,
      });
      expect(duplicate.structuredContent).toMatchObject({
        ok: false,
        code: "PROPOSAL_ALREADY_EXISTS",
      });
      expect(JSON.stringify(duplicate)).not.toContain(databaseUrl);
    } finally {
      await client.close().catch(() => undefined);
      await server.close();
    }
  });

  it("binds signed trusted context independently to each Streamable HTTP session", async () => {
    const secret = "a-production-length-session-secret-32-bytes-minimum";
    const sessionConfig = structuredClone(config);
    sessionConfig.trusted_context = {
      provider: "http_claims",
      values: { tenant_id_key: "tenant_id", principal_key: "sub" },
    };
    sessionConfig.session_auth = {
      provider: "jwt_hs256",
      secret_env: "SYNAPSOR_SESSION_JWT_SECRET",
      issuer: "https://identity.example",
      audience: "synapsor-runner",
    };
    const seen: Array<{ tenant_id: string; principal: string }> = [];
    const server = await startStreamableHttpMcpServer({
      config: sessionConfig,
      storePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-session-context-")), "local.db"),
      port: 0,
      env: { SYNAPSOR_SESSION_JWT_SECRET: secret },
      log: false,
      readRow: async ({ args, context }) => {
        seen.push({ tenant_id: context.tenant_id, principal: context.principal });
        return {
          row: { ...fixtureRow, id: args.invoice_id, tenant_id: context.tenant_id },
          rowCount: 1,
        };
      },
    });
    const expires = Math.floor(Date.now() / 1000) + 600;
    const acmeToken = signedSessionToken(secret, { sub: "alice", tenant_id: "acme", iss: "https://identity.example", aud: "synapsor-runner", exp: expires });
    const globexToken = signedSessionToken(secret, { sub: "bob", tenant_id: "globex", iss: "https://identity.example", aud: "synapsor-runner", exp: expires });
    const acmeOtherToken = signedSessionToken(secret, { sub: "mallory", tenant_id: "acme", iss: "https://identity.example", aud: "synapsor-runner", exp: expires });
    const acmeTransport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${acmeToken}` } } });
    const globexTransport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${globexToken}` } } });
    const acmeOtherTransport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${acmeOtherToken}` } } });
    const acmeClient = new Client({ name: "acme-agent", version: "0.0.0" });
    const globexClient = new Client({ name: "globex-agent", version: "0.0.0" });
    const acmeOtherClient = new Client({ name: "acme-other-agent", version: "0.0.0" });
    try {
      await acmeClient.connect(acmeTransport);
      const acme = await acmeClient.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-A" } });
      expect(acme.structuredContent).toMatchObject({ trusted_context: { tenant_id: "acme", principal: "alice", provenance: "http_claims" } });
      const acmeEvidenceUri = String((acme.structuredContent as Record<string, unknown>).evidence_resource);

      const mismatch = await fetch(server.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${globexToken}`,
          "content-type": "application/json",
          "mcp-session-id": acmeTransport.sessionId!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
      });
      expect(mismatch.status).toBe(401);
      await expect(mismatch.json()).resolves.toMatchObject({ error: "session_auth_mismatch" });

      await globexClient.connect(globexTransport);
      const globex = await globexClient.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-B" } });
      expect(globex.structuredContent).toMatchObject({ trusted_context: { tenant_id: "globex", principal: "bob", provenance: "http_claims" } });
      await expect(globexClient.readResource({ uri: acmeEvidenceUri })).rejects.toThrow(/Synapsor resource not found/i);

      await acmeOtherClient.connect(acmeOtherTransport);
      await expect(acmeOtherClient.readResource({ uri: acmeEvidenceUri })).rejects.toThrow(/Synapsor resource not found/i);
      expect(seen).toEqual([
        { tenant_id: "acme", principal: "alice" },
        { tenant_id: "globex", principal: "bob" },
      ]);
    } finally {
      await acmeClient.close().catch(() => undefined);
      await globexClient.close().catch(() => undefined);
      await acmeOtherClient.close().catch(() => undefined);
      await server.close();
    }
  });

  it("refuses claims-authenticated serving when a capability resolves an environment context", async () => {
    const secret = "a-production-length-session-secret-32-bytes-minimum";
    const mismatched = structuredClone(config);
    mismatched.trusted_context = {
      provider: "http_claims",
      values: { tenant_id_key: "tenant_id", principal_key: "sub" },
    };
    mismatched.contexts = {
      legacy_operator: {
        provider: "environment",
        values: { tenant_id_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
      },
    };
    mismatched.capabilities = mismatched.capabilities?.map((capability) => ({
      ...capability,
      context: "legacy_operator",
    }));
    mismatched.session_auth = {
      provider: "jwt_hs256",
      secret_env: "SYNAPSOR_SESSION_JWT_SECRET",
      issuer: "https://identity.example",
      audience: "synapsor-runner",
    };

    await expect(startStreamableHttpMcpServer({
      config: mismatched,
      port: 0,
      env: {
        SYNAPSOR_SESSION_JWT_SECRET: secret,
        SYNAPSOR_TENANT_ID: "tenant_A",
        SYNAPSOR_PRINCIPAL: "legacy-agent",
      },
      log: false,
    })).rejects.toThrow(/TRUSTED_CONTEXT_PROVIDER_CONFLICT/);
  });

  it("accepts active and previous JWT secrets during Streamable HTTP session rotation", async () => {
    const activeSecret = "active-production-length-session-secret-32-bytes";
    const previousSecret = "previous-production-length-session-secret-32-bytes";
    const sessionConfig = structuredClone(config);
    sessionConfig.trusted_context = {
      provider: "http_claims",
      values: { tenant_id_key: "tenant_id", principal_key: "sub" },
    };
    sessionConfig.session_auth = {
      provider: "jwt_hs256",
      secret_env: "SYNAPSOR_SESSION_JWT_SECRET",
      previous_secret_env: "SYNAPSOR_PREVIOUS_SESSION_JWT_SECRET",
      issuer: "https://identity.example",
      audience: "synapsor-runner",
    };
    const server = await startStreamableHttpMcpServer({
      config: sessionConfig,
      storePath: ":memory:",
      port: 0,
      env: {
        SYNAPSOR_SESSION_JWT_SECRET: activeSecret,
        SYNAPSOR_PREVIOUS_SESSION_JWT_SECRET: previousSecret,
      },
      log: false,
      readRow: async ({ args, context }) => ({
        row: { ...fixtureRow, id: args.invoice_id, tenant_id: context.tenant_id },
        rowCount: 1,
      }),
    });
    const expires = Math.floor(Date.now() / 1000) + 600;
    const activeToken = signedSessionToken(activeSecret, { sub: "alice", tenant_id: "acme", iss: "https://identity.example", aud: "synapsor-runner", exp: expires });
    const previousToken = signedSessionToken(previousSecret, { sub: "bob", tenant_id: "globex", iss: "https://identity.example", aud: "synapsor-runner", exp: expires });
    const staleTransport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${previousToken}` } } });
    const activeTransport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${activeToken}` } } });
    const staleClient = new Client({ name: "previous-secret-agent", version: "0.0.0" });
    const activeClient = new Client({ name: "active-secret-agent", version: "0.0.0" });
    try {
      await staleClient.connect(staleTransport);
      await activeClient.connect(activeTransport);
      const staleResult = await staleClient.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-OLD" } });
      const activeResult = await activeClient.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-NEW" } });
      expect(staleResult.structuredContent).toMatchObject({ trusted_context: { tenant_id: "globex", principal: "bob", provenance: "http_claims" } });
      expect(activeResult.structuredContent).toMatchObject({ trusted_context: { tenant_id: "acme", principal: "alice", provenance: "http_claims" } });
    } finally {
      await staleClient.close().catch(() => undefined);
      await activeClient.close().catch(() => undefined);
      await server.close();
    }
  });

  it("binds Streamable HTTP context from an RS256 JWKS session", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...await exportJWK(publicKey), kid: "runner-session-1", alg: "RS256", use: "sig" };
    const jwksServer = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    const jwksAddress = jwksServer.address();
    if (!jwksAddress || typeof jwksAddress === "string") throw new Error("JWKS server did not bind");
    const sessionConfig = structuredClone(config);
    sessionConfig.trusted_context = {
      provider: "http_claims",
      values: { tenant_id_key: "tenant_id", principal_key: "sub" },
    };
    sessionConfig.session_auth = {
      provider: "jwt_asymmetric",
      algorithms: ["RS256"],
      jwks_url_env: "SYNAPSOR_SESSION_JWKS_URL",
      issuer: "https://identity.example",
      audience: "synapsor-runner",
      fetch_timeout_ms: 1000,
      max_response_bytes: 8192,
    };
    const server = await startStreamableHttpMcpServer({
      config: sessionConfig,
      storePath: ":memory:",
      port: 0,
      env: { SYNAPSOR_SESSION_JWKS_URL: `http://127.0.0.1:${jwksAddress.port}/jwks` },
      log: false,
      readRow: async ({ args, context }) => ({
        row: { ...fixtureRow, id: args.invoice_id, tenant_id: context.tenant_id },
        rowCount: 1,
      }),
    });
    const token = await new SignJWT({ tenant_id: "globex" })
      .setProtectedHeader({ alg: "RS256", kid: "runner-session-1" })
      .setSubject("jwks-agent")
      .setIssuer("https://identity.example")
      .setAudience("synapsor-runner")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(privateKey);
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const client = new Client({ name: "jwks-agent", version: "0.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "billing.inspect_invoice", arguments: { invoice_id: "INV-JWKS" } });
      expect(result.structuredContent).toMatchObject({ trusted_context: { tenant_id: "globex", principal: "jwks-agent", provenance: "http_claims" } });
    } finally {
      await client.close().catch(() => undefined);
      await server.close();
      await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    }
  });

  it("requires client certificates when Streamable HTTP mTLS is enabled", async () => {
    const certs = generateMtlsFixture();
    const token = "test-mtls-token";
    const server = await startStreamableHttpMcpServer({
      config,
      storePath: ":memory:",
      port: 0,
      env: { SYNAPSOR_RUNNER_HTTP_TOKEN: token },
      log: false,
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
      tls: {
        cert: certs.serverCert,
        key: certs.serverKey,
        ca: certs.ca,
        requestClientCert: true,
      },
    });
    try {
      const healthzUrl = server.url.replace(/\/mcp$/, "/healthz");
      await expect(httpsJson(healthzUrl, { ca: certs.ca })).rejects.toThrow();
      await expect(httpsJson(healthzUrl, {
        ca: certs.ca,
        cert: certs.clientCert,
        key: certs.clientKey,
      })).resolves.toMatchObject({ ok: true, transport: "streamable-http" });
    } finally {
      await server.close();
    }
  });

  it("can expose OpenAI-safe Streamable HTTP tool aliases while preserving canonical names", async () => {
    expect(openaiToolNameAlias("billing.inspect_invoice")).toBe("billing__inspect_invoice");
    const token = "test-openai-alias-token";
    const server = await startStreamableHttpMcpServer({
      config,
      storePath: ":memory:",
      toolNameStyle: "openai",
      port: 0,
      env: {
        SYNAPSOR_RUNNER_HTTP_TOKEN: token,
      },
      log: false,
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    });
    const client = new Client({ name: "synapsor-runner-openai-alias-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "billing__inspect_invoice",
        "billing__propose_late_fee_waiver",
      ]);
      expect(listed.tools.every((tool) => /^[A-Za-z0-9_-]{1,64}$/.test(tool.name))).toBe(true);
      expect(listed.tools[0]?._meta?.["synapsor.canonical_tool_name"]).toBe("billing.inspect_invoice");
      expect(listed.tools[0]?._meta?.["synapsor.tool_name_style"]).toBe("openai");

      const result = await client.callTool({
        name: "billing__inspect_invoice",
        arguments: { invoice_id: "INV-3001" },
      });
      expect(result.structuredContent).toMatchObject({
        status: "ok",
        source_database_mutated: false,
        action: "billing.inspect_invoice",
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.close();
    }
  });

  it("can expose canonical and OpenAI-safe aliases together", async () => {
    const token = "test-both-alias-token";
    const server = await startStreamableHttpMcpServer({
      config,
      storePath: ":memory:",
      toolNameStyle: "both",
      port: 0,
      env: {
        SYNAPSOR_RUNNER_HTTP_TOKEN: token,
      },
      log: false,
      readRow: async () => ({ row: fixtureRow, rowCount: 1 }),
    });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    });
    const client = new Client({ name: "synapsor-runner-both-alias-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "billing.inspect_invoice",
        "billing__inspect_invoice",
        "billing.propose_late_fee_waiver",
        "billing__propose_late_fee_waiver",
      ]);

      const canonical = await client.callTool({
        name: "billing.inspect_invoice",
        arguments: { invoice_id: "INV-3001" },
      });
      const alias = await client.callTool({
        name: "billing__inspect_invoice",
        arguments: { invoice_id: "INV-3001" },
      });
      expect(canonical.structuredContent).toMatchObject({ action: "billing.inspect_invoice" });
      expect(alias.structuredContent).toMatchObject({ action: "billing.inspect_invoice" });
    } finally {
      await client.close().catch(() => undefined);
      await server.close();
    }
  });
});

function signedSessionToken(secret: string, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function generateMtlsFixture(): { ca: string; serverCert: string; serverKey: string; clientCert: string; clientKey: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-mtls-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=Synapsor Test CA", "-keyout", "ca.key", "-out", "ca.crt"]);
  fs.writeFileSync(path.join(dir, "server.ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n");
  run(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", "server.key", "-out", "server.csr"]);
  run(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "1", "-sha256", "-extfile", "server.ext"]);
  fs.writeFileSync(path.join(dir, "client.ext"), "extendedKeyUsage=clientAuth\n");
  run(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=synapsor-test-client", "-keyout", "client.key", "-out", "client.csr"]);
  run(["x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client.crt", "-days", "1", "-sha256", "-extfile", "client.ext"]);
  return {
    ca: fs.readFileSync(path.join(dir, "ca.crt"), "utf8"),
    serverCert: fs.readFileSync(path.join(dir, "server.crt"), "utf8"),
    serverKey: fs.readFileSync(path.join(dir, "server.key"), "utf8"),
    clientCert: fs.readFileSync(path.join(dir, "client.crt"), "utf8"),
    clientKey: fs.readFileSync(path.join(dir, "client.key"), "utf8"),
  };
}

function httpsJson(url: string, options: RequestOptions): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}

function httpRpc(
  port: number,
  token: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

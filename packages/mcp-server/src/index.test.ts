import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createMcpRuntime,
  createSynapsorMcpServer,
  loadRuntimeConfigFromFile,
  McpRuntimeError,
  openaiToolNameAlias,
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

describe("local Synapsor MCP runtime", () => {
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
        const proposal = runtime.store.getProposal(String(result.proposal_id));
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
          expect(runtime.store.events(String(result.proposal_id))).toEqual(expect.arrayContaining([
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

  it("returns a semantic duplicate error and permits a successor after conflict", async () => {
    let reads = 0;
    const runtime = createMcpRuntime({ ...config, result_format: 2 }, {
      readRow: async () => {
        reads += 1;
        return { row: fixtureRow, rowCount: 1 };
      },
    });
    try {
      const args = { invoice_id: "INV-3001", reason: "approved support waiver" };
      const first = await runtime.callTool("billing.propose_late_fee_waiver", args);
      const duplicate = await runtime.callTool("billing.propose_late_fee_waiver", args);
      const existing = runtime.store.listProposals()[0];
      if (!existing) throw new Error("proposal fixture missing");
      expect(duplicate).toMatchObject({
        ok: false,
        error: {
          code: "PROPOSAL_ALREADY_EXISTS",
          retryable: false,
          message: expect.stringContaining(existing.proposal_id),
        },
      });
      expect(runtime.store.listProposals()).toHaveLength(1);
      expect(reads).toBe(2);

      runtime.store.db.prepare("UPDATE proposals SET state = 'conflict' WHERE proposal_id = ?").run(existing.proposal_id);
      const successor = await runtime.callTool("billing.propose_late_fee_waiver", args);
      expect(first).toMatchObject({ ok: true });
      expect(successor).toMatchObject({ ok: true });
      expect(runtime.store.listProposals()).toHaveLength(2);
      expect(runtime.store.getProposal(existing.proposal_id)?.state).toBe("conflict");
    } finally {
      runtime.close();
    }
  });

  it("returns safe result envelope v2 errors without raw infra strings", async () => {
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
    } finally {
      runtime.close();
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
      expect(() => runtime.readResource("synapsor://evidence/ev_missing")).toThrow(/local Synapsor store is temporarily unavailable/i);
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
      const evidence = runtime.readResource(String(result.evidence_resource));
      expect(evidence).toMatchObject({
        evidence_bundle_id: result.evidence_bundle_id,
        tenant_id: "acme",
      });
    } finally {
      runtime.close();
    }
  });

  it("creates an exact proposal without mutating the source and exposes proposal/replay resources", async () => {
    const runtime = createMcpRuntime(config, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
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

      const proposal = runtime.readResource(String(result.proposal_resource));
      expect(proposal).toHaveProperty("proposal");
      expect((proposal.proposal as { state: string }).state).toBe("pending_review");

      const replay = runtime.readResource(String(result.replay_resource));
      expect(replay).toHaveProperty("replay_id", result.replay_resource?.toString().replace("synapsor://replay/", ""));
    } finally {
      runtime.close();
    }
  });

  it("auto-approves proposals under the reviewed approval policy threshold", async () => {
    const runtime = createMcpRuntime(autoApprovalConfig(), { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
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
      const proposal = runtime.store.getProposal(String(result.proposal_id));
      expect(proposal?.state).toBe("approved");
      expect(runtime.store.events(String(result.proposal_id))).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "proposal_approved",
          actor: "policy:billing_propose_late_fee_waiver_auto_approval",
        }),
      ]));
      expect(() => runtime.store.approveProposal(String(result.proposal_id), {
        approver: "support_lead",
        proposal_hash: String(result.proposal_hash),
        proposal_version: Number(result.proposal_version),
      })).toThrow(/PROPOSAL_NOT_PENDING_REVIEW|is approved/);
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
      expect(runtime.store.getProposal(String(result.proposal_id))?.state).toBe("pending_review");
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
      expect(runtime.store.getProposal(String(result.proposal_id))?.state).toBe("pending_review");
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
      expect(runtime.store.events(String(result.proposal_id)).some((event) => event.actor.startsWith("policy:"))).toBe(false);
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
    const runtime = createMcpRuntime({ ...config, mode: "shadow" }, { readRow: async () => ({ row: fixtureRow, rowCount: 1 }) });
    try {
      const result = await runtime.callTool("billing.propose_late_fee_waiver", {
        invoice_id: "INV-3001",
        reason: "approved support waiver",
      });
      expect(result.status).toBe("shadow_proposal_created");
      expect(result.source_database_mutated).toBe(false);

      const proposalResource = runtime.readResource(String(result.proposal_resource));
      const proposal = proposalResource.proposal as { proposal_id: string; change_set: { mode: string }; source_database_mutated: boolean };
      expect(proposal.change_set.mode).toBe("shadow");
      expect(proposal.source_database_mutated).toBe(false);
      expect(() => runtime.store.approveProposal(proposal.proposal_id, {
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
        transport: "http",
        tools: 2,
        mode: "review",
      });
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
        transport: "streamable-http",
        tools: 2,
        mode: "review",
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

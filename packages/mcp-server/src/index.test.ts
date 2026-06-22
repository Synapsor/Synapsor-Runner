import { describe, expect, it } from "vitest";
import { createMcpRuntime, createSynapsorMcpServer, McpRuntimeError, type RuntimeConfig } from "./index.js";

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

describe("local Synapsor MCP runtime", () => {
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
});

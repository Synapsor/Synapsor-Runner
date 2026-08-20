import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkbenchAskMcpGateway } from "./ask-mcp-gateway.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Workbench Ask MCP gateway", () => {
  it("treats an empty named-runtime surface as valid instead of calling an unsupported tools/list", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-empty-gateway-"));
    tempDirs.push(root);
    const configPath = path.join(root, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: ":memory:" },
      sources: {
        source: {
          engine: "postgres",
          read_url_env: "ASK_TEST_DATABASE_URL",
        },
      },
      trusted_context: {
        provider: "static_dev",
        values: { tenant_id: "acme", principal: "alice" },
      },
      capabilities: [],
    }, null, 2));

    const gateway = await createWorkbenchAskMcpGateway({
      configPath,
      storePath: ":memory:",
      projectRoot: root,
      env: {},
    });
    try {
      expect(await gateway.listTools()).toEqual([]);
      expect(await gateway.callTool("app.explore_data", {})).toMatchObject({
        ok: false,
        error_code: "ASK_UNKNOWN_TOOL",
        value: {
          source_database_changed: false,
        },
      });
    } finally {
      await gateway.close();
    }
  });

  it("lists only the actual model-facing runtime tools and preserves MCP argument refusal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-gateway-"));
    tempDirs.push(root);
    const configPath = path.join(root, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: ":memory:" },
      sources: {
        source: {
          engine: "postgres",
          read_url_env: "ASK_TEST_DATABASE_URL",
        },
      },
      trusted_context: {
        provider: "static_dev",
        values: { tenant_id: "acme", principal: "alice" },
      },
      capabilities: [{
        name: "support.inspect_ticket",
        kind: "read",
        source: "source",
        target: {
          schema: "public",
          table: "tickets",
          primary_key: "id",
          tenant_key: "tenant_id",
        },
        args: {
          ticket_id: { type: "string", required: true },
        },
        lookup: { id_from_arg: "ticket_id" },
        visible_columns: ["id", "status"],
        max_rows: 1,
      }],
    }, null, 2));

    const gateway = await createWorkbenchAskMcpGateway({
      configPath,
      storePath: ":memory:",
      projectRoot: root,
      env: {},
    });
    try {
      const listed = await gateway.listTools();
      expect(listed.map((tool) => tool.name)).toEqual(["support.inspect_ticket"]);
      expect(listed[0]?.metadata).toMatchObject({
        "synapsor.approval_tool": false,
      });
      expect(listed[0]?.metadata?.["synapsor.commit_tool"]).not.toBe(true);

      const invalid = await gateway.callTool("support.inspect_ticket", {});
      expect(invalid).toMatchObject({
        ok: false,
        error_code: "MCP_TOOL_ARGUMENTS_INVALID",
        value: {
          error_code: "MCP_TOOL_ARGUMENTS_INVALID",
          source_database_changed: false,
        },
      });
      expect(String(invalid.value.message)).toContain("declared input schema");

      const unknown = await gateway.callTool("synapsor.approve", {});
      expect(unknown).toMatchObject({
        ok: false,
        error_code: "ASK_UNKNOWN_TOOL",
        value: {
          source_database_changed: false,
        },
      });
    } finally {
      await gateway.close();
    }
  });

  it("exposes a proposal-only Safe Action without agent approval, apply, executor, or identity controls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-action-gateway-"));
    tempDirs.push(root);
    const configPath = path.join(root, "synapsor.actions.runner.json");
    const storePath = path.join(root, "action-ledger.db");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: storePath },
      sources: {
        source: {
          engine: "postgres",
          read_url_env: "ASK_TEST_DATABASE_URL",
          read_only: true,
        },
      },
      trusted_context: {
        provider: "static_dev",
        values: { tenant_id: "acme", principal: "alice" },
      },
      capabilities: [{
        name: "credits.propose_credit",
        kind: "proposal",
        source: "source",
        target: {
          schema: "public",
          table: "credits",
          primary_key: "id",
          tenant_key: "tenant_id",
        },
        args: {
          amount_cents: { type: "number", required: true, minimum: 1, maximum: 2500 },
        },
        lookup: { id_from_arg: "amount_cents" },
        visible_columns: ["id", "tenant_id", "request_id", "amount_cents"],
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
        approval: { mode: "human", required_role: "finance_reviewer" },
        writeback: { mode: "none" },
      }],
    }, null, 2));

    const gateway = await createWorkbenchAskMcpGateway({
      configPath,
      storePath,
      projectRoot: root,
      env: {},
      mode: "runtime",
    });
    let proposalId = "";
    try {
      const tools = await gateway.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["credits.propose_credit"]);
      expect(Object.keys(tools[0]!.input_schema)).toEqual(["type", "properties", "required", "additionalProperties", "$schema"]);
      expect(JSON.stringify(tools[0]!.input_schema)).not.toMatch(/approve|apply|activate|execute_sql|raw_sql|tenant_id|principal|writeback|executor|credential/i);
      expect(tools[0]!.metadata).toMatchObject({
        "synapsor.raw_sql_exposed": false,
        "synapsor.approval_tool": false,
      });
      const result = await gateway.callTool("credits.propose_credit", { amount_cents: 500 });
      expect(result).toMatchObject({
        ok: true,
        value: {
          status: "review_required",
          source_database_mutated: false,
        },
      });
      proposalId = String(result.value.proposal_id);
      expect(proposalId).toMatch(/^wrp_/);

      await expect(gateway.callTool("synapsor.approve", { proposal_id: proposalId }))
        .resolves.toMatchObject({ ok: false, error_code: "ASK_UNKNOWN_TOOL" });
      await expect(gateway.callTool("synapsor.apply", { proposal_id: proposalId }))
        .resolves.toMatchObject({ ok: false, error_code: "ASK_UNKNOWN_TOOL" });
    } finally {
      await gateway.close();
    }

    const store = new ProposalStore(storePath);
    try {
      expect(store.getProposal(proposalId)).toMatchObject({
        state: "pending_review",
        tenant_id: "acme",
        principal: "alice",
        source_database_mutated: false,
        change_set: {
          scope: { tenant_id: "acme" },
          writeback: { mode: "read_only", executor: "none" },
        },
      });
    } finally {
      store.close();
    }
  }, 30_000);
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary, writeAutoBoundaryArtifacts, explorationBoundaryCandidateDigest, activateExplorationBoundary } from "./auto-boundary.js";
import { createScopedExploreRuntime } from "./scoped-explore.js";
import { createWorkbenchAskMcpGateway } from "./ask-mcp-gateway.js";

// All isolated roots/evidence remain. No SOURCE database or provider connection.
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-reclassified-"));
  const inspection = churnInspection();
  const build = buildAutoBoundary({ inspection, project: { root, package_manager: "pnpm", frameworks: ["nextjs", "prisma"], schema_inputs: [], database_env_names: ["DATABASE_URL"] }, sourceEnv: "DATABASE_URL" });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  const candidate = structuredClone(build.exploration_boundary);
  const digest = explorationBoundaryCandidateDigest(candidate);
  await activateExplorationBoundary({ projectRoot: root, candidate, expectedDigest: digest, actor: "reviewer@example.test", confirmation: `ACTIVATE ${digest}`, confirmedDecisions: candidate.unresolved_decisions, currentInspection: inspection });
  return { root, inspection, env: { DATABASE_URL: "postgresql://unused.example.test/synapsor", SYNAPSOR_TENANT_ID: "tenant-acme", SYNAPSOR_PRINCIPAL: "pm-1" } };
}
it.each([
  [undefined, "connection timed out password=private-value postgres://private-host/private-db", "database failure; cause unavailable"],
  [undefined, "column does not exist token=private-value mysql://private-host/private-db", "database failure; cause unavailable"],
  ["UNKNOWN_CODE", "unknown table schema connection", "database failure; cause unavailable"],
  ["ETIMEDOUT", "column does not exist private-value", "temporary database connection or timeout failure"],
  ["ECONNREFUSED", "privee private-value", "temporary database connection or timeout failure"],
  ["42P01", "connection timed out private-value", "reviewed schema no longer matches the source"],
  ["ER_NO_SUCH_TABLE", "privee private-value", "reviewed schema no longer matches the source"],
] as const)("source-query cause follows typed code %s rather than prose %s", async (code, message, diagnostic) => {
  const f = await fixture(); const failure = Object.assign(new Error(message), code ? { code } : {});
  const executeBatch = vi.fn(async () => { throw failure; });
  const runtime = await createScopedExploreRuntime({ projectRoot: f.root, transport: "stdio", env: f.env, inspectDatabaseFn: async () => f.inspection,
    executor: { execute: async () => { throw failure; }, executeBatch, close: async () => undefined } });
  try {
    let error: unknown; try { await runtime.explore({ kind: "rows", resource: "public.subscriptions", select: ["region"], limit: 1 }); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: "EXPLORE_SOURCE_UNAVAILABLE", message: `Scoped Explore source query failed: ${diagnostic}` });
    expect(String(error)).not.toMatch(/private-value|private-host|private-db|password=|token=/);
    expect(executeBatch).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});
async function gateway() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-wire-reclassified-"));
  const configPath = path.join(root, "synapsor.runner.json");
  await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: "read_only", storage: { sqlite_path: ":memory:" },
    sources: { source: { engine: "postgres", read_url_env: "ASK_TEST_DATABASE_URL" } },
    trusted_context: { provider: "static_dev", values: { tenant_id: "acme", principal: "alice" } },
    capabilities: [{ name: "support.inspect_ticket", kind: "read", source: "source", target: { schema: "public", table: "tickets", primary_key: "id", tenant_key: "tenant_id" },
      args: { ticket_id: { type: "string", required: true } }, lookup: { id_from_arg: "ticket_id" }, visible_columns: ["id", "status"], max_rows: 1 }] }));
  return createWorkbenchAskMcpGateway({ configPath, storePath: ":memory:", projectRoot: root, env: {} });
}
it.each(["Input validation error: Invalid arguments for tool private-value", "別のエラー private-value"])("vendor prose cannot manufacture an invalidarguments decision: %s", async text => {
  const g = await gateway(); const call = vi.spyOn(Client.prototype, "callTool").mockResolvedValue({ isError: true, content: [{ type: "text", text }] });
  try { const r = await g.callTool("support.inspect_ticket", { ticket_id: "ticket-1" });
    expect(r).toMatchObject({ ok: false, error_code: "MCP_TOOL_REFUSED", value: { source_database_changed: false } });
    expect(JSON.stringify(r)).not.toContain("private-value");expect(call).toHaveBeenCalledOnce();
  } finally { call.mockRestore(); await g.close(); }
});
it("actual typed MCP validation result keeps invalidargument code independent of prose", async () => {
  const g = await gateway(); const call = vi.spyOn(Client.prototype, "callTool").mockResolvedValue({ isError: true, content: [], structuredContent: { ok: false, error_code: "MCP_TOOL_ARGUMENTS_INVALID", message: "Typed validation refused.", source_database_changed: false } });
  try { expect(await g.callTool("support.inspect_ticket", {})).toMatchObject({ ok: false, error_code: "MCP_TOOL_ARGUMENTS_INVALID" }); }
  finally { call.mockRestore(); await g.close(); }
});
it.each([true, false])("thrown protocol cause uses actual InvalidParams only: %s", async invalid => {
  const g = await gateway(); const failure = invalid ? new McpError(ErrorCode.InvalidParams, "private-value") : new Error("Input validation error: Invalid arguments for tool private-value");
  const call = vi.spyOn(Client.prototype, "callTool").mockRejectedValue(failure);
  try { const r = await g.callTool("support.inspect_ticket", {});expect(r).toMatchObject({ ok: false, error_code: invalid ? "MCP_TOOL_ARGUMENTS_INVALID" : "MCP_TOOL_FAILED", value: { source_database_changed: false } });expect(JSON.stringify(r)).not.toContain("private-value"); }
  finally { call.mockRestore(); await g.close(); }
});
it("actual SDK prose-only input refusal is honestly unknown and never reaches SOURCE", async () => {
  const g = await gateway();try { expect(await g.callTool("support.inspect_ticket", {})).toMatchObject({ ok: false, error_code: "MCP_TOOL_REFUSED", value: { source_database_changed: false } }); }
  finally { await g.close(); }
});
function churnInspection(): SchemaInspection {
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16",
    current_user: "app_reader",
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    inspected_at: "2026-07-22T00:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    tables: [{
      schema: "public",
      name: "subscriptions",
      type: "table",
      writable: true,
      columns: [
        column("id", "uuid", { immutable: true }),
        column("tenant_id", "uuid", { tenant: true, immutable: true }),
        column("region", "text"),
        column("reason_category", "text"),
        column("churned_at", "timestamp with time zone"),
        column("monthly_revenue_cents", "integer"),
        column("billing_token", "text", { sensitive: true }),
      ],
      primary_key: ["id"],
      unique_constraints: [{ name: "subscriptions_pkey", columns: ["id"] }],
      foreign_keys: [],
      indexes: [{ name: "subscriptions_pkey", columns: ["id"], unique: true }],
      row_level_security: true,
      row_level_security_policies: [{
        name: "tenant_read",
        command: "SELECT",
        permissive: true,
        roles: ["app_reader"],
        using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
      }],
      role_posture: {
        owner: "app_owner",
        current_role_is_owner: false,
        current_role_can_assume_owner: false,
        row_security_forced: true,
        row_security_effective_for_current_role: true,
        privileges: {
          select: true,
          insert: false,
          update: false,
          delete: false,
          truncate: false,
          references: false,
          trigger: false,
        },
      },
      suggestions: {
        tenant_columns: ["tenant_id"],
        conflict_columns: [],
        sensitive_columns: ["billing_token"],
        default_visible_columns: ["id", "tenant_id", "region", "reason_category", "churned_at", "monthly_revenue_cents"],
      },
    }],
  };
}

function column(
  name: string,
  dataType: string,
  overrides: Partial<{ tenant: boolean; sensitive: boolean; immutable: boolean }> = {},
) {
  return {
    name,
    data_type: dataType,
    nullable: false,
    generated: false,
    ordinal_position: 1,
    suggestions: {
      tenant: overrides.tenant ?? false,
      conflict: false,
      sensitive: overrides.sensitive ?? false,
      immutable: overrides.immutable ?? false,
      large_or_binary: false,
    },
  };
}


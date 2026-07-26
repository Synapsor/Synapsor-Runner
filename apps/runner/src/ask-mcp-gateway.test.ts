import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
        error_code: "MCP_TOOL_REFUSED",
        value: {
          source_database_changed: false,
        },
      });

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
});

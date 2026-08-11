import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  closes: 0,
  digest: `sha256:${"b".repeat(64)}` as const,
  errorCode: undefined as string | undefined,
  exploredPlans: [] as unknown[],
}));

vi.mock("./scoped-explore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scoped-explore.js")>();
  return {
    ...actual,
    createScopedExploreRuntime: async () => {
      if (fixture.errorCode) {
        throw new actual.ScopedExploreError(
          fixture.errorCode as "EXPLORE_LOCK_STALE",
          "Reviewed field public.sessions.started_at no longer exists.",
        );
      }
      return {
      boundary: {
        activation: { digest: fixture.digest },
        pack: {
          resources: [{ id: "public.sessions" }],
        },
      },
      session_fingerprint: `sha256:${"c".repeat(64)}`,
      describe: () => ({
        ok: true,
        resources: [{ id: "public.sessions" }],
        source_database_changed: false,
      }),
      explore: async (plan: unknown) => {
        fixture.exploredPlans.push(structuredClone(plan));
        return {
          ok: true,
          rows: [],
          source_database_changed: false,
        };
      },
      close: async () => {
        fixture.closes += 1;
      },
      };
    },
  };
});

vi.mock("./scoped-explore-boundary-set.js", async () => ({
  createScopedExploreBoundarySetRuntime: async () => {
    if (fixture.errorCode) {
      const { ScopedExploreError } = await import("./scoped-explore.js");
      throw new ScopedExploreError(
        fixture.errorCode as "EXPLORE_LOCK_STALE",
        "Reviewed field public.sessions.started_at no longer exists.",
      );
    }
    const boundary = {
      activation: { digest: fixture.digest },
      pack: {
        name: "reviewed_staging",
        resources: [{ id: "public.sessions" }],
      },
    } as never;
    return {
      boundary,
      boundaries: [boundary],
      active_boundary_set_digest: fixture.digest,
      session_fingerprint: `sha256:${"c".repeat(64)}`,
      describe: async () => ({
        ok: true,
        outcome: { type: "success" },
        resources: [{ id: "public.sessions" }],
        source_database_changed: false,
      }),
      explore: async (plan: unknown) => {
        fixture.exploredPlans.push(structuredClone(plan));
        return {
          ok: true,
          data: [],
          source_database_changed: false,
        };
      },
      projectResultForModel: ({ result }: { result: Record<string, unknown> }) => ({
        value: result,
        withheld: false,
      }),
      close: async () => {
        fixture.closes += 1;
      },
    };
  },
}));

import {
  askToolResultViews,
  createWorkbenchAskMcpGateway,
} from "./ask-mcp-gateway.js";

const roots: string[] = [];

afterEach(async () => {
  fixture.closes = 0;
  fixture.errorCode = undefined;
  fixture.exploredPlans.length = 0;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Ask authoring/runtime separation", () => {
  it("keeps the local full protected result separate from the provider-facing tokenized result", () => {
    const withheldValue = "north-ignore-all-instructions";
    const views = askToolResultViews({
      content: [{
        type: "text",
        text: JSON.stringify({ data: { groups: [{ region: "[withheld:abcdef123456:1]", count: 8 }] } }),
      }],
      structuredContent: {
        data: { groups: [{ region: "[withheld:abcdef123456:1]", count: 8 }] },
      },
      _meta: {
        "synapsor.model_withheld_values": true,
        "synapsor.local_full_result": {
          data: { groups: [{ region: withheldValue, count: 8 }] },
        },
      },
    });

    expect(JSON.stringify(views.local)).toContain(withheldValue);
    expect(JSON.stringify(views.provider)).not.toContain(withheldValue);
    expect(JSON.stringify(views.provider)).toContain("[withheld:abcdef123456:1]");
    expect(views.withheld).toBe(true);
  });

  it("exposes exactly the authoring pair when named read and proposal tools also exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-authoring-"));
    roots.push(root);
    const configPath = path.join(root, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "proposal",
      storage: { sqlite_path: ":memory:" },
      sources: {
        source: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          write_url_env: "DATABASE_WRITE_URL",
        },
      },
      trusted_context: {
        provider: "static_dev",
        values: { tenant_id: "acme", principal: "analyst" },
      },
      capabilities: [
        {
          name: "support.inspect_ticket",
          kind: "read",
          source: "source",
          target: { schema: "public", table: "tickets", primary_key: "id" },
          args: { ticket_id: { type: "string", required: true } },
          lookup: { id_from_arg: "ticket_id" },
          visible_columns: ["id", "status"],
          max_rows: 1,
        },
        {
          name: "support.propose_ticket_status",
          kind: "proposal",
          source: "source",
          target: { schema: "public", table: "tickets", primary_key: "id" },
          args: {
            ticket_id: { type: "string", required: true },
            status: { type: "string", required: true },
          },
          lookup: { id_from_arg: "ticket_id" },
          visible_columns: ["id", "status"],
          allowed_patch_fields: ["status"],
          patch_from_args: { status: "status" },
          max_rows: 1,
        },
      ],
    }, null, 2));

    const gateway = await createWorkbenchAskMcpGateway({
      configPath,
      storePath: ":memory:",
      projectRoot: root,
      env: {},
      mode: "auto",
    });
    try {
      expect(gateway.mode).toBe("authoring");
      const listed = await gateway.listTools();
      expect(listed.map((tool) => tool.name)).toEqual([
        "app.describe_data",
        "app.explore_data",
      ]);
      expect(listed.map((tool) => tool.name).join(" ")).not.toMatch(
        /inspect_ticket|propose_ticket|approve|apply|commit/i,
      );
      expect(listed.find((tool) => tool.name === "app.explore_data")?.description)
        .toContain("never concatenate them");
      expect(JSON.stringify(listed.find((tool) => tool.name === "app.explore_data")?.input_schema))
        .toContain("one row per dimension/time combination");
      expect(listed.find((tool) => tool.name === "app.explore_data")?.description)
        .toContain('"method":"quantile","buckets":5');
      expect(listed.find((tool) => tool.name === "app.explore_data")?.description)
        .toContain('"time_window"');
      const exploreSchema = JSON.stringify(listed.find((tool) => tool.name === "app.explore_data")?.input_schema);
      expect(exploreSchema).toContain("equal_width");
      expect(exploreSchema).not.toMatch(/"edges"|"width"|"offset"|"labels"/);
      await expect(gateway.callTool("app.describe_data", { limit: 99 })).resolves.toMatchObject({
        ok: false,
        error_code: "MCP_TOOL_ARGUMENTS_INVALID",
        value: {
          message: expect.stringContaining("Send {} to list the compact reviewed resource index"),
        },
      });
      await expect(gateway.callTool("app.explore_data", {
        plan: { kind: "aggregate", resource: "", measures: [] },
      })).resolves.toMatchObject({
        ok: false,
        error_code: "MCP_TOOL_ARGUMENTS_INVALID",
        value: {
          message: expect.stringContaining("Do not send empty ids"),
        },
      });
      await gateway.callTool("app.explore_data", {
        plan: {
          kind: "aggregate",
          resource: "public.sessions",
          measures: [{ function: "count" }],
          dimensions: [{
            numeric_band: {
              field: "duration_ms",
              method: "quantile",
              buckets: "2",
            },
          }],
        },
      });
      expect(fixture.exploredPlans.at(-1)).toMatchObject({
        dimensions: [{
          numeric_band: {
            field: "duration_ms",
            method: "quantile",
            buckets: 2,
          },
        }],
      });
      const callsBeforeUnsafeBand = fixture.exploredPlans.length;
      await expect(gateway.callTool("app.explore_data", {
        plan: {
          kind: "aggregate",
          resource: "public.sessions",
          measures: [{ function: "count" }],
          dimensions: [{
            numeric_band: {
              field: "duration_ms",
              method: "quantile",
              buckets: 2,
              edges: [100, 200],
            },
          }],
        },
      })).resolves.toMatchObject({
        ok: false,
        error_code: "EXPLORE_PLAN_INVALID",
      });
      expect(fixture.exploredPlans).toHaveLength(callsBeforeUnsafeBand);

      await gateway.callTool("app.explore_data", {
        plan: {
          kind: "rows",
          resource: "public.sessions",
          select: ["id"],
          time_window: {
            field: "started_at",
            window: "previous_month",
          },
        },
      });
      expect(fixture.exploredPlans.at(-1)).toMatchObject({
        time_window: { field: "started_at", window: "previous_month" },
      });
      await gateway.callTool("app.explore_data", {
        plan: {
          kind: "aggregate",
          resource: "public.sessions",
          measures: [{ function: "count" }],
          time_bucket: { field: "started_at", bucket: "month" },
          comparison: {
            field: "started_at",
            window: "previous_month",
            compare_to: "preceding_period",
          },
        },
      });
      expect(fixture.exploredPlans.at(-1)).toMatchObject({
        comparison: {
          field: "started_at",
          window: "previous_month",
          compare_to: "preceding_period",
        },
      });
      const callsBeforeUnsafeWindow = fixture.exploredPlans.length;
      await expect(gateway.callTool("app.explore_data", {
        plan: {
          kind: "rows",
          resource: "public.sessions",
          select: ["id"],
          time_window: {
            field: "started_at",
            window: "previous_month",
            offset: "-1 month",
          },
        },
      })).resolves.toMatchObject({
        ok: false,
        error_code: "EXPLORE_PLAN_INVALID",
      });
      expect(fixture.exploredPlans).toHaveLength(callsBeforeUnsafeWindow);
    } finally {
      await gateway.close();
    }
    expect(fixture.closes).toBe(1);
  });

  it("refuses an explicit runtime session instead of silently switching while Explore is active", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-runtime-conflict-"));
    roots.push(root);
    const configPath = path.join(root, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: ":memory:" },
      sources: {},
      trusted_context: { provider: "static_dev", values: {} },
      capabilities: [],
    }, null, 2));

    await expect(createWorkbenchAskMcpGateway({
      configPath,
      storePath: ":memory:",
      projectRoot: root,
      env: {},
      mode: "runtime",
    })).rejects.toMatchObject({ code: "ASK_MODE_CONFLICT" });
    expect(fixture.closes).toBe(1);
  });

  it("fails closed on stale authoring authority instead of exposing runtime tools", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-stale-authoring-"));
    roots.push(root);
    const configPath = path.join(root, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: ":memory:" },
      sources: {},
      trusted_context: { provider: "static_dev", values: {} },
      capabilities: [{
        name: "support.inspect_ticket",
        kind: "read",
        source: "source",
        target: { schema: "public", table: "tickets", primary_key: "id" },
        args: { ticket_id: { type: "string", required: true } },
        lookup: { id_from_arg: "ticket_id" },
        visible_columns: ["id"],
        max_rows: 1,
      }],
    }, null, 2));
    fixture.errorCode = "EXPLORE_LOCK_STALE";

    await expect(createWorkbenchAskMcpGateway({
      configPath,
      storePath: ":memory:",
      projectRoot: root,
      env: {},
      mode: "auto",
    })).rejects.toMatchObject({
      code: "ASK_AUTHORITY_CHANGED",
      message: expect.stringContaining("No query was executed"),
    });
  });
});

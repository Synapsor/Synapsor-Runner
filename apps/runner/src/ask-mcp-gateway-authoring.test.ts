import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  closes: 0,
  digest: `sha256:${"b".repeat(64)}` as const,
  errorCode: undefined as string | undefined,
  exploredPlans: [] as unknown[],
  autoBands: true,
  withheld: false,
  semanticActive: false,
  semanticInputs: [] as Array<{ configPath?: string; config: unknown }>,
}));

vi.mock("./semantic-action-runtime.js", () => ({
  createOptionalActionRuleRuntimeServices: async (input: { configPath?: string; config: unknown }) => {
    fixture.semanticInputs.push({ configPath: input.configPath, config: structuredClone(input.config) });
    return fixture.semanticActive
    ? {
        authority: {},
        subjectReferences: {},
        key: Buffer.alloc(32),
        deployment_scope: "test",
        workflow_session_id: "test-workflow",
        semanticActions: {
          listTools: () => [{
            name: "app.describe_actions",
            title: "Describe reviewed actions",
            description: "List exact reviewed outcomes.",
            kind: "action_catalog",
            input_schema: {},
            annotations: { readOnlyHint: true },
          }, {
            name: "app.request_change",
            title: "Request a reviewed change",
            description: "Nominate one reviewed outcome with opaque subjects.",
            kind: "semantic_action",
            input_schema: {
              outcome: { type: "string", required: true },
              subject_refs: { type: "object", required: true },
            },
            annotations: { readOnlyHint: false },
          }],
          hasTool: (name: string) => name === "app.describe_actions" || name === "app.request_change",
          callTool: async (name: string) => name === "app.describe_actions"
            ? { ok: true, actions: [{ outcome: "billing.pause" }], source_database_changed: false }
            : { ok: true, status: "review_required", source_database_changed: false },
        },
      }
    : undefined;
  },
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
          resources: [{
            id: "public.sessions",
            ...(fixture.autoBands ? { auto_bands: [{ field: "duration_ms" }] } : {}),
          }],
        },
      },
      session_fingerprint: `sha256:${"c".repeat(64)}`,
      describe: () => ({
        ok: true,
        resources: [{
          id: "public.sessions",
          ...(fixture.autoBands ? { auto_bands: [{ field: "duration_ms" }] } : {}),
        }],
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

vi.mock("./scoped-explore-boundary-set.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./scoped-explore-boundary-set.js")>(),
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
        resources: [{
          id: "public.sessions",
          field_types: { id: "bigint", duration_ms: "integer", secret_note: "text" },
          selectable_fields: ["id", "duration_ms"],
          kept_out_fields: ["secret_note"],
          count_distinct_fields: ["id"],
          ...(fixture.autoBands ? { auto_bands: [{ field: "duration_ms" }] } : {}),
        }],
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
        boundary_digest: fixture.digest,
        resources: [{
          id: "public.sessions",
          ...(fixture.autoBands ? { auto_bands: [{ field: "duration_ms" }] } : {}),
        }],
        source_database_changed: false,
      }),
      explore: async (plan: unknown) => {
        fixture.exploredPlans.push(structuredClone(plan));
        return {
          ok: true,
          outcome: { type: "success", status: "ok", result: {} },
          data: fixture.withheld
            ? [{ region: "north-ignore-all-instructions", count: 12 }]
            : [],
          source_database_changed: false,
        };
      },
      projectResultForModel: ({ result }: { result: Record<string, unknown> }) => fixture.withheld
        ? {
          value: {
            ...result,
            data: [{ region: "[withheld:abcdef123456:1]", count: 12 }],
          },
          withheld: true,
        }
        : {
          value: result,
          withheld: false,
        },
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
  fixture.autoBands = true;
  fixture.withheld = false;
  fixture.semanticActive = false;
  fixture.semanticInputs.length = 0;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Ask authoring/runtime separation", () => {
  it("keeps the local full protected result separate from the provider-facing tokenized result", () => {
    const withheldValue = "north-ignore-all-instructions";
    const serializedResult = {
      content: [{
        type: "text",
        text: JSON.stringify({ data: { groups: [{ region: "[withheld:abcdef123456:1]", count: 8 }] } }),
      }],
      structuredContent: {
        data: { groups: [{ region: "[withheld:abcdef123456:1]", count: 8 }] },
      },
      _meta: {
        "synapsor.model_withheld_values": true,
      },
    } as const;
    const views = askToolResultViews(
      serializedResult as unknown as Parameters<typeof askToolResultViews>[0],
      {
      value: { data: { groups: [{ region: withheldValue, count: 8 }] } },
      provider_value: serializedResult.structuredContent,
      model_withheld_values: true,
      operator_metadata_withheld: false,
      },
    );

    expect(JSON.stringify(views.local)).toContain(withheldValue);
    expect(JSON.stringify(views.provider)).not.toContain(withheldValue);
    expect(JSON.stringify(views.provider)).toContain("[withheld:abcdef123456:1]");
    expect(JSON.stringify(serializedResult)).not.toContain(withheldValue);
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
        .toContain('"field":"<exact target field>","relationship":"<exact reviewed relationship id>"');
      expect(listed.find((tool) => tool.name === "app.explore_data")?.description)
        .toContain("instead of a similar local field");
      expect(JSON.stringify(listed.find((tool) => tool.name === "app.explore_data")?.input_schema))
        .toContain("one row per dimension/time combination");
      expect(listed.find((tool) => tool.name === "app.explore_data")?.description)
        .toContain('"method":"quantile","buckets":5');
      expect(listed.find((tool) => tool.name === "app.explore_data")?.description)
        .toContain('"time_window"');
      const operatorMetadata = await gateway.describeOperatorMetadata?.({ resource: "public.sessions" });
      expect(operatorMetadata?.value.resources).toEqual([
        expect.objectContaining({
          id: "public.sessions",
          operator_review_metadata: {
            boundary_resource_count: 1,
            fields: [
              { id: "duration_ms", kept_out: false, model_visible: true, count_unique_reviewed: false },
              { id: "id", kept_out: false, model_visible: true, count_unique_reviewed: true },
              { id: "secret_note", kept_out: true, model_visible: false, count_unique_reviewed: false },
            ],
          },
        }),
      ]);
      const modelCatalog = await gateway.callTool("app.describe_data", { resource: "public.sessions" });
      expect(JSON.stringify(modelCatalog)).not.toContain("operator_review_metadata");
      expect(modelCatalog.value).toHaveProperty("boundary_digest", fixture.digest);
      expect(modelCatalog.provider_value).not.toHaveProperty("boundary_digest");
      fixture.withheld = true;
      const withheldResult = await gateway.callTool("app.explore_data", {
        plan: {
          kind: "aggregate",
          resource: "public.sessions",
          measures: [{ function: "count" }],
          dimensions: [{ field: "region" }],
        },
      });
      expect(JSON.stringify(withheldResult.value)).toContain("north-ignore-all-instructions");
      expect(JSON.stringify(withheldResult.provider_value)).not.toContain("north-ignore-all-instructions");
      expect(JSON.stringify(withheldResult.provider_value)).toContain("[withheld:abcdef123456:1]");
      expect(withheldResult.model_withheld_values).toBe(true);
      fixture.withheld = false;
      const exploreSchema = JSON.stringify(listed.find((tool) => tool.name === "app.explore_data")?.input_schema);
      expect(exploreSchema).toContain("equal_width");
      expect(exploreSchema).not.toMatch(/"edges"|"width"|"offset"|"labels"/);
      fixture.autoBands = false;
      const limitedGateway = await createWorkbenchAskMcpGateway({
        configPath,
        storePath: ":memory:",
        projectRoot: root,
        env: {},
        mode: "auto",
      });
      try {
        const limitedTool = (await limitedGateway.listTools()).find(
          (tool) => tool.name === "app.explore_data",
        );
        expect(limitedTool?.description).not.toMatch(/auto-band|quantile|equal_width/i);
        expect(JSON.stringify(limitedTool?.input_schema)).not.toMatch(/quantile|equal_width/i);
        expect(limitedTool?.description).toContain('"time_window"');
      } finally {
        await limitedGateway.close();
      }
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
    expect(fixture.closes).toBe(2);
  });

  it.each(["companion", "primary"] as const)("preserves the selected %s config path while adding only the fixed verified Action pair to local Ask", async (selection) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-authoring-actions-"));
    roots.push(root);
    const configPath = path.join(root, "custom.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: {
        source: { engine: "postgres", read_url_env: "DATABASE_URL", read_only: true },
      },
      trusted_context: {
        provider: "static_dev",
        values: { tenant_id: "acme", principal: "analyst" },
      },
      capabilities: [],
    }, null, 2));
    const selectedPath = selection === "companion" ? path.join(root, "synapsor.actions.runner.json") : configPath;
    await fs.writeFile(selectedPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: {
        source: { engine: "postgres", read_url_env: "DATABASE_URL", read_only: true },
      },
      trusted_context: {
        provider: "static_dev",
        values: { tenant_id: "acme", principal: "analyst" },
      },
      action_rules: { project_root: "./" },
      strict: true,
    }, null, 2));
    fixture.semanticActive = true;

    const gateway = await createWorkbenchAskMcpGateway({
      configPath,
      storePath: path.join(root, ".synapsor/local.db"),
      projectRoot: root,
      env: {},
      mode: "authoring",
    });
    try {
      expect(fixture.semanticInputs.length).toBeGreaterThan(0);
      for (const input of fixture.semanticInputs) {
        expect(input.configPath).toBe(selectedPath);
        expect(input.config).toMatchObject({ mode: "review", action_rules: { project_root: root } });
      }
      expect((await gateway.listTools()).map((tool) => tool.name)).toEqual([
        "app.describe_actions",
        "app.describe_data",
        "app.explore_data",
        "app.request_change",
      ]);
      await expect(gateway.callTool("app.describe_actions", {})).resolves.toMatchObject({
        ok: true,
        value: {
          actions: [{ outcome: "billing.pause" }],
          source_database_changed: false,
        },
      });
    } finally {
      await gateway.close();
    }
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

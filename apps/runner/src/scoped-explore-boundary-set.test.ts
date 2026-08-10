import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { describe, expect, it, vi } from "vitest";
import { createScopedExploreMcpServer } from "./authoring-mcp.js";
import type { ActivatedExplorationBoundary } from "./auto-boundary.js";
import {
  createScopedExploreBoundarySetRuntime,
  selectActiveExploreBoundary,
  type ScopedExploreBoundarySetRuntime,
} from "./scoped-explore-boundary-set.js";
import type { ScopedExploreRuntime } from "./scoped-explore.js";

describe("Scoped Explore active boundary routing", () => {
  const boundaries = [
    boundary("support", ["public.tickets", "public.accounts"]),
    boundary("finance", ["public.invoices", "public.accounts"]),
  ];

  it("routes a uniquely owned resource without requiring model-visible ceremony", () => {
    expect(selectActiveExploreBoundary(boundaries, undefined, "public.tickets").pack.name)
      .toBe("support");
  });

  it("requires an exact active boundary when reviewed resource aliases overlap", () => {
    expect(() => selectActiveExploreBoundary(boundaries, undefined, "public.accounts"))
      .toThrowError(expect.objectContaining({
        code: "EXPLORE_BOUNDARY_REQUIRED",
        details: expect.objectContaining({ active_boundaries: ["finance", "support"] }),
      }));
    expect(selectActiveExploreBoundary(boundaries, "finance", "public.accounts").pack.name)
      .toBe("finance");
  });

  it("resolves display labels and bare table names only when they identify one reviewed resource", () => {
    expect(selectActiveExploreBoundary(boundaries, undefined, "Tickets").pack.name)
      .toBe("support");
    expect(selectActiveExploreBoundary(boundaries, undefined, "INVOICES").pack.name)
      .toBe("finance");
    expect(selectActiveExploreBoundary(boundaries, "finance", "accounts").pack.name)
      .toBe("finance");

    const overlappingTables = [
      boundary("support", ["crm.accounts"]),
      boundary("finance", ["billing.accounts"]),
    ];
    expect(() => selectActiveExploreBoundary(overlappingTables, undefined, "Accounts"))
      .toThrowError(expect.objectContaining({
        code: "EXPLORE_BOUNDARY_REQUIRED",
        message: expect.stringContaining("billing.accounts [finance]"),
        details: expect.objectContaining({
          reviewed_candidates: [
            { boundary: "finance", resource: "billing.accounts" },
            { boundary: "support", resource: "crm.accounts" },
          ],
        }),
      }));
  });

  it("returns bounded valid resource ids and a nearest reviewed suggestion", () => {
    expect(() => selectActiveExploreBoundary(boundaries, undefined, "subscrptions"))
      .toThrowError(expect.objectContaining({
        code: "EXPLORE_RESOURCE_FORBIDDEN",
        message: expect.stringContaining("Valid reviewed resources:"),
        details: expect.objectContaining({
          valid_resources: expect.arrayContaining([
            { boundary: "finance", resource: "public.invoices" },
            { boundary: "support", resource: "public.tickets" },
          ]),
        }),
      }));
    expect(() => selectActiveExploreBoundary(
      [boundary("billing", ["public.subscriptions"])],
      undefined,
      "subscrptions",
    )).toThrowError(expect.objectContaining({
      message: expect.stringContaining("Did you mean public.subscriptions in boundary billing?"),
    }));
  });

  it("does not turn reviewer-authored labels into resource authority aliases", () => {
    const labeled = boundary("finance", ["public.invoices"]);
    labeled.pack.resources[0]!.label = "Quarterly revenue ledger";

    expect(selectActiveExploreBoundary([labeled], undefined, "invoices").pack.name)
      .toBe("finance");
    expect(() => selectActiveExploreBoundary(
      [labeled],
      undefined,
      "Quarterly revenue ledger",
    )).toThrowError(expect.objectContaining({
      code: "EXPLORE_RESOURCE_FORBIDDEN",
      details: expect.objectContaining({
        valid_resources: [{ boundary: "finance", resource: "public.invoices" }],
      }),
    }));
  });

  it("refuses unknown boundaries and resources instead of widening or combining authority", () => {
    expect(() => selectActiveExploreBoundary(boundaries, "unknown", "public.tickets"))
      .toThrowError(expect.objectContaining({ code: "EXPLORE_BOUNDARY_FORBIDDEN" }));
    expect(() => selectActiveExploreBoundary(boundaries, "finance", "public.tickets"))
      .toThrowError(expect.objectContaining({ code: "EXPLORE_RESOURCE_FORBIDDEN" }));
    expect(() => selectActiveExploreBoundary(boundaries, undefined, "public.users"))
      .toThrowError(expect.objectContaining({ code: "EXPLORE_RESOURCE_FORBIDDEN" }));
  });

  it("reports one path-free recovery action when no reviewed boundary is active", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-no-active-boundary-"));
    try {
      const error = await createScopedExploreBoundarySetRuntime({
        projectRoot,
        transport: "stdio",
      }).catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        code: "EXPLORE_DISABLED",
        message: "No reviewed analytics access is active. Run `synapsor-runner start` and complete the local data-access review.",
      });
      expect(String(error)).not.toContain(projectRoot);
      expect(String(error)).not.toContain("ENOENT");
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("discovers an additively activated boundary through one live runtime without reconnecting", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-live-boundary-set-"));
    const support = validBoundary("support", ["public.tickets"]);
    const finance = validBoundary("finance", ["public.invoices"]);
    const exploredPlans: unknown[] = [];
    const runtimeFactory = vi.fn(async (input: { boundaryName?: string }) => {
      const selected = [support, finance].find((candidate) => candidate.pack.name === input.boundaryName)!;
      return fakeChildRuntime(selected, (plan) => exploredPlans.push(plan));
    });
    try {
      await writeActiveSet(projectRoot, [support], "support");
      const runtime = await createScopedExploreBoundarySetRuntime({
        projectRoot,
        transport: "stdio",
        runtimeFactory: runtimeFactory as never,
      });
      try {
        await expect(runtime.describe({ limit: 10 })).resolves.toMatchObject({
          boundaries: [{ name: "support" }],
          resources: [{ id: "public.tickets", boundary_name: "support" }],
        });

        await writeActiveSet(projectRoot, [support, finance], "finance");
        await expect(runtime.describe({ limit: 10 })).resolves.toMatchObject({
          boundaries: [{ name: "finance" }, { name: "support" }],
          resources: expect.arrayContaining([
            expect.objectContaining({ id: "public.tickets", boundary_name: "support" }),
            expect.objectContaining({ id: "public.invoices", boundary_name: "finance" }),
          ]),
        });
        await expect(runtime.explore({ kind: "rows", resource: "public.tickets" }))
          .resolves.toMatchObject({ boundary_name: "support" });
        await expect(runtime.explore(
          { kind: "rows", resource: "Invoices" },
          "finance",
        )).resolves.toMatchObject({ boundary_name: "finance" });
        expect(exploredPlans.at(-1)).toMatchObject({ resource: "public.invoices" });
        await expect(runtime.describe({ resource: "Tickets" })).resolves.toMatchObject({
          resources: [{ id: "public.tickets", boundary_name: "support" }],
        });
        expect(runtimeFactory).toHaveBeenCalledWith(expect.objectContaining({ boundaryName: "support" }));
        expect(runtimeFactory).toHaveBeenCalledWith(expect.objectContaining({ boundaryName: "finance" }));
      } finally {
        await runtime.close();
      }
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps the production MCP surface at two read-only tools and routes an explicit reviewed boundary", async () => {
    const support = validBoundary("support", ["public.tickets"]);
    const finance = validBoundary("finance", ["public.invoices"]);
    const explore = vi.fn(async (_plan: Record<string, unknown>, _boundary?: string) => ({
      ok: true,
      outcome: { type: "success" },
      boundary_name: "finance",
      data: [],
      source_database_changed: false,
    }));
    const describe = vi.fn(async () => ({
      ok: true,
      boundaries: [{ name: "finance" }, { name: "support" }],
      resources: [],
      source_database_changed: false,
    }));
    const runtime = {
      boundary: finance,
      boundaries: [support, finance],
      active_boundary_set_digest: `sha256:${"4".repeat(64)}`,
      session_fingerprint: `sha256:${"3".repeat(64)}`,
      describe,
      explore,
      projectResultForModel: ({ result }: { result: Record<string, unknown> }) => ({
        value: result,
        withheld: false,
      }),
      close: async () => undefined,
    } as ScopedExploreBoundarySetRuntime;
    const server = createScopedExploreMcpServer(runtime, { mode: "production_http" });
    const client = new Client({ name: "boundary-set-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "app.describe_data",
        "app.explore_data",
      ]);
      expect(tools.tools.every((tool) =>
        tool._meta?.["synapsor.production_explore"] === true
        && tool._meta?.["synapsor.authoring_only"] === false
        && tool._meta?.["synapsor.raw_sql_exposed"] === false
        && tool._meta?.["synapsor.approval_tool"] === false
        && tool._meta?.["synapsor.commit_tool"] === false))
        .toBe(true);
      expect(tools.tools.every((tool) =>
        !Object.hasOwn(tool._meta ?? {}, "synapsor.boundary_set_digest")
        && !Object.hasOwn(tool._meta ?? {}, "synapsor.boundary_digest")))
        .toBe(true);
      const exploreTool = tools.tools.find((tool) => tool.name === "app.explore_data")!;
      expect(exploreTool.description).toContain("kind is exactly rows or aggregate");
      expect(exploreTool.description).toContain('"plan":{"kind":"aggregate"');
      expect(exploreTool.description).toContain('"plan":{"kind":"rows"');
      expect(exploreTool.description).toContain("<exact resource id>");
      expect(exploreTool.description).not.toContain("public.invoices");
      expect(exploreTool.inputSchema).toMatchObject({
        properties: {
          boundary: expect.objectContaining({
            type: "string",
            pattern: "^(?:[a-z][a-z0-9_.-]{0,63})?$",
          }),
          plan: expect.any(Object),
        },
        required: ["plan"],
        additionalProperties: false,
      });
      expect(tools.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/activate|create|approve|apply/i),
      ]));
      await client.callTool({
        name: "app.describe_data",
        arguments: { boundary: null, resource: null, cursor: null, limit: null },
      });
      expect(describe).toHaveBeenLastCalledWith({});
      await client.callTool({
        name: "app.explore_data",
        arguments: {
          boundary: "finance",
          plan: {
            kind: "rows",
            resource: "public.invoices",
            select: ["id"],
            limit: 1,
          },
        },
      });
      expect(explore).toHaveBeenCalledWith(expect.objectContaining({
        resource: "public.invoices",
      }), "finance");

      const beforeNullFilter = explore.mock.calls.length;
      const nullFilter = await client.callTool({
        name: "app.explore_data",
        arguments: {
          boundary: null,
          plan: {
            kind: "aggregate",
            resource: "public.invoices",
            relationship: null,
            measures: [{ function: "count", field: null, relationship: null }],
            dimensions: [{ field: "status", relationship: null }],
            time_bucket: null,
            where: [{ field: "status", op: "eq", value: null, relationship: null }],
            order_by: null,
            top_n: 10,
            comparison: null,
          },
        },
      });
      expect(nullFilter.isError).toBe(true);
      expect(explore).toHaveBeenCalledTimes(beforeNullFilter);

      await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "aggregate",
            resource: "public.invoices",
            measures: [{ function: "count" }],
            dimensions: null,
            time_bucket: {
              field: "created_at",
              bucket: "month",
              relationship: null,
            },
            where: null,
            top_n: 10,
            comparison: {
              field: "created_at",
              relationship: null,
              ranges: [
                { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
                { start: "2026-07-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
              ],
            },
          },
        },
      });
      expect(explore).toHaveBeenLastCalledWith(expect.objectContaining({
        time_bucket: { field: "created_at", bucket: "month" },
        comparison: expect.objectContaining({ field: "created_at" }),
      }), undefined);

      const beforeCoercedAggregate = explore.mock.calls.length;
      await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "aggregate",
            resource: "public.invoices",
            measures: JSON.stringify([{ function: "sum", field: "amount_cents" }]),
            dimensions: JSON.stringify([{ field: "status" }]),
            where: JSON.stringify([{ field: "status", op: "eq", value: "open" }]),
            order_by: JSON.stringify({ kind: "measure", index: "0", direction: "desc" }),
            top_n: "25",
          },
        },
      });
      expect(explore).toHaveBeenCalledTimes(beforeCoercedAggregate + 1);
      expect(explore).toHaveBeenLastCalledWith({
        kind: "aggregate",
        resource: "public.invoices",
        measures: [{ function: "sum", field: "amount_cents" }],
        dimensions: [{ field: "status" }],
        where: [{ field: "status", op: "eq", value: "open" }],
        order_by: { kind: "measure", index: 0, direction: "desc" },
        top_n: 25,
      }, undefined);

      const beforeCoercedRows = explore.mock.calls.length;
      await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "rows",
            resource: "public.invoices",
            select: JSON.stringify(["id", "status"]),
            order_by: JSON.stringify([{ field: "status", direction: "asc" }]),
            limit: "100",
          },
        },
      });
      expect(explore).toHaveBeenCalledTimes(beforeCoercedRows + 1);
      expect(explore).toHaveBeenLastCalledWith({
        kind: "rows",
        resource: "public.invoices",
        select: ["id", "status"],
        order_by: [{ field: "status", direction: "asc" }],
        limit: 100,
      }, undefined);

      const flatPlan = await client.callTool({
        name: "app.explore_data",
        arguments: {
          boundary: "finance",
          kind: "aggregate",
          resource: "public.invoices",
          measures: [{ function: "count" }],
          top_n: "25",
        },
      });
      expect(flatPlan.isError).toBe(true);

      const callCount = explore.mock.calls.length;
      const requiredResourceNull = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "rows",
            resource: null,
            select: ["id"],
            limit: 1,
          },
        },
      });
      const requiredKindNull = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: null,
            resource: "public.invoices",
            select: ["id"],
            limit: 1,
          },
        },
      });
      await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "aggregate",
            resource: "public.invoices",
            measures: [{ function: "count" }],
            top_n: null,
          },
        },
      });
      await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "rows",
            resource: "public.invoices",
            select: ["id"],
            limit: null,
          },
        },
      });
      const unknownKey = await client.callTool({
        name: "app.describe_data",
        arguments: { hallucinated_scope: null },
      });
      const unknownFlatKey = await client.callTool({
        name: "app.explore_data",
        arguments: {
          kind: "aggregate",
          resource: "public.invoices",
          measures: [{ function: "count" }],
          top_n: 25,
          tenant: "model-selected-tenant",
        },
      });
      const malformedContainer = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "rows",
            resource: "public.invoices",
            select: "not-json",
            limit: "1",
          },
        },
      });
      const invalidKind = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "plan",
            resource: "public.invoices",
            measures: [{ function: "count" }],
            top_n: 25,
          },
        },
      });
      expect(requiredResourceNull.isError).toBe(true);
      expect(requiredKindNull.isError).toBe(true);
      expect(unknownKey.isError).toBe(true);
      expect(unknownFlatKey.isError).toBe(true);
      expect(malformedContainer.isError).toBe(true);
      expect(invalidKind.isError).toBe(true);
      const invalidKindContent = invalidKind.content as Array<{ type: string; text?: string }>;
      const invalidKindText = invalidKindContent.find((entry) => entry.type === "text")?.text ?? "";
      expect(invalidKindText).toContain("plan.kind must be exactly rows or aggregate");
      expect(invalidKindText).toContain('{\\"plan\\":{\\"kind\\":\\"aggregate\\"');
      expect(explore).toHaveBeenCalledTimes(callCount + 2);
      expect(explore.mock.calls.slice(-2).map(([plan]) => plan)).toEqual([
        {
          kind: "aggregate",
          resource: "public.invoices",
          measures: [{ function: "count" }],
        },
        {
          kind: "rows",
          resource: "public.invoices",
          select: ["id"],
        },
      ]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});

function boundary(name: string, resources: string[]): ActivatedExplorationBoundary {
  return {
    pack: {
      name,
      resources: resources.map((id) => ({ id, tenant_key: "tenant_id" })),
    },
  } as unknown as ActivatedExplorationBoundary;
}

function validBoundary(name: string, resources: string[]): ActivatedExplorationBoundary {
  const authority = {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "reviewed",
    deployment_profile: "staging",
    source: "DATABASE_URL",
    compiler_version: "test",
    spec_version: "test",
    trusted_context: {
      provider: "environment" as const,
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
    },
    generation_lock_fingerprint: `sha256:${"1".repeat(64)}`,
    role_posture_fingerprint: `sha256:${"2".repeat(64)}`,
    pack: {
      name,
      resources: resources.map((id) => ({ id, tenant_key: "tenant_id" })),
    },
    budgets: {},
  };
  const digest = canonicalJsonDigest(authority);
  return {
    ...authority,
    activation: {
      state: "active",
      digest,
      actor: "test",
      activated_at: "2026-07-31T00:00:00.000Z",
      generation_lock_fingerprint: authority.generation_lock_fingerprint,
      reviewed_decisions: [],
    },
  } as unknown as ActivatedExplorationBoundary;
}

function fakeChildRuntime(
  boundary: ActivatedExplorationBoundary,
  onExplore?: (plan: unknown) => void,
): ScopedExploreRuntime {
  return {
    boundary,
    session_fingerprint: `sha256:${"3".repeat(64)}`,
    trusted_scope: {
      tenant: { source: "environment", binding: "SYNAPSOR_TENANT_ID" },
      principal: { source: "not_required" },
    },
    describe: async ({ resource, cursor = 0, limit = 10 } = {}) => {
      const resources = boundary.pack.resources
        .filter((candidate) => !resource || candidate.id === resource)
        .map((candidate) => ({ id: candidate.id }));
      const page = resources.slice(cursor, cursor + limit);
      return {
        ok: true,
        resources: page,
        next_cursor: cursor + page.length < resources.length ? cursor + page.length : null,
        source_database_changed: false,
      };
    },
    explore: async (plan) => {
      onExplore?.(plan);
      return {
        ok: true,
        outcome: { type: "success" },
        data: [],
        source_database_changed: false,
      };
    },
    close: async () => undefined,
  } as ScopedExploreRuntime;
}

async function writeActiveSet(
  projectRoot: string,
  boundaries: ActivatedExplorationBoundary[],
  selectedName: string,
): Promise<void> {
  const stateDir = path.join(projectRoot, ".synapsor");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "exploration-boundaries.active.json"),
    `${JSON.stringify({
      schema_version: "synapsor.active-exploration-boundaries.v1",
      selected_name: selectedName,
      boundaries,
      updated_at: "2026-07-31T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createInactiveSemanticActionRuntime, ScopedCatalogIndex } from "@synapsor-runner/mcp-server";
import { describe, expect, it, vi } from "vitest";
import { createScopedExploreMcpServer } from "./authoring-mcp.js";
import { loadActivatedExplorationBoundaries, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import {
  createScopedExploreBoundarySetRuntime,
  selectActiveExploreBoundary,
  type ScopedExploreBoundarySetRuntime,
} from "./scoped-explore-boundary-set.js";
import { ScopedExploreError, type ScopedExploreRuntime } from "./scoped-explore.js";

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
    const validatedPlans: unknown[] = [];
    const subjectReferences = {
      service: { issue: vi.fn() },
      workflow_session_id: "workflow_shared_subjects",
    };
    const runtimeFactory = vi.fn(async (input: { boundaryName?: string }) => {
      const selected = [support, finance].find((candidate) => candidate.pack.name === input.boundaryName)!;
      return fakeChildRuntime(
        selected,
        (plan) => exploredPlans.push(plan),
        (plan) => validatedPlans.push(plan),
      );
    });
    try {
      await writeActiveSet(projectRoot, [support], "support");
      const runtime = await createScopedExploreBoundarySetRuntime({
        projectRoot,
        transport: "stdio",
        subjectReferences: subjectReferences as never,
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
        await expect(runtime.validate(
          { kind: "rows", resource: "Invoices" },
          "finance",
        )).resolves.toMatchObject({
          boundary_name: "finance",
          active_boundary_set_digest: runtime.active_boundary_set_digest,
        });
        expect(validatedPlans.at(-1)).toMatchObject({ resource: "public.invoices" });
        await expect(runtime.describe({ resource: "Tickets" })).resolves.toMatchObject({
          resources: [{ id: "public.tickets", boundary_name: "support" }],
        });
        expect(runtimeFactory).toHaveBeenCalledWith(expect.objectContaining({ boundaryName: "support" }));
        expect(runtimeFactory).toHaveBeenCalledWith(expect.objectContaining({ boundaryName: "finance" }));
        expect(runtimeFactory).toHaveBeenCalledWith(expect.objectContaining({
          subjectReferences,
        }));
      } finally {
        await runtime.close();
      }
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("allows local protocol discovery without identity but denies catalog and rows before routing", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-deferred-scope-"));
    const runtimeFactory = vi.fn(async () => { throw new ScopedExploreError("EXPLORE_SCOPE_FORBIDDEN", "Trusted runtime identity is missing"); });
    let runtime: ScopedExploreBoundarySetRuntime | undefined;
    let server: ReturnType<typeof createScopedExploreMcpServer> | undefined;
    const client = new Client({ name: "connection-check", version: "1" });
    try {
      await writeActiveSet(projectRoot, [validBoundary("support", ["public.tickets"])], "support");
      runtime = await createScopedExploreBoundarySetRuntime({ projectRoot, transport: "stdio", deferTrustedScope: true, runtimeFactory });
      server = createScopedExploreMcpServer(runtime, { semanticActions: createInactiveSemanticActionRuntime() });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change",
      ]);
      expect(runtimeFactory).not.toHaveBeenCalled();
      const actions = await client.callTool({ name: "app.describe_actions", arguments: {} });
      expect(actions.isError).toBe(true);
      expect(JSON.stringify(actions)).toContain("Trusted runtime identity is missing");
      await expect(runtime.describe()).rejects.toThrow("Trusted runtime identity is missing");
      await expect(runtime.describe({ resource: "secret_unknown" })).rejects.toThrow("Trusted runtime identity is missing");
      await expect(runtime.explore({ resource: "secret_unknown" })).rejects.toThrow("Trusted runtime identity is missing");
      await expect(runtime.validate({ resource: "secret_unknown" })).rejects.toThrow("Trusted runtime identity is missing");
    } finally {
      await client.close(); await server?.close(); await runtime?.close();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("qualifies active-file Read discovery over MCP with 1000 authorized and 1000 inaccessible resources", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-read-discovery-scale-"));
    const resourceIds = Array.from({ length: 1_000 }, (_, i) => `warehouse.stock_${String(i).padStart(4, "0")}`);
    const deniedIds = Array.from({ length: 1_000 }, (_, i) => `private.hidden_${String(i).padStart(4, "0")}`);
    const finance = scaleBoundary("finance", resourceIds.slice(0, 400));
    const support = scaleBoundary("support", resourceIds.slice(400));
    const secret = scaleBoundary("secret", deniedIds);
    const registryPath = path.join(projectRoot, ".synapsor/exploration-boundaries.active.json");
    const readFile = vi.spyOn(fs, "readFile");
    const search = vi.spyOn(ScopedCatalogIndex.prototype, "search");
    const detailCalls = vi.fn();
    const materializeField = vi.fn((id: string) => ({ id, operations: { select: true, filter: ["eq", "in"] } }));
    const sourceCalls = vi.fn(async () => { throw new Error("This metadata test must not query source rows"); });
    const children: Array<{ name: string; close: ReturnType<typeof vi.fn> }> = [];
    // Only child scope decisions and detail construction are mocked. Active-file
    // validation, index/cache, routing, projection and MCP serialization are real.
    const runtimeFactory = vi.fn(async ({ boundaryName }: { boundaryName?: string }) => {
      if (boundaryName === "secret") throw new ScopedExploreError("EXPLORE_SCOPE_FORBIDDEN", "Mock trusted child denies this scope");
      const loaded = (await loadActivatedExplorationBoundaries(projectRoot)).find((entry) => entry.pack.name === boundaryName)!;
      const child = fakeChildRuntime(loaded);
      const close = vi.fn(async () => undefined);
      children.push({ name: loaded.pack.name, close });
      return {
        ...child,
        close,
        explore: sourceCalls,
        describe: async (request: Parameters<ScopedExploreRuntime["describe"]>[0] = {}) => {
          detailCalls(loaded.pack.name, request);
          const resource = loaded.pack.resources.find((entry) => entry.id === request.resource)!;
          return {
            ok: true,
            resources: [{ ...scaleDetail(resource), fields: resource.selectable_fields.map(materializeField) }],
            next_cursor: null,
            source_database_changed: false,
          };
        },
      } as ScopedExploreRuntime;
    });
    let runtime: ScopedExploreBoundarySetRuntime | undefined;
    let server: ReturnType<typeof createScopedExploreMcpServer> | undefined;
    const client = new Client({ name: "read-scale-qualification", version: "1" });
    const costs: Array<Record<string, unknown>> = [];
    let maxPayloadBytes = 0;
    let maxMcpBytes = 0;
    const registryReads = () => readFile.mock.calls.filter(([file]) => String(file) === registryPath).length;
    const call = async (label: string, args: Record<string, unknown>) => {
      const readsBefore = registryReads();
      const childrenBefore = runtimeFactory.mock.calls.length;
      const started = performance.now();
      const response = await client.callTool({ name: "app.describe_data", arguments: args });
      const elapsedMs = performance.now() - started;
      const payload = response.structuredContent as Record<string, unknown>;
      expect(payload).toBeDefined();
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
      const mcpBytes = Buffer.byteLength(JSON.stringify(response));
      maxPayloadBytes = Math.max(maxPayloadBytes, payloadBytes);
      maxMcpBytes = Math.max(maxMcpBytes, mcpBytes);
      costs.push({ label, ms: Math.round(elapsedMs * 100) / 100, registry_reads: registryReads() - readsBefore,
        child_scope_attempts: runtimeFactory.mock.calls.length - childrenBefore, payload_bytes: payloadBytes, mcp_bytes: mcpBytes });
      expect(payloadBytes).toBeLessThanOrEqual(16_384);
      expect.soft(mcpBytes, `${label}: complete serialized MCP result`).toBeLessThanOrEqual(16_384);
      expect(JSON.stringify(response)).not.toContain("private.hidden");
      expect(JSON.stringify(response)).not.toContain('"boundary_name":"secret"');
      return { response, payload };
    };
    const ids = (payload: Record<string, unknown>) => (payload.resources as Array<{ id: string }>).map((entry) => entry.id);
    try {
      await writeActiveSet(projectRoot, [secret, finance, support], "support");
      const fileBytes = (await fs.stat(registryPath)).size;
      const loaderCosts: Array<Record<string, unknown>> = [];
      for (const label of ["cold_loader", "warm_loader"]) {
        const readsBefore = registryReads();
        const started = performance.now();
        const loaded = await loadActivatedExplorationBoundaries(projectRoot);
        loaderCosts.push({ label, ms: Math.round((performance.now() - started) * 100) / 100,
          registry_reads: registryReads() - readsBefore });
        expect(loaded.reduce((count, entry) => count + entry.pack.resources.length, 0)).toBe(2_000);
      }
      const started = performance.now();
      runtime = await createScopedExploreBoundarySetRuntime({ projectRoot, transport: "stdio", runtimeFactory });
      const runtimeInitMs = performance.now() - started;
      expect(runtime.boundaries.reduce((count, entry) => count + entry.pack.resources.length, 0)).toBe(2_000);
      expect(runtime.boundaries.find((entry) => entry.pack.name === "secret")!.pack.resources).toHaveLength(1_000);
      server = createScopedExploreMcpServer(runtime, { semanticActions: createInactiveSemanticActionRuntime() });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change",
      ]);

      const cold = await call("cold_summary", {});
      expect(cold.response.isError).not.toBe(true);
      expect(ids(cold.payload)).toEqual(resourceIds.slice(0, 5));
      expect(cold.payload.discovery).toMatchObject({ mode: "summary", eligibility: "not_checked" });
      const coldIndex = search.mock.contexts.at(-1)! as ScopedCatalogIndex;
      expect(coldIndex.ids).toHaveLength(1_000);
      expect(coldIndex.ids.every((id) => !id.startsWith("secret/"))).toBe(true);
      const warm = await call("warm_summary", {});
      expect(ids(warm.payload)).toEqual(ids(cold.payload));
      expect(search.mock.contexts.at(-1)).toBe(coldIndex);
      const page = await call("page_1", { limit: 20 });
      const next = await call("page_2", { limit: 20, cursor: page.payload.next_cursor });
      expect([...ids(page.payload), ...ids(next.payload)]).toEqual(resourceIds.slice(0, 40));
      expect(new Set([...ids(page.payload), ...ids(next.payload)]).size).toBe(40);
      const highest = await call("search_last_authorized", { query: "stock 0999" });
      expect(ids(highest.payload)).toEqual([resourceIds[999]]);
      const deniedSearch = await call("search_denied", { query: "hidden 0999" });
      const unknownSearch = await call("search_unknown", { query: "nonexistent 0999" });
      expect(ids(deniedSearch.payload)).toEqual([]);
      expect(deniedSearch.response).toEqual(unknownSearch.response);
      expect(detailCalls).not.toHaveBeenCalled();
      expect(materializeField).not.toHaveBeenCalled();
      expect((page.payload.resources as Array<{ fields?: unknown[] }>).every((entry) => !entry.fields?.length)).toBe(true);

      const denied = await call("detail_denied", { boundary: "secret", resource: deniedIds[999] });
      const unknown = await call("detail_unknown", { boundary: "absent", resource: "unknown.resource" });
      expect(denied.response.isError).toBe(true);
      expect(denied.payload.error_code).toBe("CATALOG_ENTRY_UNAVAILABLE");
      expect(denied.response).toEqual(unknown.response);
      expect(detailCalls).not.toHaveBeenCalled();
      const detailResource = support.pack.resources.at(-1)!;
      const detail = await call("exact_detail", { boundary: "support", resource: detailResource.id });
      expect(detail.response.isError).not.toBe(true);
      expect(detail.payload.resources).toHaveLength(1);
      expect(detail.payload.resources).toEqual([expect.objectContaining({ ...scaleDetail(detailResource), boundary_name: "support" })]);
      expect(detailCalls).toHaveBeenCalledExactlyOnceWith("support", { resource: detailResource.id, include_time_coverage: false });
      expect(materializeField).toHaveBeenCalledTimes(detailResource.selectable_fields.length);

      const revised = scaleBoundary("support", resourceIds.slice(400), "Revised stock contract");
      expect(revised.activation.digest).not.toBe(support.activation.digest);
      const beforeRevision = await call("before_revision", { limit: 20 });
      const previousIndex = search.mock.contexts.at(-1)!;
      await writeActiveSet(projectRoot, [secret, finance, revised], "support");
      const stale = await call("stale_revision_cursor", { limit: 20, cursor: beforeRevision.payload.next_cursor });
      expect(stale.payload.error_code).toBe("CATALOG_CURSOR_INVALID");
      expect(children.find((child) => child.name === "support")!.close).toHaveBeenCalledOnce();
      const current = await call("revised_summary", { query: "stock 0999" });
      expect(search.mock.contexts.at(-1)).not.toBe(previousIndex);
      expect(current.payload.resources).toEqual([expect.objectContaining({ id: detailResource.id, description: "Revised stock contract" })]);
      const revisedDetail = await call("revised_detail", { boundary: "support", resource: detailResource.id });
      expect(revisedDetail.payload.resources).toHaveLength(1);
      expect(revisedDetail.payload.resources).toEqual([expect.objectContaining({ ...scaleDetail(revised.pack.resources.at(-1)!), boundary_name: "support" })]);

      const beforeRemoval = await call("before_removal", { limit: 20 });
      await writeActiveSet(projectRoot, [secret, revised], "support");
      const removedCursor = await call("removed_boundary_cursor", { limit: 20, cursor: beforeRemoval.payload.next_cursor });
      expect(removedCursor.payload.error_code).toBe("CATALOG_CURSOR_INVALID");
      const removed = await call("removed_boundary_detail", { boundary: "finance", resource: resourceIds[0] });
      expect(removed.response).toEqual(unknown.response);
      const remaining = await call("remaining_summary", {});
      expect(ids(remaining.payload)).toEqual(resourceIds.slice(400, 405));
      expect(children.find((child) => child.name === "finance")!.close).toHaveBeenCalledOnce();
      expect(sourceCalls).not.toHaveBeenCalled();
      expect(detailCalls).toHaveBeenCalledTimes(2);
      expect((await client.listTools()).tools).toEqual(tools.tools);
      console.info(JSON.stringify({ benchmark: "active_file_read_discovery_mcp", scope: "mock trusted child; real active-file loader/index/MCP; no live DB proof",
        authorized: 1_000, inaccessible: 1_000, registry_bytes: fileBytes, loader_costs: loaderCosts,
        runtime_init_ms: Math.round(runtimeInitMs * 100) / 100,
        max_payload_bytes: maxPayloadBytes, max_mcp_bytes: maxMcpBytes, costs }));
    } finally {
      await client.close();
      await server?.close();
      await runtime?.close();
      readFile.mockRestore();
      search.mockRestore();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("advertises relative UTC windows only when an active boundary has reviewed UTC authority", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-set-time-"));
    const legacy = validBoundary("legacy", ["public.legacy_events"]);
    const secondLegacy = validBoundary("second_legacy", ["public.other_events"]);
    const reviewedUtc = validBoundary("reviewed_utc", ["public.utc_events"], "UTC");
    const runtimeFactory = vi.fn(async (input: { boundaryName?: string }) => {
      const selected = [legacy, secondLegacy, reviewedUtc].find((candidate) =>
        candidate.pack.name === input.boundaryName)!;
      return fakeChildRuntime(selected);
    });
    try {
      await writeActiveSet(projectRoot, [legacy, secondLegacy], "legacy");
      const runtime = await createScopedExploreBoundarySetRuntime({
        projectRoot,
        transport: "stdio",
        runtimeFactory: runtimeFactory as never,
      });
      try {
        await expect(runtime.describe({ limit: 10 })).resolves.toMatchObject({
          relative_time_windows: {
            available: false,
            reporting_timezone: null,
            windows: [],
            comparison_partners: [],
          },
        });

        await writeActiveSet(projectRoot, [legacy, secondLegacy, reviewedUtc], "reviewed_utc");
        await expect(runtime.describe({ limit: 10 })).resolves.toMatchObject({
          relative_time_windows: {
            available: true,
            reporting_timezone: "UTC",
            windows: expect.arrayContaining(["previous_month", "month_to_date"]),
            comparison_partners: ["preceding_period", "same_period_last_year"],
          },
        });
      } finally {
        await runtime.close();
      }
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("withholds operator diagnostics even when an internal result has no boundary routing tag", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-set-projection-"));
    const support = validBoundary("support", ["public.tickets"], "UTC");
    try {
      await writeActiveSet(projectRoot, [support], "support");
      const runtime = await createScopedExploreBoundarySetRuntime({
        projectRoot,
        transport: "stdio",
        runtimeFactory: (async () => fakeChildRuntime(support)) as never,
      });
      try {
        expect(runtime.projectResultForModel({
          tool: "app.explore_data",
          arguments: {
            plan: {
              kind: "aggregate",
              resource: "public.tickets",
              measures: [{ function: "count" }],
            },
          },
          result: {
            ok: true,
            operator_budget: { queries: { used: 1, limit: 1000 } },
            operator_time_windows: [{
              resolved_at: "2026-08-11T06:00:00.000Z",
              ranges: [{
                start_inclusive: "2026-07-12T06:00:00.000Z",
                end_exclusive: "2026-08-11T06:00:00.000Z",
              }],
            }],
          },
        })).toEqual({
          value: { ok: true },
          withheld: false,
          operator_metadata_withheld: true,
        });
      } finally {
        await runtime.close();
      }
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("applies semantic and exact authority metadata modes to boundary-set results", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-set-metadata-"));
    const support = validBoundary("support", ["public.tickets"], "UTC");
    try {
      await writeActiveSet(projectRoot, [support], "support");
      const result = {
        ok: true,
        boundary_digest: support.activation.digest,
        active_boundary_set_digest: `sha256:${"4".repeat(64)}`,
        data: [{ digest: support.activation.digest }],
        source_database_changed: false,
      };
      const semantic = await createScopedExploreBoundarySetRuntime({
        projectRoot,
        transport: "stdio",
        modelAuthorityMetadata: "semantic",
        runtimeFactory: (async () => fakeChildRuntime(support)) as never,
      });
      try {
        expect(semantic.projectResultForModel({
          tool: "app.explore_data",
          arguments: {
            plan: { kind: "rows", resource: "public.tickets", select: ["id"] },
          },
          result,
        })).toMatchObject({
          value: {
            data: [{ digest: support.activation.digest }],
          },
          operator_metadata_withheld: true,
        });
      } finally {
        await semantic.close();
      }

      const exact = await createScopedExploreBoundarySetRuntime({
        projectRoot,
        transport: "stdio",
        modelAuthorityMetadata: "exact",
        runtimeFactory: (async () => fakeChildRuntime(support)) as never,
      });
      try {
        expect(exact.projectResultForModel({
          tool: "app.explore_data",
          arguments: {
            plan: { kind: "rows", resource: "public.tickets", select: ["id"] },
          },
          result,
        })).toEqual({ value: result, withheld: false });
      } finally {
        await exact.close();
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
      validate: async () => ({}) as never,
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
      expect(exploreTool.description).toContain('"where":[{"field":"status","op":"eq"');
      expect(exploreTool.description).toContain('"order_by":{"kind":"measure","index":0');
      expect(exploreTool.description).toContain('"time_bucket":{"field":"<time field>","bucket":"month"},"comparison"');
      expect(exploreTool.description).toContain('"comparison":{"field":"<time field>","window":"this_month","compare_to":"preceding_period"}');
      expect(exploreTool.description).toContain("sibling plan keys, never nested");
      expect(exploreTool.description).not.toContain("public.invoices");
      expect(exploreTool.inputSchema).toMatchObject({
        properties: {
          boundary: expect.objectContaining({
            anyOf: [expect.objectContaining({ type: "string",
              pattern: "^(?:[a-z][a-z0-9_.-]{0,63})?$" }), { type: "null" }],
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
      expect(describe).not.toHaveBeenCalled();
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
      const invalidFilterAlias = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "aggregate",
            resource: "public.invoices",
            measures: [{ function: "count" }],
            filters: [{ field: "status", operator: "eq", value: "open" }],
          },
        },
      });
      const invalidComparisonAlias = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "aggregate",
            resource: "public.invoices",
            measures: [{ function: "count" }],
            time_window: { field: "created_at", window: "this_month" },
            comparison_partner: "preceding_period",
          },
        },
      });
      const invalidComparisonToAlias = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "aggregate",
            resource: "public.invoices",
            measures: [{ function: "count" }],
            time_window: { field: "created_at", window: "this_month" },
            comparison_to: "preceding_period",
          },
        },
      });
      const invalidRootCompareToAlias = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "aggregate",
            resource: "public.invoices",
            measures: [{ function: "count" }],
            time_window: { field: "created_at", window: "this_month" },
            compare_to: "preceding_period",
          },
        },
      });
      expect(requiredResourceNull.isError).toBe(true);
      expect(requiredKindNull.isError).toBe(true);
      expect(unknownKey.isError).toBe(true);
      expect(unknownFlatKey.isError).toBe(true);
      expect(malformedContainer.isError).toBe(true);
      expect(invalidKind.isError).toBe(true);
      expect(invalidFilterAlias.isError).toBe(true);
      expect(invalidComparisonAlias.isError).toBe(true);
      expect(invalidComparisonToAlias.isError).toBe(true);
      expect(invalidRootCompareToAlias.isError).toBe(true);
      const invalidKindContent = invalidKind.content as Array<{ type: string; text?: string }>;
      const invalidKindText = invalidKindContent.find((entry) => entry.type === "text")?.text ?? "";
      expect(invalidKindText).toContain("plan.kind must be exactly rows or aggregate");
      expect(invalidKindText).toContain('{\\"plan\\":{\\"kind\\":\\"aggregate\\"');
      const invalidFilterText = (invalidFilterAlias.content as Array<{ type: string; text?: string }>)
        .find((entry) => entry.type === "text")?.text ?? "";
      expect(invalidFilterText).toContain("use plan.where");
      expect(invalidFilterText).toContain("filter and filters are not grammar keys");
      const invalidComparisonText = (invalidComparisonAlias.content as Array<{ type: string; text?: string }>)
        .find((entry) => entry.type === "text")?.text ?? "";
      expect(invalidComparisonText).toContain("use plan.comparison");
      expect(invalidComparisonText).toContain("plan.time_bucket");
      expect(invalidComparisonText).toContain("compare_to");
      for (const response of [invalidComparisonToAlias, invalidRootCompareToAlias]) {
        const responseText = (response.content as Array<{ type: string; text?: string }>)
          .find((entry) => entry.type === "text")?.text ?? "";
        expect(responseText).toContain("plan.comparison");
        expect(responseText).toContain("preceding_period");
      }
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

function validBoundary(
  name: string,
  resources: string[],
  reportingTimezone?: "UTC",
): ActivatedExplorationBoundary {
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
    ...(reportingTimezone ? { reporting_timezone: reportingTimezone } : {}),
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

function scaleBoundary(name: string, ids: string[], description = "Reviewed stock contract"): ActivatedExplorationBoundary {
  const active = validBoundary(name, ids, "UTC");
  const fields = Array.from({ length: 12 }, (_, i) => `field_${String(i).padStart(2, "0")}`);
  active.pack.resources = active.pack.resources.map((resource) => ({
    ...resource,
    label: `Stock ${resource.id.split("_").at(-1)}`,
    description,
    selectable_fields: [...fields],
    filterable_fields: { [fields[0]!]: ["eq", "in"] },
    field_types: Object.fromEntries(fields.map((field) => [field, "text"])),
  }));
  const { activation, ...authority } = active;
  active.activation = { ...activation, digest: canonicalJsonDigest({ ...authority, activation: "reviewed" }) };
  return active;
}

function scaleDetail(resource: ActivatedExplorationBoundary["pack"]["resources"][number]) {
  return {
    id: resource.id,
    label: resource.label,
    description: resource.description,
    fields: resource.selectable_fields.map((id) => ({ id, operations: { select: true, filter: ["eq", "in"] } })),
    selectable_fields: resource.selectable_fields,
    filter_operators: resource.filterable_fields,
    maximum_rows: 25,
    time_coverage: {},
  };
}

function fakeChildRuntime(
  boundary: ActivatedExplorationBoundary,
  onExplore?: (plan: unknown) => void,
  onValidate?: (plan: unknown) => void,
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
    validate: async (plan) => {
      onValidate?.(plan);
      return {} as never;
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

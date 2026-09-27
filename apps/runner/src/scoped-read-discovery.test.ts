import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createInactiveSemanticActionRuntime } from "@synapsor-runner/mcp-server";
import { createScopedExploreMcpServer } from "./authoring-mcp.js";
import { createScopedReadDiscovery } from "./scoped-read-discovery.js";
import type { ScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";

function fixture(count = 40, longSummaries = false) {
  const materializeFields = vi.fn(() => { throw new Error("Summary discovery must not materialize field metadata"); });
  const boundary = (name: string, count: number) => ({ pack: { name, resources: Array.from({ length: count }, (_, i) => ({
    id: `${name}.resource_${i}`, label: longSummaries ? "Reviewed resource label ".repeat(3).slice(0, 64) : `${name} item ${i}`,
    description: longSummaries ? "Reviewed business description ".repeat(10).slice(0, 280) : `Reviewed business information ${i}`,
    get field_metadata() { return materializeFields(); },
  })) }, activation: { digest: `sha256:${name.repeat(64).slice(0, 64)}` } });
  const all = [boundary("public", count), boundary("secret", count)];
  let allowed = [all[0]!];
  let onDetail = () => {};
  let malformed = false;
  const requireTrustedScope = vi.fn(async () => {});
  const describeResource = vi.fn(async (request: { resource: string }) => {
    onDetail();
    return { ok: true, resources: [{ id: malformed ? "secret.wrong" : request.resource,
      fields: [{ name: "business_label", operations: ["return"] }], time_coverage: {} }], next_cursor: null };
  });
  const runtime = { boundaries: all, active_boundary_set_digest: `sha256:${"c".repeat(64)}`, session_fingerprint: `sha256:${"a".repeat(64)}`,
    requireTrustedScope, authorizedCatalogBoundaries: async () => allowed, describe: describeResource,
  } as unknown as ScopedExploreBoundarySetRuntime;
  return { runtime, discover: createScopedReadDiscovery(runtime), requireTrustedScope, describeResource, materializeFields,
    revoke: () => { allowed = []; }, changeRevision: () => { allowed = [{ ...all[0]!, activation: { digest: `sha256:${"b".repeat(64)}` } }]; },
    duringDetail: (fn: () => void) => { onDetail = fn; }, corruptDetail: () => { malformed = true; } };
}

describe("scoped Read discovery", () => {
  it("binds resource-only sections to the resolved authorized boundary without broadening listing or replay scope", async () => {
    const boundary = (name: string) => ({ pack: { name, resources: [{ id: "shared.resource", label: "Shared resource" },
      { id: `${name}.only`, label: `${name} only` }] }, activation: { digest: `sha256:${name.repeat(64).slice(0, 64)}` } });
    const a = boundary("a"), b = boundary("b");
    let allowed = [a];
    const runtime = { boundaries: [a, b], session_fingerprint: `sha256:${"f".repeat(64)}`,
      authorizedCatalogBoundaries: async () => allowed,
      describe: async ({ resource, boundary }: { resource: string; boundary: string }) => ({ boundary_name: boundary,
        resources: [{ id: resource, fields: Array.from({ length: 60 }, (_, i) => ({ id: `field_${i}`, description: "Reviewed text ".repeat(30) })) }] }),
    } as unknown as ScopedExploreBoundarySetRuntime;
    const discover = createScopedReadDiscovery(runtime);
    const overview = await discover({ resource: "shared.resource" });
    const args = (overview.contract_navigation as any).sections.find((section: any) => section.section === "fields").next_call.arguments;
    expect(args.boundary).toBe("a");
    const page = await discover(args);
    expect(page.contract_section).toMatchObject({ section: "fields" });
    expect(page.next_cursor).toMatch(/^cur_/);
    const next = { ...args, cursor: page.next_cursor };
    expect((await discover(next)).contract_section).toHaveProperty("section", "fields");

    allowed = [a, b];
    await expect(discover({ resource: "shared.resource" })).rejects.toMatchObject({ code: "CATALOG_ENTRY_UNAVAILABLE" });
    await expect(discover(next)).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
    await expect(discover({ ...next, boundary: "b" })).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
    const explicit = await discover({ resource: "shared.resource", boundary: "a" });
    expect(explicit.contract_navigation).toHaveProperty("subject", "shared.resource");
    await discover({ resource: "a.only" });
    expect((await discover({ boundary: "a" })).resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: "a.only" })]));
    expect((await discover({ boundary: "a" })).resources).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "b.only" })]));
    expect((await discover({ boundary: "b" })).resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: "b.only" })]));
    allowed = [b];
    await expect(discover({ ...args, boundary: "a" })).rejects.toMatchObject({ code: "CATALOG_ENTRY_UNAVAILABLE" });
  });

  it("retains four typed object-root declarations for native consumers without root combinators", async () => {
    const f = fixture(6);
    const server = createScopedExploreMcpServer(f.runtime, { semanticActions: createInactiveSemanticActionRuntime() });
    const client = new Client({ name: "native-portable-discovery", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b); await client.connect(a);
      const tools = (await client.listTools()).tools;
      expect(tools.map(t => t.name).sort()).toEqual([
        "app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change",
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        for (const rootKeyword of ["anyOf", "oneOf", "allOf", "$ref"]) {
          expect(tool.inputSchema, `${tool.name}: ${rootKeyword}`).not.toHaveProperty(rootKeyword);
        }
        expect(tool.inputSchema.properties).toBeDefined();
        expect(tool.inputSchema.additionalProperties).toBe(false);
      }
    } finally { await client.close(); await server.close(); }
  });
  it("browses bounded authorized summaries without materializing fields or requesting source coverage", async () => {
    const f = fixture(1_000);
    const first = await f.discover({ limit: 3 });
    expect(first.resources).toHaveLength(3);
    expect(first.next_cursor).toMatch(/^cur_/u);
    expect(f.describeResource).not.toHaveBeenCalled();
    expect(f.materializeFields).not.toHaveBeenCalled();
    expect(JSON.stringify(first)).not.toContain("secret");
    const next = await f.discover({ limit: 3, cursor: first.next_cursor as string });
    const ids = [...first.resources as Array<{ id: string }>, ...next.resources as Array<{ id: string }>].map((r) => r.id);
    expect(new Set(ids).size).toBe(6);
    expect(f.materializeFields).not.toHaveBeenCalled();
    const exact = await f.discover({ boundary: "public", resource: "public.resource_1" });
    expect(exact).toMatchObject({ resources: [{ id: "public.resource_1", fields: [{ name: "business_label" }] }] });
    expect(f.describeResource).toHaveBeenCalledExactlyOnceWith({ boundary: "public", resource: "public.resource_1", include_time_coverage: false });
    expect(f.requireTrustedScope).toHaveBeenCalled();
  });

  it("emits valid exact Read and continuation arguments without obtaining detail from listing permission", async () => {
    const f = fixture(6);
    const exactSearch = await f.discover({ query: "public.resource_1" });
    expect(exactSearch).not.toHaveProperty("inline_contract");
    expect(exactSearch.discovery).toMatchObject({ contract_status: "exact_detail_required", next_steps: [{
      kind: "inspect_exact_details", tool: "app.describe_data", arguments: { boundary: "public", resource: "public.resource_1" },
    }] });
    expect(f.describeResource).not.toHaveBeenCalled();
    const page = await f.discover({ boundary: "public", query: "business", limit: 2 });
    expect(page.discovery).toMatchObject({ next_steps: expect.arrayContaining([{ kind: "continue_page", tool: "app.describe_data",
      arguments: { boundary: "public", query: "business", limit: 2, cursor: page.next_cursor } }]) });
    expect(page.pagination).toMatchObject({ state: "more_pages", scope: "authorized_catalog_metadata" });
    const continuation = (page.discovery as { next_steps: Array<{ kind: string; arguments: Record<string, unknown> }> }).next_steps.find(step => step.kind === "continue_page")!;
    const next = await f.discover(continuation.arguments);
    expect(new Set([...page.resources as Array<{ id: string }>, ...next.resources as Array<{ id: string }>].map(entry => entry.id)).size).toBe(4);
    expect(f.describeResource).not.toHaveBeenCalled();
  });

  it("does not distinguish denied from unknown resources and cannot retain revoked pages", async () => {
    const f = fixture();
    for (const resource of ["secret.resource_1", "unknown.resource_1"]) {
      await expect(f.discover({ resource })).rejects.toMatchObject({ code: "CATALOG_ENTRY_UNAVAILABLE" });
    }
    expect(f.describeResource).not.toHaveBeenCalled();
    const first = await f.discover({});
    f.changeRevision();
    await expect(f.discover({ cursor: first.next_cursor as string })).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
    f.revoke();
    expect(await f.discover({ query: "business" })).toMatchObject({ resources: [] });
  });

  it("refuses a revision change during asynchronous detail materialization", async () => {
    const f = fixture();
    f.duringDetail(f.revoke);
    await expect(f.discover({ resource: "public.resource_1" })).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
  });

  it("refuses incomplete or wrong-resource detail rather than silently substituting a summary", async () => {
    const f = fixture();
    f.corruptDetail();
    await expect(f.discover({ resource: "public.resource_1" })).rejects.toMatchObject({ code: "CATALOG_ENTRY_UNAVAILABLE" });
    await expect(f.discover({ resource: "public.resource_1", query: "business" })).rejects.toMatchObject({ code: "ARGUMENT_INVALID" });
  });

  it("fails authentication before query validation or catalog detail lookup", async () => {
    const f = fixture();
    f.requireTrustedScope.mockRejectedValueOnce(new Error("Trusted identity unavailable"));
    await expect(f.discover({ resource: "secret.resource_1", query: "x".repeat(300) })).rejects.toThrow("Trusted identity unavailable");
    expect(f.describeResource).not.toHaveBeenCalled();
  });

  it("refuses oversized exact detail without returning a truncated contract", async () => {
    const f = fixture();
    f.describeResource.mockResolvedValueOnce({ ok: true, resources: [{
      id: "public.resource_1", fields: [{ name: "business_label", operations: ["return"], ...{ description: "x".repeat(16_384) } }],
      time_coverage: {},
    }], next_cursor: null });
    await expect(f.discover({ resource: "public.resource_1" })).rejects.toMatchObject({ code: "CATALOG_CONTRACT_TOO_LARGE" });
    expect(f.describeResource).toHaveBeenCalledExactlyOnceWith({ boundary: "public", resource: "public.resource_1", include_time_coverage: false });
  });

  it("keeps real Read pagination and context-bound cursors through tools/list and dispatch", async () => {
    const f = fixture(6);
    const server = createScopedExploreMcpServer(f.runtime, { semanticActions: createInactiveSemanticActionRuntime() });
    const client = new Client({ name: "read-operation-pagination", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b); await client.connect(a);
      expect((await client.listTools()).tools).toHaveLength(4);
      const call = (args: Record<string, unknown>) => client.callTool({ name: "app.describe_data", arguments: args });
      const first = await call({ boundary: "public", limit: 2 });
      expect(first.isError).not.toBe(true);
      const page = first.structuredContent as Record<string, any>;
      expect(page.next_cursor).toMatch(/^cur_[A-Za-z0-9_-]{43}$/);
      const second = await call({ boundary: "public", limit: 2, cursor: page.next_cursor });
      expect(second.isError).not.toBe(true);
      expect(new Set([...page.resources, ...(second.structuredContent as any).resources].map(r => r.id)).size).toBe(4);
      for (const args of [{ boundary: "public", cursor: `cur_${"x".repeat(43)}` },
        { boundary: "public", query: "other", cursor: page.next_cursor },
        { boundary: "secret", cursor: page.next_cursor }]) expect((await call(args)).isError).toBe(true);
      f.changeRevision();
      expect((await call({ boundary: "public", cursor: page.next_cursor })).isError).toBe(true);
      expect((await call({ resource: "public.resource_0", boundary: "public", limit: null })).isError).not.toBe(true);
      expect((await call({ resource: "secret.resource_0" })).isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  });

  it("bounds the complete public MCP summary response to 16 KiB with maximum-length metadata", async () => {
    // Isolates serialization with mocked authorization/metadata. The active-file
    // composition at 1000 + 1000 resources is covered in the boundary-set suite.
    const f = fixture(1_000, true);
    const server = createScopedExploreMcpServer(f.runtime, { semanticActions: createInactiveSemanticActionRuntime() });
    const client = new Client({ name: "read-disclosure-size", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const response = await client.callTool({ name: "app.describe_data", arguments: { limit: 20 } });
      const payload = response.structuredContent as Record<string, unknown>;
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
      const mcpBytes = Buffer.byteLength(JSON.stringify(response));
      console.info(JSON.stringify({ benchmark: "read_mcp_maximum_summary_metadata", authorized: 1_000,
        inaccessible: 1_000, payload_bytes: payloadBytes, mcp_bytes: mcpBytes, error_code: payload.error_code }));
      expect(response.isError).not.toBe(true);
      expect((payload.resources as unknown[]).length).toBeGreaterThan(0);
      expect((payload.resources as unknown[]).length).toBeLessThanOrEqual(20);
      expect(f.describeResource).not.toHaveBeenCalled();
      expect(f.materializeFields).not.toHaveBeenCalled();
      expect(payloadBytes).toBeLessThanOrEqual(16_384);
      expect(mcpBytes).toBeLessThanOrEqual(16_384);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

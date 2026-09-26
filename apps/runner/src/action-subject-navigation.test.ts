import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createInactiveSemanticActionRuntime } from "@synapsor-runner/mcp-server";
import { createScopedExploreMcpServer } from "./authoring-mcp.js";
import { createActionSubjectNavigation } from "./action-subject-navigation.js";
import type { ScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";

/** Renamed structural fixture: metadata only, no model observations or effects. */
function fixture() {
  const boundary = { pack: { name: "permitted", resources: [{ id: "lab.runs" }, { id: "lab.related", relationship_only: true }] },
    activation: { digest: `sha256:${"a".repeat(64)}` } };
  let allowed = [boundary];
  let supported: boolean | undefined = true;
  let onDetail = () => {};
  let privateTotal = 45;
  const describe = vi.fn(async ({ resource }: { resource: string }) => {
    onDetail();
    return { ok: true, resources: [{ id: resource, private_total: privateTotal, primary_key: "private_key",
      fields: [{ id: "public_label", label: "Public label", semantic_status: "descriptive_identifier" },
        { id: "private_amount", label: "Private", semantic_status: "quantity" }],
      field_egress: { private_amount: { model_egress: "withheld" } }, selectable_fields: ["public_label", "private_amount"],
      filter_operators: { public_label: ["eq"], private_amount: ["eq"] }, time_coverage: {} }] };
  });
  const runtime = { boundary, boundaries: [boundary], active_boundary_set_digest: `sha256:${"d".repeat(64)}`, session_fingerprint: `sha256:${"b".repeat(64)}`,
    requireTrustedScope: vi.fn(async () => {}), authorizedCatalogBoundaries: async () => allowed, describe,
    supportsSubjectReferences: vi.fn(async () => supported) } as unknown as ScopedExploreBoundarySetRuntime;
  return { runtime, describe, navigation: createActionSubjectNavigation(runtime),
    duringDetail: (fn: () => void) => { onDetail = fn; }, revoke: () => { allowed = []; },
    changeRevision: () => { allowed = [{ ...boundary, activation: { digest: `sha256:${"c".repeat(64)}` } }]; },
    hiddenTotal: (value: number) => { privateTotal = value; },
    noReferences: () => { supported = undefined; }, duplicate: () => { allowed = [boundary, { ...boundary, pack: { ...boundary.pack, name: "alternative" } }]; } };
}

describe("current authorized Action subject navigation", () => {
  it("uses only the existing model Read projection and copies a valid minimal rows route", async () => {
    const f = fixture();
    const result = await f.navigation(["lab.runs"]);
    expect(result.resources).toEqual({ "lab.runs": expect.objectContaining({ status: "rows_reference_available",
      describe_data: { boundary: "permitted", resource: "lab.runs" }, selectable_fields: ["public_label"],
      filter_operators: { public_label: ["eq"] }, explore_data: { boundary: "permitted", plan: {
        kind: "rows", resource: "lab.runs", select: ["public_label"] } } }) });
    expect(JSON.stringify(result.resources)).not.toMatch(/private_amount|private_key|sha256:/);
    expect(f.describe).toHaveBeenCalledExactlyOnceWith({ boundary: "permitted", resource: "lab.runs", include_time_coverage: false });
  });

  it("bounds navigation to three reviewed fields and labels it as a subset rather than truncating the Action contract", async () => {
    const f = fixture();
    const raw = await f.describe({ resource: "lab.runs" });
    f.describe.mockResolvedValueOnce({ ...raw, resources: [{ ...raw.resources[0]!, fields: [],
      selectable_fields: Array.from({ length: 1000 }, (_, i) => `visible_${i}`),
      filter_operators: { ...raw.resources[0]!.filter_operators,
        ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`visible_${i}`, ["eq"]])) },
    }] });
    const result = await f.navigation(["lab.runs"]);
    expect(result.resources["lab.runs"]).toMatchObject({ field_scope: expect.stringContaining("bounded_navigation_subset"),
      selectable_fields: ["visible_0", "visible_1", "visible_2"], filter_operators: { visible_0: ["eq"], visible_1: ["eq"], visible_2: ["eq"] } });
    expect(Buffer.byteLength(JSON.stringify(result.resources))).toBeLessThan(1500);
  });

  it("does not manufacture caller input from indistinguishable discovery with different private totals", async () => {
    const f = fixture();
    const first = await f.navigation(["lab.runs"]);
    f.hiddenTotal(99);
    expect(await f.navigation(["lab.runs"])).toEqual(first);
    expect(JSON.stringify(first.resources)).not.toMatch(/private_total|45|99/);
  });

  it("forwards checked navigation through the real four-tool MCP adapter and agrees in text/structured output", async () => {
    const f = fixture();
    const inactive = createInactiveSemanticActionRuntime();
    const call = vi.fn(async (_name: string, _args: Record<string, unknown>, options?: Parameters<typeof inactive.callTool>[2]) => {
      const navigation = await options?.describeSubjectNavigation?.(["lab.runs"]);
      return { ok: true, actions: [{ outcome: "lab.close_run", subjects: [{ binding: "run", resource: "lab.runs",
        navigation: navigation?.resources["lab.runs"] }] }], source_database_changed: false };
    });
    const server = createScopedExploreMcpServer(f.runtime, { semanticActions: { ...inactive, callTool: call } });
    const client = new Client({ name: "action-navigation-wire", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
        "app.describe_actions", "app.request_change", "app.describe_data", "app.explore_data",
      ]);
      const result = await client.callTool({ name: "app.describe_actions", arguments: { outcome: "lab.close_run" } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ actions: [{ subjects: [{ navigation: {
        status: "rows_reference_available", selectable_fields: ["public_label"] } }] }] });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(content.find(item => item.type === "text")!.text!)).toEqual(result.structuredContent);
      expect(JSON.stringify(result)).not.toMatch(/private_amount|private_key|private_total/);
    } finally { await client.close(); await server.close(); }
  });

  it("never advertises a relationship-only subject as an independent Read root", async () => {
    const f = fixture();
    const result = await f.navigation(["lab.related"]);
    expect(result.resources["lab.related"]).toMatchObject({ status: "relationship_only" });
    expect(result.resources["lab.related"]).not.toHaveProperty("explore_data");
    expect(result.resources["lab.related"]).not.toHaveProperty("describe_data");
    expect(f.describe).not.toHaveBeenCalled();
  });

  it.each(["absent", "ambiguous"])("keeps an %s public root unavailable without choosing or exposing another scope", async state => {
    const f = fixture();
    if (state === "ambiguous") f.duplicate();
    const result = await f.navigation([state === "absent" ? "secret.runs" : "lab.runs"]);
    expect(Object.values(result.resources)[0]).toMatchObject({ status: "unavailable" });
    expect(f.describe).not.toHaveBeenCalled();
  });

  it("does not infer reference support from a selectable row field or an Action subject name", async () => {
    const f = fixture(); f.noReferences();
    const result = await f.navigation(["lab.runs"]);
    expect(result.resources["lab.runs"]).toMatchObject({ status: "reference_not_established" });
    expect(result.resources["lab.runs"]).not.toHaveProperty("explore_data");
  });

  it.each(["revocation", "revision"])("rejects %s during metadata composition instead of returning stale navigation", async change => {
    const f = fixture(); f.duringDetail(change === "revocation" ? f.revoke : f.changeRevision);
    await expect(f.navigation(["lab.runs"])).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
  });
});

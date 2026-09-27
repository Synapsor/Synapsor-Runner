import { describe, expect, it, vi } from "vitest";
import { CATALOG_LIMITS } from "@synapsor-runner/mcp-server";
import { createScopedRowContinuation } from "./scoped-row-continuation.js";
import type { ExplorePlan, ScopedExploreValidationResult } from "./scoped-explore.js";

// Synthetic callback composition for finite transport-only limits/reference
// presentation. Actual authority, parser, projection, source accounting and MCP
// companions are separately exercised in scoped-explore.test.ts.
const plan = { kind: "rows", resource: "public.owned", select: ["label"], limit: 6 } as const;
function composition(rows = Array.from({ length: 6 }, (_, i) => ({ label: `owned-${i}` }))) {
  let now = 1000, revision = "reviewed-1", session = "caller-1";
  const source = { ok: true, data: rows, subjects: rows.map((_, i) => ({ row_index: i, resource: "public.owned",
    ref: `obj_original_${i}`, expires_at: "2026-09-27T03:05:00.000Z" })),
    outcome: { result: { completeness: { result_page: "not_established" } } } };
  const validate = vi.fn(async (request: unknown) => ({ normalized_plan: structuredClone(request),
    boundary_name: "owned", boundary_digest: revision, generation_lock_fingerprint: "lock",
    database_engine: "postgres", trusted_scope: { tenant: "t", principal: "p" } } as ScopedExploreValidationResult));
  const explore = vi.fn(async () => source);
  const project = vi.fn((_plan: ExplorePlan, _boundary: string, value: Record<string, unknown>) => ({ value, withheld: false }));
  const page = createScopedRowContinuation({ current: async () => {}, session: () => session, validate, explore, project,
    limits: () => ({ max_rows: 6, max_response_bytes: 32768 }),
    measure: value => Buffer.byteLength(JSON.stringify(value)) * 2, clock: () => now });
  return { page, validate, explore, project, source, tick: (value: number) => { now = value; },
    change: () => { revision = "reviewed-2"; }, changeCaller: () => { session = "caller-2"; } };
}

describe("bounded row transport composition", () => {
  it("retains exact original references/expiry with page-local row indices and immutable observed values", async () => {
    const fixture = composition();
    const first = await fixture.page({ plan, page_rows: 2 });
    fixture.source.data[2]!.label = "later-source-value";
    const second = await fixture.page({ plan, page_rows: 2, cursor: first.value.next_cursor as string });
    expect(second.value.data).toEqual([{ label: "owned-2" }, { label: "owned-3" }]);
    expect(second.value.subjects).toEqual([
      { row_index: 0, resource: "public.owned", ref: "obj_original_2", expires_at: "2026-09-27T03:05:00.000Z" },
      { row_index: 1, resource: "public.owned", ref: "obj_original_3", expires_at: "2026-09-27T03:05:00.000Z" },
    ]);
    expect(second.value.row_continuation).toMatchObject({ offset: 2, original_query_limit: 6,
      original_result_rows: 6, source_query_executed_this_call: false, reference_expiry: "unchanged" });
    expect(fixture.explore).toHaveBeenCalledOnce();
  });

  it("refuses at exact cursor expiry and current authority/caller drift without a fresh query", async () => {
    for (const change of ["expiry", "authority", "caller"] as const) {
      const fixture = composition(), first = await fixture.page({ plan, page_rows: 2 });
      if (change === "expiry") fixture.tick(1000 + CATALOG_LIMITS.cursorMs);
      if (change === "authority") fixture.change();
      if (change === "caller") fixture.changeCaller();
      await expect(fixture.page({ plan, page_rows: 2, cursor: first.value.next_cursor as string }))
        .rejects.toMatchObject({ code: "EXPLORE_CURSOR_INVALID" });
      expect(fixture.explore).toHaveBeenCalledOnce();
    }
  });

  it("refuses an indivisible large row without slicing and does not enlarge the original response budget", async () => {
    const fixture = composition([{ label: "x".repeat(CATALOG_LIMITS.responseBytes) }]);
    await expect(fixture.page({ plan, page_rows: 2 })).rejects.toMatchObject({ code: "EXPLORE_ROW_TOO_LARGE" });
    expect(fixture.explore).toHaveBeenCalledOnce();
    const excessive = composition([{ label: "x".repeat(32769) }]);
    await expect(excessive.page({ plan, page_rows: 2 })).rejects.toMatchObject({ code: "EXPLORE_CONTINUATION_UNAVAILABLE" });
  });
});

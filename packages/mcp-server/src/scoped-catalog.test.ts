import { describe, expect, it } from "vitest";
import { CATALOG_LIMITS, ScopedCatalogIndex, ScopedCatalogSession, catalogResponseBytes, type CatalogEntry } from "./scoped-catalog.js";

function entries(count: number): CatalogEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `inventory.action_${String(index).padStart(5, "0")}`;
    return { id, title: `Replenish product ${index}`, summary: "Request a reviewed stock replenishment",
      aliases: [`sku${index}`, "restock"], value: { outcome: id, title: `Replenish product ${index}`, eligibility: "not_checked" },
      detail: () => ({ outcome: id, inputs: [{ name: "quantity", type: "integer", minimum: 1, maximum: index + 1 }],
        subjects: [{ binding: "stock", resource: "inventory.stock_items" }], eligibility: "not_checked" }) };
  });
}
const call = (session: ScopedCatalogSession, index: ScopedCatalogIndex, request = {}, binding = "north:maya:agent1:revision1") =>
  session.describe({ index, binding, request, key: "actions" });

describe("scoped indexed catalog", () => {
  it("ranks exact ids and strong phrases; tolerates incidental words and labels bounded partial alternatives", () => {
    const record = (id: string, title: string, summary = ""): CatalogEntry => ({ id, title, summary,
      value: { outcome: id }, detail: () => ({ outcome: id }) });
    const index = new ScopedCatalogIndex([
      record("review.approve_claim", "Approve claim", "Record a reviewed decision"),
      record("review.reject_claim", "Reject claim", "Record a reviewed decision"),
      record("review.audit", "Inspect decision", "Approve claim history"),
    ]);
    expect(index.search(" REVIEW / APPROVE-CLAIM ").ids[0]).toBe("review.approve_claim");
    expect(index.search("please approve the claim").ids[0]).toBe("review.approve_claim");
    const partial = call(new ScopedCatalogSession(), index, { query: "approve reject" });
    expect(partial.discovery).toHaveProperty("search_status", "partial_matches");
    expect(partial.actions).toEqual([
      expect.objectContaining({ outcome: "review.approve_claim", search_match: expect.objectContaining({ kind: "partial", missing_terms: ["reject"] }) }),
      expect.objectContaining({ outcome: "review.reject_claim", search_match: expect.objectContaining({ kind: "partial", missing_terms: ["approve"] }) }),
    ]);
    expect(index.search("unrelated absent approve register transaction").ids).toEqual([]);
    expect(index.search("approve claim 999").ids).toEqual([]); // Never drop an unmatched numeric identifier.
    expect(call(new ScopedCatalogSession(), index, { query: "approve reject" }).discovery).not.toHaveProperty("empty_search");
    expect(() => call(new ScopedCatalogSession(), index, { detail: "REVIEW.APPROVE_CLAIM" })).toThrow(/not available/);
  });

  it("identifies only a unique exact tier or a sole complete hit as unambiguous", () => {
    const record = (id: string, title: string): CatalogEntry => ({ id, title, summary: title,
      value: { outcome: id }, detail: () => ({ outcome: id }) });
    const index = new ScopedCatalogIndex([
      record("review.approve_claim", "Approve claim"), record("review.reject_claim", "Reject claim"),
      record("review.approve_archive", "Approve archived claim"),
    ]);
    expect(index.search("REVIEW / APPROVE-CLAIM")).toHaveProperty("unambiguous_id", "review.approve_claim");
    expect(index.search("please approve the claim")).toHaveProperty("unambiguous_id", "review.approve_claim");
    expect(index.search("claim")).not.toHaveProperty("unambiguous_id");
    expect(index.search("approve reject")).not.toHaveProperty("unambiguous_id");
    const duplicateNames = new ScopedCatalogIndex([record("one.approve", "Approve claim"), record("two.approve", "Approve claim")]);
    expect(duplicateNames.search("approve claim")).not.toHaveProperty("unambiguous_id");
  });

  it("emits structured current page state and exact schema continuation without implying source completeness", () => {
    const index = new ScopedCatalogIndex(entries(7));
    const session = new ScopedCatalogSession();
    const first = call(session, index, { limit: 5 });
    expect(first.pagination).toMatchObject({ state: "more_pages", scope: "authorized_catalog_metadata" });
    expect(first.discovery).toMatchObject({ currentness: "checked_current_authority", next_steps: [
      { kind: "continue_page", tool: "app.describe_actions", arguments: { limit: 5, cursor: first.next_cursor } },
    ] });
    const last = call(session, index, { limit: 5, cursor: first.next_cursor });
    expect(last.pagination).toHaveProperty("state", "exhausted");
    expect(last.discovery).toHaveProperty("next_steps.0.kind", "inspect_exact_details");
    const none = call(session, index, { query: "absent" });
    expect(none.pagination).toHaveProperty("state", "no_matches");
    expect(none.discovery).toHaveProperty("next_steps.0.kind", "revise_query");
  });

  it("only inlines an explicitly prepared complete authorized contract, otherwise gives an exact route", () => {
    const index = new ScopedCatalogIndex(entries(1));
    const session = new ScopedCatalogSession();
    const id = index.ids[0]!;
    const value = index.get(id)!.detail();
    const result = session.describe({ index, binding: "one", key: "actions", request: { query: "sku0" },
      inlineDetail: { id, value } });
    expect(result.inline_contract).toEqual(value);
    expect(result.discovery).toHaveProperty("contract_status", "inline_complete");
    const listingOnly = call(new ScopedCatalogSession(), index, { query: "sku0" });
    expect(listingOnly).not.toHaveProperty("inline_contract");
    expect(listingOnly.discovery).toHaveProperty("contract_status", "exact_detail_required");
    const tooLarge = session.describe({ index, binding: "one", key: "actions", request: { query: "sku0" },
      inlineDetail: { id, value: { outcome: id, inputs: "x".repeat(12_000) } } });
    expect(tooLarge).not.toHaveProperty("inline_contract");
    expect(tooLarge.discovery).toMatchObject({ contract_status: "exact_detail_required", inline_status: "complete_contract_exceeds_inline_bound",
      next_steps: [{ kind: "inspect_exact_details", tool: "app.describe_actions", arguments: { outcome: id } }] });
  });

  it("reports page counts and exact authorized match totals separately, with an unambiguous end", () => {
    const index = new ScopedCatalogIndex(entries(13));
    const session = new ScopedCatalogSession();
    const first = call(session, index, { limit: 5 });
    expect(first.pagination).toMatchObject({ page_item_count: 5, has_more: true, total: { kind: "exact", value: 13 } });
    const second = call(session, index, { limit: 5, cursor: first.next_cursor });
    const last = call(session, index, { limit: 5, cursor: second.next_cursor });
    expect(last.pagination).toMatchObject({ page_item_count: 3, has_more: false, total: { kind: "exact", value: 13 } });
    expect(last.next_cursor).toBeNull();
    expect(call(new ScopedCatalogSession(), index, { query: "absent" }).discovery).toHaveProperty("search_status", "no_matches");
    expect(call(new ScopedCatalogSession(), index).discovery).toHaveProperty("search_status", "no_query");
  });
  it("reports empty search only for a genuinely empty filtered result, never for hits or browsing", () => {
    const index = new ScopedCatalogIndex(entries(4));
    const session = new ScopedCatalogSession();
    expect(call(session, index, { query: "restock" }).discovery).not.toHaveProperty("empty_search");
    expect(call(session, index).discovery).not.toHaveProperty("empty_search");
    expect(call(session, index, { query: "unavailable phrase" }).discovery).toHaveProperty("empty_search", "no_matches_to_this_query");
  });

  it("indexes 8000 authorized records; exact lookup and selective lexical search do not scan the catalog", () => {
    const started = performance.now();
    const index = new ScopedCatalogIndex(entries(8_000));
    const buildMs = performance.now() - started;
    const session = new ScopedCatalogSession();
    const queryStart = performance.now();
    const searched = call(session, index, { query: "sku4123" });
    expect(searched.actions).toEqual([expect.objectContaining({ outcome: "inventory.action_04123" })]);
    expect(session.lastWork.visited).toBe(1);
    const detailed = call(session, index, { detail: "inventory.action_04123" });
    expect(detailed.actions).toEqual([expect.objectContaining({ inputs: [{ name: "quantity", type: "integer", minimum: 1, maximum: 4124 }] })]);
    expect(session.lastWork.visited).toBe(0);
    expect(session.lastWork.bytes).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
    console.info(JSON.stringify({ catalog_benchmark: { records: 8000, build_ms: buildMs,
      search_and_detail_ms: performance.now() - queryStart, search_candidates: 1, detail_candidates: 0 } }));
  });

  it("lists in stable order without repeats; query aliases are deterministic and paginated", () => {
    const index = new ScopedCatalogIndex(entries(51).reverse());
    const session = new ScopedCatalogSession();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = call(session, index, { query: "restock", limit: 20, ...(cursor ? { cursor } : {}) });
      ids.push(...(result.actions as Array<{ outcome: string }>).map((value) => value.outcome));
      cursor = result.next_cursor as string | undefined;
      expect(session.lastWork.bytes).toBeLessThanOrEqual(16384);
    } while (cursor);
    expect(ids).toEqual(entries(51).map((entry) => entry.id));
    expect(new Set(ids).size).toBe(51);
  });

  it.each(["south:maya:agent1:revision1", "north:lee:agent1:revision1", "north:maya:agent2:revision1", "north:maya:agent1:revision2"])(
    "rejects a cursor across changed scope or current authority (%s)", (binding) => {
      const index = new ScopedCatalogIndex(entries(10));
      const session = new ScopedCatalogSession();
      const first = call(session, index);
      expect(first.next_cursor).toMatch(/^cur_[A-Za-z0-9_-]{43}$/u);
      expect(first.next_cursor).not.toContain("maya");
      expect(() => call(session, index, { cursor: first.next_cursor }, binding)).toThrowError(/Restart discovery/u);
    });

  it("replays the same page consistently but rejects tampered, cross-query, cross-page-size, expired and foreign-session cursors", () => {
    let now = 10;
    const index = new ScopedCatalogIndex(entries(15));
    const session = new ScopedCatalogSession(() => now);
    const cursor = call(session, index, { query: "restock" }).next_cursor;
    expect(() => call(session, index, { query: "restock", cursor: `${cursor}a` })).toThrow();
    expect(() => call(session, index, { query: "replenish", cursor })).toThrow();
    expect(() => call(session, index, { query: "restock", limit: 10, cursor })).toThrow();
    expect(() => call(new ScopedCatalogSession(() => now), index, { query: "restock", cursor })).toThrow();
    const page = call(session, index, { query: "restock", cursor });
    const next = page.next_cursor;
    expect(call(session, index, { query: "restock", cursor })).toEqual(page);
    now += CATALOG_LIMITS.cursorMs;
    expect(() => call(session, index, { query: "restock", cursor: next })).toThrow();
  });

  it("bounds bytes without truncating contracts and rejects oversized exact contracts", () => {
    const records = entries(6).map((entry) => ({ ...entry,
      detail: () => ({ outcome: entry.id, inputs: [{ name: "kind", enum: ["x".repeat(5_000)] }] }) }));
    const index = new ScopedCatalogIndex(records);
    const session = new ScopedCatalogSession();
    const page = session.describe({ index, request: {}, binding: "one", key: "actions", legacy: true });
    expect(page.actions).toHaveLength(1);
    expect(page.next_cursor).toBeTypeOf("string");
    expect(JSON.stringify(page)).toContain("x".repeat(5_000));
    expect(catalogResponseBytes(page)).toBeLessThanOrEqual(16384);
    const wireTooLarge = new ScopedCatalogIndex([{ ...records[0]!, detail: () => ({ inputs: "x".repeat(10_000) }) }]);
    expect(() => call(session, wireTooLarge, { detail: records[0]!.id })).toThrowError(/does not fit/u);
    const tooLarge = new ScopedCatalogIndex([{ ...records[0]!, detail: () => ({ inputs: "x".repeat(16384) }) }]);
    expect(() => call(session, tooLarge, { detail: records[0]!.id })).toThrowError(/no constraints were truncated/iu);
    try { call(session, wireTooLarge, { detail: records[0]!.id }); }
    catch (error) {
      expect(error).toMatchObject({ code: "CATALOG_CONTRACT_TOO_LARGE", details: {
        kind: "response", measured_bytes: expect.any(Number), limit_bytes: 16384,
        retryable: false, recovery: "operator_boundary_review",
      } });
      expect((error as Error).message).toContain("changing the page size will not help");
      expect((error as Error).message).toContain("Discovery compatibility");
    }
  });

  it("budgets session discovery across revisions, not just a page", () => {
    const index = new ScopedCatalogIndex(entries(500));
    const session = new ScopedCatalogSession();
    for (let turn = 0; turn < 15; turn++) call(session, index, { limit: 20 }, `scope:revision${turn}`);
    expect(() => call(session, index, { limit: 20 }, "scope:newrevision")).toThrowError(/session reached its discovery limit/u);
  });

  it("bounds empty-query work and failed-call volume; a returned value cannot mutate cached summaries", () => {
    const session = new ScopedCatalogSession();
    const index = new ScopedCatalogIndex(entries(2));
    const first = call(session, index);
    (first.actions as Array<Record<string, unknown>>)[0]!.outcome = "forged";
    expect((call(session, index).actions as Array<Record<string, unknown>>)[0]!.outcome).not.toBe("forged");
    for (let turn = 2; turn < 80; turn++) call(session, index, { query: "no_matching_term" });
    expect(() => call(session, index, { query: "none" })).toThrowError(/discovery limit/u);
  });

  it("has the same exact-lookup refusal for unknown and withheld entries", () => {
    const index = new ScopedCatalogIndex(entries(10).filter((entry) => entry.id !== "inventory.action_00003"));
    const session = new ScopedCatalogSession();
    const messages = ["inventory.action_00003", "not.real"].map((detail) => {
      try { call(session, index, { detail }); } catch (error) { return (error as Error).message; }
    });
    expect(messages[0]).toBe(messages[1]);
    expect(call(session, index, { query: "sku3" }).actions).toEqual([]);
  });
});

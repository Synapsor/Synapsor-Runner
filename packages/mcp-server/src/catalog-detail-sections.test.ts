import { describe, expect, it } from "vitest";
import { CATALOG_LIMITS, ScopedCatalogIndex, ScopedCatalogSession, catalogResponseBytes } from "./scoped-catalog.js";

const wide = () => ({ outcome: "inventory.reserve", inputs: Array.from({ length: 32 }, (_, i) => ({
  name: `quantity_${i}`, required: true, origin: "caller_business_input", type: "integer",
  description: "Reviewed caller quantity: é漢字 ".repeat(16), minimum: 1, maximum: i + 10,
})), approval: { disclosure: "partial", mode: "human_review", conditions: "not_disclosed" },
business_effects: { assignments: [{ field: "state", operation: "set", value: "reserved" }],
  companion_mutations: [{ field: "version", operation: "increment", amount: 1 }] } });
function fixture(value: Record<string, unknown>, clock?: () => number) {
  const index = new ScopedCatalogIndex([{ id: "inventory.reserve", title: "Reserve inventory", summary: "Reviewed reservation",
    value: { outcome: "inventory.reserve" }, detail: () => value }]);
  const session = new ScopedCatalogSession(clock);
  const call = (request: Record<string, unknown> = { detail: "inventory.reserve" }, binding = "caller-one:revision-one") =>
    session.describe({ index, binding, key: "actions", request, detailValue: value });
  return { call, session };
}
describe("bounded exact contract sections", () => {
  it("offers executable sections for an exact wide contract that exceeded the old entry boundary", () => {
    const value = wide();
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(CATALOG_LIMITS.detailBytes);
    const f = fixture(value);
    const overview = f.call();
    expect(overview.discovery).toHaveProperty("contract_status", "partial_navigable");
    expect(overview.contract_navigation).toMatchObject({ revision: expect.stringMatching(/^rev_/), complete_contract: false });
    expect(catalogResponseBytes(overview)).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
    const assembled: Record<string, unknown> = {};
    for (const section of (overview.contract_navigation as any).sections) {
      let args = section.next_call.arguments;
      const units: Array<{ key: string; value: unknown }> = [];
      do {
        const page = f.call({ detail: args.outcome, section: args.section, contract_revision: args.contract_revision, limit: args.limit, cursor: args.cursor });
        expect(page.contract_section).toMatchObject({ section: section.section, revision: (overview.contract_navigation as any).revision });
        expect(catalogResponseBytes(page)).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
        units.push(...(page.contract_section as any).items);
        args = page.next_cursor ? { ...args, cursor: page.next_cursor } : undefined;
      } while (args);
      assembled[section.section] = section.representation === "array" ? units.map(unit => unit.value)
        : section.representation === "object" ? Object.fromEntries(units.map(unit => [unit.key, unit.value])) : units[0]!.value;
    }
    expect(assembled).toEqual(value);
  });

  it("keeps a fitting exact contract complete and refuses an indivisible oversized value", () => {
    const small = { outcome: "inventory.reserve", inputs: [{ name: "quantity", type: "integer", required: true }] };
    expect(fixture(small).call()).toMatchObject({ actions: [small] });
    expect(fixture(small).call()).not.toHaveProperty("contract_navigation");
    expect(() => fixture({ ...small, description: "x".repeat(16_384) }).call()).toThrow(expect.objectContaining({ code: "CATALOG_CONTRACT_TOO_LARGE" }));
  });

  it("recommends bounded section batches independently of the index default and respects explicit limits", () => {
    const f = fixture(wide());
    const overview = f.call();
    const section = (overview.contract_navigation as any).sections.find((entry: any) => entry.section === "inputs");
    expect(section.next_call.arguments.limit).toBe(CATALOG_LIMITS.maxPage);
    const args = section.next_call.arguments;
    const page = f.call({ detail: args.outcome, section: args.section, contract_revision: args.contract_revision, limit: args.limit });
    // Large units still reduce a recommended batch to the wire envelope.
    expect((page.contract_section as any).items.length).toBeLessThanOrEqual(CATALOG_LIMITS.maxPage);
    expect(catalogResponseBytes(page)).toBeLessThanOrEqual(CATALOG_LIMITS.responseBytes);
    expect(page.next_cursor).toMatch(/^cur_/);
    expect(() => f.call({ detail: args.outcome, section: args.section, contract_revision: args.contract_revision,
      limit: 5, cursor: page.next_cursor })).toThrow(expect.objectContaining({ code: "CATALOG_CURSOR_INVALID" }));

    const explicit = fixture(wide()).call({ detail: "inventory.reserve", section: "@sections", limit: 2 });
    expect(explicit.pagination).toMatchObject({ page_item_count: 2 });
    expect((explicit.contract_navigation as any).sections.every((entry: any) => entry.next_call.arguments.limit === 2)).toBe(true);
    const smallPage = f.call({ detail: "inventory.reserve", section: "inputs", limit: 2 });
    expect((smallPage.contract_section as any).items).toHaveLength(2);
  });

  it("supports focused exact input while binding continuation to section/current trusted authority", () => {
    const f = fixture(wide());
    const input = f.call({ detail: "inventory.reserve", section: "inputs", item: "quantity_27" });
    expect(input.contract_section).toMatchObject({ item: "quantity_27", items: [{ key: "27", value: { name: "quantity_27", required: true } }], complete_section: false });
    const page = f.call({ detail: "inventory.reserve", section: "inputs", limit: 2 });
    expect(page.next_cursor).toMatch(/^cur_/);
    const revision = (page.contract_section as any).revision;
    expect(() => f.call({ detail: "inventory.reserve", section: "inputs", contract_revision: revision }, "caller-one:revision-two")).toThrow(expect.objectContaining({ code: "CATALOG_CURSOR_INVALID" }));
    for (const [request, binding] of [
      [{ detail: "inventory.reserve", section: "approval", limit: 2, cursor: page.next_cursor }, "caller-one:revision-one"],
      [{ detail: "inventory.reserve", section: "inputs", limit: 3, cursor: page.next_cursor }, "caller-one:revision-one"],
      [{ detail: "inventory.reserve", section: "inputs", limit: 2, cursor: page.next_cursor }, "caller-two:revision-one"],
      [{ detail: "inventory.reserve", section: "inputs", limit: 2, cursor: page.next_cursor }, "caller-one:revision-two"],
    ] as const) expect(() => f.call(request, binding)).toThrow(expect.objectContaining({ code: "CATALOG_CURSOR_INVALID" }));
    expect(() => f.call({ detail: "inventory.reserve", section: "inputs", item: "secret_input" })).toThrow(expect.objectContaining({ code: "CATALOG_ENTRY_UNAVAILABLE" }));
  });

  it("binds section-index continuation, exact public revision and TTL without renewing evidence", () => {
    let now = 1000;
    const value = { ...wide(), ...Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`extra_${i}`, { supported: false, values: [] }])) };
    const f = fixture(value, () => now);
    const overview = f.call();
    const navigation = overview.contract_navigation as any;
    expect(navigation.complete_section_index).toBe(false);
    expect(overview.pagination).toMatchObject({ page_item_count: 5, has_more: true, total: { value: 19 }, scope: "contract_section_index" });
    const args = (overview.discovery as any).next_steps[0].arguments;
    const follow = { ...args, detail: args.outcome }; delete follow.outcome;
    expect(f.call(follow).contract_navigation).toHaveProperty("revision", navigation.revision);
    for (const request of [{ ...follow, contract_revision: `rev_${"x".repeat(43)}` }, { ...follow, limit: 4 },
      { ...follow, section: "inputs" }, { ...follow, cursor: `cur_${"x".repeat(43)}` }]) {
      expect(() => f.call(request)).toThrow(expect.objectContaining({ code: "CATALOG_CURSOR_INVALID" }));
    }
    now += CATALOG_LIMITS.cursorMs;
    expect(() => f.call(follow)).toThrow(expect.objectContaining({ code: "CATALOG_CURSOR_INVALID" }));
    expect(() => f.call({ detail: "inventory.reserve", section: "inputs", contract_revision: navigation.revision })).toThrow(expect.objectContaining({ code: "CATALOG_CURSOR_INVALID" }));
  });

  it("section pages use the original cumulative meter rather than a page-local allowance", () => {
    const f = fixture(wide());
    let failure: any;
    for (let i = 0; i < CATALOG_LIMITS.sessionCalls + 1; i++) {
      try { f.call({ detail: "inventory.reserve", section: "inputs", item: "quantity_1" }); }
      catch (error) { failure = error; break; }
    }
    expect(failure?.code).toBe("CATALOG_SESSION_LIMIT");
  });
});

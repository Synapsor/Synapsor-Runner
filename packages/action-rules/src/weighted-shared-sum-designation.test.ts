import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest, canonicalJsonStringify } from "@synapsor-runner/protocol";
import * as exports from "./index.js";
import { parseSharedSumDesignation } from "./shared-sum-designation.js";
import { experimentalSharedSumFixture } from "./testing/experimental-shared-sum-fixture.js";

function api(name: string) {
  const candidate = (exports as Record<string, unknown>)[name];
  expect(typeof candidate, `supported ${name} export`).toBe("function");
  return candidate as (value: unknown) => any;
}
export function weightedDesignationFixture() {
  const hash = canonicalJsonDigest("weighted policy source"), money = { kind: "money_minor", currency: "USD" }, minutes = { kind: "integer", unit: "minutes" };
  const provenance = { source_session: randomUUID(), source_digest: hash, store_digest: hash, start: 1, end: 4 };
  const valuation = (input_unit: unknown, numerator: string) => ({ input_unit, output_unit: money, numerator, denominator: "1", version: "policy.v1", provenance });
  return { schema_version: "synapsor.shared-sum-designation.v2", kind: "weighted_shared_sum", source: "customer_source",
    scope: { tenant_field: "tenant_id", principal_field: "customer_id" },
    guard: { resource: "customer_periods", identity_field: "id", period_start_field: "starts_at", period_end_field: "ends_at" },
    populations: [{ id: "grants", resource: "minute_grants", guard_relationship: "minute_grants.period" },
      { id: "discounts", resource: "discounts", guard_relationship: "discounts.period" }],
    measures: [{ id: "minutes", population: "grants", field: "minutes", input_unit: minutes, meaning: "Granted service minutes.", valuation: valuation(minutes, "2"), raw_cap: { resource: "customer_periods", field: "minutes_cap" } },
      { id: "discount_cents", population: "discounts", field: "amount", input_unit: money, meaning: "Discount in USD minor units.", valuation: valuation(money, "1"), raw_cap: { resource: "customer_periods", field: "discount_cap" } }],
    limit: { resource: "customer_periods", field: "weighted_limit", unit: money, meaning: "Combined budget in USD minor units." },
    period: { kind: "utc_calendar_month", interval: "half_open", attribution: "host_execution_admission" },
    revaluation: "complete_selected_period_current_state", external_writers: "participating_only",
    participating_outcomes: ["grant.minutes", "grant.discount", "change.limit"] };
}
describe("prospective weighted shared-SUM designation DATA", () => {
  it("round trips the exact closed original units and immutable rational valuation", () => {
    const parse = api("parseWeightedSharedSumDesignation"), d = weightedDesignationFixture();
    expect(parse(d)).toEqual(d); expect(canonicalJsonStringify(parse(d))).toBe(canonicalJsonStringify(d));
  });
  it("preserves the old same-unit designation bytes and parser behavior", () => {
    const f = experimentalSharedSumFixture(), { kind: _, schema_version: __, ...fields } = f.designation;
    const legacy = { ...fields, schema_version: "synapsor.shared-sum-designation.v1", kind: "shared_sum",
      unit: { kind: "integer", unit: "reviewed_credits", meaning: "One reviewed credit." } };
    const before = canonicalJsonStringify(legacy);
    expect(canonicalJsonStringify(parseSharedSumDesignation(legacy))).toBe(before);
    expect(() => parseSharedSumDesignation(weightedDesignationFixture())).toThrow();
  });
  it("shares one population across field measures and rejects duplicated terms", () => {
    const parse = api("parseWeightedSharedSumDesignation"), d = weightedDesignationFixture();
    const shared = { ...d, populations: [d.populations[0]], measures: [d.measures[0], { ...d.measures[1], population: "grants", field: "discount_amount" }] };
    expect(parse(shared)).toEqual(shared);
    expect(() => parse({ ...shared, measures: [shared.measures[0], { ...shared.measures[0], id: "alias" }] })).toThrow();
    expect(() => parse({ ...d, populations: [...d.populations, { ...d.populations[0], id: "alias" }] })).toThrow();
    expect(() => parse({ ...d, measures: [d.measures[0]] })).toThrow();
    expect(() => parse({ ...d, measures: Array.from({ length: 9 }, (_, n) => ({ ...d.measures[0], id: `m${n}`, field: `q${n}` })) })).toThrow();
  });
  it("requires positive bounded reduced decimal rationals without floating coercion", () => {
    const parse = api("parseWeightedSharedSumDesignation"), d = weightedDesignationFixture();
    const rate = (numerator: unknown, denominator: unknown) => ({ ...d, measures: [{ ...d.measures[0], valuation: { ...d.measures[0]!.valuation, numerator, denominator } }, d.measures[1]] });
    expect(parse(rate("1", "3")).measures[0].valuation.denominator).toBe("3");
    for (const pair of [["0", "1"], ["-1", "1"], ["1", "0"], ["01", "1"], ["2", "4"], ["1000000000000", "1"], ["1.5", "1"], [2, 1]])
      expect(() => parse(rate(...pair as [unknown, unknown]))).toThrow();
  });
  it("keeps explicit money units and refuses valuation unit/scale substitutions", () => {
    const parse = api("parseWeightedSharedSumDesignation"), d = weightedDesignationFixture();
    const changed = structuredClone(d); changed.measures[0]!.valuation.output_unit = { kind: "money_minor", currency: "EUR" };
    expect(() => parse(changed)).toThrow();
    const input = structuredClone(d); input.measures[0]!.valuation.input_unit = { kind: "integer", unit: "hours" };
    expect(() => parse(input)).toThrow();
    expect(() => parse({ ...d, scale: 60 })).toThrow();
    expect(() => parse({ ...d, measures: [{ ...d.measures[0], input_unit: { kind: "integer" } }, d.measures[1]] })).toThrow();
  });
  it("uses the Source currency grammar even when every money unit agrees", () => {
    const parse = api("parseWeightedSharedSumDesignation");
    for (const currency of ["usd", "US", "USDD", "123"]) {
      const d = weightedDesignationFixture();
      d.limit.unit.currency = currency;
      for (const measure of d.measures) {
        measure.valuation.output_unit.currency = currency;
        if (measure.input_unit.kind === "money_minor") Object.assign(measure.input_unit, { currency });
        if ((measure.valuation.input_unit as { kind: string }).kind === "money_minor") Object.assign(measure.valuation.input_unit as object, { currency });
      }
      expect(() => parse(d), currency).toThrow();
    }
  });
  it("binds weighted and raw limits to the same stable guard fields", () => {
    const parse = api("parseWeightedSharedSumDesignation"), d = weightedDesignationFixture();
    expect(() => parse({ ...d, limit: { ...d.limit, resource: "other" } })).toThrow();
    const other = structuredClone(d); other.measures[0]!.raw_cap.resource = "other";
    expect(() => parse(other)).toThrow();
    expect(() => parse({ ...d, guard: { ...d.guard, period_end_field: d.guard.period_start_field } })).toThrow();
  });
  it("requires exact finite Source provenance instead of actor or latest-rate claims", () => {
    const parse = api("parseWeightedSharedSumDesignation"), d = weightedDesignationFixture();
    const changed = structuredClone(d); changed.measures[0]!.valuation.provenance.end = 0;
    expect(() => parse(changed)).toThrow();
    expect(() => parse({ ...d, actor: "local_installation_operator" })).toThrow();
    expect(() => parse({ ...d, measures: [{ ...d.measures[0], valuation: { ...d.measures[0]!.valuation, latest: true } }, d.measures[1]] })).toThrow();
  });
  it("requires a named participant set and exact UTC month admission semantics", () => {
    const parse = api("parseWeightedSharedSumDesignation"), d = weightedDesignationFixture();
    expect(() => parse({ ...d, participating_outcomes: [] })).toThrow();
    expect(() => parse({ ...d, participating_outcomes: ["grant.minutes", "grant.minutes"] })).toThrow();
    for (const period of [{ ...d.period, kind: "rolling_30_days" }, { ...d.period, attribution: "commit_time" }, { ...d.period, now: "2026-10-01" }])
      expect(() => parse({ ...d, period })).toThrow();
    expect(() => parse({ ...d, revaluation: "future_requests_only" })).toThrow();
  });
  it("retains separate confirmation DATA without blessing a model actor claim", () => {
    const parse = api("parseReviewedWeightedSharedSum"), d = weightedDesignationFixture(), hash = canonicalJsonDigest("protected question reference");
    const confirmation = { actor: "local_installation_operator", decision: "new_attributed_decision", recorded_at: "2026-10-09T20:00:00.000Z",
      question: { id: randomUUID(), revision: 1, digest: hash }, proposal_digest: hash, context_digest: hash, source_digest: hash,
      catalog_digest: hash, generation_lock_fingerprint: hash, read_dependencies: [{ name: "customer.read", digest: hash }], designation_digest: canonicalJsonDigest(d) };
    const record = { schema_version: "synapsor.reviewed-shared-sum.v2", designation: d, confirmation };
    expect(parse(record)).toEqual(record);
    expect(() => parse({ ...record, confirmation: { ...confirmation, actor: "model" } })).toThrow();
    expect(() => parse({ ...record, designation: { ...d, participating_outcomes: ["different"] } })).toThrow();
  });
  it("renders units, exact valuations, caps, participants and current-period revaluation", () => {
    const read = api("weightedSharedSumReadback"), d = weightedDesignationFixture(), lines = read(d).join("\n");
    for (const value of ["minutes", "USD", "2/1", "minutes_cap", "weighted_limit", "UTC", "half-open", "admission", "revalue", "grant.discount"])
      expect(lines).toContain(value);
  });
});

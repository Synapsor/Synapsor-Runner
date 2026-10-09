import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createActionRuleAuthority, parseActionRuleAuthority } from "./authority.js";
import { actionRuleRegistryDigest, createActionRuleRegistry, snapshotActionRuleRegistry } from "./registry.js";
import { deriveReviewedWeightedSharedSumProtection } from "./weighted-protection.js";
import { weightedConstraintFixture } from "./testing/weighted-constraint-fixture.js";

// Synthetic component review references are DATA, not native operator consent.
function fixture(options: Parameters<typeof weightedConstraintFixture>[0] = {}) {
  const f = weightedConstraintFixture(options);
  const input = { name: "weighted_authority", action_boundary_name: "weighted.actions",
    catalog: f.catalog, rules: f.entries, shared_sum: f.shared_sum };
  return { f, input, loaded: createActionRuleAuthority(input) };
}
function reseal(value: any): void { const { digest: _, ...material } = value; value.digest = canonicalJsonDigest(material); }

describe("prospective persisted weighted authority V3", () => {
  it.each([{}, { sharedPopulation: true }, { third: true }])("reconstructs complete V3 protection through the real constructor (%j)", options => {
    const { input, loaded } = fixture(options);
    const cold = parseActionRuleAuthority(JSON.parse(JSON.stringify(loaded.authority)), loaded.authority.digest);
    expect(cold).toEqual(loaded);
    expect(cold.authority.schema_version).toBe("synapsor.action-rule-authority.v3");
    expect(cold.authority.action_boundary.schema_version).toBe("synapsor.semantic-action-boundary.v3");
    expect(cold.authority.action_boundary.shared_sum_digest).toBe(canonicalJsonDigest(input.shared_sum));
    expect(cold.registry.schema_version).toBe("synapsor.action-rule-registry.v3");
    expect(deriveReviewedWeightedSharedSumProtection(cold.registry)).toBeDefined();
    expect(snapshotActionRuleRegistry(structuredClone(cold.registry))).toEqual(cold.registry);
    expect(Object.isFrozen(cold.registry.shared_sum?.designation)).toBe(true);
  });
  it("binds policy and confirmation changes into complete authority without changing compiled rules", () => {
    const { input, loaded } = fixture(), changed = structuredClone(input);
    const rate = changed.shared_sum.designation.measures[0]!.valuation;
    rate.numerator = "3"; rate.version = "policy.v2";
    changed.shared_sum.confirmation.question.revision += 1;
    changed.shared_sum.confirmation.designation_digest = canonicalJsonDigest(changed.shared_sum.designation);
    const next = createActionRuleAuthority(changed);
    expect(next.authority.digest).not.toBe(loaded.authority.digest);
    expect(next.authority.action_boundary.digest).not.toBe(loaded.authority.action_boundary.digest);
    expect(next.registry.digest).not.toBe(loaded.registry.digest);
    expect(next.registry.rules.map(r => r.compiled.compiled_plan_digest)).toEqual(loaded.registry.rules.map(r => r.compiled.compiled_plan_digest));
  });
  it.each([
    ["missing record", (v: any) => { delete v.shared_sum; }],
    ["V2 tag with weighted record", (v: any) => { v.schema_version = "synapsor.action-rule-authority.v2"; }],
    ["V1 tag with weighted record", (v: any) => { v.schema_version = "synapsor.action-rule-authority.v1"; }],
    ["wrong Boundary tag", (v: any) => { v.action_boundary.schema_version = "synapsor.semantic-action-boundary.v2"; reseal(v.action_boundary); }],
    ["changed reviewed binding", (v: any) => { v.action_boundary.shared_sum_digest = canonicalJsonDigest("other"); reseal(v.action_boundary); }],
    ["unknown extension", (v: any) => { v.optional_protection = false; }],
  ] as const)("refuses serialized authority %s after resealing", (_, mutate) => {
    const value = structuredClone(fixture().loaded.authority); mutate(value); reseal(value);
    expect(() => parseActionRuleAuthority(value)).toThrow();
  });
  it.each([
    ["missing record", (v: any) => { delete v.shared_sum; }],
    ["V2 tag with weighted record", (v: any) => { v.schema_version = "synapsor.action-rule-registry.v2"; }],
    ["V1 tag with weighted record", (v: any) => { v.schema_version = "synapsor.action-rule-registry.v1"; }],
    ["unknown extension", (v: any) => { v.optional_protection = false; }],
  ] as const)("refuses serialized registry %s after recomputing its material digest", (_, mutate) => {
    const value = structuredClone(fixture().loaded.registry); mutate(value); value.digest = actionRuleRegistryDigest(value);
    expect(() => snapshotActionRuleRegistry(value)).toThrow();
  });
  it("requires the compiler hook for direct registry construction and cold snapshots", () => {
    const value = structuredClone(fixture().loaded.registry);
    for (const rule of value.rules) rule.action_boundary_digest = canonicalJsonDigest("unbound boundary");
    value.digest = actionRuleRegistryDigest(value);
    expect(() => createActionRuleRegistry(value)).toThrow(expect.objectContaining({ path: "source.hard_limit.weighted_boundary_inventory" }));
    expect(() => snapshotActionRuleRegistry(value)).toThrow(expect.objectContaining({ path: "source.hard_limit.weighted_boundary_inventory" }));
  });
  it("refuses a removed writer and stale inspected dependencies before publishing", () => {
    const { input } = fixture(), removed = structuredClone(input), stale = structuredClone(input);
    removed.rules.pop(); stale.shared_sum.confirmation.read_dependencies[0]!.digest = canonicalJsonDigest("stale read");
    expect(() => createActionRuleAuthority(removed)).toThrow(expect.objectContaining({ path: "source.hard_limit.weighted_writer_inventory" }));
    expect(() => createActionRuleAuthority(stale)).toThrow();
  });
});

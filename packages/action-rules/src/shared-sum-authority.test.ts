import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createActionRuleAuthority, parseActionRuleAuthority } from "./authority.js";
import { actionRuleRegistryDigest, snapshotActionRuleRegistry } from "./registry.js";
import { experimentalSharedSumFixture } from "./testing/experimental-shared-sum-fixture.js";
import { type ReviewedSharedSumV1, type SharedSumDesignationV1 } from "./shared-sum-designation.js";

function fixture() {
  const f = experimentalSharedSumFixture();
  const { schema_version: _version, kind: _kind, ...fields } = f.designation;
  const designation: SharedSumDesignationV1 = { ...fields, schema_version: "synapsor.shared-sum-designation.v1",
    kind: "shared_sum", unit: { kind: "integer", unit: "reviewed_credits", meaning: "One credit is one reviewed service unit." } };
  const reads = new Map(f.entries.map(entry => [entry.read_boundary_name, entry.read_boundary_digest]));
  const hash = f.catalog.generation_lock_fingerprint;
  // Synthetic codec references; native confirmation is separately owned by the
  // publishing host and is not qualified by this unit fixture.
  const reviewed: ReviewedSharedSumV1 = { schema_version: "synapsor.reviewed-shared-sum.v1", designation,
    confirmation: { actor: "local_installation_operator", decision: "new_attributed_decision",
      recorded_at: "2026-10-09T00:00:00.000Z", question: { id: "12345678-1234-1234-1234-123456789abc", revision: 1, digest: hash },
      proposal_digest: hash, context_digest: hash, source_digest: hash, catalog_digest: canonicalJsonDigest(f.catalog),
      generation_lock_fingerprint: hash, read_dependencies: [...reads].map(([name, digest]) => ({ name, digest })),
      designation_digest: canonicalJsonDigest(designation) } };
  const input = { name: "shared_native_experiment", action_boundary_name: "shared.actions", catalog: f.catalog,
    rules: f.entries, shared_sum: reviewed };
  return { f, input, loaded: createActionRuleAuthority(input) };
}
function reseal(record: any): void {
  const { digest: _digest, ...material } = record;
  record.digest = canonicalJsonDigest(material);
}

describe("persisted shared-SUM authority and registry versions", () => {
  it("preserves captured legacy v1 authority, Boundary and registry digests", () => {
    const f = experimentalSharedSumFixture();
    expect(f.authority.authority.digest).toBe("sha256:54f8dd5c2b0df2fe3b7f6602aa44f0eef5138fc8006161598b068303b61f2a5f");
    expect(f.authority.authority.action_boundary.digest).toBe("sha256:d192e4dc8add87713dbde77ed74b4af5e88727cdd53d69c6323b79a472f68e64");
    expect(f.registry.digest).toBe("sha256:9bc012b649a0517f67c610ba2dee90f8392094bb2af1e1dfe082c8caaa9e50c4");
    const cold = parseActionRuleAuthority(JSON.parse(JSON.stringify(f.authority.authority)));
    expect(cold.authority).toEqual(f.authority.authority);
    expect(cold.registry.schema_version).toBe("synapsor.action-rule-registry.v1");
    expect(cold.registry).not.toHaveProperty("shared_sum");
  });

  it("reconstructs v2 current authority and its protection from serialized records", () => {
    const { input, loaded } = fixture();
    const cold = parseActionRuleAuthority(JSON.parse(JSON.stringify(loaded.authority)), loaded.authority.digest);
    expect(cold).toEqual(loaded);
    expect(cold.authority.schema_version).toBe("synapsor.action-rule-authority.v2");
    expect(cold.authority.action_boundary.schema_version).toBe("synapsor.semantic-action-boundary.v2");
    expect(cold.authority.action_boundary.shared_sum_digest).toBe(canonicalJsonDigest(input.shared_sum));
    expect(cold.registry.schema_version).toBe("synapsor.action-rule-registry.v2");
    expect(snapshotActionRuleRegistry(structuredClone(cold.registry))).toEqual(cold.registry);
    expect(Object.isFrozen(cold.registry.shared_sum?.designation)).toBe(true);
    expect(cold.registry.rules.every(r => r.action_boundary_digest === cold.authority.action_boundary.digest)).toBe(true);
  });

  it("binds changed confirmation into Boundary and registry digests without rewriting compiled plans", () => {
    const { input, loaded } = fixture();
    const next = structuredClone(input);
    next.shared_sum.confirmation.question.revision += 1;
    next.shared_sum.confirmation.question.digest = `sha256:${"b".repeat(64)}`;
    const changed = createActionRuleAuthority(next);
    expect(changed.authority.digest).not.toBe(loaded.authority.digest);
    expect(changed.authority.action_boundary.digest).not.toBe(loaded.authority.action_boundary.digest);
    expect(changed.registry.digest).not.toBe(loaded.registry.digest);
    expect(changed.registry.rules.map(r => r.compiled.compiled_plan_digest))
      .toEqual(loaded.registry.rules.map(r => r.compiled.compiled_plan_digest));
  });

  it.each([
    ["missing designation", (a: any) => { delete a.shared_sum; }],
    ["v1 downgrade with designation", (a: any) => { a.schema_version = "synapsor.action-rule-authority.v1"; }],
    ["v1 downgrade after stripping designation", (a: any) => { delete a.shared_sum; a.schema_version = "synapsor.action-rule-authority.v1"; }],
    ["unknown version", (a: any) => { a.schema_version = "synapsor.action-rule-authority.v3"; }],
    ["extra authority key", (a: any) => { a.optional_verifier = false; }],
    ["changed Boundary binding", (a: any) => { a.action_boundary.shared_sum_digest = `sha256:${"b".repeat(64)}`; reseal(a.action_boundary); }],
    ["participant removed", (a: any) => { a.rules.pop(); }],
  ])("refuses %s on cold authoritative parse even after outer digest is recomputed", (_name, mutate) => {
    const { loaded } = fixture(); const stored: any = structuredClone(loaded.authority);
    mutate(stored); reseal(stored);
    expect(() => parseActionRuleAuthority(stored)).toThrow();
  });

  it.each([
    ["missing designation", (r: any) => { delete r.shared_sum; }],
    ["v1 carrying designation", (r: any) => { r.schema_version = "synapsor.action-rule-registry.v1"; }],
    ["unknown version", (r: any) => { r.schema_version = "synapsor.action-rule-registry.v3"; }],
    ["unknown authority key", (r: any) => { r.optional_verifier = false; }],
    ["unbound participant Boundary", (r: any) => { r.rules[0].action_boundary_digest = `sha256:${"b".repeat(64)}`; }],
  ])("refuses parsed registry %s before returning an indexed snapshot", (_name, mutate) => {
    const { loaded } = fixture(); const stored: any = structuredClone(loaded.registry); mutate(stored);
    stored.digest = actionRuleRegistryDigest(stored);
    expect(() => snapshotActionRuleRegistry(stored)).toThrow();
  });

  it.each(["catalog_digest", "generation_lock_fingerprint", "read_dependencies"] as const)
    ("refuses stale confirmed %s while constructing current authority", key => {
      const { input } = fixture(); const changed = structuredClone(input);
      if (key === "read_dependencies") changed.shared_sum.confirmation.read_dependencies[0]!.digest = `sha256:${"b".repeat(64)}`;
      else changed.shared_sum.confirmation[key] = `sha256:${"b".repeat(64)}`;
      expect(() => createActionRuleAuthority(changed)).toThrow();
    });
});

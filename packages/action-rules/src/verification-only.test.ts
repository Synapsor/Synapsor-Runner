import { describe, expect, it } from "vitest";
import { compileActionRule, createActionRuleCompiler } from "./compile.js";
import { normalizeActionRuleCatalog } from "./normalize.js";
import { completeCollectionFixture } from "./testing/complete-collection-fixture.js";
import { evaluateActionRule } from "./evaluate.js";

function insertFixture(engine: "postgres" | "mysql") {
  const f = completeCollectionFixture(engine);
  f.effect_envelope.operation = "insert";
  delete f.effect_envelope.target_binding;
  delete f.effect_envelope.conflict_key;
  delete f.effect_envelope.version_advance;
  f.effect_envelope.deduplication = { components: [{ column: "customer_id", source: "proposal_id" }, { column: "tenant_id", source: "trusted_tenant" }] };
  f.rule.effect.operation = "insert";
  delete f.rule.effect.target_binding;
  return f;
}

function atomicFixture(engine: "postgres" | "mysql") {
  const f = completeCollectionFixture(engine), target = f.catalog.resources[1]!;
  target.version_field = "version";
  target.fields.push({ name: "version", type: { kind: "integer" }, nullable: false });
  f.verification_boundary.resources[1] = { binding: "holds", resource: target.name, source: { kind: "subject_ref" },
    primary_key: "hold_id", version_field: "version", fields: target.fields, scope: { mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" },
    cardinality: "one", max_rows: 1, overflow: "unsupported", lock: "for_update" };
  f.rule.subjects.push({ binding: "holds", resource: target.name, input: "opaque_subject_ref" });
  f.rule.require = { kind: "compare", operator: "eq", left: { kind: "field", binding: "customer", field: "state" },
    right: { kind: "literal", value: "active", value_type: target.fields.find(field => field.name === "state")!.type } };
  const { schema_version: _schema, name: _name, source: _source, approval_classes: _approval, writeback: _writeback, ...envelope } = f.effect_envelope;
  f.effect_envelope.atomic_updates = [{ ...envelope, operation: "update", target_resource: target.name, target_binding: "holds", primary_key: "hold_id",
    conflict_key: "version", version_advance: { column: "version", strategy: "integer_increment" } }];
  f.rule.atomic_updates = [{ ...structuredClone(f.rule.effect), operation: "update", target_resource: target.name, target_binding: "holds" }];
  return f;
}

describe.each(["postgres", "mysql"] as const)("verification-only resource purpose on %s", engine => {
  it("allows complete private verification without a fabricated version and preserves the rule", () => {
    const f = completeCollectionFixture(engine), before = structuredClone(f.rule), legacy = compileActionRule(f);
    f.catalog.resources[1]!.verification_only = true;
    const compiled = compileActionRule(f);
    expect(compiled.schema_lock_digest).not.toBe(legacy.schema_lock_digest);
    expect(compiled.rule).toEqual(legacy.rule);
    expect(f.rule).toEqual(before);
    expect(compiled.bindings.find(binding => binding.binding === "holds")!.resource).toMatchObject({ verification_only: true });
    expect(evaluateActionRule({ compiled, facts: f.facts, proposal_id: "p1" }).result).toBe("eligible");
  });

  it.each(["update", "insert"] as const)("rejects a primary %s that would otherwise compile", operation => {
    const f = operation === "insert" ? insertFixture(engine) : completeCollectionFixture(engine);
    expect(() => compileActionRule(f)).not.toThrow();
    f.catalog.resources[0]!.verification_only = true;
    expect(() => compileActionRule(f)).toThrow("Verification-only resource collections.customers cannot be an effect target.");
    try { compileActionRule(f); } catch (error) { expect(error).toMatchObject({ code: "ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", path: "effect_envelope.target_resource" }); }
  });

  it("rejects an otherwise valid atomic companion UPDATE on a private source", () => {
    const f = atomicFixture(engine);
    expect(() => compileActionRule(f)).not.toThrow();
    f.catalog.resources[1]!.verification_only = true;
    expect(() => compileActionRule(f)).toThrow("Verification-only resource collections.holds cannot be an effect target.");
    try { compileActionRule(f); } catch (error) { expect(error).toMatchObject({ code: "ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", path: "effect_envelope.atomic_updates.0.target_resource" }); }
  });

  it("also rejects unsupported atomic INSERT attempts without permitting a private target", () => {
    const f = atomicFixture(engine);
    f.catalog.resources[1]!.verification_only = true;
    Object.assign(f.effect_envelope.atomic_updates![0]!, { operation: "insert" });
    Object.assign(f.rule.atomic_updates![0]!, { operation: "insert" });
    expect(() => compileActionRule(f)).toThrow("Atomic updates require distinct exact verified rows");
  });

  it("keeps the private-source guard in the compiler's owned snapshot", () => {
    const f = atomicFixture(engine);
    f.catalog.resources[1]!.verification_only = true;
    const compile = createActionRuleCompiler(f.catalog);
    delete f.catalog.resources[1]!.verification_only;
    expect(() => compileActionRule(f)).not.toThrow();
    expect(() => compile(f)).toThrow("Verification-only resource collections.holds cannot be an effect target.");
  });
});

describe("canonical verification-only purpose", () => {
  it.each([false, null, "true", 1, {}])("rejects noncanonical purpose %j instead of dropping it", value => {
    const f = completeCollectionFixture();
    Object.assign(f.catalog.resources[1]!, { verification_only: value });
    expect(() => normalizeActionRuleCatalog(f.catalog)).toThrow("Verification-only purpose must be true or absent.");
  });
  it("preserves true through normalization and leaves legacy resource purpose absent", () => {
    const f = completeCollectionFixture();
    f.catalog.resources[1]!.verification_only = true;
    const normalized = normalizeActionRuleCatalog(f.catalog);
    expect(normalized.resources.find(resource => resource.name === "collections.holds")!.verification_only).toBe(true);
    expect(normalized.resources.find(resource => resource.name === "collections.customers")).not.toHaveProperty("verification_only");
  });
});

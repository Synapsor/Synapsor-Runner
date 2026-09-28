import { describe, expect, it } from "vitest";
import { parseStoredActionRuleAuthority, buildActionRuleAuthorityDraft, removeOutcomeActionRuleAuthorityDraft,
  type ActionRuleAuthorityDraftV1, type ActionRuleAuthorityActivationV1 } from "./action-rule-authority.js";
import { proveExactActionWithdrawal } from "./action-rule-withdrawal-proof.js";
import { atomicSource } from "../../../packages/action-rules/src/testing/atomic-fixture.js";

// Source-only canonical factory controls. No stored activation, database,
// provider, approved request or source effect is created by this fixture.
const before = "2026-09-27T00:00:00.000Z";
const after = "2026-09-27T01:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}` as const;

function fixture() {
  const source = atomicSource("postgres");
  const names = ["atomic.first", "atomic.second", "atomic.third"];
  const rules = names.map(outcome => ({
    read_boundary_name: "atomic.read", read_boundary_digest: digest,
    verification_boundary: structuredClone(source.verification), effect_envelope: structuredClone(source.envelope),
    rule: { ...structuredClone(source.rule), name: outcome, outcome,
      inputs: [{ name: "requested_plan", description: "Caller-selected plan", type: { kind: "string" as const, max_length: 64, comparison: "exact" as const } }],
      effect: { ...structuredClone(source.rule.effect), set: { plan: { kind: "input" as const, name: "requested_plan" } } } },
  }));
  const draft = buildActionRuleAuthorityDraft({ name: "atomic_authority", action_boundary_name: "atomic.actions",
    catalog: source.catalog, rules, now: before,
    approval_classes: [{ name: "atomic.review", mode: "policy", required_role: "action_reviewer", required_approvals: 1,
      rules: rules.map(entry => ({ outcome: entry.rule.outcome, auto_approve_when: entry.rule.require })),
      shared_limits: [{ id: "shared_boundary", kind: "count", scope: "boundary", maximum: 3, window_seconds: 86400 },
        { id: "shared_principal", kind: "count", scope: "tenant_principal", maximum: 2, window_seconds: 86400 }] }],
    reviews: names.map(outcome => ({ outcome, when: "Current offer and subscription facts match.",
      then: "Apply the exact plan and consume the offer together.", refused: ["Missing or changed facts refuse."],
      human_review: "Automatic approval remains conditional on current eligibility and limits.",
      examples: [{ kind: "eligible", scenario: "Exact current facts and allowance.", result: "One bounded proposal." }] })),
  });
  const active: ActionRuleAuthorityActivationV1 = { schema_version: "synapsor.action-rule-authority-activation.v1",
    state: "active", authority: draft.authority, digest: draft.digest, reviews: draft.reviews,
    actor: "synthetic local fixture operator", activated_at: before };
  parseStoredActionRuleAuthority(active);
  return { active, reduced: removeOutcomeActionRuleAuthorityDraft({ existing: active, outcome: names[1]!, now: after }) };
}

type Material = Parameters<typeof buildActionRuleAuthorityDraft>[0];
function rebuild(draft: ActionRuleAuthorityDraftV1, change: (material: Material) => void) {
  const material: Material = { name: draft.authority.name, action_boundary_name: draft.authority.action_boundary.name,
    catalog: structuredClone(draft.authority.catalog), now: draft.created_at,
    rules: draft.authority.rules.map(({ activated_at: _at, ...entry }) => structuredClone(entry)),
    approval_classes: structuredClone(draft.authority.approval_classes), reviews: structuredClone(draft.reviews) };
  change(material);
  const candidate = buildActionRuleAuthorityDraft(material);
  expect(parseStoredActionRuleAuthority(candidate)).toEqual(candidate);
  return candidate;
}

function refuses(active: ActionRuleAuthorityActivationV1, candidate: ActionRuleAuthorityDraftV1) {
  expect(() => proveExactActionWithdrawal(active, candidate)).toThrow("ACTION_RULE_WITHDRAWAL_NOT_EXACT");
  try { proveExactActionWithdrawal(active, candidate); } catch (error) {
    expect(error).toMatchObject({ code: "ACTION_RULE_WITHDRAWAL_NOT_EXACT" });
  }
}

describe("exact rights-reducing Action withdrawal proof (source-only)", () => {
  it("proves a real canonical reduction with intact inputs, atomic companion, approvals and review copy", () => {
    const { active, reduced } = fixture();
    const originals = structuredClone({ active, reduced });
    expect(proveExactActionWithdrawal(active, reduced)).toEqual(["atomic.second"]);
    expect({ active, reduced }).toEqual(originals);
  });

  it("proves more than one removed outcome while retaining at least one exact outcome", () => {
    const { active, reduced } = fixture();
    const final = removeOutcomeActionRuleAuthorityDraft({ existing: reduced, outcome: "atomic.third", now: after });
    expect(proveExactActionWithdrawal(active, final)).toEqual(["atomic.second", "atomic.third"]);
  });

  it("rejects a fresh lifecycle copy with no withdrawal", () => {
    const { active } = fixture();
    const copy = rebuild({ schema_version: "synapsor.action-rule-authority-draft.v1", state: "disabled",
      authority: active.authority, digest: active.digest, reviews: active.reviews, created_at: after }, () => undefined);
    refuses(active, copy);
  });

  it.each([
    ["input bound", (m: Material) => { m.rules[0]!.rule.inputs![0]!.type = { kind: "string", max_length: 63, comparison: "exact" }; }],
    ["input meaning", (m: Material) => { m.rules[0]!.rule.inputs![0]!.description = "Source-derived plan"; }],
    ["Read binding", (m: Material) => { m.rules[0]!.read_boundary_digest = `sha256:${"b".repeat(64)}`; }],
    ["shared limit", (m: Material) => { m.approval_classes![0]!.shared_limits[0]!.maximum = 4; }],
    ["approval role", (m: Material) => { m.approval_classes![0]!.required_role = "different_reviewer"; }],
    ["approval count", (m: Material) => { m.approval_classes![0]!.required_approvals = 2; }],
    ["approval predicate", (m: Material) => { m.approval_classes![0]!.rules[0]!.auto_approve_when = { kind: "not", expression: m.rules[0]!.rule.require }; }],
    ["companion effect", (m: Material) => { m.rules[0]!.rule.atomic_updates![0]!.set.status = { kind: "field", binding: "offer", field: "status" }; }],
    ["rule lifetime", (m: Material) => { m.rules[0]!.rule.ttl_seconds = 299; }],
    ["review copy", (m: Material) => { m.reviews[0]!.then = "Another interpretation of the same outcome."; }],
    ["catalog material", (m: Material) => { m.catalog.resources[0]!.fields.push({ name: "additional_field", type: { kind: "boolean" }, nullable: false }); }],
    ["authority name", (m: Material) => { m.name = "another_authority"; }],
  ] as const)("rejects a canonical reduction disguised by a changed retained %s", (_name, change) => {
    const { active, reduced } = fixture();
    refuses(active, rebuild(reduced, change));
  });

  it("rejects a canonical addition mixed with a removal", () => {
    const { active, reduced } = fixture();
    const mixed = rebuild(reduced, m => {
      const extra = structuredClone(m.rules[0]!); extra.rule.name = extra.rule.outcome = "atomic.new";
      m.rules.push(extra);
      m.approval_classes![0]!.rules.push({ outcome: extra.rule.outcome, auto_approve_when: extra.rule.require });
      m.reviews.push({ ...structuredClone(m.reviews[0]!), outcome: extra.rule.outcome });
    });
    refuses(active, mixed);
  });

  it("rejects empty or invalid records without treating them as deactivation or authority", () => {
    const { active, reduced } = fixture();
    const empty = structuredClone(reduced); empty.authority.rules = [];
    refuses(active, empty);
    const corrupted = structuredClone(reduced); corrupted.digest = `sha256:${"c".repeat(64)}`;
    refuses(active, corrupted);
    refuses({ ...active, state: "disabled" } as unknown as ActionRuleAuthorityActivationV1, reduced);
  });
});

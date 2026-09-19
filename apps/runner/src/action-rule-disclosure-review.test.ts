import fs from "node:fs";
import { describe, it, expect } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { compileActionRule, evaluateActionRule, type ActionRuleAuthorityV1, type ActionRuleFactSetV1 } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { actionRuleModelDraftFromAuthority, compileActionRuleModelDraft } from "./action-rule-draft.js";
import { actionRuleDisclosureReconciliation, actionRuleEditDifferenceLines } from "./action-rule-disclosure-review.js";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { ActionRuleAuthorityReviewV1 } from "./action-rule-authority.js";

function fixture() {
  return JSON.parse(fs.readFileSync(new URL("./fixtures/minimal-edit-verification.json", import.meta.url), "utf8")) as {
    baseline: ActionRuleAuthorityV1; boundary: ExplorationBoundaryDraft; inspection: SchemaInspection; review: ActionRuleAuthorityReviewV1 };
}
function prepare(f = fixture(), numeric = false) {
  const source = f.baseline.rules[0]!;
  const built = buildActionRuleAuthoringCatalog({ boundary: f.boundary, inspection: f.inspection, retainedCatalog: f.baseline.catalog });
  const draft = actionRuleModelDraftFromAuthority({ authority: f.baseline, outcome: source.rule.outcome, review: f.review, preserveVerificationFields: true });
  if (numeric && draft.require.kind === "all") {
    const count = draft.require.expressions[4]!;
    if (count.kind !== "compare" || count.right.kind !== "literal" || count.right.value !== 2) throw new Error("Exact captured count required");
    count.right.value = 3;
  }
  const compiled = compileActionRuleModelDraft({ draft, builtCatalog: built, readBoundary: f.boundary,
    readBoundaryDigest: explorationBoundaryCandidateDigest(f.boundary), activatedAt: source.activated_at });
  return { source, built, draft, compiled, current: compiled.loaded.authority.rules[0]! };
}

describe("exact saved Action disclosure reconciliation", () => {
  it.each([false, true])("detects both historical host-produced flips without model changes (numeric %s)", numeric => {
    const { source, current } = prepare(fixture(), numeric);
    const review = actionRuleDisclosureReconciliation(source, current);
    expect(review.changes.map(({binding,field,before,after})=>({binding,field,before,after}))).toEqual([
      { binding: "candidate", field: "candidate_state", before: false, after: true },
      { binding: "candidate", field: "slot_id", before: true, after: false },
    ]);
    const expected = structuredClone(source);
    expected.verification_boundary = current.verification_boundary;
    if (numeric && expected.rule.require.kind === "all") {
      const count = expected.rule.require.expressions[4]!;
      if (count.kind === "compare" && count.right.kind === "literal") count.right.value = 3;
    }
    expect(current).toEqual(expected);
    expect(review.lines).toHaveLength(2);
  });
  it("preserves truthful explicit true/false and identifies unknown independently", () => {
    const {current} = prepare();
    expect(actionRuleDisclosureReconciliation(current, structuredClone(current)).changes).toEqual([]);
    const previous = structuredClone(current);
    delete previous.verification_boundary.resources[0]!.fields[1]!.model_visible;
    expect(actionRuleDisclosureReconciliation(previous, current).changes).toMatchObject([{ before: null, after: true }]);
  });
  it("does not mix identically named fields in different complete bindings", () => {
    const {current} = prepare(); const previous = structuredClone(current);
    previous.verification_boundary.resources.find(r=>r.binding==="candidate")!.fields.find(f=>f.name==="slot_id")!.model_visible = true;
    const changes = actionRuleDisclosureReconciliation(previous,current).changes;
    expect(changes).toMatchObject([{binding:"candidate",resource:"release_ops.build_candidates",field:"slot_id"}]);
    expect(changes).toHaveLength(1);
    expect(current.verification_boundary.resources.find(r=>r.binding==="slot")!.fields.find(f=>f.name==="slot_id")!.model_visible).toBe(false);
  });
  it("handles explicitly mapped structural equivalents, without fixture-name conditions", () => {
    const mapping: Record<string,string> = {candidate:"subject_item",candidate_state:"phase_code",slot_id:"link_ref"};
    const rename = (v: unknown): unknown => typeof v === "string" ? mapping[v] ?? v : Array.isArray(v) ? v.map(rename)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k,x])=>[mapping[k]??k,rename(x)])) : v;
    const f = rename(fixture()) as ReturnType<typeof fixture>;
    f.baseline.rules[0]!.read_boundary_digest = explorationBoundaryCandidateDigest(f.boundary);
    const {source,current} = prepare(f);
    expect(actionRuleDisclosureReconciliation(source,current).changes.map(c=>[c.binding,c.field])).toEqual([["subject_item","phase_code"],["subject_item","link_ref"]]);
  });
  it.each(["read", "source", "scope", "collection", "missing_private", "type"])("refuses %s drift as annotation-only review", drift => {
    const {source,current}=prepare();
    if(drift==="read") current.read_boundary_digest = `sha256:${"f".repeat(64)}`;
    if(drift==="source") current.verification_boundary.resources[0]!.source={kind:"relationship",from_binding:"slot",relationship:"unrelated",direction:"inverse",field_pairs:[{local_field:"slot_id",target_field:"slot_id"}]};
    if(drift==="scope") current.verification_boundary.resources[0]!.scope={mode:"columns",tenant_field:"principal_id"};
    if(drift==="collection") delete current.verification_boundary.resources[1]!.collection_consistency;
    if(drift==="missing_private") current.verification_boundary.resources.splice(1,1);
    if(drift==="type") current.verification_boundary.resources[0]!.fields[1]!.nullable=true;
    expect(()=>actionRuleDisclosureReconciliation(source,current)).toThrow("ACTION_DISCLOSURE_CONTEXT_CHANGED");
  });
  it("refuses a wrong catalog generation instead of borrowing broader metadata",()=>{
    const f=fixture();f.baseline.catalog.generation_lock_fingerprint=`sha256:${"f".repeat(64)}`;
    expect(()=>prepare(f)).toThrow();
  });
  it("makes an extra effect/approval change independently visible in the exact edit review",()=>{
    const before=prepare().draft, after=prepare(fixture(),true).draft;
    after.approval.required_approvals+=1;after.effect.allowed_fields[0]!.values=["other_value"];
    const lines=actionRuleEditDifferenceLines(before,after);
    expect(lines.some(line=>line.startsWith("/require/expressions/4/right/value: 2 -> 3"))).toBe(true);
    expect(lines.some(line=>line.startsWith("/approval/required_approvals:"))).toBe(true);
    expect(lines.some(line=>line.startsWith("/effect/allowed_fields/0/values"))).toBe(true);
  });
  it("changes the compiled synthetic minimum, retaining all-passed, time, privacy and atomic effects",()=>{
    const old=prepare(), next=prepare(fixture(),true);
    const facts: ActionRuleFactSetV1 = {subject_provenance_digest:`sha256:${"a".repeat(64)}`, trusted:{tenant:"synthetic_t",principal:"synthetic_p",transaction_time:"2026-09-19T00:00:00.000Z"},bindings:{
        candidate:{rows:[{candidate_id:"synthetic_c",tenant_id:"synthetic_t",principal_id:"synthetic_p",slot_id:"synthetic_s",candidate_state:"staged",security_hold:false,version:1}]},
        slot:{rows:[{slot_id:"synthetic_s",tenant_id:"synthetic_t",principal_id:"synthetic_p",slot_state:"ready",version:1}]},
        checks:{rows:[]},
      }};
    const evaluate=(p:typeof old)=>evaluateActionRule({compiled:compileActionRule({catalog:p.compiled.loaded.authority.catalog,...p.current}),facts,proposal_id:"synthetic_only"}).result;
    facts.bindings.checks!.rows=Array.from({length:2},(_,n)=>({candidate_id:"synthetic_c",check_id:`synthetic_${n}`,tenant_id:"synthetic_t",principal_id:"synthetic_p",check_state:"passed",elapsed_seconds:10,version:1}));
    expect(evaluate(old)).toBe("eligible");expect(evaluate(next)).toBe("ineligible");
    facts.bindings.checks!.rows.push({...facts.bindings.checks!.rows[0]!,check_id:"synthetic_2"});
    expect(evaluate(next)).toBe("eligible");facts.bindings.checks!.rows[0]!.check_state="failed";expect(evaluate(next)).toBe("ineligible");
    expect(canonicalJsonDigest(next.current.effect_envelope)).toBe(canonicalJsonDigest(old.current.effect_envelope));
  });
});

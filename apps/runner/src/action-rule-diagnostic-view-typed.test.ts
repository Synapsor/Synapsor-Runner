import { expect, it } from "vitest";
import { ActionRuleError } from "@synapsor-runner/action-rules";
import { ActionRuleAuthoringError } from "./action-rule-authoring-error.js";
import { actionRuleDraftCancelled, actionRuleDraftFailureView } from "./action-rule-diagnostic-view.js";

it("uses the authentic reviewed grammar origin, preserving its text", () => {
 const e=new ActionRuleAuthoringError("ACTION_RULE_DRAFT_INVALID", "Any display text, with no magic prefix.", {presentation:"reviewed_grammar"});
 expect(actionRuleDraftFailureView(e)).toEqual({kind:"reviewed_grammar",blockers:["Any display text, with no magic prefix."]});
});
it("keeps a terminal authored error outside grammar recovery", () => {
 expect(actionRuleDraftFailureView(new ActionRuleAuthoringError("ACTION_RULE_MODEL_DRAFT_INCOMPLETE", "ACTION_RULE_MODEL_DRAFT_INCOMPLETE: pending"))).toBeUndefined();
});
it("uses a genuine Runtime diagnostic without inferring its meaning", () => {
 expect(actionRuleDraftFailureView(new ActionRuleError("ACTION_RULE_AMBIGUOUS", "Exact Runtime diagnostic"))).toEqual({kind:"reviewed_grammar",blockers:["Exact Runtime diagnostic"]});
});
it("never derives local origin from prefixed prose or a copied error", () => {
 const e=new ActionRuleAuthoringError("ACTION_RULE_DRAFT_INVALID", "Retained wording", {presentation:"reviewed_grammar"});
 for(const fake of [new Error("ACTION_RULE_DRAFT_INVALID: harmless display"), {...e}, JSON.parse(JSON.stringify(e)), Object.assign(new Error("ACTION_RULE_DRAFT_INVALID: text"), {code:"ACTION_RULE_DRAFT_INVALID",name:"ActionRuleAuthoringError"})]) expect(actionRuleDraftFailureView(fake)).toBeUndefined();
});
it("uses the registered diagnostic even if display properties change", () => {
 const e=new ActionRuleAuthoringError("ACTION_RULE_DRAFT_INVALID", "Retained wording", {presentation:"reviewed_grammar"});
 e.message="ACTION_RULE_MODEL_DRAFT_CANCELLED";
 expect(actionRuleDraftFailureView(e)).toEqual({kind:"reviewed_grammar",blockers:["Retained wording"]});
});

it("pauses only from genuine host cancellation, even with changed display words", () => {
 const cancelled=new ActionRuleAuthoringError("ACTION_RULE_MODEL_DRAFT_CANCELLED", "Any local display");
 cancelled.message="Some display update";
 expect(actionRuleDraftCancelled(cancelled)).toBe(true);
 for(const fake of [new Error("ACTION_RULE_MODEL_DRAFT_CANCELLED"), {code:"ACTION_RULE_MODEL_DRAFT_CANCELLED"}, new ActionRuleAuthoringError("ACTION_RULE_DRAFT_INVALID", "ACTION_RULE_MODEL_DRAFT_CANCELLED", {presentation:"reviewed_grammar"})]) expect(actionRuleDraftCancelled(fake)).toBe(false);
});

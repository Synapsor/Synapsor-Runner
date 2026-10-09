import {expect,it} from "vitest";
import {actionRuleDraftFailureView} from "./action-rule-diagnostic-view.js";
import {ActionRuleAuthoringError} from "./action-rule-authoring-error.js";
import {ActionRuleError} from "@synapsor-runner/action-rules";
const messages=[
  "A quoted example says multiple reviewed work.items subject rows, but validation failed for another reason.",
  "Do not report TARGET_AMBIGUOUS; original target was never assessed.",
  "The operator asked what target_binding means; no target validation result exists.",
  "UPDATE work.items is quoted in a target_binding explanation only.",
  "対象は未評価です。条件式を確認してください。",
];
it.each(messages)("FS prose stays exact diagnostic: %s",message=>{
 expect(actionRuleDraftFailureView(new ActionRuleAuthoringError("ACTION_RULE_DRAFT_INVALID", message, {presentation:"reviewed_grammar"}))).toEqual({kind:"reviewed_grammar",blockers:[message]});
});
it("FS unrelated runtime ambiguity is not interpreted as a row-target finding",()=>{
 const message="An outcome describes multiple reviewed work.items subject rows in a quoted label.";
 expect(actionRuleDraftFailureView(new ActionRuleError("ACTION_RULE_AMBIGUOUS",message))).toEqual({kind:"reviewed_grammar",blockers:[message]});
});
it("FS invented required-tool codes do not establish a local origin",()=>{
 for(const code of ["ACTION_RULE_NOT_SUBMITTED","ACTION_RULE_AUTHORING_NOT_SUBMITTED","ACTION_RULE_CLARIFICATION_REQUIRED"])
  expect(actionRuleDraftFailureView(new Error(`${code}: multiple reviewed work.items subject rows`))).toBeUndefined();
});
it("FS unregistered prose, objects and code fragments do not enter Action grammar recovery",()=>{
 for(const input of ["ACTION_RULE_DRAFT_INVALID: text",{message:"ACTION_RULE_DRAFT_INVALID: text"},new Error("quoted ACTION_RULE_DRAFT_INVALID: text"),new Error("Multiple reviewed work.items subject rows")])expect(actionRuleDraftFailureView(input)).toBeUndefined();
});
it("FS authentic diagnostic text remains exact without prefix interpretation",()=>{
 expect(actionRuleDraftFailureView(new ActionRuleAuthoringError("ACTION_RULE_DRAFT_INVALID", "ACTION_RULE_DRAFT_INVALID: ACTION_RULE_EFFECT_INVALID: unknown field", {presentation:"reviewed_grammar"}))).toEqual({kind:"reviewed_grammar",blockers:["ACTION_RULE_DRAFT_INVALID: ACTION_RULE_EFFECT_INVALID: unknown field"]});
});

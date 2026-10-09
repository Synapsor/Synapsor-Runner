import {expect,it} from "vitest";
import {actionRuleDraftFailureView} from "./action-rule-diagnostic-view.js";
import {ActionRuleError} from "@synapsor-runner/action-rules";
const messages=[
  "A quoted example says multiple reviewed work.items subject rows, but validation failed for another reason.",
  "Do not report TARGET_AMBIGUOUS; original target was never assessed.",
  "The operator asked what target_binding means; no target validation result exists.",
  "UPDATE work.items is quoted in a target_binding explanation only.",
  "対象は未評価です。条件式を確認してください。",
];
it.each(messages)("FS prose stays exact diagnostic: %s",message=>{
 expect(actionRuleDraftFailureView(new Error(`ACTION_RULE_DRAFT_INVALID: ${message}`))).toEqual({kind:"reviewed_grammar",blockers:[message]});
});
it("FS unrelated runtime ambiguity is not interpreted as a row-target finding",()=>{
 const message="An outcome describes multiple reviewed work.items subject rows in a quoted label.";
 expect(actionRuleDraftFailureView(new ActionRuleError("ACTION_RULE_AMBIGUOUS",message))).toBeUndefined();
});
it("FS required tool codes preserve the exact existing recovery class",()=>{
 for(const code of ["ACTION_RULE_NOT_SUBMITTED","ACTION_RULE_AUTHORING_NOT_SUBMITTED","ACTION_RULE_CLARIFICATION_REQUIRED"])
  expect(actionRuleDraftFailureView(new Error(`${code}: multiple reviewed work.items subject rows`))).toEqual({kind:"required_tool"});
});
it("FS unregistered prose, objects and code fragments do not enter Action grammar recovery",()=>{
 for(const input of ["ACTION_RULE_DRAFT_INVALID: text",{message:"ACTION_RULE_DRAFT_INVALID: text"},new Error("quoted ACTION_RULE_DRAFT_INVALID: text"),new Error("Multiple reviewed work.items subject rows")])expect(actionRuleDraftFailureView(input)).toBeUndefined();
});
it("FS exact nested formal prefixes keep established normalization only",()=>{
 expect(actionRuleDraftFailureView(new Error("ACTION_RULE_DRAFT_INVALID: ACTION_RULE_EFFECT_INVALID: unknown field"))).toEqual({kind:"reviewed_grammar",blockers:["unknown field"]});
});

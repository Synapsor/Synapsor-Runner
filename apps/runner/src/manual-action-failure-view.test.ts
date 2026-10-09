import { expect, it, vi } from "vitest";
import { ActionRuleAuthoringError } from "./action-rule-authoring-error.js";
import { reviewManualActionFailure, type ManualSemanticActionPrompter } from "./manual-semantic-action-editor.js";

it.each([
 ["unknown", new Error("Storage refused the save")],
 ["forged grammar prose", new Error("ACTION_RULE_DRAFT_INVALID: please repair")],
 ["terminal native", new ActionRuleAuthoringError("ACTION_RULE_MODEL_DRAFT_INCOMPLETE", "Pending")]
])("does not offer collected-answer repair for %s", async (_kind,error) => {
 const choose=vi.fn(async()=> "edit"), message=vi.fn(async()=>{});
 const prompter={choose,message} as unknown as ManualSemanticActionPrompter;
 expect(await reviewManualActionFailure(error,undefined,prompter)).toBe("inspect");
 expect(choose).not.toHaveBeenCalled();
 expect(message).toHaveBeenCalledOnce();
});
it("keeps bounded editing for an authentic reviewed grammar failure", async()=>{
 const choose=vi.fn(async()=> "edit"), message=vi.fn(async()=>{});
 const prompter={choose,message} as unknown as ManualSemanticActionPrompter;
 expect(await reviewManualActionFailure(new ActionRuleAuthoringError("ACTION_RULE_DRAFT_INVALID","Exact local constraint",{presentation:"reviewed_grammar"}),undefined,prompter)).toBe("edit");
 expect(choose).toHaveBeenCalledOnce();
});

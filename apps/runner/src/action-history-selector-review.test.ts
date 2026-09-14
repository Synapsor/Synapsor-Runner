import { readFileSync } from "node:fs";
import { it,expect,vi } from "vitest";
import { reviewHistorySelectorChange, historySelectorChanges } from "./action-history-selector-review.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
const saved=JSON.parse(readFileSync(new URL("./fixtures/counting-addition-review.json",import.meta.url),"utf8"));
const make=()=>{const before=structuredClone(saved.draft.actions[0]),after=structuredClone(before);for(const l of after.approval.shared_limits)l.capability=after.outcome;return {before,after,read_digest:"exact-reviewed-read"};};
it.each([true,false])("shows an exact disabled selector difference and respects declined review (%s)",async accepted=>{
 const request=make(),original=structuredClone(request),confirm=vi.fn(async()=>accepted),current=vi.fn(async()=>{});
 expect(await reviewHistorySelectorChange(request,{confirm} as unknown as BoundaryReviewInteractiveSession,current)).toBe(accepted);
 expect(confirm).toHaveBeenCalledOnce();expect(current).toHaveBeenCalledTimes(accepted?2:1);expect(request).toEqual(original);
 expect(JSON.stringify(confirm.mock.calls)).toContain("No approval record is deleted or refunded");
 expect(historySelectorChanges(request).map(c=>[c.before,c.after,c.maximum,c.window_seconds])).toEqual([[null,request.after.outcome,2,86400],[null,request.after.outcome,6,86400]]);
});
it("refuses a concurrent dependency change after exact confirmation",async()=>{
 const current=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ACTION_RULE_REVISION_STALE"));
 await expect(reviewHistorySelectorChange(make(),{confirm:async()=>true} as unknown as BoundaryReviewInteractiveSession,current)).rejects.toThrow("ACTION_RULE_REVISION_STALE");
});

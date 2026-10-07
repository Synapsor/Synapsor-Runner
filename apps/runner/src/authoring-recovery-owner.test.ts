import { describe,expect,it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { retainedRecoveryOwner } from "./authoring-recovery-owner.js";
import type { AuthoringInterruptedRecoveryPreview,AuthoringTransportState } from "./authoring-generation-recovery.js";
const context=canonicalJsonDigest("retained semantic context");
function fixture(){
  const recovery:AuthoringTransportState={version:1,operations:[{id:"operation",request_digest:canonicalJsonDigest("request"),
    context_digest:context,deadline:"2026-10-06T00:01:00Z",state:"unknown",episode_id:"budget",attempts:[]}],
    episodes:[{id:"budget",key_digest:canonicalJsonDigest("selected tools"),context_digest:context,conversational:false,
      iterations_used:1,tool_calls_used:0,correction_used:false,wording_correction_used:false}]};
  const preview:AuthoringInterruptedRecoveryPreview={operation_id:"operation",attempt_id:"attempt",operation_digest:canonicalJsonDigest("op"),
    prior_context_digest:context,current_context_digest:context,checkpoint_digest:canonicalJsonDigest("checkpoint"),
    state_digest:canonicalJsonDigest("state"),root_operation_id:"operation",remaining_attempts:2,unresolved_operation_count:1,episode_id:"budget"};
  return {recovery,preview};
}
// Resolver-only controls; native validation/admission is covered separately.
describe("selected recovery allowance",()=>{
  it("preserves a proven unchanged legacy generic fallback owner",()=>expect(retainedRecoveryOwner(fixture())).toBe(true));
  it.each(["wrong owner","changed context","exhausted iterations","exhausted tools"])("does not borrow counters (%s)",change=>{
    const f=fixture();if(change==="wrong owner")f.recovery.operations[0]!.episode_id="another";
    if(change==="changed context")f.preview.current_context_digest=canonicalJsonDigest("new business choice");
    if(change==="exhausted iterations")f.recovery.episodes![0]!.iterations_used=6;
    if(change==="exhausted tools")f.recovery.episodes![0]!.tool_calls_used=8;
    expect(retainedRecoveryOwner(f)).toBe(false);
  });
  it("does not infer an untagged Source controller from its open journal",()=>{
    expect(retainedRecoveryOwner({...fixture(),sources:{id:"sources",snapshots:[],approvals:[],coverage_episodes:[{id:"review",context,
      started_at:"2026-10-06T00:00:00Z",submissions:[{number:1,reserved_at:"2026-10-06T00:00:01Z"}]}]}})).toBe(false);
  });
  it("uses the exact typed Action turn, never another same-consumer tail",()=>{
    const f=fixture();delete f.preview.episode_id;delete f.recovery.operations[0]!.episode_id;
    f.recovery.operations[0]!.producer_input={consumer:"action_rule_components",operator_message:"Keep the reviewed choice",logical_turn_id:"selected"};
    const turn={id:"other",iterations_used:1,tool_calls_used:1};
    expect(retainedRecoveryOwner({...f,actionTurn:turn})).toBe(false);
    turn.id="selected";expect(retainedRecoveryOwner({...f,actionTurn:turn})).toBe(true);
    expect(retainedRecoveryOwner({...f,actionTurn:{...turn,completed:{recorded:true}}})).toBe(false);
  });
});

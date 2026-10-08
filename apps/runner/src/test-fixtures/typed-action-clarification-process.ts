/** Exact whole-Action clarification process control; no provider or Source DB. */
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { catalog, boundary, readDigest } from "./typed-action-parameter.js";
import { generateModelActionRuleDraft } from "../action-rule-model.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeState } from "../boundary-authoring-resume.js";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, authoringQuestionCheckpoint } from "../authoring-generation-recovery.js";
import { actionLogicalTurnMaterialDigest, type ActionRuleAuthoringCheckpoint } from "../action-rule-authoring-checkpoint.js";
const [root,mode] = process.argv.slice(2);
if (!root || !["create","resume","stale"].includes(mode!)) throw new Error("Explicit fixture mode required");
const binding = {boundary_name:"warehouse",generation_lock_fingerprint:digest("lock"),schema_fingerprint:digest("schema"),role_posture_fingerprint:digest("role")};
const intent = "Prepare proposal-only changes to the reorder threshold of enabled warehouse items. Ask how many warehouse reviewers should review otherwise valid requests; that number has not been decided.";
const base = {binding,stage:"action_drafting" as const,jobIntent:intent,provider:"openai" as const,model:"controlled-clarification-process"};
let state: BoundaryAuthoringResumeState;
if (mode === "create") {
  state=buildBoundaryAuthoringResumeState({...base,authoringProtocol:{version:"synapsor.structured-authoring.v1"}});
  await writeBoundaryAuthoringResumeState(root,state,{expectedRevisionDigest:null});
} else {
  const loaded=await readBoundaryAuthoringResumeState(root,binding);
  if(loaded.status!=="ready")throw new Error("Exact native pending record unavailable");
  state=loaded.value;
}
const before=digest(state);let checkpoint:ActionRuleAuthoringCheckpoint|undefined=state.action?.checkpoint;
let requests=0,prompts=0,error="";
const question="How many warehouse reviewers should approve an otherwise valid threshold change?";
const strings=(value:unknown):string[]=>typeof value==="string"?[value]:Array.isArray(value)?value.flatMap(strings):value&&typeof value==="object"?Object.values(value).flatMap(strings):[];
const persist=async(next:BoundaryAuthoringResumeState)=>{await writeBoundaryAuthoringResumeState(root,next,{expectedRevisionDigest:state.revision_digest});state=next;};
try { await withAuthoringGenerationRecovery(async()=>{
  configureAuthoringGenerationRecovery({available:()=>true,read:()=>state.generation_recovery,current:async()=>digest("whole-current-Action-process-context"),progress:()=>{},
    write:recovery=>persist(buildBoundaryAuthoringResumeState({...base,previous:state,generationRecovery:recovery}))});
  await generateModelActionRuleDraft({builtCatalog:catalog(),readBoundary:boundary(),readBoundaryDigest:mode==="stale"?digest("different current Read"):readDigest,
    intent,checkpoint,authoringProtocol:{version:"synapsor.structured-authoring.v1"},egressAcknowledged:true,
    session:{provider:"openai",model:base.model,apiKey:"inert-local-only",dependencies:{requestJson:async request=>{
      if(mode!=="create" || ++requests>1)throw new Error("No provider replay allowed");
      const line=strings(request.body).flatMap(value=>value.split("\n")).find(value=>value.startsWith("Current disabled draft: "))!;
      const context=JSON.parse(line.slice("Current disabled draft: ".length)).clarification_context;
      return {status:200,body:{output:[{type:"function_call",call_id:"actual_declared_question",name:"runner__submit_approval_policy_draft",
        arguments:JSON.stringify({status:"clarification",question,context_digest:context.context_digest,target:{kind:"action_component",phase:"approval"}})}]}};
    }}},
    stageVersionQuestion:()=>{throw new Error("No Version question declared");},reviewVersionQuestion:async()=>{throw new Error("No Version review declared");},
    assertLogicalTurnBoundary:async()=>{throw new Error("No next logical turn declared");},
    onCheckpoint:async(next,metadata)=>{
      if(metadata?.expected_checkpoint_digest!==checkpoint?.digest)throw new Error("Unexpected checkpoint predecessor");
      let recovery=state.generation_recovery;
      if(metadata?.ordinary_completion) {
        if(metadata.ordinary_completion.kind!=="ordinary_clarification")throw new Error("Only question completion expected");
        recovery=authoringQuestionCheckpoint(recovery,next);
      }
      await persist(buildBoundaryAuthoringResumeState({...base,previous:state,generationRecovery:recovery,action:{intent,checkpoint:next}}));checkpoint=next;
    },
    askClarification:async value=>{if(value!==question)throw new Error("Unexpected operator question");prompts++;return undefined;},
  });
}); } catch(caught) {error=String(caught);}
const loaded=await readBoundaryAuthoringResumeState(root,binding);
if(loaded.status!=="ready")throw new Error("Native record did not survive");
await fs.writeFile(path.join(root,`result-${mode}.json`),JSON.stringify({pid:process.pid,mode,requests,prompts,error,before,after:digest(loaded.value),
 checkpoint:loaded.value.action?.checkpoint,generation:loaded.value.generation_recovery,
 material:loaded.value.action?.checkpoint?actionLogicalTurnMaterialDigest(loaded.value.action.checkpoint):null}));

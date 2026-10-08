import { randomUUID } from "node:crypto";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest } from "../auto-boundary.js";
import { generateModelReadWorkload, readWorkloadCatalog } from "../read-workload-model.js";
import { projectReadScopeHostContext } from "../read-current-evidence.js";
import { READ_SCOPE_PROTOCOL, type ReadScopeProposal } from "../read-structured-scope.js";
import { createReadScopeQuestion, proposeReadScopeReview, confirmReadScopeReview } from "../authoring-read-scope-question.js";
import { authoringReadCheckpoint, configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, type AuthoringTransportState } from "../authoring-generation-recovery.js";
import { readScopeConsumption } from "../authoring-read-scope-binding.js";
import type { OperatorQuestion } from "../authoring-operator-question.js";

/** Declared public facts and finite targets for a test's actual original request.
 * No English interpretation, analysis-to-expected-response conversion, or private oracle. */
export function declaredReadContext(request: string, resources: string[]) {
  const catalog = { resources: resources.map(id => ({ id, fields: [{ id: "name" }] })), relationships: [] };
  const context = projectReadScopeHostContext({ request: { id: "original-job", text: request }, catalog: { ...catalog, digest: d(catalog) },
    binding: { meaning_digest: d({ request, declared_field: "name" }), applicability_digest: d("declared test job"), operation_digest: d(catalog) } });
  const proposal: ReadScopeProposal = { protocol: READ_SCOPE_PROTOCOL, original_request: "original-job", applicability: "read_requested", requirements: resources.map((resource, index) => ({
    id: `names-${index}`, intended_use: `Show the names in ${resource}`, references: ["original-job"], disposition: "include", subjects:[{root_resource:resource,mode:"trusted_principal"}], targets: [
      { root_resource: resource, resource, operation: "resource" }, { root_resource: resource, resource, operation: "return", field: "name" },
    ],
  })) };
  return { context, proposal, structuredScope: { protocol: READ_SCOPE_PROTOCOL, current: () => context } };
}


import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareReviewedReadScope } from "./reviewed-read-scope.js";
import { projectReadSubjectContext } from "../authoring-read-subject-context.js";
import { buildBoundaryAuthoringResumeState,writeBoundaryAuthoringResumeState,readBoundaryAuthoringResumeState,type BoundaryAuthoringResumeState } from "../boundary-authoring-resume.js";

/** Actual structural review, producer/compiler, native consumption and separate
 * explicit scope confirmation. Disposable preparation, not a planning call. */
export async function preparedNativeReadContext(resources: string[]) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"owned-prepared-read-"));await fs.chmod(root,0o700);
 try {
  const prepared=await prepareReviewedReadScope(root,{resources,field:"name"}),boundary=prepared.context.candidate;
  const request=`Show names from ${resources.join(", ")}.`;
  const nativeBinding={boundary_name:boundary.pack.name,generation_lock_fingerprint:boundary.generation_lock_fingerprint,
    schema_fingerprint:prepared.context.lock.schema_fingerprint,role_posture_fingerprint:prepared.context.lock.role_posture_fingerprint};
  const input={binding:nativeBinding,stage:"read_mapping" as const,jobIntent:request,provider:"openai" as const,model:"scripted"};
  let state=buildBoundaryAuthoringResumeState({...input,authoringProtocol:{version:"synapsor.structured-authoring.v2"}});
  await writeBoundaryAuthoringResumeState(root,state,{expectedRevisionDigest:null});
  const persist=async(next:BoundaryAuthoringResumeState)=>{await writeBoundaryAuthoringResumeState(root,next,{expectedRevisionDigest:state.revision_digest});state=next;};
  const catalog=readWorkloadCatalog(boundary),subjects=projectReadSubjectContext({context:prepared.context,sourceDigest:d(null)});
  const context=projectReadScopeHostContext({request:{id:"original-job",text:request},catalog:{digest:catalog.digest,resources:catalog.resources,relationships:[],subject_scopes:subjects.subject_scopes},
    binding:{meaning_digest:d({request}),applicability_digest:d({request,binding:nativeBinding}),operation_digest:explorationBoundaryCandidateDigest(boundary)}});
  let question:OperatorQuestion|undefined,proposal:ReadScopeProposal|undefined;
  const result=await withAuthoringGenerationRecovery(async()=>{
    configureAuthoringGenerationRecovery({available:()=>true,read:()=>state.generation_recovery,current:async()=>d(context),
      write:async generationRecovery=>persist(buildBoundaryAuthoringResumeState({...input,previous:state,generationRecovery}))});
    return generateModelReadWorkload({name:"saved_names",allowedQuestions:[request],provider:"openai",model:"scripted",apiKey:"inert-test-key",
      generatedBoundary:boundary,egressAcknowledged:true,deferNarration:true,structuredScope:{protocol:READ_SCOPE_PROTOCOL,current:()=>context},
      dependencies:{requestJson:async actual=>{
        const strings:string[]=[];const visit=(v:unknown)=>{if(typeof v==="string")strings.push(v);else if(v&&typeof v==="object")Object.values(v).forEach(visit);};visit(actual.body);
        const get=(prefix:string)=>{for(const text of strings)for(const line of text.split("\n"))if(line.startsWith(prefix))return JSON.parse(line.slice(prefix.length));throw new Error(`Actual request omits ${prefix}`);};
        const refs=get("Host scope reference inventory: ") as typeof context.references;
        const scopes=get("Host reviewed subject scope inventory: ") as typeof subjects.subject_scopes;
        const visible=get("Structural catalog: ") as {resources:Array<{id:string;fields:Array<{id:string}>}>};
        const original=refs.find(ref=>ref.kind==="request");if(!original)throw new Error("No actual request reference");
        const selected=resources.map(id=>{const r=visible.resources.find(r=>r.id===id);if(!r?.fields.some(f=>f.id==="name"))throw new Error("Declared field absent from transmitted catalog");return r;});
        proposal={protocol:READ_SCOPE_PROTOCOL,original_request:original.id,applicability:"read_requested",requirements:selected.map((r,index)=>{
          const scope=scopes.find(s=>s.root_resource===r.id);if(!scope)throw new Error("No actual reviewed scope");
          return {id:`names-${index}`,intended_use:`Show the names in ${r.id}`,references:[original.id],disposition:"include",
            subjects:[{root_resource:r.id,mode:"reviewed_resource",scope_reference:scope.reference}],targets:[{root_resource:r.id,resource:r.id,operation:"resource"},{root_resource:r.id,resource:r.id,operation:"return",field:"name"}]};})};
        return{status:200,body:{output:[{type:"function_call",call_id:"prepare_native_read",name:"runner__submit_read_workloads",arguments:JSON.stringify({read_scope:proposal,forbidden:[],allowed:selected.map((r,index)=>({id:`names_${index}`,description:`Show names from ${r.id}`,plan:{kind:"rows",resource:r.id,select:["name"]}}))})}]}};
      }},onCheckpoint:async(_checkpoint,_boundary,accepted,completion)=>{
        if(!accepted)return;if(!accepted.read_scope||!completion)throw new Error("Missing actual typed producer completion");
        const pending=createReadScopeQuestion({id:randomUUID(),revision:1,scope_digest:d({request}),context_digest:completion.context_digest,read_scope:{mode:"review",record:accepted.read_scope,completion}});
        const generationRecovery=authoringReadCheckpoint(state.generation_recovery,completion,readScopeConsumption(pending.read_scope!));
        await persist(buildBoundaryAuthoringResumeState({...input,previous:state,generationRecovery,operatorQuestions:[pending]}));
        const proposed=proposeReadScopeReview(pending,context.binding,accepted.analysis,context);
        await persist(buildBoundaryAuthoringResumeState({...input,previous:state,operatorQuestions:[proposed]}));
        question=confirmReadScopeReview(proposed,context.binding,accepted.analysis,proposed.digest,context);
        await persist(buildBoundaryAuthoringResumeState({...input,previous:state,operatorQuestions:[question]}));
      }});
  });
  const disk=await readBoundaryAuthoringResumeState(root,nativeBinding);
  if(!question||!proposal||disk.status!=="ready")throw new Error("Missing actual confirmed native scope");
  const confirmed=disk.value.operator_questions!.find(q=>q.id===question!.id)!;
  return{proposal,structuredScope:{protocol:READ_SCOPE_PROTOCOL,current:()=>({...context,reusable:{questions:[confirmed],handoffs:[],generation:disk.value.generation_recovery,question_id:confirmed.id,analysis:result.analysis}})}};
 }finally{await fs.rm(root,{recursive:true,force:true});}
}

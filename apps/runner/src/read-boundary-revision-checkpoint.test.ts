import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { generateModelReadBoundaryRevision } from "./read-boundary-revision-model.js";
import { readBoundaryRevisionCheckpoint, parseReadBoundaryRevisionCheckpoint, type ReadBoundaryRevisionCheckpoint } from "./read-boundary-revision-checkpoint.js";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, validateAuthoringTransportState, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { secureAskJsonRequest } from "./model-ask.js";
import { reviewReadRelationship, validateReviewedReadRelationship, type ReviewedReadRelationship } from "./read-relationship-review.js";

const question={question:"Should order status stay visible or become private to Runner?",reason:"Confirm the current owner exposure choice."};
const answer="Keep status private to Runner with no model analysis.";
const response=(args:unknown)=>({status:200,body:{output:[{type:"function_call",call_id:"owned-read-revision-checkpoint",name:"runner__submit_read_boundary_revision",arguments:JSON.stringify(args)}]}});
const valid={resource_changes:[{resource:"public.orders",field_exposure:[{field:"status",exposure:"runner_only",model_operations:"none"}]}]};
const hash=`sha256:${"1".repeat(64)}` as const;
function boundary():ExplorationBoundaryDraft {return {schema_version:"synapsor.exploration-boundary.v1",activation:"disabled_unreviewed",deployment_profile:"staging",source:"local_postgres",compiler_version:"1.8.0",spec_version:"1.11.0",reporting_timezone:"UTC",trusted_context:{provider:"environment",tenant_env:"SYNAPSOR_TENANT_ID",principal_env:"SYNAPSOR_PRINCIPAL"},generation_lock_fingerprint:hash,role_posture_fingerprint:hash,
  pack:{name:"owned_checkpoint_read",resources:[{id:"public.orders",schema:"public",table:"orders",primary_key:"id",tenant_key:"tenant_id",principal_key:"principal_id",field_types:{id:"uuid",status:"text",tenant_id:"text",principal_id:"text"},field_enums:{status:["open","closed"]},selectable_fields:["id","status"],filterable_fields:{status:["eq"]},sortable_fields:["status"],groupable_fields:[],aggregate_measures:[],count_distinct_fields:[],time_bucket_fields:{},kept_out_fields:["tenant_id","principal_id"],relationships:[],minimum_cohort_size:5,suppression_aware_totals:true}]},budgets:structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS),unresolved_decisions:[]};}
const setup=(requestJson:any)=>({instruction:"Review the exact status visibility; preserve other access.",provider:"openai" as const,model:"owned-offline",apiKey:"owned-offline",boundary:boundary(),egressAcknowledged:true,dependencies:{requestJson}});
async function paused(correction=false) {
  let saved:ReadBoundaryRevisionCheckpoint|undefined,calls=0;
  const send=vi.fn(async()=>response(correction && ++calls===1 ? {resource_changes:[{resource:"public.unknown",field_exposure:[{field:"status",exposure:"runner_only"}]}]} : {clarification_request:question}));
  await expect(generateModelReadBoundaryRevision({...setup(send),onCheckpoint:async(value:any)=>{saved=value;},clarificationHandler:async()=>undefined} as any)).rejects.toMatchObject({code:"ASK_CANCELLED"});
  expect(saved?.stage).toBe("waiting");return {saved:saved!,send};
}

it("persists the canonical question before its owner handler and resumes with zero initial sends",async()=>{
  let saved:ReadBoundaryRevisionCheckpoint|undefined;
  const first=vi.fn(async()=>response({clarification_request:question}));
  await expect(generateModelReadBoundaryRevision({...setup(first),onCheckpoint:async(value:any)=>{saved=value;},clarificationHandler:async()=>{
    expect(saved?.pending_question).toMatchObject({kind:"clarification",request:question,question:question.question});return undefined;
  }} as any)).rejects.toMatchObject({code:"ASK_CANCELLED"});
  expect(first).toHaveBeenCalledOnce();const next=vi.fn(async request=>{expect(JSON.stringify(request.body)).toContain(answer);return response(valid);});
  const stages:string[]=[];
  const result=await generateModelReadBoundaryRevision({...setup(next),resumeCheckpoint:saved,onCheckpoint:async(value:any)=>{if(value)stages.push(value.stage);},clarificationHandler:async()=>{expect(next).not.toHaveBeenCalled();return {state:"answered",answer};}} as any);
  expect(next).toHaveBeenCalledOnce();expect(stages).toEqual(["waiting","decided","dispatching","dispatching"]);expect(result.changes).toMatchObject([{field:"status",after:"runner_only"}]);
});

it("saved decided answer survives a callback crash without a reprompt or duplicate answer",async()=>{
  const {saved}=await paused();let decided:ReadBoundaryRevisionCheckpoint|undefined;
  const noSend=vi.fn();await expect(generateModelReadBoundaryRevision({...setup(noSend),resumeCheckpoint:saved,onCheckpoint:async(value:any)=>{if(value?.stage==="decided"){decided=value;throw new Error("OWNED_DECIDED_COMMITTED_THEN_CRASH");}},clarificationHandler:async()=>({state:"answered",answer})} as any)).rejects.toThrow("OWNED_DECIDED_COMMITTED_THEN_CRASH");
  expect(noSend).not.toHaveBeenCalled();const handler=vi.fn(),next=vi.fn(async()=>response(valid));
  await generateModelReadBoundaryRevision({...setup(next),resumeCheckpoint:decided,clarificationHandler:handler} as any);
  expect(handler).not.toHaveBeenCalled();expect(next).toHaveBeenCalledOnce();expect(decided?.state.clarification_answers).toEqual([{question:question.question,answer}]);
});

it("rechecks the restored decided answer through the caller checkpoint before any resumed send",async()=>{
  const {saved}=await paused();let decided:ReadBoundaryRevisionCheckpoint|undefined;
  await expect(generateModelReadBoundaryRevision({...setup(vi.fn()),resumeCheckpoint:saved,clarificationHandler:async()=>({state:"answered",answer}),onCheckpoint:async value=>{
    if(value?.stage==="decided"){decided=value;throw new Error("OWNED_DECIDED_CRASH");}
  }})).rejects.toThrow("OWNED_DECIDED_CRASH");
  const send=vi.fn(),handler=vi.fn();
  await expect(generateModelReadBoundaryRevision({...setup(send),resumeCheckpoint:decided,clarificationHandler:handler,onCheckpoint:async value=>{
    expect(value).toEqual(decided);throw new Error("OWNED_CURRENT_ANSWER_CONTEXT_CHANGED");
  }})).rejects.toThrow("OWNED_CURRENT_ANSWER_CONTEXT_CHANGED");expect(send).not.toHaveBeenCalled();expect(handler).not.toHaveBeenCalled();
});

it.each(["instruction","boundary","profile","catalog","tool"])("refuses current %s drift before handler/send",async mode=>{
  const {saved}=await paused();const noSend=vi.fn(),handler=vi.fn(),input:any={...setup(noSend),resumeCheckpoint:saved,clarificationHandler:handler};
  if(mode==="instruction")input.instruction+=" A different owner request.";
  if(mode==="boundary")input.boundary.budgets.max_rows--;
  if(mode==="profile")input.privacyOnly=true;
  if(mode==="catalog")input.boundary.pack.resources[0].field_types.status="integer";
  if(mode==="tool")input.reviewRelationship=async()=>undefined;
  await expect(generateModelReadBoundaryRevision(input)).rejects.toThrow(/CHECKPOINT_STALE/);expect(handler).not.toHaveBeenCalled();expect(noSend).not.toHaveBeenCalled();
});

it("does not reset the existing correction allowance across a pending-question restart",async()=>{
  const {saved}=await paused(true);expect(saved.state.correction_used).toBe(true);expect(saved.state.call_count).toBe(2);
  const invalid=vi.fn(async()=>response({resource_changes:[{resource:"public.missing",field_exposure:[{field:"status",exposure:"runner_only"}]}]}));
  await expect(generateModelReadBoundaryRevision({...setup(invalid),resumeCheckpoint:saved,clarificationHandler:async()=>({state:"answered",answer})} as any)).rejects.toThrow("READ_BOUNDARY_REVISION_NOT_SUBMITTED");expect(invalid).toHaveBeenCalledOnce();
});

it("persists correction consumption before dispatch even from an already-decided resumed record",async()=>{
  const {saved}=await paused();let durable=saved,decided:ReadBoundaryRevisionCheckpoint|undefined;
  await expect(generateModelReadBoundaryRevision({...setup(vi.fn()),resumeCheckpoint:saved,clarificationHandler:async()=>({state:"answered",answer}),onCheckpoint:async value=>{
    if(value?.stage==="decided"){decided=value;throw new Error("OWNED_DECIDED_CRASH");}
  }})).rejects.toThrow("OWNED_DECIDED_CRASH");
  let sent=0;
  await expect(generateModelReadBoundaryRevision({...setup(async()=>{
    if(++sent===1)return response({resource_changes:[{resource:"public.missing",field_exposure:[{field:"status",exposure:"runner_only"}]}]});
    expect(durable.state.correction_used).toBe(true);expect(durable.state.call_count).toBe(2);
    return response({resource_changes:[{resource:"public.missing",field_exposure:[{field:"status",exposure:"runner_only"}]}]});
  }),resumeCheckpoint:decided,onCheckpoint:async value=>{if(value)durable=value;}})).rejects.toThrow("READ_BOUNDARY_REVISION_NOT_SUBMITTED");
  const invalid=vi.fn(async()=>response({resource_changes:[{resource:"public.missing",field_exposure:[{field:"status",exposure:"runner_only"}]}]}));
  await expect(generateModelReadBoundaryRevision({...setup(invalid),resumeCheckpoint:durable})).rejects.toThrow("READ_BOUNDARY_REVISION_NOT_SUBMITTED");expect(invalid).toHaveBeenCalledOnce();
});

it("retains a typed private field choice through correction, question pause and resumed validation",async()=>{
  let saved:ReadBoundaryRevisionCheckpoint|undefined,sends=0;
  const validateRevision=vi.fn(async()=>{if(validateRevision.mock.calls.length===1)throw new Error("OWNED_PREVIEW_REQUIRES_CORRECTION");});
  await expect(generateModelReadBoundaryRevision({...setup(async()=>response(++sends===1 ? valid : {clarification_request:question})),validateRevision,
    onCheckpoint:async value=>{if(value)saved=value;},clarificationHandler:async()=>undefined})).rejects.toMatchObject({code:"ASK_CANCELLED"});
  expect(saved?.state.private_decisions).toMatchObject([{field:"status",after:"runner_only",model_operations:"none"}]);
  const dropped=vi.fn(async()=>response({resource_changes:[{resource:"public.orders",field_exposure:[{field:"id",exposure:"runner_only"}]}]}));
  await expect(generateModelReadBoundaryRevision({...setup(dropped),resumeCheckpoint:saved,clarificationHandler:async()=>({state:"answered",answer})})).rejects.toThrow("correction dropped the Runner-only decision");
  expect(dropped).toHaveBeenCalledOnce();
  const kept=await generateModelReadBoundaryRevision({...setup(async()=>response(valid)),resumeCheckpoint:saved,clarificationHandler:async()=>({state:"answered",answer})});
  expect(kept).toMatchObject({correction_used:true,changes:[expect.objectContaining({field:"status",after:"runner_only"})]});
});

it("explicit decline is durably decided while EOF remains waiting",async()=>{
  const {saved}=await paused();let decided:ReadBoundaryRevisionCheckpoint|undefined;const noSend=vi.fn();
  await expect(generateModelReadBoundaryRevision({...setup(noSend),resumeCheckpoint:saved,onCheckpoint:async(value:any)=>{decided=value;},clarificationHandler:async()=>({state:"declined"})} as any)).rejects.toThrow("READ_BOUNDARY_REVISION_CLARIFICATION_DECLINED");
  expect(decided?.stage).toBe("decided");if(!decided || decided.stage!=="decided" || decided.pending_question.kind!=="clarification")throw new Error("Expected the actual decided clarification checkpoint");expect(decided.pending_question.decision).toEqual({state:"declined"});expect(noSend).not.toHaveBeenCalled();
});

it("closed parser refuses nested extras, changed digest and oversized records",async()=>{
  const {saved}=await paused();const reseal=(value:any)=>{const {digest:_hash,schema_version:_version,...body}=value;return readBoundaryRevisionCheckpoint(body);};
  expect(()=>parseReadBoundaryRevisionCheckpoint({...saved,digest:hash})).toThrow("CHECKPOINT_INVALID");
  expect(()=>reseal({...saved,pending_question:{...saved.pending_question,request:{...question,authority:true}}})).toThrow("CHECKPOINT_INVALID");
  expect(()=>reseal({...saved,pending_question:{...saved.pending_question,completion:undefined}})).toThrow("CHECKPOINT_INVALID");
  expect(()=>reseal({...saved,state:{...saved.state,issue:"x".repeat(1501)}})).toThrow("CHECKPOINT_INVALID");
  const large={...saved,state:{...saved.state,clarification_count:16,call_count:17,clarification_answers:Array.from({length:16},()=>({question:"q".repeat(500),answer:"a".repeat(1000)})),private_decisions:Array.from({length:130},(_,i)=>({resource:"r".repeat(256),field:String(i)+"f".repeat(250),before:"model_and_runner",after:"runner_only",rationale:"r".repeat(500)}))}};
  expect(()=>reseal(large)).toThrow("CHECKPOINT_INVALID");expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(64*1024);
});

it("retained private selection shape rejects nested extras and explicit null/undefined without inventing consent",async()=>{
  const {saved}=await paused(),{digest:_d,schema_version:_s,...body}=saved;
  const source={schema:"public",table:"owned_current_state"},fields={tenant_column:"tenant_id",principal_column:"principal_id",state_column:"state",effective_from_column:"effective_from",effective_until_column:"effective_until"};
  // Shape fixture only; restoring it still requires actual host revalidation.
  const p:any={schema_version:"synapsor.read-current-state-prerequisite.v1",source,subject:{tenant_column:"tenant_id",principal_column:"principal_id",unique_constraint:"owner_current_state"},current_state:{state_column:"state",positive_state:"active",effective_from_column:"effective_from",effective_until_column:"effective_until",interval:"[effective_from,effective_until)",clock:"database_utc"},semantic_consent:{source_description:"Owned current state shape fixture",positive_state_description:"Owned positive state shape fixture",confirmed:true},dependency:{schema_version:"synapsor.read-prerequisite-dependency.v1",source,fields,unique_constraint:"owner_current_state",positive_state:"active",clock:"database_utc",fingerprint:hash}};
  const seal=(value:any)=>readBoundaryRevisionCheckpoint({...body,state:{...saved.state,reviewed_prerequisite:value}});
  expect(seal(p).state.reviewed_prerequisite).toEqual(p);
  for(const path of ["source","subject","current_state","semantic_consent","dependency","dependency.source","dependency.fields"]) {
    const next=structuredClone(p);let node=next;for(const key of path.split("."))node=node[key];node.unrequested=true;
    expect(()=>seal(next)).toThrow("CHECKPOINT_INVALID");
  }
  for(const value of [null,undefined])for(const location of ["root","dependency"]) {
    const next=structuredClone(p);(location==="root" ? next : next.dependency).rls_session=value;
    expect(()=>seal(next)).toThrow("CHECKPOINT_INVALID");
  }
});

it("restores an actual host-factory relationship selection with fresh generated-proof validation",async()=>{
  const current=boundary();current.pack.resources[0]!.field_types.customer_id="uuid";
  current.pack.resources.push({...structuredClone(current.pack.resources[0]!),id:"public.customers",table:"customers"});
  const generated=structuredClone(current);
  const links=[{constraint_name:"orders_customer_fk",source_resource:"public.orders",target_resource:"public.customers",source_columns:["tenant_id","customer_id"],target_columns:["tenant_id","id"],target_uniqueness:{kind:"unique_constraint" as const,name:"customers_tenant_id",columns:["tenant_id","id"]},nullable:false,cardinality:"many_to_one" as const,max_fan_out:1 as const}];
  generated.pack.resources[0]!.relationships.push({id:"orders_customer_fk",target_resource:"public.customers",local_columns:links[0]!.source_columns,target_columns:links[0]!.target_columns,counted_entity:"public.customers",cardinality:"many_to_one",max_fan_out:1,path_depth:1,proof:{source:"database_catalog",links,digest:canonicalJsonDigest(links)}});
  let reviewed:ReviewedReadRelationship|undefined,saved:ReadBoundaryRevisionCheckpoint|undefined,sends=0;
  const reviewRelationship=async()=>{reviewed=await reviewReadRelationship({projectRoot:"/tmp/owned-revision-checkpoint",boundary:current,generatedBoundary:generated,fromResource:"public.orders",toResource:"public.customers",modelLabel:"owned-offline",session:{chooseOption:async()=>"0"} as any,assertCurrent:async()=>undefined});return reviewed;};
  await expect(generateModelReadBoundaryRevision({...setup(async()=>response(++sends===1 ? {relationship_review_request:{from_resource:"public.orders",to_resource:"public.customers",reason:"Restore the exact requested generated path."}} : {clarification_request:question})),boundary:current,reviewRelationship,onCheckpoint:async value=>{if(value)saved=value;},clarificationHandler:async()=>undefined})).rejects.toMatchObject({code:"ASK_CANCELLED"});
  expect(saved?.state.reviewed_relationship).toEqual(reviewed);const revalidate=vi.fn(async(selections:any)=>{validateReviewedReadRelationship(selections.reviewed_relationship,current,generated);});
  const result=await generateModelReadBoundaryRevision({...setup(async()=>response(valid)),boundary:current,reviewRelationship,resumeCheckpoint:saved,revalidateStagedSelections:revalidate,clarificationHandler:async()=>({state:"answered",answer})});
  expect(revalidate).toHaveBeenCalledTimes(2);expect(result.reviewed_relationship).toEqual(reviewed);expect(result.policy_changes?.[0]?.settings.relationship_ids).toContain("orders_customer_fk");
});

it("retained host relationship cannot be restored without actual current revalidation",async()=>{
  const {saved}=await paused();const {digest:_hash,schema_version:_version,...body}=saved;
  const staged=readBoundaryRevisionCheckpoint({...body,state:{...saved.state,reviewed_relationship:{schema_version:"synapsor.reviewed-read-relationship.v1",candidate_digest:explorationBoundaryCandidateDigest(boundary()),resource:"public.orders",relationship_id:"owned_old_path",relationship_fingerprint:hash}}});
  const noSend=vi.fn(),handler=vi.fn(),input:any={...setup(noSend),resumeCheckpoint:staged,reviewRelationship:async()=>undefined,clarificationHandler:handler};
  // Match the static review-handler profile of the original checkpoint.
  const fresh=await paused();const {digest:_d,schema_version:_s,...core}=fresh.saved;
  input.resumeCheckpoint=readBoundaryRevisionCheckpoint({...core,state:staged.state});delete input.reviewRelationship;
  await expect(generateModelReadBoundaryRevision(input)).rejects.toThrow(/STAGED.*REVALIDATION/);
  input.revalidateStagedSelections=async()=>{throw new Error("OWNED_RELATIONSHIP_PROOF_STALE");};
  await expect(generateModelReadBoundaryRevision(input)).rejects.toThrow("OWNED_RELATIONSHIP_PROOF_STALE");expect(handler).not.toHaveBeenCalled();expect(noSend).not.toHaveBeenCalled();
});

it("accepted-result notification precedes caller save and does not silently clear a retained decision",async()=>{
  const {saved}=await paused();let durable:ReadBoundaryRevisionCheckpoint|undefined=saved;const calls=vi.fn(async()=>response(valid));let accepted=false;
  await expect(generateModelReadBoundaryRevision({...setup(calls),resumeCheckpoint:saved,clarificationHandler:async()=>({state:"answered",answer}),onCheckpoint:async(value:any,_boundary:any,result:any)=>{
    if(value)durable=value;else {accepted=true;expect(result.changes).toMatchObject([{field:"status",after:"runner_only"}]);expect(durable?.stage).toBe("dispatching");expect(durable?.state.clarification_answers).toEqual([{question:question.question,answer}]);throw new Error("OWNED_GUARDED_SAVE_REFUSED");}
  }} as any)).rejects.toThrow("OWNED_GUARDED_SAVE_REFUSED");expect(accepted).toBe(true);expect(durable?.stage).toBe("dispatching");expect(durable?.state.clarification_answers).toEqual([{question:question.question,answer}]);expect(calls).toHaveBeenCalledOnce();
});

it.each([1,2])("carries a real decoded completion receipt for owner wait at actual turn%s",async turn=>{
  let saved:ReadBoundaryRevisionCheckpoint|undefined,state:AuthoringTransportState={version:1,operations:[]},sends=0;
  const server=createServer(async(req,res)=>{for await(const _chunk of req){}sends++;res.setHeader("content-type","application/json");res.end(JSON.stringify(response({clarification_request:{...question,question:question.question+String(sends)}}).body));});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const endpoint=new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`);
  const host={available:()=>true,read:()=>state,current:async()=>canonicalJsonDigest(saved??"owned_revision_origin"),write:async(value:AuthoringTransportState)=>{validateAuthoringTransportState(value);state=structuredClone(value);}};
  try {await expect(withAuthoringGenerationRecovery(()=>{configureAuthoringGenerationRecovery(host);return generateModelReadBoundaryRevision({...setup((request:any)=>secureAskJsonRequest({...request,endpoint,scope:"custom_loopback"})),onCheckpoint:async(value:any)=>{saved=value;},clarificationHandler:async()=>{
    const op=state.operations.at(-1)!;if(!saved || saved.stage!=="waiting")throw new Error("Expected the actual waiting clarification checkpoint");expect(saved.pending_question.completion).toMatchObject({operation_id:op.id,request_digest:op.request_digest,context_digest:op.context_digest,
      response_digest:canonicalJsonDigest(response({clarification_request:{...question,question:question.question+String(sends)}}).body)});
    expect(op.state).toBe("handled");return sends<turn ? {state:"answered",answer} : undefined;
  }} as any);})).rejects.toMatchObject({code:"ASK_CANCELLED"});expect(sends).toBe(turn);}
  finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


it("saves a dispatching revision with no invented question before send and revalidates its ordinary continuation", async () => {
  let saved: ReadBoundaryRevisionCheckpoint | undefined;
  const noSend = vi.fn();
  await expect(generateModelReadBoundaryRevision({ ...setup(noSend), onCheckpoint: async next => {
    if (next?.stage === "dispatching") { saved = next; throw new Error("OWNED_BEFORE_DISPATCH_STOP"); }
  } })).rejects.toThrow("OWNED_BEFORE_DISPATCH_STOP");
  expect(noSend).not.toHaveBeenCalled(); expect(saved).toMatchObject({ stage: "dispatching", state: { call_count: 0, correction_used: false } });
  expect(saved).not.toHaveProperty("pending_question");
  const { digest: _d, schema_version: _s, ...body } = saved!;
  expect(() => readBoundaryRevisionCheckpoint({ ...body, pending_question: { kind: "clarification", request: question, question: question.question } } as any)).toThrow("CHECKPOINT_INVALID");
  expect(() => readBoundaryRevisionCheckpoint({ ...body, dispatch_question: "" } as any)).toThrow("CHECKPOINT_INVALID");
  const changed = vi.fn();
  await expect(generateModelReadBoundaryRevision({ ...setup(changed), instruction: "A different business request.", resumeCheckpoint: saved })).rejects.toThrow("CHECKPOINT_STALE");
  expect(changed).not.toHaveBeenCalled();
  const resumed = vi.fn(async request => { expect(JSON.stringify(request.body)).toContain(JSON.stringify(saved!.dispatch_question).slice(1,-1)); return response(valid); });
  const result = await generateModelReadBoundaryRevision({ ...setup(resumed), resumeCheckpoint: saved });
  expect(resumed).toHaveBeenCalledOnce(); expect(result.changes).toMatchObject([{ field: "status", after: "runner_only" }]);
});


it("outer controller callback reservation records a revision count before an uncertain raw save", async () => {
  let saved: ReadBoundaryRevisionCheckpoint | undefined, state: AuthoringTransportState = { version: 1, operations: [] }, sends = 0;
  const server = createServer(async (req, res) => { for await (const _chunk of req) {} sends++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "completed", ...response(valid).body })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`);
  const host = { available: () => true, read: () => state, current: async () => canonicalJsonDigest("fixed current revision business input"),
    write: async (value: AuthoringTransportState) => { validateAuthoringTransportState(value); state = structuredClone(value); } };
  try {
    await expect(withAuthoringGenerationRecovery(() => { configureAuthoringGenerationRecovery(host);
      return generateModelReadBoundaryRevision({ ...setup((r: Parameters<typeof secureAskJsonRequest>[0]) => secureAskJsonRequest({ ...r, endpoint, scope: "custom_loopback" })),
        instruction: "Keep status private to Runner with no model analysis; preserve other access.", onCheckpoint: async value => {
          saved = structuredClone(value); if(value?.stage === "dispatching" && value.state.call_count === 1) throw new Error("OWNED_RAW_COUNTER_ACK_LOST");
        } }); })).rejects.toMatchObject({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" });
    expect(sends).toBe(1); expect(saved).toMatchObject({ stage: "dispatching", state: { call_count: 1 } }); expect(saved).not.toHaveProperty("pending_question");
    expect(state.operations[0]?.state).toBe("partial"); expect(saved?.state.private_decisions).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


it("retains exact typed history after a revision answer without making it active again", async () => {
  const {saved}=await paused();let decided: ReadBoundaryRevisionCheckpoint|undefined,dispatch: ReadBoundaryRevisionCheckpoint|undefined;
  const send=vi.fn(async()=>response(valid)),handler=vi.fn(async()=>({state:"answered" as const,answer}));
  await generateModelReadBoundaryRevision({...setup(send),resumeCheckpoint:saved,clarificationHandler:handler,onCheckpoint:async cp=>{
    if(cp?.stage==="decided")decided=structuredClone(cp);if(cp?.stage==="dispatching")dispatch=structuredClone(cp);
  }});
  expect(handler).toHaveBeenCalledOnce();expect(send).toHaveBeenCalledOnce();
  if(!decided || decided.stage!=="decided" || !dispatch || dispatch.stage!=="dispatching")throw new Error("Expected real typed and dispatch records");
  expect(dispatch.previous_question).toEqual({stage:"decided",pending_question:decided.pending_question});expect(dispatch).not.toHaveProperty("pending_question");
  const {digest:_d,schema_version:_s,...body}=dispatch, previous=decided.pending_question;
  expect(()=>readBoundaryRevisionCheckpoint({...body,previous_question:{stage:"waiting" as const,pending_question:previous}})).toThrow("CHECKPOINT_INVALID");
});

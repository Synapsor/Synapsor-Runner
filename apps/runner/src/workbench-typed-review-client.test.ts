import vm from "node:vm";
import { expect, it } from "vitest";
import { renderBoundaryWorkbench } from "./boundary-workbench.js";

function client() {
  const source=renderBoundaryWorkbench("csrf").match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const start=source.indexOf("const reviewDecision=id=>"),end=source.indexOf("const classificationFor=",start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const script=source.slice(start,end);
  const candidate={pack:{name:"declared",resources:[{id:"equipment.parts"}]}};
  const context=vm.createContext({structuredClone,candidate,typedReviewDecisions:[],reviewCandidateDigest:undefined,
    reviewCandidateSnapshot:undefined,confirmedDecisions:new Set(),authoringBinding:undefined});
  const api=vm.runInContext(`${script}; ({adoptTypedReview,typedReviewSubmission,resourceDecisions,globalDecisions,reviewDecisionIds})`,context);
  const refs=[{id:"scope",kind:"principal_scope",resource_id:"equipment.parts",input_digest:"sha256:scope",decision:"A changed presentation string"},
    {id:"deployment",kind:"deployment_profile",input_digest:"sha256:deployment",decision:"equipment.parts: misleading presentation"}];
  const payload={review_decisions:refs,review_candidate_digest:"sha256:candidate",confirmed_review_ids:[]};
  return {source,context,api,payload,candidate};
}
it("Workbench sends only explicitly selected exact typed references; prose never determines identity or confirmation",()=>{
  const x=client();x.api.adoptTypedReview(x.payload);
  expect(x.api.typedReviewSubmission().decisions).toEqual([]);
  expect(x.api.resourceDecisions("equipment.parts")).toEqual(["scope"]);
  expect(x.api.globalDecisions()).toEqual(["deployment"]);
  const actual=x.api.typedReviewSubmission(["scope"]);
  expect(actual).toEqual({schema_version:"synapsor.boundary-review-submission.v1",candidate_digest:"sha256:candidate",decisions:[{id:"scope",kind:"principal_scope",resource_id:"equipment.parts",input_digest:"sha256:scope"}]});
  x.payload.review_decisions[0]!.decision="A different human explanation";
  x.api.adoptTypedReview(x.payload);
  expect(x.api.typedReviewSubmission(["scope"])).toEqual(actual);
  expect(x.api.typedReviewSubmission().decisions).toEqual([]);
});
it("Workbench rejects stale candidate, foreign choices and old string-only inventory before sending",()=>{
  const x=client();expect(()=>x.api.adoptTypedReview({confirmed_decisions:["yes"]})).toThrow(/typed Read review/);
  x.api.adoptTypedReview(x.payload);
  expect(()=>x.api.typedReviewSubmission(["foreign"])).toThrow(/selected review changed/);
  x.candidate.pack.name="changed";
  expect(()=>x.api.typedReviewSubmission(["scope"])).toThrow(/Save the disabled change/);
});
it("actual Workbench progress sender submits exact typed selection and adopts only the successful server readback",async()=>{
  const x=client();x.api.adoptTypedReview(x.payload);
  const start=x.source.indexOf("function queueReviewProgressSave(){"),end=x.source.indexOf("function renderResourceDetail(){",start);
  const sent:unknown[]=[];
  const nodes={actor:{value:"declared human"},message:{textContent:"",className:""}};
  Object.assign(x.context,{reviewReport:{},reviewRevision:4,reviewInvalidations:[],reviewProgressHealthy:true,progressSave:Promise.resolve(),
    byId:(id:keyof typeof nodes)=>nodes[id],updateActivationState:()=>{},post:async(url:string,body:unknown)=>{
      sent.push({url,body});return {...x.payload,revision:5,confirmed_review_ids:["scope"],invalidated_decisions:[]};}});
  vm.runInContext('confirmedDecisions.add("scope")',x.context);
  const save=vm.runInContext(`${x.source.slice(start,end)}; queueReviewProgressSave`,x.context);
  await save();
  expect(sent).toEqual([{url:"/api/boundary/progress",body:{candidate:x.candidate,review_submission:x.api.typedReviewSubmission(["scope"]),expected_revision:4,actor:"declared human",authoring_binding:undefined}}]);
  expect(x.context.reviewRevision).toBe(5);
  expect([...x.context.confirmedDecisions]).toEqual(["scope"]);
  x.context.post=async()=>{throw new Error("stale native revision")};
  await save();expect(x.context.reviewRevision).toBe(5);expect(x.context.reviewProgressHealthy).toBe(false);
});
it("a successful earlier transport ACK cannot replace a different currently displayed native binding",async()=>{
  const x=client(),start=x.source.indexOf("const post=async"),end=x.source.indexOf("const currentResource=",start);
  const old={repository_id:"r",deployment_id:"d",project_id:"p",epoch:1,revision_id:"old"};
  const current={...old,epoch:2,revision_id:"new-view"},ack={...old,epoch:3,revision_id:"old-request-ack"};
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});
  const sent:unknown[]=[];
  const context=vm.createContext({structuredClone,initial:old,fetch:async(_url:string,input:{body:string})=>{
    sent.push(JSON.parse(input.body));await held;return {ok:true,payload:{ok:true,authoring_binding:ack}};}});
  const api=vm.runInContext(`let authoringBinding=structuredClone(initial);const csrf="csrf";
    const readPayload=async result=>result.payload;const handleSessionFailure=()=>false;
    ${x.source.slice(start,end)}
    ({post,binding:()=>authoringBinding,change:value=>{authoringBinding=value}});`,context);
  const request={authoring_binding:old,actor:"old operator"};
  const pending=api.post("/api/boundary/progress",request);api.change(current);release();await pending;
  expect(sent).toEqual([request]);expect(api.binding()).toEqual(current);
});
it("queued ACK preserves a later candidate, revision, operator and native binding instead of mixing views",async()=>{
  const x=client();x.api.adoptTypedReview(x.payload);
  const start=x.source.indexOf("function queueReviewProgressSave(){"),end=x.source.indexOf("function renderResourceDetail(){",start);
  const binding={repository_id:"r",deployment_id:"d",project_id:"p",epoch:2,revision_id:"shown"};
  const next={...binding,epoch:3,revision_id:"different"};
  const actor={value:"shown human"},message={textContent:"",className:""},sent:unknown[]=[];
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});
  Object.assign(x.context,{authoringBinding:binding,reviewReport:{},reviewRevision:4,reviewInvalidations:["current"],reviewProgressHealthy:true,progressSave:held,
    byId:(id:string)=>id==="actor"?actor:message,updateActivationState:()=>{},post:async(_url:string,body:unknown)=>{
      sent.push(structuredClone(body));return {...x.payload,revision:5,authoring_binding:{...binding,epoch:3,revision_id:"saved"},confirmed_review_ids:["scope"],invalidated_decisions:["older"]};}});
  const save=vm.runInContext(`${x.source.slice(start,end)}; queueReviewProgressSave`,x.context);
  const capturedCandidate=structuredClone(x.candidate),pending=save();
  x.candidate.pack.name="later view";actor.value="later human";x.context.reviewRevision=9;x.context.authoringBinding=next;
  release();await pending;
  expect(sent).toEqual([{candidate:capturedCandidate,review_submission:{...x.payload,decisions:[]},expected_revision:4,actor:"shown human",authoring_binding:binding}].map(item=>({...item,review_submission:{schema_version:"synapsor.boundary-review-submission.v1",candidate_digest:x.payload.review_candidate_digest,decisions:[]}})));
  expect(x.context.reviewRevision).toBe(9);expect(x.context.authoringBinding).toEqual(next);
  expect(x.context.reviewInvalidations).toEqual(["current"]);expect([...x.context.confirmedDecisions]).toEqual([]);
  expect(x.candidate.pack.name).toBe("later view");expect(actor.value).toBe("later human");
});

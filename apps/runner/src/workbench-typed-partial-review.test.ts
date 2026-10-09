import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { nativeReadScopeActivationFixture } from "./test-fixtures/native-read-scope-activation.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { boundaryReviewSubmissionForDecisions, applicableBoundaryReviewConfirmations } from "./boundary-review-domain.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { startLocalUiServer } from "./local-ui.js";

async function fixture() {
  const f=await nativeReadScopeActivationFixture();
  const mutation=await prepareBoundaryResourceReviewMutation(f.dir,{resource_id:"work.items",metadata:{label:"Reviewed items"},actor:"declared Workbench operator",reason:"Use this explicit presentation label"},async()=>f.prepared.inspection);
  await commitBoundaryResourceReviewMutation(f.dir,mutation);
  const context=await loadBoundaryReviewContext(f.dir);
  expect(context.bundle.outstanding_decision_ids.length).toBeGreaterThan(0);
  const server=await startLocalUiServer({projectRoot:f.dir,boundaryRoot:path.join(f.dir,"synapsor/generated"),
    configPath:path.join(f.dir,"synapsor.runner.json"),storePath:path.join(f.dir,".synapsor/local.db"),
    token:"typed-partial-token",csrfToken:"typed-partial-csrf",schemaInspector:async()=>f.prepared.inspection});
  const post=async(body:unknown)=>{
    const response=await fetch(`http://${server.host}:${server.port}/api/boundary/progress`,{method:"POST",headers:{"content-type":"application/json","x-synapsor-ui-token":"typed-partial-token","x-synapsor-csrf":"typed-partial-csrf"},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as Record<string,unknown>};
  };
  const submission=boundaryReviewSubmissionForDecisions(context.candidate,context.bundle.outstanding_decision_ids.slice(0,1));
  const body={candidate:context.candidate,review_submission:submission,expected_revision:context.progress!.revision,
    authoring_binding:context.bundle.mutation_bindings.authoring,actor:"declared Workbench operator"};
  return {f,context,server,post,body};
}
it("actual Workbench partial typed submission saves only its displayed reference with protected native origin",async()=>{
  const x=await fixture();try{
    const before=await readProjectReadAuthoring(x.f.dir);
    const result=await x.post(x.body);
    expect(result.status).toBe(200);expect(result.body.ok).toBe(true);
    const after=await readProjectReadAuthoring(x.f.dir);expect(after!.bindings.epoch).toBe(before!.bindings.epoch+1);
    const submitted=x.body.review_submission.decisions[0]!;
    const confirmation=after!.selected!.progress.confirmations.find(item=>item.id===submitted.id)!;
    expect(confirmation.origin).toEqual({revision_id:before!.bindings.revision_id,boundary_id:before!.selected!.progress.boundary_id,candidate_digest:x.context.bundle.candidate_digest});
    expect(applicableBoundaryReviewConfirmations(after!.selected!.progress.candidate,after!.selected!.progress.confirmations,after!.resolvedOrigins).some(item=>item.current.id===submitted.id)).toBe(true);
    expect(result.body.authoring_binding).toEqual(after!.bindings);
    await expect(loadActivatedExplorationBoundaries(x.f.dir)).rejects.toMatchObject({code:"ENOENT"});
  }finally{await x.server.close();}
},30000);
it("actual Workbench empty typed submission leaves missing review pending",async()=>{
  const x=await fixture();try{
    const before=await readProjectReadAuthoring(x.f.dir);
    const result=await x.post({...x.body,review_submission:{...x.body.review_submission,decisions:[]}});
    expect(result.status).toBe(200);
    const after=await readProjectReadAuthoring(x.f.dir);
    expect(after!.selected!.progress.confirmations).toEqual(before!.selected!.progress.confirmations);
    expect((await loadBoundaryReviewContext(x.f.dir)).bundle.outstanding_decision_ids).toEqual(x.context.bundle.outstanding_decision_ids);
    await expect(loadActivatedExplorationBoundaries(x.f.dir)).rejects.toMatchObject({code:"ENOENT"});
  }finally{await x.server.close();}
},30000);
it.each(["old-strings","foreign-reference","duplicate-reference","wrong-candidate-digest","stale-revision","stale-authoring","changed-candidate"])("actual Workbench refuses %s without saving",async kind=>{
  const x=await fixture();try{
    const before=await readProjectReadAuthoring(x.f.dir),body=structuredClone(x.body);
    if(kind==="foreign-reference")body.review_submission.decisions[0]!.id="foreign-reference";
    if(kind==="duplicate-reference")body.review_submission.decisions.push(structuredClone(body.review_submission.decisions[0]!));
    if(kind==="wrong-candidate-digest")body.review_submission.candidate_digest=`sha256:${"0".repeat(64)}`;
    if(kind==="stale-authoring")body.authoring_binding!.epoch--;
    if(kind==="stale-revision")body.expected_revision--;
    if(kind==="changed-candidate")body.candidate.pack.name+="_changed";
    const result=await x.post(kind==="old-strings"?{candidate:body.candidate,confirmed_decisions:x.context.candidate.unresolved_decisions,expected_revision:body.expected_revision,authoring_binding:body.authoring_binding,actor:body.actor}:body);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(await readProjectReadAuthoring(x.f.dir)).toEqual(before);
    await expect(loadActivatedExplorationBoundaries(x.f.dir)).rejects.toMatchObject({code:"ENOENT"});
  }finally{await x.server.close();}
},30000);

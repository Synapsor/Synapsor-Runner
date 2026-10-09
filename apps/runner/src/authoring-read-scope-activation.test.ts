import { describe, expect, it } from "vitest";
import { nativeReadScopeActivationFixture as activationFixture,
  reviewNativeReadScopeActivationFixture as review } from "./test-fixtures/native-read-scope-activation.js";
import { readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { assessReadScopeForActivation } from "./authoring-read-scope-activation.js";

const assess=(f:Awaited<ReturnType<typeof activationFixture>>,destination=f.destination)=>withProjectAuthorityMutation(f.dir,permit=>
  assessReadScopeForActivation({projectRoot:f.dir,candidate:f.prepared.context.candidate,readerInspection:f.prepared.inspection,permit,
    ...(destination?{currentDestination:destination}:{})}));
describe("standalone activation native Read assessment hydration",()=>{
  it.each([true,false,null])("derives only the genuine native displayed decision %s",async accepted=>{
    const f=await activationFixture();await review(f,accepted);
    const before=await readBoundaryAuthoringResumeState(f.dir,f.nativeBinding);
    const result=await assess(f);
    expect(result).toMatchObject({kind:"native",status:accepted===true?"confirmed":"pending",replacement_pending:false});
    expect(await readBoundaryAuthoringResumeState(f.dir,f.nativeBinding)).toEqual(before);
    expect(result.kind==="native"&&result.analysis_assessment?.status).toBe("compatible");
  });
  it("keeps a real saved setup without a scope question pending",async()=>{
    const f=await activationFixture();expect(await assess(f)).toMatchObject({kind:"missing",status:"pending"});
  });
  it("refuses a different actual candidate without adopting it",async()=>{
    const f=await activationFixture();await review(f,true);
    await expect(withProjectAuthorityMutation(f.dir,permit=>assessReadScopeForActivation({projectRoot:f.dir,
      candidate:{...f.prepared.context.candidate,pack:{...f.prepared.context.candidate.pack,name:"changed"}},readerInspection:f.prepared.inspection,permit}))).rejects.toThrow("selected candidate");
  });
  it("requires a valid live mutation permit",async()=>{
    const f=await activationFixture();let expired: any;
    await withProjectAuthorityMutation(f.dir,async permit=>{expired=permit;});
    await expect(assessReadScopeForActivation({projectRoot:f.dir,candidate:f.prepared.context.candidate,
      readerInspection:f.prepared.inspection,permit:expired})).rejects.toMatchObject({code:"POLICY_MUTATION_PERMIT_INVALID"});
  });
  it("requires the custom endpoint's exact saved metadata identity",async()=>{
    const f=await activationFixture(true);await review(f,true);
    expect(await assess(f)).toMatchObject({kind:"native",status:"confirmed"});
    await expect(assess(f,{...f.destination,baseUrl:"http://localhost:9999/v1"})).rejects.toThrow("saved metadata permission");
    await expect(withProjectAuthorityMutation(f.dir,permit=>assessReadScopeForActivation({projectRoot:f.dir,
      candidate:f.prepared.context.candidate,readerInspection:f.prepared.inspection,permit}))).rejects.toThrow("destination is unavailable");
  });
});

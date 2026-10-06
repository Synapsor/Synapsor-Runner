import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { onboard, start } from "./guided-start.js";
import { boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { readBoundaryRevisionCatalog } from "./read-boundary-revision-model.js";
import { ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";
import * as delegationSetup from "./delegation-setup.js";
import * as boundaryMutations from "./boundary-review-mutation.js";

/** One implementer-derived, Source-free public Read revision owner wait.
 * Ordinary local provider responses and terminal/inspection IO are supplied;
 * the real planner, encoder, narrator, revision consumer and stores run. */
const question="Should parcel units remain visible to the assistant, or stay private to Runner?";
const answer="Keep parcel units private to Runner; remove model return and all model analysis on units.";
const instruction="Review whether parcel units should be visible to the assistant or private; preserve parcel labels and all other access.";
const job="Read parcel labels and units. studio.parcels is the parcel register; studio.parcels.label is the public parcel name; studio.parcels.units is the unit count.";
const strings=(value:any):string[]=>typeof value==="string" ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value==="object" ? Object.values(value).flatMap(strings) : [];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

async function publicReadRevisionWait(control:"healthy"|"pause_restart"|"terminal_invalid"|"committed_read"|"guard_ack_loss") {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),`owned-public-read-revision-wait-${control}-`));
  const inspection=ownedProgramInspection(),inspect=async()=>structuredClone(inspection);
  const resumeFile=path.join(root,".synapsor/boundary-authoring/resume.json");
  const readResume=async()=>fs.readFile(resumeFile,"utf8").then(text=>JSON.parse(text)).catch(()=>undefined);
  let transcript="",stage:"initial"|"revision"|"reopen"="initial",requests=0,revisionRequests=0,jobReads=0,instructionReads=0,questionReads=0,reopenOffset=0;
  let chosenRevision=false,awaitingClarification=false,followupSeen=false,before:any,waiting:any,paused:any,reopened:any,statementConfirmations=0,statementDetailsRequested=false;
  const responses:any[]=[],menus:any[]=[],failures:any[]=[],reads:any[]=[];
  let committedFault = false;
  const writeDelegation = delegationSetup.writeDelegationDraft;
  if(control==="committed_read") vi.spyOn(delegationSetup,"writeDelegationDraft").mockImplementation(async(...args)=>{
    const current=await loadBoundaryReviewContext(root);
    const units=readBoundaryRevisionCatalog(current.candidate).resources.find(resource=>resource.id==="studio.parcels")?.fields.find(field=>field.id==="units");
    if(!committedFault && stage==="revision" && units?.current_exposure==="runner_only") {
      committedFault=true;throw new Error("OWNED_POST_READ_COMMIT_PRE_DELEGATION_WRITE");
    }
    return writeDelegation(...args);
  });
  if(control==="guard_ack_loss") for(const method of ["commitBoundaryReviewMutationBatch","commitExactBoundaryCandidateMutation"] as const) {
    const original=boundaryMutations[method];
    vi.spyOn(boundaryMutations,method).mockImplementation(async(...args:any[])=>{
      const result=await (original as any)(...args);
      const current=await loadBoundaryReviewContext(root);
      const units=readBoundaryRevisionCatalog(current.candidate).resources.find(resource=>resource.id==="studio.parcels")?.fields.find(field=>field.id==="units");
      if(!committedFault && stage==="revision" && units?.current_exposure==="runner_only") {
        committedFault=true;throw new Error("OWNED_READ_GUARD_ACK_LOSS_AFTER_REAL_COMMIT");
      }
      return result;
    });
  }
  const write=(text:string)=>{transcript+=text;};
  const fail=(message:string):never=>{throw new Error(`${message}\n${transcript.slice(-6000)}`);};
  const read=async()=>{
    const snapshot=await readResume();reads.push({stage,requests,awaitingClarification,resume:structuredClone(snapshot)});
    if(awaitingClarification && (stage!=="reopen" || transcript.slice(reopenOffset).includes(question))) {
      questionReads++;expect(transcript).toContain(question);waiting??=structuredClone(snapshot);
      if(stage==="reopen") {
        expect(requests).toBe(paused.requests);
        expect(snapshot?.owner_handoffs?.at(-1)).toEqual(waiting?.owner_handoffs?.at(-1));
      }
      return control==="pause_restart" && stage!=="reopen" ? undefined : answer;
    }
    if(stage==="revision") {instructionReads++;expect(instructionReads).toBe(1);return instruction;}
    if(stage==="reopen")return undefined;
    jobReads++;expect(jobReads).toBe(1);return job;
  };
  const io:any={write,writeChunk:write,columns:()=>110,isTerminal:()=>false,setStatus:()=>{},clearStatus:()=>{},close:()=>{},onInterrupt:()=>()=>{},
    review:async(title:string,content:string[])=>write(`\n${title}\n${content.join("\n")}\n`),read,readConversation:read,
    choose:async(choice:any)=>{
      const values=choice.options.map((entry:any)=>entry.value);let selected:string|undefined;
      if(choice.title==="START BOUNDARY DRAFTING")selected=stage==="reopen" ? "resume" : "model";
      else if(choice.title==="SAVED BUSINESS STATEMENT") {
        expect(choice.initialValue).toBe("keep");expect(stage).toBe("reopen");expect(control).toBe("pause_restart");
        const saved=await readResume();
        expect(saved?.owner_handoffs?.at(-1)).toMatchObject({state:"waiting",question});
        expect(saved?.operator_questions?.at(-1)?.raw_answer).toBeUndefined();
        selected="review";
      }
      else if(choice.title==="CLIENT FOR THIS JOB")selected="later";
      else if(choice.title==="CLIENT INTEGRATION RESPONSIBILITIES")selected="assign";
      else if(choice.message==="Record this exact statement for the current question?") {
        expect(choice.initialValue).toBe("no");
        const saved=await readResume();
        expect(saved?.operator_questions?.at(-1)).toMatchObject({kind:"attributed_meaning",raw_answer:{text:answer},proposal:{value:{kind:"attributed_meaning"}}});
        expect(saved?.operator_questions?.at(-1)?.confirmation).toBeUndefined();
        expect(saved?.owner_handoffs?.at(-1)).toMatchObject({state:"waiting",question});
        expect(transcript.replace(/\s+/gu," ")).toContain(answer);
        expect(values).toContain("__view_runner_details__");
        if(!statementDetailsRequested) {statementDetailsRequested=true;selected="__view_runner_details__";}
        else {
          expect(transcript).toContain("EXACT BUSINESS STATEMENT");
          expect(transcript.replace(/\s+/gu," ")).toContain(question);
          statementConfirmations++;selected="yes";
        }
      }
      else if(values.includes("revise_model") && !chosenRevision) {chosenRevision=true;stage="revision";before=await loadBoundaryReviewContext(root);selected="revise_model";}
      else if(values.includes("finish"))selected="finish";
      else if(choice.title==="SETUP NEEDS ATTENTION" || values.includes("pause") && !values.includes("yes"))selected="pause";
      else if(values.includes("yes") && /Send this Boundary-authoring conversation|Allow the assistant to send|reviewed structural context|Allow the assistant to read|Allow the reviewed change requests/.test(choice.message)) {expect(choice.initialValue).toBe("no");selected="yes";}
      else if(choice.title==="REVIEW DECLARED TEXT INPUT BOUNDS")selected="none";
      menus.push({stage,...choice,selected});return selected && values.includes(selected) ? selected : undefined;
    }};
  const requestJson=async(request:any)=>{
    if(++requests>30)fail("Owned finite response fixture bound exceeded.");
    const body=request.body,text=strings(body).join("\n"),names=(body.tools??[]).map((tool:any)=>tool.name??tool.function?.name);
    let name:string|undefined,args:any,narration:string|undefined;
    if(names.includes("runner__plan_boundary_job")) {
      name="runner__plan_boundary_job";args={status:"planned",read_mode:"create",read_intent:job,action_mode:"none",summary:"Prepare a disabled label and units Read; no Action."};
    } else if(names.includes("runner__submit_read_workloads")) {
      name="runner__submit_read_workloads";args={allowed:[{id:"parcel_labels_units",description:"Read parcel labels and units.",plan:{kind:"rows",resource:"studio.parcels",select:["label","units"]}}],forbidden:[],
        operator_meanings:[{resource:"studio.parcels",operator_quote:"studio.parcels is the parcel register"},{resource:"studio.parcels",field:"label",operator_quote:"studio.parcels.label is the public parcel name"},{resource:"studio.parcels",field:"units",operator_quote:"studio.parcels.units is the unit count"}]};
    } else if(names.includes("runner__submit_read_boundary_revision")) {
      name="runner__submit_read_boundary_revision";revisionRequests++;
      if(control==="terminal_invalid") {
        args={resource_changes:[{resource:"studio.absent",field_exposure:[{field:"units",exposure:"runner_only"}]}]};
      } else if(revisionRequests===1) {awaitingClarification=true;args={clarification_request:{question,reason:"The requested existing units exposure remains a current owner choice."}};}
      else {
        expect(text).toContain(answer);expect(text).toContain(question);
        const saved=await readResume();expect(saved?.conversation).toContainEqual(expect.objectContaining({kind:"clarification",question,answer}));
        followupSeen=true;awaitingClarification=false;
        args={status:"revision",resource_changes:[{resource:"studio.parcels",field_exposure:[{field:"units",exposure:"runner_only",model_operations:"none"}]}]};
      }
    } else if(!names.length) {
      const line=text.split("\n").find(line=>line.startsWith("Exact next question: "));
      narration=line ? JSON.parse(line.slice("Exact next question: ".length)) : "The exact Read draft remains disabled; no source query or authority change occurred.";
    } else fail(`Unexpected actual tool surface: ${names.join(", ")}`);
    responses.push({stage,requests,names,args,bytes:Buffer.byteLength(JSON.stringify(body)),...(name==="runner__submit_read_boundary_revision" ? {encoded_question:text} : {})});
    return {status:200,body:{output:name ? [{type:"function_call",call_id:`owned-read-revision-wait-${requests}`,name,arguments:JSON.stringify(args)}]
      : [{type:"message",content:[{type:"output_text",text:narration}]}]}};
  };
  const outer:any={chooseResource:async()=>fail("No manual resource bypass"),editFieldTiers:async()=>fail("No manual field bypass"),
    chooseOption:async(title:string,choices:any[],options:any)=>{failures.push({title,context:options?.context,choices});return choices.some(entry=>entry.value==="pause") ? "pause" : undefined;},
    rememberDetails:(title:string,details:string[])=>{failures.push({title,details});},promptText:async()=>undefined,confirm:async()=>fail("No outer confirmation bypass")};
  const options:any={startWithAgentJob:true,exitAfterAgentJob:true,
    modelAuthoringSession:{provider:"openai",model:"owned-read-revision-wait-offline",apiKey:"owned-offline-fixture",dependencies:{requestJson}},
    actionProjectInspector:inspect,boundaryAuthoringChatFactory:(selection:any)=>createBoundaryAuthoringChat({...selection,io,color:false,streamLineDelayMs:0})};
  vi.stubEnv("OWNED_READ_REVISION_WAIT_URL","postgresql://fixture.invalid/never-opened");
  const stdout=vi.spyOn(process.stdout,"write").mockReturnValue(true);
  vi.spyOn(globalThis,"fetch").mockImplementation(async()=>fail("External network forbidden"));
  try {
    await onboard(["db","--project-root",root,"--from-env","OWNED_READ_REVISION_WAIT_URL","--schema","studio","--json"],{interactive:false,schemaInspector:inspect});
    await start(["--project-root",root,"--from-env","OWNED_READ_REVISION_WAIT_URL","--schema","studio","--cli"],{interactive:true,schemaInspector:inspect,
      runBoundaryReview:(args,inspector)=>boundaryReviewCommand(args,inspector,outer,undefined,options)});
    paused={requests,resume:await readResume(),context:await loadBoundaryReviewContext(root)};
    expect(chosenRevision,transcript).toBe(true);expect(before).toBeDefined();
    if(control==="committed_read" || control==="guard_ack_loss") {
      expect(statementConfirmations).toBe(1);
      expect(committedFault).toBe(true);
      expect(paused.context.bundle.candidate_digest).not.toBe(before.bundle.candidate_digest);
      expect(paused.resume.pending_read_revision_state.result_received).toBe(true);
      if(control==="committed_read") expect(paused.resume.pending_read_revision_state.saved_read_digest).toBe(paused.context.bundle.candidate_digest);
      else expect(paused.resume.pending_read_revision_state.saved_read_digest).toBeUndefined();
      const priorResponses=revisionRequests;
      stage="reopen";reopenOffset=transcript.length;
      await boundaryReviewCommand(["--project-root",root,"--access","--job-first"],inspect,outer,undefined,options);
      reopened={requests,resume:await readResume(),context:await loadBoundaryReviewContext(root)};
      expect(reopened.requests).toBe(paused.requests);expect(revisionRequests).toBe(priorResponses);
      expect(reopened.context.bundle.candidate_digest).toBe(paused.context.bundle.candidate_digest);
      expect(JSON.stringify(failures)).toContain(control==="committed_read" ? "READ_BOUNDARY_REVISION_SAVED_REVIEW_PENDING" : "READ_BOUNDARY_REVISION_RESULT_NOT_SAVED");
      const inspectionStart=requests;
      await boundaryReviewCommand(["--project-root",root,"--map","--all","--details"],inspect);
      expect(requests).toBe(inspectionStart);
      expect(await fs.readFile(path.join(root,".synapsor/exploration-boundary.active.json")).catch(()=>undefined)).toBeUndefined();
      if(control==="guard_ack_loss") {
        expect(transcript).not.toContain("The exact disabled Read and Action drafts are unchanged.");
        expect(transcript).toContain("Read revision save not confirmed");
        expect(transcript).toContain("Inspect current disabled Read/Action records");
      }
      return;
    }
    if(control==="terminal_invalid") {
      expect(statementConfirmations).toBe(0);
      expect(revisionRequests).toBe(2);expect(questionReads).toBe(0);
      expect(paused.resume.pending_read_revision_state.terminal_reason).toBe("READ_BOUNDARY_REVISION_NOT_SUBMITTED");
      expect(paused.context.bundle.candidate_digest).toBe(before.bundle.candidate_digest);
      stage="reopen";reopenOffset=transcript.length;
      await boundaryReviewCommand(["--project-root",root,"--access","--job-first"],inspect,outer,undefined,options);
      reopened={requests,resume:await readResume(),context:await loadBoundaryReviewContext(root)};
      expect(reopened.requests).toBe(paused.requests);expect(revisionRequests).toBe(2);
      expect(reopened.context.bundle.candidate_digest).toBe(before.bundle.candidate_digest);
      expect(reopened.resume.pending_read_revision_state).toEqual(paused.resume.pending_read_revision_state);
      expect(JSON.stringify(failures)).toContain("READ_BOUNDARY_REVISION_NOT_SUBMITTED");
      return;
    }
    expect(questionReads,transcript).toBe(1);
    expect(waiting?.policy_source_session).toBeUndefined();
    if(control==="pause_restart") {
      expect(paused.context.bundle.candidate_digest).toBe(before.bundle.candidate_digest);
      stage="reopen";reopenOffset=transcript.length;
      await boundaryReviewCommand(["--project-root",root,"--access","--job-first"],inspect,outer,undefined,options);
      reopened={requests,resume:await readResume(),context:await loadBoundaryReviewContext(root)};
      // Exact model-produced question must be durable BEFORE the human wait.
      const diagnostic={waiting_handoffs:waiting?.owner_handoffs,waiting_source:waiting?.policy_source_session,
        waiting_operations:waiting?.generation_recovery?.operations.map((operation:any)=>({state:operation.state,question_handoff:operation.question_handoff})),
        paused_requests:paused.requests,reopened_requests:reopened.requests,questionReads,failures};
      expect(waiting?.owner_handoffs?.at(-1),JSON.stringify(diagnostic)).toMatchObject({state:"waiting",question});
      // The unchanged healthy flow also makes its ordinary post-save narrator request.
      // Count the exact revision separately; do not turn that narrator into a replay.
      expect(questionReads).toBe(2);expect(revisionRequests).toBe(2);expect(followupSeen).toBe(true);
      expect(responses.filter(response=>response.stage==="reopen" && response.names.includes("runner__submit_read_boundary_revision"))).toHaveLength(1);
    } else expect(followupSeen,transcript).toBe(true);
    expect(statementConfirmations).toBe(1);
    const current=await loadBoundaryReviewContext(root),resource=readBoundaryRevisionCatalog(current.candidate).resources.find(entry=>entry.id==="studio.parcels")!;
    expect(current.bundle.candidate_digest).not.toBe(before.bundle.candidate_digest);
    expect(resource.fields.find(field=>field.id==="units")?.current_exposure).toBe("runner_only");
    expect(resource.fields.find(field=>field.id==="units")?.model_operations).toEqual([]);
    expect(resource.fields.find(field=>field.id==="label")?.current_exposure).toBe(readBoundaryRevisionCatalog(before.candidate).resources.find(entry=>entry.id==="studio.parcels")!.fields.find(field=>field.id==="label")!.current_exposure);
    expect(await fs.readFile(path.join(root,".synapsor/exploration-boundary.active.json")).catch(()=>undefined)).toBeUndefined();
  } finally {
    const evidence=process.env.OWNED_PUBLIC_READ_REVISION_WAIT_EVIDENCE;
    if(evidence) {await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,`${control}-${randomUUID()}.json`),JSON.stringify({origin:"IMPLEMENTER_DERIVED_PUBLIC_READ_REVISION_WAIT",control,transcript,publicOutput:stdout.mock.calls.map(([chunk])=>String(chunk)).join(""),responses,menus,failures,reads,waiting,paused,reopened,
      requests,revisionRequests,questionReads,followupSeen,finalResume:await readResume(),finalContext:await loadBoundaryReviewContext(root).catch(error=>({error:String(error)}))},null,2));}
    await fs.rm(root,{recursive:true,force:true});
  }
}

it.each(["healthy","pause_restart","terminal_invalid","committed_read","guard_ack_loss"] as const)("public Read revision preserves the exact model owner question before its consumer: %s",async control=>{
  await publicReadRevisionWait(control);
},30_000);

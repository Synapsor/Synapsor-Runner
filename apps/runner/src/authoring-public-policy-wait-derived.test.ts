import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { onboard, start } from "./guided-start.js";
import { boundaryAssistCommand, boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import { READ_WORKLOAD_SET_VERSION } from "./read-workload-assist.js";
import { saveInstantBoundaryReviewBaseline } from "./boundary-review-persistence.js";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation } from "./action-rule-authority.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { activePolicySource, loadPolicySources, policyTextSnapshot, savePolicySources } from "./authoring-policy-source.js";
import { ownedProgramDraft, ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";

/** Owned synthetic public regression. Only IO, inspection and local ordinary
 * provider responses are supplied. The actual planner/compiler/Source parser,
 * generation recovery, owner handoff, chat recorder, writer permit and CAS run.
 * No readiness/assessment callback or accepted-owner record is fabricated. */
type Control = "healthy" | "pause_restart" | "source_drift" | "schema_drift" | "role_drift" | "competing_resume" | "explicit_review";
const question="Should this parcel action be permitted only when the parcel is available?";
const answer="Yes. Require available=true; refuse unavailable parcels.";
const strings=(value:any):string[]=>typeof value==="string" ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value==="object" ? Object.values(value).flatMap(strings) : [];
const jsonLine=(text:string,prefix:string):any=>{
  const line=text.split("\n").find(line=>line.startsWith(prefix));return line ? JSON.parse(line.slice(prefix.length)) : undefined;
};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

async function publicPolicyWait(control:Control) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),`owned-public-policy-wait-${control}-`));
  const resumeFile=path.join(root,".synapsor/boundary-authoring/resume.json");
  const inspection=ownedProgramInspection();
  const inspect=async()=>structuredClone(inspection);
  const intent="studio.pack_parcel_1 records caller-supplied units from 1 to 10 for an available parcel; refuse unavailable parcels. Propose only; one human parcel_reviewer decides.";
  const job="Prepare studio.pack_parcel_1 in the attached rules. Read parcel labels and units. studio.parcels is the parcel register; studio.parcels.label is the public parcel name; studio.parcels.units is the unit count.";
  const lines=["Derived parcel proposal program.",
    "Whether availability must be true for this parcel action is undecided; obtain the current owner's confirmation before treating the interpretation as complete.",
    "The assistant may read parcel labels and units. studio.parcels is the parcel register; studio.parcels.label is the public parcel name; studio.parcels.units is the unit count.",
    "The Action accepts units from 1 to 10, changes only units and Runner's maintained counter, proposes only, and requires one human parcel_reviewer.",
    "Synthetic source-owner operating fact: every studio.parcels writer increments integer version on each update. This is an operator assertion, not observed enforcement.",
    "The available eligibility fact stays private to Runner verification; it is not returned to the assistant."];
  const initialLines=[...lines];initialLines[1]="The parcel action requires available=true; refuse unavailable parcels.";
  const sourceFile=path.join(root,"derived-policy-wait-rules.txt");await fs.writeFile(sourceFile,initialLines.join("\n"));
  let stage:"initial"|"question"|"restart"|"explicit_review"="initial",transcript="",requests=0,actionPhase=0,questionNarrations=0;
  let sourceId:string|undefined,questionReads=0,clarifyChosen=false,injected=false,expectedWaiting:any,competingSaved:any,baseline:any;
  const answers:Array<string|undefined>=[`/attach ${sourceFile}`,job];
  const responses:any[]=[],menus:any[]=[],reports:any[]=[],questionSnapshots:any[]=[],failures:any[]=[];
  const readResume=async()=>JSON.parse(await fs.readFile(resumeFile,"utf8"));
  const fail=(message:string):never=>{throw new Error(`${message}\n${transcript.slice(-10000)}`);};
  const inject=async()=>{
    if(injected)return;injected=true;
    if(control==="source_drift") {
      const saved=await loadPolicySources(root,sourceId!),next=structuredClone(saved),prior=activePolicySource(saved)!;
      const source=policyTextSnapshot(Buffer.from(prior.text+"\nA competing new requirement awaits review."),prior.name,prior.version+1);
      next.snapshots.push(source);next.active=source.version;await savePolicySources(root,next,{expectedDigest:canonicalJsonDigest(saved)});competingSaved=next;
    } else if(control==="schema_drift") inspection.tables[0]!.columns.find(column=>column.name==="units")!.data_type="bigint";
    else if(control==="role_drift") {
      inspection.current_user="studio_changed_reader";inspection.role_posture!.read_only=false;
      inspection.role_posture!.writable_relations=["studio.parcels"];inspection.tables[0]!.role_posture!.privileges.update=true;
    } else if(control==="competing_resume") {
      const saved=await readResume(),next=buildBoundaryAuthoringResumeState({previous:saved,binding:saved.binding,stage:saved.stage,
        jobIntent:saved.job_intent,provider:saved.model.provider,model:saved.model.name,policySourceSession:saved.policy_source_session,
        read:saved.read,action:saved.action,pendingReadRevision:"Another current owner requested a separate Read inspection."});
      await writeBoundaryAuthoringResumeState(root,next,{expectedRevisionDigest:saved.revision_digest});competingSaved=next;
    }
  };
  const read=async()=>{
    if(stage==="initial")return answers.shift();
    questionReads++;const saved=await readResume(),handoff=saved.owner_handoffs?.at(-1);
    sourceId=saved.policy_source_session;
    expect(handoff,transcript).toMatchObject({consumer:"policy_clarification",state:"waiting",question});
    expect(handoff.context_digest).toMatch(/^sha256:[a-f0-9]{64}$/);expect(handoff.scope_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(saved.generation_recovery?.operations.some((op:any)=>["unknown","partial","received","in_flight"].includes(op.state))).toBe(false);
    questionSnapshots.push({stage,requests,questionNarrations,handoff:structuredClone(handoff),resume_revision:saved.revision_digest});
    if(expectedWaiting)expect(handoff).toEqual(expectedWaiting);else expectedWaiting=structuredClone(handoff);
    if(!baseline)baseline={authority:(await listActionRuleAuthorityDrafts(root))[0],read:(await loadBoundaryReviewContext(root)).bundle.candidate_digest,
      activeRead:await fs.readFile(path.join(root,".synapsor/exploration-boundary.active.json")).catch(()=>undefined),
      sources:await loadPolicySources(root,sourceId!)};
    expect(baseline.authority).toBeDefined();expect(saved.reviewed_version_fields).toHaveLength(1);expect(baseline.sources.operator_messages).not.toContain(answer);
    if(stage==="restart") {expect(requests).toBe(resumeRequests);expect(questionNarrations).toBe(resumeNarrations);}
    if(["source_drift","schema_drift","role_drift","competing_resume"].includes(control))await inject();
    if(control==="pause_restart" && stage==="question" || control==="explicit_review")return undefined;
    return answer;
  };
  const write=(text:string)=>{transcript+=text;};
  const io:any={write,writeChunk:write,columns:()=>110,isTerminal:()=>false,setStatus:()=>{},clearStatus:()=>{},close:()=>{},
    onInterrupt:()=>()=>{},review:async(title:string,content:string[])=>write(`\n${title}\n${content.join("\n")}\n`),read,readConversation:read,
    choose:async(choice:any)=>{
      const values=choice.options.map((entry:any)=>entry.value);let selected:string|undefined;
      if(choice.title==="START BOUNDARY DRAFTING")selected=stage==="initial" ? "model" : stage==="explicit_review" ? "review_rules" : "resume";
      else if(choice.title==="CLIENT FOR THIS JOB")selected="later";
      else if(choice.title==="SEND ATTACHED RULES") {expect(choice.initialValue).toBe("cancel");selected="send";}
      else if(choice.title==="USE THE SAVED ATTACHMENT")selected="continue";
      else if(choice.message==="Use this complete intended Action inventory?") {expect(choice.initialValue).toBe("no");selected="yes";}
      else if(choice.message==="REVIEW CHANGED-RECORD PROTECTION") {expect(choice.initialValue).toBe("pending");expect(transcript).toContain("studio.parcels.version");selected="confirm";}
      else if(choice.title==="REVIEW DECLARED TEXT INPUT BOUNDS")selected="none";
      else if(choice.message==="Save this exact attributed input-policy interpretation?") {expect(choice.initialValue).toBe("no");selected="yes";}
      else if(choice.message==="Run a new bounded model review?") {expect(choice.initialValue).toBe("no");selected="yes";}
      else if(choice.title==="CLIENT INTEGRATION RESPONSIBILITIES") {expect(choice.initialValue).toBe("back");selected="assign";}
      else if(choice.title==="FINISH ATTACHED RULES REVIEW") {
        selected=stage==="question" && !clarifyChosen ? "clarify" : "pause";if(selected==="clarify")clarifyChosen=true;
      } else if(choice.title==="SETUP NEEDS ATTENTION" || values.includes("pause") && !values.includes("yes"))selected="pause";
      else if(values.includes("yes") && /Send this Boundary-authoring conversation|Allow the assistant to send|reviewed structural context|Allow the assistant to read|Allow the reviewed change requests/.test(choice.message)) {expect(choice.initialValue).toBe("no");selected="yes";}
      else if(values.includes("activate"))selected=values.includes("finish") ? "finish" : values.includes("back") ? "back" : undefined;
      menus.push({stage,...choice,values,selected});if(!selected || !values.includes(selected))return undefined;return selected;
    }};
  const requestJson=async(request:any)=>{
    if(++requests>60)fail("Finite local ordinary response bound exceeded.");
    const body=request.body,text=strings(body).join("\n"),names=(body.tools??[]).map((tool:any)=>tool.name??tool.function?.name);
    responses.push({stage,names,bytes:Buffer.byteLength(JSON.stringify(body)),request:requests});
    let name:string|undefined,args:any,narration:string|undefined;
    if(names.includes("runner__plan_boundary_job")) {expect(stage).toBe("initial");name="runner__plan_boundary_job";
      args={status:"planned",read_mode:"reuse",action_mode:"create",action_strategy:"rule_derived",action_intent:intent,summary:"Prepare the requested one-Action disabled proposal."};
    } else if(names.includes("runner__submit_read_workloads")) {name="runner__submit_read_workloads";
      args={allowed:[{id:"parcel_labels_units",description:"Read parcel labels and units.",plan:{kind:"rows",resource:"studio.parcels",select:["label","units"]}}],forbidden:[],
        operator_meanings:[{resource:"studio.parcels",operator_quote:"studio.parcels is the parcel register"},{resource:"studio.parcels",field:"label",operator_quote:"studio.parcels.label is the public parcel name"},{resource:"studio.parcels",field:"units",operator_quote:"studio.parcels.units is the unit count"}]};
    } else if(names.includes("runner__submit_action_rule_draft")) {
      expect(stage).toBe("initial");const draft=ownedProgramDraft(1),{schema_version:_version,verification,effect,approval,...rule}=draft;
      const phases:Array<[string,any]>=[["runner__review_version_field",{resource:"studio.parcels",field:"version"}],
        ["runner__submit_verification_boundary_draft",{status:"draft",...verification,changed_fields:[]}],
        ["runner__submit_effect_envelope_draft",{status:"draft",...effect,changed_fields:[]}],
        ["runner__submit_action_rule_draft",{status:"draft",...rule,changed_fields:[]}],
        ["runner__submit_approval_policy_draft",{status:"draft",...approval,changed_fields:[]}],["runner__validate_action_draft",{}]];
      if(actionPhase<phases.length)[name,args]=phases[actionPhase++]!;else narration="The structurally compiled proposal remains disabled and its Source interpretation is still incomplete.";
    } else if(names.includes("runner__review_policy_coverage")) {
      name="runner__review_policy_coverage";const draft=jsonLine(text,"Current draft (JSON pointer root): "),references=jsonLine(text,"Exact coverage references (select, do not invent paths): ");
      const messages=jsonLine(text,"Indexed operator messages for supporting clarifications or explicit overrides (not source text or model narration): ")??[];
      expect(draft.actions).toHaveLength(1);expect(draft.actions[0].outcome).toBe("studio.pack_parcel_1");
      const evidence=draft.runner_evidence.actions["studio.pack_parcel_1"];
      expect(evidence.scoped_bindings.parcel.fields.available).toMatchObject({model_visible:false,actual_values_returned:false,private_action_verification:true,model_analysis:[]});
      expect(evidence.effect.source_counter_maintenance).not.toBeNull();
      const accepted=messages.find((entry:any)=>entry.message===answer);
      const decided=stage==="initial" || !!accepted;
      if(accepted) {const saved=await readResume(),sources=await loadPolicySources(root,sourceId!);
        expect(saved.owner_handoffs.at(-1)).toMatchObject({consumer:"policy_clarification",state:"answered",question,answer});
        expect(sources.operator_messages!.filter(message=>message===answer)).toHaveLength(1);
      }
      const passages=[{start:1,end:1,disposition:"background",interpretation:"Owned parcel proposal heading.",draft_paths:[]},
        {start:2,end:2,disposition:decided ? "implemented" : "needs_decision",responsibility:decided ? "runner" : "operator",issue_kind:decided ? "coverage_link" : "business_choice",
          interpretation:accepted ? "The exact current owner clarification supports the existing availability condition." : decided ? "The unambiguous original Source clause is represented by the actual availability condition." : "The owner has not yet confirmed availability eligibility; this interpretation remains incomplete.",
          draft_paths:["/actions/0/require"],...(accepted ? {operator_message_id:accepted.operator_message_id} : !decided ? {next_step:"Ask whether the parcel action requires availability."} : {})},
        {start:3,end:3,disposition:"implemented",responsibility:"runner",interpretation:"The exact reviewed Read returns labels and units.",draft_paths:["/read"]},
        {start:4,end:4,disposition:"implemented",responsibility:"runner",interpretation:"The proposal preserves bounded units, effect and human review.",draft_paths:["/actions/0/inputs","/actions/0/effect","/actions/0/approval"]},
        {start:5,end:5,disposition:"implemented",responsibility:"operator",interpretation:"The ordinary exact owner counter commitment is recorded, without independently attesting live enforcement.",draft_paths:["/runner_evidence/actions/studio.pack_parcel_1/effect/source_counter_maintenance"]},
        {start:6,end:6,disposition:"implemented",responsibility:"runner",interpretation:"Availability stays private in the actual prepared Read/Action evidence.",draft_paths:["/runner_evidence/actions/studio.pack_parcel_1/scoped_bindings/parcel/fields/available"],field_checks:[{resource:"studio.parcels",field:"available",expectation:"private"}]}];
      for(const passage of passages)for(const pointer of passage.draft_paths)expect(references).toContain(pointer);
      args={passages};reports.push({stage,draft_digest:canonicalJsonDigest(draft),accepted:!!accepted,messages,passages});
    } else if(!names.length) {
      if(text.includes("Help the operator clarify the disputed interpretation in this saved job.")
        || text.includes("Ask only these unresolved business choices together, with their purpose and suggested answers; do not repeat the saved action summary.")) {
        questionNarrations++;stage="question";clarifyChosen=true;narration=question;
      }
      else narration=jsonLine(text,"Exact next question: ")??"The actual disabled record and unfinished interpretation remain available for review.";
    } else fail(`Unexpected actual emitted tool surface: ${names.join(", ")}`);
    if(name)expect(names).toContain(name);
    return {status:200,body:{output:name ? [{type:"function_call",call_id:`owned-policy-wait-${requests}`,name,arguments:JSON.stringify(args)}]
      : [{type:"message",content:[{type:"output_text",text:narration}]}]}};
  };
  const outer:any={chooseResource:async()=>fail("No manual resource bypass"),editFieldTiers:async()=>fail("No manual field bypass"),
    chooseOption:async(title:string,choices:any[],options:any)=>{expect(title).toBe("SETUP NEEDS ATTENTION");expect(choices.some(entry=>entry.value==="pause")).toBe(true);
      failures.push({title,context:options?.context,choices});return "pause";},
    rememberDetails:(title:string,details:string[])=>{failures.push({title,details});},promptText:async()=>undefined,confirm:async()=>fail("No outer confirmation bypass")};
  const options:any={startWithAgentJob:true,exitAfterAgentJob:true,
    modelAuthoringSession:{provider:"openai",model:"owned-policy-wait-offline",apiKey:"owned-offline-fixture",dependencies:{requestJson}},
    actionProjectInspector:inspect,boundaryAuthoringChatFactory:(selection:any)=>createBoundaryAuthoringChat({...selection,io,color:false,streamLineDelayMs:0})};
  let resumeRequests=0,resumeNarrations=0;
  vi.stubEnv("OWNED_POLICY_WAIT_READ_URL","postgresql://fixture.invalid/never-opened");
  const stdout=vi.spyOn(process.stdout,"write").mockReturnValue(true);
  vi.spyOn(globalThis,"fetch").mockImplementation(async()=>fail("External network forbidden"));
  try {
    await onboard(["db","--project-root",root,"--from-env","OWNED_POLICY_WAIT_READ_URL","--schema","studio","--json"],{interactive:false,schemaInspector:inspect});
    const workload=path.join(root,"derived-private-read.json");await fs.writeFile(workload,JSON.stringify({schema_version:READ_WORKLOAD_SET_VERSION,name:"owned_private_availability",
      allowed:[{id:"parcel_labels_units",description:"Read parcel labels and units.",plan:{kind:"rows",resource:"studio.parcels",select:["label","units"]}}],
      forbidden:[{id:"private_available",description:"Never return availability to the assistant.",plan:{kind:"rows",resource:"studio.parcels",select:["available"]}}],source:{kind:"operator_exact_plan"}}));
    stdout.mockClear();await expect(boundaryAssistCommand(["--project-root",root,"--workload",workload,"--actor","owned-local-operator","--reason","Keep availability private while reading labels and units.","--json"],inspect)).resolves.toBe(0);
    const preview=JSON.parse(stdout.mock.calls.map(([chunk])=>String(chunk)).join(""));expect(preview.preview.authority_activated).toBe(false);
    await expect(boundaryAssistCommand(["--project-root",root,"--analysis",preview.workload.analysis_id,"--actor","owned-local-operator","--reason","Keep availability private while reading labels and units.","--apply","--confirm",`APPLY WORKLOAD ${preview.preview.decision_digest}`,"--json"],inspect)).resolves.toBe(0);
    const reviewed=await loadBoundaryReviewContext(root);await saveInstantBoundaryReviewBaseline({projectRoot:root,draft:reviewed.draft,candidate:reviewed.candidate,actor:"owned-local-operator",expectedAuthoring:reviewed.bundle.mutation_bindings.authoring});
    await start(["--project-root",root,"--from-env","OWNED_POLICY_WAIT_READ_URL","--schema","studio","--cli"],{interactive:true,schemaInspector:inspect,
      runBoundaryReview:(args,inspector)=>boundaryReviewCommand(args,inspector,outer,undefined,options)});
    const initiallySaved=await readResume();sourceId=initiallySaved.policy_source_session;
    expect((await listActionRuleAuthorityDrafts(root))[0],transcript).toBeDefined();
    const originalSource=await loadPolicySources(root,sourceId!),changedSource=structuredClone(originalSource);
    const changedSnapshot=policyTextSnapshot(Buffer.from(lines.join("\n")),path.basename(sourceFile),activePolicySource(originalSource)!.version+1);
    changedSource.snapshots.push(changedSnapshot);changedSource.active=changedSnapshot.version;
    await savePolicySources(root,changedSource,{expectedDigest:canonicalJsonDigest(originalSource)});
    stage="question";
    await boundaryReviewCommand(["--project-root",root,"--access","--job-first"],inspect,outer,undefined,options);
    const before=await readResume();sourceId=before.policy_source_session;const authorityBefore=baseline?.authority;
    expect(authorityBefore,transcript).toBeDefined();expect(authorityBefore!.authority.rules.map((rule:any)=>rule.rule.outcome)).toEqual(["studio.pack_parcel_1"]);
    expect(before.reviewed_version_fields,transcript).toHaveLength(1);
    const readBefore=baseline.read,activeBefore=baseline.activeRead;
    expect(questionReads,transcript).toBe(1);expect(questionNarrations,transcript).toBe(1);expect(expectedWaiting).toBeDefined();
    if(control==="pause_restart") {
      const paused=await readResume();expect(paused.owner_handoffs.at(-1)).toEqual(expectedWaiting);expect((await loadPolicySources(root,sourceId!)).operator_messages).not.toContain(answer);
      resumeRequests=requests;resumeNarrations=questionNarrations;stage="restart";
      await boundaryReviewCommand(["--project-root",root,"--access","--job-first"],inspect,outer,undefined,options);
      expect(questionReads,transcript).toBe(2);
    } else if(control==="explicit_review") {
      const paused=await readResume();resumeRequests=requests;resumeNarrations=questionNarrations;stage="explicit_review";
      await boundaryReviewCommand(["--project-root",root,"--access","--job-first","--review-rules"],inspect,outer,undefined,options);
      expect((await readResume()).owner_handoffs.at(-1)).toEqual(paused.owner_handoffs.at(-1));expect(requests).toBe(resumeRequests);expect(questionNarrations).toBe(resumeNarrations);expect(questionReads).toBe(1);
    }
    const after=await readResume(),sources=await loadPolicySources(root,sourceId!);
    if(control==="healthy" || control==="pause_restart") {
      expect(after.owner_handoffs.at(-1)).toMatchObject({consumer:"policy_clarification",state:"answered",question,answer});
      expect(sources.operator_messages!.filter(message=>message===answer)).toHaveLength(1);expect(reports.some(report=>report.accepted)).toBe(true);
      expect(sources.coverage!.passages.find(passage=>passage.start===2)!.disposition).toBe("implemented");
    } else {
      expect(after.owner_handoffs.at(-1)).toEqual(expectedWaiting);expect(sources.operator_messages).not.toContain(answer);expect(reports.some(report=>report.accepted)).toBe(false);
      if(control==="source_drift")expect(sources).toEqual(competingSaved);if(control==="competing_resume")expect(after).toEqual(competingSaved);
      if(control!=="explicit_review") {
        expect(injected).toBe(true);expect(requests).toBe(questionSnapshots[0].requests);
        const refusal=control==="source_drift" ? "POLICY_SOURCE_CHANGED" : control==="competing_resume"
          ? "BOUNDARY_AUTHORING_RESUME_CHANGED" : "AUTHORING_OWNER_QUESTION_CONTEXT_CHANGED";
        expect(JSON.stringify(failures)).toContain(refusal);
      }
    }
    expect((await listActionRuleAuthorityDrafts(root))[0]).toEqual(authorityBefore);expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(readBefore);
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();expect(await fs.readFile(path.join(root,".synapsor/exploration-boundary.active.json")).catch(()=>undefined)).toEqual(activeBefore);
    return {origin:"IMPLEMENTER_DERIVED_PUBLIC_POLICY_WAIT",control,requests,questionNarrations,questionReads,activation:false,provider_calls:0};
  } finally {
    const evidenceRoot=process.env.OWNED_PUBLIC_POLICY_WAIT_EVIDENCE;
    if(evidenceRoot) {const persisted=await Promise.allSettled([readResume(),listActionRuleAuthorityDrafts(root),sourceId ? loadPolicySources(root,sourceId) : Promise.resolve(undefined)]);
      await fs.mkdir(evidenceRoot,{recursive:true});await fs.writeFile(path.join(evidenceRoot,`${control}-${randomUUID()}.json`),JSON.stringify({origin:"IMPLEMENTER_DERIVED_PUBLIC_POLICY_WAIT",control,transcript,publicOutput:stdout.mock.calls.map(([chunk])=>String(chunk)).join(""),menus,failures,responses,reports,questionSnapshots,injected,
        persisted:persisted.map((result,index)=>({kind:["resume","disabled_actions","sources"][index],...(result.status==="fulfilled" ? {value:result.value} : {error:String(result.reason)} )}))},null,2));}
    await fs.rm(root,{recursive:true,force:true});
  }
}

it.each(["healthy","pause_restart","source_drift","schema_drift","role_drift","competing_resume","explicit_review"] as const)(
  "public Source owner wait persists the actual business question and protects its current answer: %s",async control=>{
    const result=await publicPolicyWait(control);expect(result.provider_calls).toBe(0);
  },30_000);

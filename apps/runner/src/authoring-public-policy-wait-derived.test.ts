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
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation } from "./action-rule-authority.js";
import { readSemanticSupervisedExecutionState } from "./semantic-action-deployment.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { activePolicySource, loadPolicySources, policyTextSnapshot, savePolicySources } from "./authoring-policy-source.js";
import { ownedProgramDraft, ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";
import { modelVisibleUserText } from "./test-fixtures/model-visible-frame.js";
import { PUBLIC_INPUT_FACTS } from "./test-fixtures/public-input-onboarding-facts.js";

/** Owned synthetic public regression. Only IO, inspection and local ordinary
 * provider responses are supplied. The actual planner/compiler/Source parser,
 * generation recovery, owner handoff, chat recorder, writer permit and CAS run.
 * No readiness/assessment callback or accepted-owner record is fabricated. */
type Control = "healthy" | "pause_restart" | "source_drift" | "schema_drift" | "role_drift" | "competing_resume" | "explicit_review" | "client_keep" | "client_cancel" | "nested_source_review" | "nested_competing_resume" | "nested_competing_source" | "nested_transfer_cancel" | "nested_cached_activate" | "nested_review_role_drift" | "nested_review_schema_drift" | "nested_review_role_after_response" | "nested_review_role_client_back";
const question="Should this parcel action be permitted only when the parcel is available?";
const answer="Yes. Require available=true; refuse unavailable parcels.";
const strings=(value:any):string[]=>typeof value==="string" ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value==="object" ? Object.values(value).flatMap(strings) : [];
const jsonLine=(text:string,prefix:string):any=>{
  const line=text.split("\n").find(line=>line.startsWith(prefix));return line ? JSON.parse(line.slice(prefix.length)) : undefined;
};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

async function publicPolicyWait(control:Control, requireSavedCoverageCheckpoint=false, positiveInput=false, editInputBaseline=false, activationPresentation=false, receiptEntry?: "setup" | "edit") {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),`owned-public-policy-wait-${control}-`));
  const resumeFile=path.join(root,".synapsor/boundary-authoring/resume.json");
  const inspection=ownedProgramInspection();
  const inspect=async()=>structuredClone(inspection);
  const intent=("studio.pack_parcel_1 records caller-supplied units from 1 to 10 for an available parcel; refuse unavailable parcels. Propose only; one human parcel_reviewer decides." +
    (positiveInput ? " Require a caller-supplied operator_note with the exact bounds confirmed by the current owner; never trim or store it as a Source effect." : ""))
    .replace("Propose only;", receiptEntry ? "Use separately approved supervised execution;" : "Propose only;");
  const inputIntents=PUBLIC_INPUT_FACTS.outcomes.map(outcome=>intent.replace("studio.pack_parcel_1",outcome));
  const job=`Prepare ${positiveInput ? "both independent studio.pack_parcel_1 and studio.pack_parcel_2 Actions" : "studio.pack_parcel_1"} in the attached rules. Read parcel labels and units. studio.parcels is the parcel register; studio.parcels.label is the public parcel name; studio.parcels.units is the unit count.`;
  const lines=["Derived parcel proposal program.",
    "Whether availability must be true for this parcel action is undecided; obtain the current owner's confirmation before treating the interpretation as complete.",
    "The assistant may read parcel labels and units. studio.parcels is the parcel register; studio.parcels.label is the public parcel name; studio.parcels.units is the unit count.",
    "The Action accepts units from 1 to 10, changes only units and Runner's maintained counter, proposes only, and requires one human parcel_reviewer.",
    "Synthetic source-owner operating fact: every studio.parcels writer increments integer version on each update. This is an operator assertion, not observed enforcement.",
    "The available eligibility fact stays private to Runner verification; it is not returned to the assistant."];
  const initialLines=[...lines];initialLines[1]="The parcel action requires available=true; refuse unavailable parcels.";
  if(positiveInput) {
    initialLines[0]="Derived two-Action parcel proposal program: studio.pack_parcel_1 and studio.pack_parcel_2 are independently requested outcomes.";
    initialLines[1]="Every retained parcel action requires available=true; refuse unavailable parcels.";
    initialLines[3]="Every retained Action accepts units from 1 to 10, changes only units and Runner's maintained counter, proposes only, and requires one human parcel_reviewer. Each Action has its own independent reviewer requirement: " +
      PUBLIC_INPUT_FACTS.outcomes.map((outcome,index)=>`${outcome} uses ${PUBLIC_INPUT_FACTS.reviewClasses[index]}`).join("; ") + "; both initially require one parcel_reviewer.";
    initialLines.push(PUBLIC_INPUT_FACTS.sourceClause);
  }
  const receiptClause="Require evidence that a requested change has completed; distinguish a request that has not been applied.";
  const receiptAnswer="A change is complete only with an applied-change completion receipt. An unapplied request remains pending or approved.";
  if (receiptEntry) {
    initialLines[0]+=" Supplemental supervised receipt case; the original proposal-only studio fixture is unchanged.";
    initialLines[3]=initialLines[3]!.replace("proposes only", "uses separately approved supervised execution");
    if (receiptEntry === "setup") initialLines.push(receiptClause);
  }
  const sourceFile=path.join(root,"derived-policy-wait-rules.txt");await fs.writeFile(sourceFile,initialLines.join("\n"));
  let stage:"initial"|"question"|"restart"|"explicit_review"|"edit"="initial",transcript="",requests=0,actionPhase=0,questionNarrations=0;
  let sourceId:string|undefined,questionReads=0,clarifyChosen=false,injected=false,expectedWaiting:any,competingSaved:any,baseline:any;
  let clientDutyPrompts=0,versionAnswerPending=false,liveCoverageBefore:any;
  let inputAnswerPending=false,inputPrompts=0,inputConfirmations=0,inputBeforeConfirmation:any;
  const inputActionPhases=new Map<number,number>();
  const inputSnapshots:any[]=[];
  let editPhase=0,editSaveConfirmations=0;
  let receiptReads=0,receiptMappings=0,receiptConfirmations=0,receiptResolves=0;
  const receiptSnapshots:any[]=[];
  const editSnapshots:any[]=[];
  const activationSnapshots:any[]=[];
  let nestedEntered=false,nestedReads=0,nestedDeclines=0,nestedStartRequests=0,nestedAuthorityBefore:any,cachedActivationAttempts=0;
  const nestedControl=control.startsWith("nested_");
  const reviewWaitControl=control.startsWith("nested_review_");
  let reviewWaitSnapshot:any;
  const changeReaderRole=()=>{
    inspection.role_posture!.read_only=false;
    inspection.role_posture!.writable_relations=["studio.parcels"];
    inspection.tables[0]!.role_posture!.privileges.update=true;
  };
  const replacementFile=path.join(root,"replacement-policy-review.txt");
  await fs.writeFile(replacementFile,["Updated heading for the same parcel proposal program.",...initialLines.slice(1)].join("\n"));
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
    if (receiptEntry) {
      const saved=await readResume().catch(()=>undefined);
      const q=saved?.operator_questions?.filter((q:any)=>q.kind==="receipt_requirement").at(-1);
      if (q && !q.raw_answer && saved.owner_handoffs?.at(-1)?.state==="waiting") {
        receiptReads++;receiptSnapshots.push({stage:"question",entry:stage,question:q});return receiptAnswer;
      }
    }
    if(versionAnswerPending) {versionAnswerPending=false;return lines[4];}
    if(inputAnswerPending) {
      inputAnswerPending=false;inputPrompts++;
      const saved=await readResume();
      expect(saved.owner_handoffs.at(-1)).toMatchObject({consumer:"input_policy",state:"waiting",question:PUBLIC_INPUT_FACTS.question});
      expect(saved.operator_questions.filter((q:any)=>q.kind==="input_bounds").at(-1)).not.toHaveProperty("raw_answer");
      inputSnapshots.push({stage:"question-before-raw",resume:saved});
      return PUBLIC_INPUT_FACTS.rawAnswer;
    }
    if(stage==="edit")return answers.shift();
    if(stage==="initial") {
      if(nestedControl && nestedEntered && nestedReads++===0)return `/attach ${replacementFile}`;
      return answers.shift();
    }
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
      if(choice.title==="START BOUNDARY DRAFTING")selected=stage==="initial" ? positiveInput ? "program" : "model" : stage==="edit" ? "model" : stage==="explicit_review" ? "review_rules" : "resume";
      else if(choice.title==="CLIENT FOR THIS JOB")selected="later";
      else if(choice.title==="SEND ATTACHED RULES") {expect(choice.initialValue).toBe("cancel");selected=control==="nested_transfer_cancel" && nestedEntered ? "cancel" : "send";}
      else if(choice.title==="USE THE SAVED ATTACHMENT") {
        if(nestedEntered)nestedAuthorityBefore=(await listActionRuleAuthorityDrafts(root))[0];
        if(nestedEntered && !injected && ["nested_competing_resume","nested_competing_source","nested_cached_activate"].includes(control)) {
          injected=true;
          const saved=await readResume();sourceId=saved.policy_source_session;
          if(control==="nested_competing_resume") {
            const next=buildBoundaryAuthoringResumeState({previous:saved,binding:saved.binding,stage:saved.stage,
              jobIntent:saved.job_intent,provider:saved.model.provider,model:saved.model.name,policySourceSession:saved.policy_source_session,
              read:saved.read,action:saved.action,pendingReadRevision:"A separate current operator requested a new Read inspection."});
            await writeBoundaryAuthoringResumeState(root,next,{expectedRevisionDigest:saved.revision_digest});competingSaved=next;
          } else {
            const sources=await loadPolicySources(root,sourceId!),next=structuredClone(sources),prior=activePolicySource(sources)!;
            const snapshot=policyTextSnapshot(Buffer.from("Competing heading for the same parcel proposal program.\n"+prior.text.split("\n").slice(1).join("\n")),prior.name,prior.version+1);
            next.snapshots.push(snapshot);next.active=snapshot.version;
            await savePolicySources(root,next,{expectedDigest:canonicalJsonDigest(sources)});competingSaved=next;
          }
        }
        selected=nestedControl && nestedEntered ? "review" : "continue";
      }
      else if(choice.message==="Use this complete intended Action inventory?") {expect(choice.initialValue).toBe("no");selected="yes";}
      else if(choice.message==="REVIEW CHANGED-RECORD PROTECTION") {expect(choice.initialValue).toBe("pending");expect(transcript).toContain("studio.parcels.version");selected="confirm";}
      else if(choice.message==="Record this planned counter maintenance for the current setup?") {expect(choice.initialValue).toBe("no");expect(transcript.replace(/\s+/gu," ")).toContain(lines[4]);selected="yes";}
      else if(choice.title==="REVIEW DECLARED TEXT INPUT BOUNDS")selected="none";
      else if(receiptEntry && choice.message==="Record this exact statement for the current question?") {
        expect(choice.initialValue).toBe("no");receiptConfirmations++;
        receiptSnapshots.push({stage:"readback",entry:stage,resume:await readResume()});selected="yes";
      }
      else if(choice.message==="Save this exact disabled Action edit?" && stage==="edit") {
        expect(choice.initialValue).toBe("no");expect(transcript.replace(/\s+/gu," ")).toContain(PUBLIC_INPUT_FACTS.editRequest);
        expect(transcript).toContain("/approval/required_approvals: 1 -> 2");
        editSaveConfirmations++;
        editSnapshots.push({stage:"exact-edit-before-save",resume:await readResume(),authority:(await listActionRuleAuthorityDrafts(root))[0]});
        selected="yes";
      }
      else if(choice.message==="Save this exact attributed input-policy interpretation?") {
        expect(choice.initialValue).toBe("no");
        if(positiveInput) {
          inputConfirmations++;const saved=await readResume();inputBeforeConfirmation=saved.operator_questions.filter((q:any)=>q.kind==="input_bounds").at(-1);
          inputSnapshots.push({stage:"readback-before-confirmation",resume:saved});
          expect(inputBeforeConfirmation.raw_answer.text).toBe(PUBLIC_INPUT_FACTS.rawAnswer);
          expect(inputBeforeConfirmation.proposal).toMatchObject({disposition:"proposed",value:{kind:"input_bounds",requirements:[{
            outcomes:[...PUBLIC_INPUT_FACTS.outcomes],input:PUBLIC_INPUT_FACTS.input,
            min_length:PUBLIC_INPUT_FACTS.minimum,max_length:PUBLIC_INPUT_FACTS.maximum}]}});
          expect(inputBeforeConfirmation.confirmation).toBeUndefined();
          expect(transcript.replace(/\s+/gu," ")).toContain("The operator_note is 1 through 64 UTF-16 units; spaces count, including café 😀.");
        }
        selected="yes";
      }
      else if(choice.message==="Run a new bounded model review?") {
        expect(choice.initialValue).toBe("no");
        if(reviewWaitControl && nestedEntered) {
          expect(injected).toBe(false);injected=true;
          const saved=await readResume();sourceId=saved.policy_source_session;
          reviewWaitSnapshot={requests,sources:await loadPolicySources(root,sourceId!),
            authority:(await listActionRuleAuthorityDrafts(root))[0],
            read:(await loadBoundaryReviewContext(root)).bundle.candidate_digest};
          if(control==="nested_review_role_drift") {
            // Same principal and schema; only its native UPDATE posture changes
            // while the operator is deciding whether to submit this review.
            changeReaderRole();
          } else if(control==="nested_review_schema_drift") inspection.tables[0]!.columns.find(column=>column.name==="units")!.data_type="bigint";
          else injected=false;
          selected="yes";
        } else if(nestedControl && nestedEntered) {nestedDeclines++;selected="no";} else selected="yes";
      }
      else if(choice.title==="CLIENT INTEGRATION RESPONSIBILITIES") {
        expect(choice.initialValue).toBe("back");clientDutyPrompts++;
        if(requireSavedCoverageCheckpoint)liveCoverageBefore=structuredClone((await readResume()).generation_recovery);
        if(control==="nested_review_role_client_back" && reviewWaitSnapshot) {
          expect(injected).toBe(false);injected=true;changeReaderRole();selected="back";
        } else if(control==="client_keep" || control==="client_cancel") {
          if(clientDutyPrompts>1)fail("The same client-duty prompt repeated after the operator's pending/cancel choice.");
          selected=control==="client_keep" ? "back" : undefined;
        } else selected="assign";
      }
      else if(receiptEntry && choice.title==="FINISH BOUNDARY REVIEW" && values.includes("resolve") && receiptResolves===0) {
        receiptResolves++;selected="resolve";
      }
      else if(choice.title==="FINISH ATTACHED RULES REVIEW") {
        selected=receiptEntry && receiptResolves++ === 0 ? "resolve" : stage==="question" && !clarifyChosen ? "clarify" : "pause";if(selected==="clarify")clarifyChosen=true;
      } else if(choice.title==="SETUP NEEDS ATTENTION" || values.includes("pause") && !values.includes("yes"))selected="pause";
      else if(activationPresentation && choice.title==="REVIEW CHANGE REQUESTS") {
        expect(choice.message).toBe("Allow the reviewed change requests and approval rules? Database execution has a separate review.");
        expect(choice.initialValue).toBe("no");
        expect(choice.options.find((entry:any)=>entry.value==="yes")!.label).toBe("Enable the reviewed change requests");
        expect(choice.options.find((entry:any)=>entry.value==="no")!.label).toBe("Not now; keep authority unchanged");
        const authority=(await listActionRuleAuthorityDrafts(root))[0]!;
        expect(authority.authority.rules.map(entry=>entry.rule.outcome)).toEqual(PUBLIC_INPUT_FACTS.outcomes);
        expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
        activationSnapshots.push({stage:"authored-action-before-default-no",resume:await readResume(),authority,
          activeRead:await loadActivatedExplorationBoundaries(root),execution:await readSemanticSupervisedExecutionState({projectRoot:root})});
        selected="no";
      }
      else if(values.includes("yes") && /Send this Boundary-authoring conversation|Allow the assistant to send|reviewed structural context|Allow the assistant to read|Allow the reviewed change requests/.test(choice.message)) {expect(choice.initialValue).toBe("no");selected="yes";}
      else if(values.includes("activate")) {
        if(activationPresentation && choice.title==="REVIEW ACCESS") {
          expect(choice.message).toBe("Allow the assistant to read the information shown above? This does not enable changes to the database.");
          expect(choice.initialValue).toBe("finish");
          expect(choice.options.find((entry:any)=>entry.value==="activate")!.label).toBe("Enable the reviewed reading access");
          activationSnapshots.push({stage:"read-before-explicit-activate",resume:await readResume(),authority:(await listActionRuleAuthorityDrafts(root))[0],
            read:await loadBoundaryReviewContext(root)});
          selected="activate";
        } else if(nestedControl && !nestedEntered) {
          expect(values).toContain("__ask_boundary_model__");nestedEntered=true;nestedStartRequests=requests;selected="__ask_boundary_model__";
        } else if(control==="nested_cached_activate" && injected) {cachedActivationAttempts++;selected="activate";}
        else selected=values.includes("finish") ? "finish" : values.includes("back") ? "back" : undefined;
      }
      menus.push({stage,...choice,values,selected});if(!selected || !values.includes(selected))return undefined;return selected;
    }};
  const requestJson=async(request:any)=>{
    if(++requests>60)fail("Finite local ordinary response bound exceeded.");
    const body=request.body,text=positiveInput ? modelVisibleUserText(body) : strings(body).join("\n"),names=(body.tools??[]).map((tool:any)=>tool.name??tool.function?.name);
    responses.push({stage,names,bytes:Buffer.byteLength(JSON.stringify(body)),request:requests,...(positiveInput ? {body} : {}),...(names.includes("runner__propose_operator_decision") ? {current_operator_question:jsonLine(text,"Current question: "),decision_tool:body.tools[0]} : {})});
    try {
    let name:string|undefined,args:any,narration:string|undefined;
    if(names.includes("runner__plan_boundary_job")) {
      expect(["initial","edit"]).toContain(stage);name="runner__plan_boundary_job";
      if(stage==="edit") {
        const current=jsonLine(text,"Current reviewed state: ");
        expect(current.read.exact_reusable_revision_count).toBeGreaterThan(0);
        const selected=current.actions.find((action:any)=>action.outcome===PUBLIC_INPUT_FACTS.outcomes[0]);
        expect(selected).toMatchObject({kind:"rule_derived",authority:"disabled"});
        expect(current.read.resource_ids).toContain(selected.resource);
        expect(current.actions.some((action:any)=>action.outcome===PUBLIC_INPUT_FACTS.outcomes[1])).toBe(true);
        expect(text).toContain(PUBLIC_INPUT_FACTS.editRequest);
        args={status:"planned",read_mode:"reuse",action_mode:"revise",action_strategy:"rule_derived",action_outcome:selected.outcome,
          action_intent:PUBLIC_INPUT_FACTS.editRequest,summary:"Change only the first packing Action to two reviewers; retain the complete disabled program."};
      } else {
      args={status:"planned",read_mode:"reuse",action_mode:"create",action_strategy:"rule_derived",action_intent:intent,summary:"Prepare the requested one-Action disabled proposal."};
      if(positiveInput) {args.action_intents=inputIntents;args.action_outcomes=[...PUBLIC_INPUT_FACTS.outcomes];}
      }
    } else if(names.includes("runner__propose_operator_decision")) {
      // Fixture delivery for the actual connected Version conversation. The
      // existing Source-owner operating fact remains unverified and is given
      // only at the real raw-answer prompt, followed by explicit confirmation.
      const current=jsonLine(text,"Current question: ");
      if(receiptEntry && current.kind==="receipt_requirement") {
        expect(current.raw_answer).toBe(receiptAnswer);expect(current.answer_id).toEqual(expect.any(String));
        receiptMappings++;name="runner__propose_operator_decision";
        args={question_id:current.question_id,revision:current.revision,answer_id:current.answer_id,status:"proposal",disposition:"proposed",
          value:{kind:"receipt_requirement",completion_basis:"applied_change_receipt",unapplied_status:"pending_or_approved"}};
      } else if(positiveInput && current.kind==="input_bounds") {
        expect(current.target.outcomes).toEqual(PUBLIC_INPUT_FACTS.outcomes);
        name="runner__propose_operator_decision";
        if(current.source_binding) {
          expect(current.source_reference).toBe(canonicalJsonDigest(current.source_binding));
          expect(text).toContain(PUBLIC_INPUT_FACTS.sourceClause);inputAnswerPending=true;
          args={question_id:current.question_id,revision:current.revision,source_reference:current.source_reference,
            status:"needs_information",question:PUBLIC_INPUT_FACTS.question};
        } else {
          expect(current.raw_answer).toBe(PUBLIC_INPUT_FACTS.rawAnswer);
          args={question_id:current.question_id,revision:current.revision,answer_id:current.answer_id,status:"proposal",disposition:"proposed",
            value:{kind:"input_bounds",requirements:[{outcomes:current.target.outcomes,input:PUBLIC_INPUT_FACTS.input,
              min_length:PUBLIC_INPUT_FACTS.minimum,max_length:PUBLIC_INPUT_FACTS.maximum}]}};
        }
      } else {
        expect(current.kind).toBe("writer_maintenance");
        expect(current.target).toEqual({phase:"changed_record_protection",resource:"studio.parcels",field:"version",outcomes:positiveInput ? [...PUBLIC_INPUT_FACTS.outcomes] : []});
        expect(current.evidence).toEqual([{id:"version-structure",digest:expect.stringMatching(/^sha256:[a-f0-9]{64}$/)}]);
        name="runner__propose_operator_decision";
        if(current.answer_id===undefined) {
          expect(current.raw_answer).toBeUndefined();versionAnswerPending=true;
          args={question_id:current.question_id,revision:current.revision,status:"needs_information",
            question:"Do all your applications advance the parcel change counter every time they change a parcel?"};
        } else {
          expect(current.raw_answer).toBe(lines[4]);expect(current.answer_id).toEqual(expect.any(String));
          args={question_id:current.question_id,revision:current.revision,answer_id:current.answer_id,status:"proposal",disposition:"proposed",
            value:{kind:"writer_maintenance",maintenance:"all_writers_increment"}};
        }
      }
    } else if(names.includes("runner__submit_read_workloads")) {name="runner__submit_read_workloads";
      args={allowed:[{id:"parcel_labels_units",description:"Read parcel labels and units.",plan:{kind:"rows",resource:"studio.parcels",select:["label","units"]}}],forbidden:[],
        operator_meanings:[{resource:"studio.parcels",operator_quote:"studio.parcels is the parcel register"},{resource:"studio.parcels",field:"label",operator_quote:"studio.parcels.label is the public parcel name"},{resource:"studio.parcels",field:"units",operator_quote:"studio.parcels.units is the unit count"}]};
    } else if(names.includes("runner__submit_action_rule_draft")) {
      expect(["initial","edit"]).toContain(stage);
      if(stage==="edit") {
        const initial=jsonLine(text,"Current disabled draft: "),contract=jsonLine(text,"Current work-unit contract: ");
        // The opening prompt retains its original snapshot. Native tool results
        // carry subsequent component saves in this actual transmitted frame.
        const toolResults=(body.input??[]).filter((item:any)=>item.type==="function_call_output").map((item:any)=>JSON.parse(item.output));
        const savedComponents=toolResults.filter((value:any)=>value.status==="disabled_component_saved"&&value.persistence_scope==="component_checkpoint_only");
        const current=savedComponents.at(-1)??initial;
        expect(current.editing_outcome).toBe(PUBLIC_INPUT_FACTS.outcomes[0]);
        expect(contract.identity.intended_outcome).toBe(current.editing_outcome);
        expect(current.missing).toEqual([]);
        const approval=current.components.approval;
        expect(approval).toMatchObject({class_name:PUBLIC_INPUT_FACTS.reviewClasses[0],mode:"human",required_role:"parcel_reviewer",shared_limits:[]});
        if(editPhase===0) {
          editPhase++;
          expect(approval.required_approvals).toBe(1);
          name="runner__submit_approval_policy_draft";
          args={status:"draft",class_name:approval.class_name,mode:approval.mode,required_role:approval.required_role,
            shared_limits:approval.shared_limits,required_approvals:2,changed_fields:["required_approvals"]};
        } else if(editPhase===1) {
          editPhase++;expect(approval.required_approvals).toBe(2);
          name="runner__validate_action_draft";args={};
        } else {
          expect(editPhase).toBe(2);expect(approval.required_approvals).toBe(2);
          expect(toolResults.at(-1)).toMatchObject({status:"ready_for_review",outcome:current.editing_outcome,draft_changed:true,
            validation_scope:"structural",action_save_performed:false,whole_program_review_performed:false,
            publication_performed:false,authority_granted:false,source_database_changed:false});
          narration="The validated first packing Action requires two parcel reviewers. This proposal remains disabled for exact edit and whole Source review.";
        }
      } else {
      const currentIntent=positiveInput ? jsonLine(text,"Current action intent: ") : undefined;
      const actionIndex=positiveInput ? inputIntents.indexOf(currentIntent)+1 : 1;
      if(positiveInput)expect(actionIndex).toBeGreaterThan(0);
      const draft=ownedProgramDraft(actionIndex),{schema_version:_version,verification,effect,approval,...rule}=draft;
      if(receiptEntry) {
        expect(text).toContain("supervised");effect.writeback="supervised";
      }
      if(positiveInput) {
        const contract=jsonLine(text,"Current work-unit contract: ");
        expect(contract.identity.intended_outcome).toBe(draft.outcome);
        const current=contract.current_interpretation.input_requirements.find((entry:any)=>entry.decision==="confirmed"
          && entry.requirements.some((requirement:any)=>requirement.input===PUBLIC_INPUT_FACTS.input));
        const requirement=current.requirements.find((requirement:any)=>requirement.input===PUBLIC_INPUT_FACTS.input);
        expect(requirement).toMatchObject({min_length:PUBLIC_INPUT_FACTS.minimum,max_length:PUBLIC_INPUT_FACTS.maximum});
        const reviewClass=PUBLIC_INPUT_FACTS.reviewClasses[actionIndex-1]!;
        expect(text).toContain(`${draft.outcome} uses ${reviewClass}`);approval.class_name=reviewClass;
        rule.inputs!.push({name:PUBLIC_INPUT_FACTS.input,description:"The caller note required by the Source.",
          type:{kind:"string",min_length:requirement.min_length,max_length:requirement.max_length,comparison:"exact"}});
        // Disk snapshots are retained evidence only. Reply identifiers/bounds
        // above come from the actual transmitted work-unit contract.
        if(!inputSnapshots.some(snapshot=>snapshot.stage==="acknowledged-next-owner")) {
          const saved=await readResume();
          inputSnapshots.push({stage:"acknowledged-next-owner",resume:saved,sources:await loadPolicySources(root,saved.policy_source_session)});
        }
      }
      const phases:Array<[string,any]>=[["runner__review_version_field",{resource:"studio.parcels",field:"version"}],
        ["runner__submit_verification_boundary_draft",{status:"draft",...verification,changed_fields:[]}],
        ["runner__submit_effect_envelope_draft",{status:"draft",...effect,changed_fields:[]}],
        ["runner__submit_action_rule_draft",{status:"draft",...rule,changed_fields:[]}],
        ["runner__submit_approval_policy_draft",{status:"draft",...approval,changed_fields:[]}],["runner__validate_action_draft",{}]];
      const phase=positiveInput ? inputActionPhases.get(actionIndex)??0 : actionPhase;
      if(phase<phases.length) {
        [name,args]=phases[phase]!;
        if(positiveInput)inputActionPhases.set(actionIndex,phase+1);else actionPhase++;
      } else narration=positiveInput
        ? "The structurally compiled proposal remains disabled for ordinary Source coverage review."
        : "The structurally compiled proposal remains disabled and its Source interpretation is still incomplete.";
      if(positiveInput && name==="runner__review_version_field") {
        const catalog=jsonLine(text,"Current normalized structural catalog: ");
        const resource=catalog.resources.find((resource:any)=>resource.name==="studio.parcels");
        expect(resource.version_field_options).toContain("version");
        args={resource:resource.name,field:resource.version_field_options.find((field:string)=>field==="version")};
      }
      }
    } else if(names.includes("runner__review_policy_coverage")) {
      name="runner__review_policy_coverage";const draft=jsonLine(text,"Current draft (JSON pointer root): "),references=jsonLine(text,"Exact coverage references (select, do not invent paths): ");
      const messages=jsonLine(text,"Indexed operator messages for supporting clarifications or explicit overrides (not source text or model narration): ")??[];
      expect(draft.actions).toHaveLength(positiveInput ? 2 : 1);expect(draft.actions[0].outcome).toBe("studio.pack_parcel_1");
      const evidence=draft.runner_evidence.actions["studio.pack_parcel_1"];
      expect(evidence.scoped_bindings.parcel.fields.available).toMatchObject({model_visible:false,actual_values_returned:false,private_action_verification:true,model_analysis:[]});
      expect(evidence.effect.source_counter_maintenance).not.toBeNull();
      const accepted=messages.find((entry:any)=>entry.message===answer);
      const decided=stage==="initial" || positiveInput&&stage==="edit" || !!accepted;
      if(accepted) {const saved=await readResume(),sources=await loadPolicySources(root,sourceId!);
        expect(saved.owner_handoffs.at(-1)).toMatchObject({consumer:"policy_clarification",state:"answered",question,answer});
        expect(sources.operator_messages!.filter(message=>message===answer)).toHaveLength(1);
      }
      const passages:any[]=[{start:1,end:1,disposition:"background",interpretation:"Owned parcel proposal heading.",draft_paths:[]},
        {start:2,end:2,disposition:decided ? "implemented" : "needs_decision",responsibility:decided ? "runner" : "operator",issue_kind:decided ? "coverage_link" : "business_choice",
          interpretation:accepted ? "The exact current owner clarification supports the existing availability condition." : decided ? "The unambiguous original Source clause is represented by the actual availability condition." : "The owner has not yet confirmed availability eligibility; this interpretation remains incomplete.",
          draft_paths:["/actions/0/require"],...(accepted ? {operator_message_id:accepted.operator_message_id} : !decided ? {next_step:"Ask whether the parcel action requires availability."} : {})},
        {start:3,end:3,disposition:"implemented",responsibility:"runner",interpretation:"The exact reviewed Read returns labels and units.",draft_paths:["/read"]},
        {start:4,end:4,disposition:"implemented",responsibility:"runner",interpretation:"The proposal preserves bounded units, effect and human review.",draft_paths:["/actions/0/inputs","/actions/0/effect","/actions/0/approval"]},
        {start:5,end:5,disposition:"implemented",responsibility:"operator",interpretation:"The ordinary exact owner counter commitment is recorded, without independently attesting live enforcement.",draft_paths:["/runner_evidence/actions/studio.pack_parcel_1/effect/source_counter_maintenance"]},
        {start:6,end:6,disposition:"implemented",responsibility:"runner",interpretation:"Availability stays private in the actual prepared Read/Action evidence.",draft_paths:["/runner_evidence/actions/studio.pack_parcel_1/scoped_bindings/parcel/fields/available"],field_checks:[{resource:"studio.parcels",field:"available",expectation:"private"}]}];
      if(positiveInput) {
        expect(draft.actions.map((action:any)=>action.outcome)).toEqual(PUBLIC_INPUT_FACTS.outcomes);
        if(stage==="edit")for(const [index,action] of draft.actions.entries())
          expect(action.require).toEqual(ownedProgramDraft(index+1).require);
        expect(draft.actions[0].inputs.find((input:any)=>input.name===PUBLIC_INPUT_FACTS.input).type).toMatchObject({kind:"string",min_length:1,max_length:64,comparison:"exact"});
        expect(draft.runner_evidence.input_policy_requirement.reviews.at(-1)).toMatchObject({decision:"confirmed",question_reference:{basis:"operator_answer"}});
        passages.push({start:7,end:7,disposition:"implemented",responsibility:"runner",
          interpretation:"The exact current owner answer establishes the retained caller-note bounds without trimming or Source writeback.",
          draft_paths:["/actions/0/inputs","/runner_evidence/input_policy_requirement"]});
        for(const passage of passages)for(const pointer of [...passage.draft_paths] as string[])
          if(pointer.startsWith("/actions/0/"))passage.draft_paths.push(pointer.replace("/actions/0/","/actions/1/"));
        passages[0]={...passages[0],disposition:"implemented",responsibility:"runner",
          interpretation:"The full two-Action agenda is represented by both exact independent outcomes.",draft_paths:["/actions/0/outcome","/actions/1/outcome"]};
        for(const passage of passages)for(const pointer of [...passage.draft_paths] as string[])
          if(pointer.startsWith("/runner_evidence/actions/studio.pack_parcel_1/"))passage.draft_paths.push(pointer.replace("studio.pack_parcel_1","studio.pack_parcel_2"));
        if(stage==="edit") {
          const owner=messages.find((entry:any)=>entry.message===PUBLIC_INPUT_FACTS.editRequest);
          expect(owner).toBeDefined();
          expect(draft.actions[0].approval).toMatchObject({class_name:PUBLIC_INPUT_FACTS.reviewClasses[0],required_approvals:editPhase===0 ? 1 : 2});
          expect(draft.actions[1].approval).toMatchObject({class_name:PUBLIC_INPUT_FACTS.reviewClasses[1],required_approvals:1});
          // The native Source assessment first reviews the unchanged baseline.
          // It does not complete the pending edit. Only the subsequently
          // compiled two-reviewer candidate needs the explicit Source override.
          if(editPhase!==0) {
          passages[3]!.draft_paths=passages[3]!.draft_paths.filter((pointer:string)=>pointer!=="/actions/0/approval");
          passages[3]!.interpretation="All original unit inputs, effects and independent reviewer arrangements remain; the second packing Action still requires one reviewer.";
          passages.push({start:4,end:4,disposition:"overridden",responsibility:"operator",
            interpretation:"The exact later operator request replaces only the first packing Action's one-reviewer clause with two reviewers; all other clauses and the peer remain unchanged.",
            draft_paths:["/actions/0/approval"],operator_message_id:owner.operator_message_id});
          }
        }
      }
      if(receiptEntry && (receiptEntry==="setup" || stage==="edit")) {
        expect(text).toContain(receiptClause);
        passages.push({start:8,end:8,disposition:"implemented",responsibility:"runner",
          interpretation:"The configured Runner-ledger receipt separates applied completion from unapplied requests.",
          draft_paths:["/runner_evidence/runtime_contract/receipt_configuration"]});
      }
      for(const passage of passages)for(const pointer of passage.draft_paths)expect(references).toContain(pointer);
      args={passages};reports.push({stage,draft_digest:canonicalJsonDigest(draft),accepted:!!accepted,messages,passages,
        ...(stage==="edit" ? {reviewed_approvals:draft.actions.map((action:any)=>({outcome:action.outcome,...action.approval}))} : {})});
    } else if(!names.length) {
      if(text.includes("Help the operator clarify the disputed interpretation in this saved job.")
        || text.includes("Ask only these unresolved business choices together, with their purpose and suggested answers; do not repeat the saved action summary.")) {
        if(positiveInput&&stage==="edit")fail("Unexpected unresolved business-choice request during an approval-only edit of the unambiguous Source; inspect the actual retained frame.");
        questionNarrations++;stage="question";clarifyChosen=true;narration=question;
      }
      else narration=jsonLine(text,"Exact next question: ")??"The actual disabled record and unfinished interpretation remain available for review.";
    } else fail(`Unexpected actual emitted tool surface: ${names.join(", ")}`);
    if(name)expect(names).toContain(name);
    if(control==="nested_review_role_after_response" && reviewWaitSnapshot && name==="runner__review_policy_coverage") {
      expect(injected).toBe(false);injected=true;changeReaderRole();
    }
    const reply={status:200,body:{output:name ? [{type:"function_call",call_id:`owned-policy-wait-${requests}`,name,arguments:JSON.stringify(args)}]
      : [{type:"message",content:[{type:"output_text",text:narration}]}]}};
    if(positiveInput)responses.at(-1).reply=reply;
    return reply;
    } catch(error) {
      responses.at(-1).derivation_error=error instanceof Error ? error.message : String(error);
      throw error;
    }
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
    if(receiptEntry) {
      const setup=await loadBoundaryReviewContext(root);
      const source=setup.candidate.source;
      const config={version:1,mode:"review",storage:{sqlite_path:path.join(root,".synapsor/local.db")},capabilities:[],
        trusted_context:{provider:"environment"},action_rules:{project_root:root},
        sources:{[source]:{engine:"postgres",read_url_env:"OWNED_POLICY_WAIT_READ_URL",receipts:{authority:"runner_ledger"}}}};
      await fs.writeFile(path.join(root,"synapsor.actions.runner.json"),JSON.stringify(config),{mode:0o600});
      const actual=await (await import("./authoring-receipt-configuration.js")).authoringReceiptConfiguration(root,[source]);
      expect(actual.status).toBe("current");expect(actual.modes).toEqual([{source,authority:"runner_ledger",explicitly_configured:true}]);
    }
    if(control==="client_keep" || control==="client_cancel") {
      const setup=await loadBoundaryReviewContext(root);
      failures.push({title:"OWNED_CLIENT_TEST_SETUP_READBACK",draft:setup.draft,candidate:setup.candidate});
    }
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
    expect((await listActionRuleAuthorityDrafts(root))[0],transcript+"\nDIAGNOSTIC_REQUESTS_MENUS_FAILURES="+JSON.stringify({responses,menus,failures})).toBeDefined();
    if(positiveInput) {
      const sources=await loadPolicySources(root,sourceId!),authority=(await listActionRuleAuthorityDrafts(root))[0]!;
      if(receiptEntry==="setup") {
        expect(receiptReads,transcript).toBe(1);expect(receiptMappings,transcript).toBe(1);expect(receiptConfirmations,transcript).toBe(1);
        expect(sources.receipt_requirement_reviews?.at(-1)).toMatchObject({decision:"confirmed",verified:false});
      }
      const inputQuestions=initiallySaved.operator_questions.filter((q:any)=>q.kind==="input_bounds"),rootQuestion=inputQuestions.find((q:any)=>q.source_binding),child=inputQuestions.at(-1);
      expect(inputPrompts,transcript).toBe(1);expect(inputConfirmations,transcript).toBe(1);expect(clientDutyPrompts,transcript).toBe(1);
      expect(child).toMatchObject({id:inputBeforeConfirmation.id,raw_answer:inputBeforeConfirmation.raw_answer,proposal:inputBeforeConfirmation.proposal,
        budget_owner_id:rootQuestion.id,confirmation:{actor:"local_installation_operator"}});
      expect(rootQuestion.budget).toEqual({iterations_used:2,tool_calls_used:2,correction_used:false});
      expect(initiallySaved.owner_handoffs.find((h:any)=>h.id===child.handoff_id)).toMatchObject({consumer:"input_policy",state:"answered",question:PUBLIC_INPUT_FACTS.question,answer:PUBLIC_INPUT_FACTS.rawAnswer,actor:"local_installation_operator"});
      expect(sources.input_policy_reviews).toHaveLength(1);
      expect(sources.input_policy_reviews![0]).toMatchObject({decision:"confirmed",question_reference:{id:child.id,digest:child.digest,root_id:rootQuestion.id,basis:"operator_answer",answer_id:child.raw_answer.id}});
      expect(sources.input_policy_reviews![0]!.verified).toBe(false);
      const acknowledged=inputSnapshots.find(snapshot=>snapshot.stage==="acknowledged-next-owner");
      expect(initiallySaved.operator_questions.filter((q:any)=>q.kind==="input_bounds")).toEqual(acknowledged.resume.operator_questions.filter((q:any)=>q.kind==="input_bounds"));
      expect(sources.input_policy_reviews).toEqual(acknowledged.sources.input_policy_reviews);
      expect(policyReviewReadiness(activePolicySource(sources)!,sources.coverage,sources).ready,transcript).toBe(true);
      expect(initiallySaved.stage,transcript).toBe("authority_review");
      expect(initiallySaved.action.checkpoint).toBeUndefined();expect(initiallySaved.pending_action_revision).toBeUndefined();
      expect(initiallySaved.action.intended_outcomes).toEqual(PUBLIC_INPUT_FACTS.outcomes);
      expect(initiallySaved.action.completed_outcomes).toEqual(PUBLIC_INPUT_FACTS.outcomes);
      expect(authority.authority.rules.map(entry=>entry.rule.outcome)).toEqual(PUBLIC_INPUT_FACTS.outcomes);
      for(const entry of authority.authority.rules)expect(entry.rule.inputs!.find(input=>input.name===PUBLIC_INPUT_FACTS.input)!.type).toMatchObject({kind:"string",min_length:1,max_length:64,comparison:"exact"});
      for(const [index,entry] of authority.authority.rules.entries()) {
        const declared=ownedProgramDraft(index+1);
        expect(entry.rule).toMatchObject({outcome:declared.outcome,require:declared.require,derive:declared.derive,ttl_seconds:declared.ttl_seconds,
          approval_class:PUBLIC_INPUT_FACTS.reviewClasses[index],effect:{operation:"update",target_resource:"studio.parcels",target_binding:"parcel",set:{units:{kind:"input",name:"units"}}}});
        expect(entry.rule.effect.set).not.toHaveProperty(PUBLIC_INPUT_FACTS.input);
      }
      expect(initiallySaved.generation_recovery.operations.some((op:any)=>["in_flight","unknown","partial","received","handled"].includes(op.state))).toBe(false);
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      if(activationPresentation) {
        expect(activationSnapshots.map(snapshot=>snapshot.stage)).toEqual(["read-before-explicit-activate","authored-action-before-default-no"]);
        const before=activationSnapshots[1],activeRead=await loadActivatedExplorationBoundaries(root);
        expect(activeRead).toHaveLength(1);expect(activeRead).toEqual(before.activeRead);
        expect(activeRead[0]!.activation).toMatchObject({state:"active",actor:"local-developer"});
        expect(authority).toEqual(before.authority);
        expect(await readSemanticSupervisedExecutionState({projectRoot:root})).toEqual(before.execution);
        expect(before.execution).toMatchObject({enabled:false,policies:[]});
        expect(menus.filter(menu=>menu.title==="REVIEW CHANGE REQUESTS")).toHaveLength(1);
        expect(menus.find(menu=>menu.title==="REVIEW CHANGE REQUESTS")).toMatchObject({initialValue:"no",selected:"no"});
        activationSnapshots.push({stage:"authored-action-declined-public-return",resume:initiallySaved,sources,authority,activeRead,execution:before.execution});
      } else {
        expect(await fs.readFile(path.join(root,".synapsor/exploration-boundary.active.json")).catch(()=>undefined)).toBeUndefined();
      }
      expect(failures.filter(entry=>entry.title==="SETUP NEEDS ATTENTION"),transcript).toEqual([]);
      inputSnapshots.push({stage:activationPresentation ? "reviewed-read-active-action-disabled-program" : "reviewed-disabled-program",resume:initiallySaved,sources,authority,read:(await loadBoundaryReviewContext(root))});
      if(editInputBaseline) {
        const before={resume:initiallySaved,sources,authority,read:await loadBoundaryReviewContext(root),requests,inputPrompts,inputConfirmations};
        editSnapshots.push({stage:"reviewed-disabled-baseline",...before});
        stage="edit";
        if(receiptEntry==="edit") {
          const replacement=path.join(root,"supplemental-studio-receipt-edit.txt");
          await fs.writeFile(replacement,[...initialLines,receiptClause].join("\n"));
          answers.push(`/attach ${replacement}`);
        }
        answers.push(PUBLIC_INPUT_FACTS.editRequest);
        expect(await boundaryReviewCommand(["--project-root",root,"--access","--job-first"],inspect,outer,undefined,options)).toBe(0);
        const after={resume:await readResume(),sources:await loadPolicySources(root,sourceId!),authority:(await listActionRuleAuthorityDrafts(root))[0]!,read:await loadBoundaryReviewContext(root)};
        editSnapshots.push({stage:"post-edit-public-return",...after});
        expect(editSaveConfirmations,transcript).toBe(1);expect(editPhase).toBe(2);
        // R2 independently adjudicated v6: a newly attached Source needs its
        // own Input decision. The unchanged-Source edit still asks nothing.
        expect(inputPrompts).toBe(before.inputPrompts+(receiptEntry==="edit" ? 1 : 0));
        expect(inputConfirmations).toBe(before.inputConfirmations+(receiptEntry==="edit" ? 1 : 0));
        if(receiptEntry==="edit") {
          expect(receiptReads,transcript).toBe(1);expect(receiptMappings,transcript).toBe(1);expect(receiptConfirmations,transcript).toBe(1);
          expect(after.sources.receipt_requirement_reviews?.at(-1)).toMatchObject({decision:"confirmed",verified:false});
          for(const prior of before.resume.operator_questions) expect(after.resume.operator_questions.find((q:any)=>q.id===prior.id)).toEqual(prior);
        } else {
          expect(after.resume.operator_questions).toEqual(before.resume.operator_questions);
          expect(after.resume.owner_handoffs).toEqual(before.resume.owner_handoffs);
        }
        if(receiptEntry==="edit") expect(after.sources.input_policy_reviews!.slice(0,before.sources.input_policy_reviews!.length)).toEqual(before.sources.input_policy_reviews);
        else expect(after.sources.input_policy_reviews).toEqual(before.sources.input_policy_reviews);
        if(receiptEntry==="edit") {
          expect(after.sources.snapshots.slice(0,before.sources.snapshots.length)).toEqual(before.sources.snapshots);
          expect(activePolicySource(after.sources)!.text).toBe([...initialLines,receiptClause].join("\n"));
        } else expect(after.sources.snapshots).toEqual(before.sources.snapshots);
        expect(after.sources.application_assignments!.slice(0,before.sources.application_assignments!.length)).toEqual(before.sources.application_assignments);
        // Normal Source assessment and final changed-candidate review each
        // have their own exact draft subject; old ownership remains history.
        expect(after.sources.application_assignments).toHaveLength(before.sources.application_assignments!.length+2);
        for(const assignment of after.sources.application_assignments!.slice(before.sources.application_assignments!.length))
          expect(assignment).toMatchObject({source_digest:receiptEntry==="edit" ? activePolicySource(after.sources)!.digest : before.sources.coverage!.source_digest,
            contract_digest:before.sources.coverage!.client_duties!.contract_digest,
            obligations:before.sources.application_assignments!.at(-1)!.obligations,owner:"client_application",verified:false});
        expect(after.sources.application_assignments!.at(-1)).toMatchObject({source_digest:receiptEntry==="edit" ? activePolicySource(after.sources)!.digest : before.sources.coverage!.source_digest,
          draft_digest:after.sources.coverage!.draft_digest,contract_digest:before.sources.coverage!.client_duties!.contract_digest,
          obligations:before.sources.application_assignments!.at(-1)!.obligations,owner:"client_application",verified:false});
        expect(after.read.candidate).toEqual(before.read.candidate);
        // The ordinary disabled Read review is saved once again. Assert its
        // exact revision increment and timestamp instead of discarding either.
        expect(after.read.progress).toEqual({...before.read.progress,revision:before.read.progress!.revision+1,
          updated_at:after.read.progress!.updated_at});
        expect(Date.parse(after.read.progress!.updated_at)).toBeGreaterThan(Date.parse(before.read.progress!.updated_at));
        expect(after.resume.reviewed_version_fields).toEqual(before.resume.reviewed_version_fields);
        // Normal merge rebuilds the disabled artifact's activated_at metadata;
        // every business field and exact Read dependency remains unchanged.
        const rules=(value:typeof authority)=>value.authority.rules.map(({activated_at:_time,...rule})=>rule);
        expect(rules(after.authority)).toEqual(rules(before.authority));
        const approvalClasses=structuredClone(before.authority.authority.approval_classes);
        approvalClasses.find(entry=>entry.name===PUBLIC_INPUT_FACTS.reviewClasses[0])!.required_approvals=2;
        expect(after.authority.authority.approval_classes).toEqual(approvalClasses);
        expect(after.authority.authority.catalog).toEqual(before.authority.authority.catalog);
        expect(after.resume.action.intended_outcomes).toEqual(PUBLIC_INPUT_FACTS.outcomes);
        expect(after.resume.action.completed_outcomes).toEqual(PUBLIC_INPUT_FACTS.outcomes);
        expect(after.resume.pending_action_revision).toBeUndefined();expect(after.resume.stage).toBe("authority_review");
        expect(after.resume.generation_recovery.operations.slice(0,before.resume.generation_recovery.operations.length)).toEqual(before.resume.generation_recovery.operations);
        expect(after.sources.coverage!.client_duties).toEqual(before.sources.coverage!.client_duties);
        expect(after.sources.coverage!.passages.find(passage=>passage.disposition==="overridden")).toMatchObject({start:4,end:4,operator_override:PUBLIC_INPUT_FACTS.editRequest});
        expect(after.sources.operator_messages!.filter(message=>message===PUBLIC_INPUT_FACTS.editRequest)).toHaveLength(1);
        // The appended receipt clause first refuses the baseline until its
        // meaning is confirmed, then reviews that baseline and the changed rule.
        expect(reports.filter(report=>report.stage==="edit").map(report=>report.reviewed_approvals.map((approval:any)=>approval.required_approvals)))
          .toEqual(receiptEntry==="edit" ? [[1,1],[1,1],[2,1]] : [[1,1],[2,1]]);
        expect(policyReviewReadiness(activePolicySource(after.sources)!,after.sources.coverage,after.sources).ready,transcript).toBe(true);
        const editInputResponses=responses.filter(response=>response.stage==="edit"&&response.current_operator_question?.kind==="input_bounds");
        if(receiptEntry==="edit") {
          // Two actual submissions, not two raw answers: one root request for
          // missing information and one child mapping of the fresh exact answer.
          expect(editInputResponses).toHaveLength(2);
          const rootRequest=editInputResponses[0].current_operator_question,childRequest=editInputResponses[1].current_operator_question;
          const rootQuestion=after.resume.operator_questions.find((q:any)=>q.id===rootRequest.question_id)!;
          const child=after.resume.operator_questions.find((q:any)=>q.id===childRequest.question_id)!;
          const currentSource=activePolicySource(after.sources)!;
          expect(rootQuestion.source_binding).toMatchObject({source_session:after.sources.id,source_digest:currentSource.digest,lines:8});
          expect(rootQuestion.target.outcomes).toEqual(PUBLIC_INPUT_FACTS.outcomes);
          expect(rootQuestion.raw_answer).toBeUndefined();expect(rootQuestion.confirmation).toBeUndefined();
          expect(rootQuestion.budget).toEqual({iterations_used:2,tool_calls_used:2,correction_used:false});
          expect(child.budget_owner_id).toBe(rootQuestion.id);expect(child.revision).toBe(rootQuestion.revision+1);
          expect(child.target).toEqual(rootQuestion.target);expect(child.context_digest).toBe(rootQuestion.context_digest);
          expect(child.evidence).toEqual(rootQuestion.evidence);
          expect(child.raw_answer.text).toBe(PUBLIC_INPUT_FACTS.rawAnswer);
          expect(childRequest.answer_id).toBe(child.raw_answer.id);expect(childRequest.raw_answer).toBe(PUBLIC_INPUT_FACTS.rawAnswer);
          expect(child.proposal).toMatchObject({question_id:child.id,revision:child.revision,answer_id:child.raw_answer.id,disposition:"proposed"});
          expect(child.confirmation).toMatchObject({decision:"new_attributed_decision",proposal_digest:canonicalJsonDigest(child.proposal)});
          expect(after.sources.input_policy_reviews).toHaveLength(before.sources.input_policy_reviews!.length+1);
          expect(after.sources.input_policy_reviews!.at(-1)).toMatchObject({source_session:after.sources.id,source_digest:currentSource.digest,
            agenda_digest:rootQuestion.source_binding.agenda_digest,outcomes:PUBLIC_INPUT_FACTS.outcomes,decision:"confirmed",verified:false,
            question_reference:{id:child.id,revision:child.revision,digest:child.digest,proposal_digest:child.confirmation.proposal_digest,
              root_id:rootQuestion.id,root_digest:rootQuestion.digest,basis:"operator_answer",answer_id:child.raw_answer.id}});
          const replies=editInputResponses.map(response=>JSON.parse(response.reply.body.output[0].arguments));
          expect(replies[0]).toMatchObject({question_id:rootQuestion.id,revision:rootQuestion.revision,status:"needs_information"});
          expect(replies[1]).toMatchObject({question_id:child.id,revision:child.revision,answer_id:child.raw_answer.id,status:"proposal"});
        } else expect(editInputResponses).toEqual([]);
        expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
        expect(await fs.readFile(path.join(root,".synapsor/exploration-boundary.active.json")).catch(()=>undefined)).toBeUndefined();
        expect(failures.filter(entry=>entry.title==="SETUP NEEDS ATTENTION"),transcript).toEqual([]);
        return {origin:"IMPLEMENTER_PUBLIC_INPUT_SELECTED_BASELINE_EDIT_DISABLED",control,requests,inputPrompts,inputConfirmations,activation:false,provider_calls:0};
      }
      if(activationPresentation)return {origin:"IMPLEMENTER_PUBLIC_AUTHORED_ACTION_DEFAULT_NO",control,requests,inputPrompts,inputConfirmations,read_activation:true,proposal_activation:false,execution_activation:false,provider_calls:0};
      return {origin:"IMPLEMENTER_PUBLIC_INPUT_ONBOARDING_DISABLED",control,requests,inputPrompts,inputConfirmations,activation:false,provider_calls:0};
    }
    if(reviewWaitControl) {
      expect(nestedEntered,transcript).toBe(true);expect(injected).toBe(true);
      const afterResponse=control==="nested_review_role_after_response" || control==="nested_review_role_client_back";
      expect(requests,transcript).toBe(reviewWaitSnapshot.requests+(afterResponse ? 1 : 0));
      const sources=await loadPolicySources(root,sourceId!);
      if(afterResponse) {
        // The already reserved submission stays in history. A changed reader
        // cannot turn its response or a pending ownership choice into coverage.
        const {coverage_episodes:prior=[],...sourceBefore}=reviewWaitSnapshot.sources;
        const {coverage_episodes:episodes=[],...sourceAfter}=sources;
        expect(sourceAfter).toEqual(sourceBefore);
        expect(episodes).toHaveLength(prior.length+1);expect(episodes.slice(0,-1)).toEqual(prior);
        expect(episodes.at(-1)!.submissions).toHaveLength(1);
        expect(episodes.at(-1)!.submissions[0]!.validated).toBe(control==="nested_review_role_client_back" ? true : undefined);
      } else expect(sources).toEqual(reviewWaitSnapshot.sources);
      expect((await listActionRuleAuthorityDrafts(root))[0]).toEqual(reviewWaitSnapshot.authority);
      expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(reviewWaitSnapshot.read);
      expect(transcript).toContain("reader schema or role changed");
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      expect(await fs.readFile(path.join(root,".synapsor/exploration-boundary.active.json")).catch(()=>undefined)).toBeUndefined();
      return {origin:"IMPLEMENTER_DERIVED_PUBLIC_REVIEW_CONSENT_CURRENTNESS",control,requests,activation:false,provider_calls:0};
    }
    if(control==="nested_transfer_cancel") {
      expect(nestedEntered,transcript).toBe(true);expect(nestedDeclines).toBe(0);
      expect(requests,transcript).toBe(nestedStartRequests);
      const sources=await loadPolicySources(root,sourceId!);
      expect(sources.snapshots).toHaveLength(1);expect(activePolicySource(sources)!.text).toBe(initialLines.join("\n"));
      expect(failures.filter(entry=>entry.title==="SETUP NEEDS ATTENTION"),transcript).toEqual([]);
      expect(transcript).not.toContain("BOUNDARY_AUTHORING_RESUME_CHANGED");
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      expect(await fs.readFile(path.join(root,".synapsor/exploration-boundary.active.json")).catch(()=>undefined)).toBeUndefined();
      return {origin:"IMPLEMENTER_DERIVED_PUBLIC_DECLINED_SOURCE_TRANSFER",control,requests,activation:false,provider_calls:0};
    }
    if(control==="nested_competing_resume" || control==="nested_competing_source" || control==="nested_cached_activate") {
      expect(nestedEntered,transcript).toBe(true);expect(injected).toBe(true);
      expect(requests,transcript).toBe(nestedStartRequests);expect(competingSaved).toBeDefined();
      if(control==="nested_competing_resume") {
        expect(await readResume()).toEqual(competingSaved);
        expect(failures.some(entry=>entry.title==="SETUP NEEDS ATTENTION"),transcript).toBe(true);
        expect(failures.flatMap(entry=>entry.context??entry.details??[]).join("\n")).toContain("BOUNDARY_AUTHORING_RESUME_CHANGED");
      } else {
        const current=await loadPolicySources(root,sourceId!);
        expect(current).toEqual(competingSaved);expect(activePolicySource(current)!.version).toBe(3);
        expect(transcript).toContain("POLICY_SOURCE_CHANGED");
        expect(nestedDeclines).toBe(0); // Refused before even offering a new episode.
        expect(policyReviewReadiness(activePolicySource(current)!,current.coverage,current).ready).toBe(false);
      }
      if(control==="nested_cached_activate")expect(cachedActivationAttempts,transcript).toBe(1);
      expect(await fs.readFile(path.join(root,".synapsor/exploration-boundary.active.json")).catch(()=>undefined)).toBeUndefined();
      expect(nestedAuthorityBefore).toBeDefined();
      expect((await listActionRuleAuthorityDrafts(root))[0]).toEqual(nestedAuthorityBefore);
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      return {origin:"IMPLEMENTER_DERIVED_PUBLIC_NESTED_REVIEW_RACE",control,requests,activation:false,provider_calls:0};
    }
    if(control==="nested_source_review") {
      // Real enclosing Read permission conversation -> /attach -> saved Review
      // -> decline. It must unwind before the stale outer save or narration.
      expect(nestedEntered,transcript).toBe(true);expect(nestedDeclines,transcript).toBe(1);
      expect(requests,transcript).toBe(nestedStartRequests);
      expect(failures.filter(entry=>entry.title==="SETUP NEEDS ATTENTION"),transcript).toEqual([]);
      expect(transcript).not.toContain("BOUNDARY_AUTHORING_RESUME_CHANGED");
      expect(transcript).not.toContain("BOUNDARY DRAFTS SAVED");
      const sources=await loadPolicySources(root,sourceId!);
      expect(sources.snapshots).toHaveLength(2);expect(sources.snapshots[0]!.text).toBe(initialLines.join("\n"));
      expect(activePolicySource(sources)!.version).toBe(2);
      expect(sources.application_assignments).toBeDefined();
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      const savedRevision=initiallySaved.revision_digest;stage="explicit_review";
      await boundaryReviewCommand(["--project-root",root,"--access","--job-first","--review-rules"],inspect,outer,undefined,options);
      expect(requests,transcript).toBe(nestedStartRequests);expect((await readResume()).revision_digest).toBeDefined();
      expect(savedRevision).toBeDefined();expect(activePolicySource(await loadPolicySources(root,sourceId!))!.version).toBe(2);
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      return {origin:"IMPLEMENTER_DERIVED_PUBLIC_NESTED_REVIEW",control,requests,nestedDeclines,activation:false,provider_calls:0};
    }
    if(control==="client_keep" || control==="client_cancel") {
      // Actual public start/CLI consumer and ordinary local provider replies,
      // not a direct call to the client-duty or readiness helper.
      expect(clientDutyPrompts,transcript).toBe(1);
      const sources=await loadPolicySources(root,sourceId!);
      expect(sources.application_assignments ?? []).toEqual([]);
      expect(sources.coverage,transcript).toBeDefined();
      expect(sources.coverage_episodes!.at(-1)!.submissions.at(-1)!.validated).toBe(true);
      expect(policyReviewReadiness(activePolicySource(sources)!,sources.coverage,sources).ready).toBe(false);
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      expect(transcript).toContain(control==="client_keep" ? "Client responsibilities remain pending" : "Boundary conversation paused");
      expect(transcript).toContain("Resume");
      if(requireSavedCoverageCheckpoint) {
        // The real producer consumed a complete valid report and the guarded
        // Source save succeeded. Cancellation grants nothing, but it must not
        // leave that newly owned, already-saved response uncertain on restart.
        expect(responses.at(-1)!.names).toEqual(["runner__review_policy_coverage"]);
        expect(liveCoverageBefore.operations.at(-1)).toMatchObject({state:"handled"});
        const current=initiallySaved.generation_recovery!.operations;
        expect(current.slice(0,-1)).toEqual(liveCoverageBefore.operations.slice(0,-1));
        expect(current.at(-1)!.id).toBe(liveCoverageBefore.operations.at(-1).id);
        expect(current.at(-1)!.attempts).toEqual(liveCoverageBefore.operations.at(-1).attempts);
        expect(current.at(-1)).toMatchObject({state:"checkpointed",checkpoint_seen:true});
      }
      return {origin:"IMPLEMENTER_DERIVED_PUBLIC_CLIENT_DUTY",control,requests,questionNarrations,questionReads,activation:false,provider_calls:0};
    }
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
      await fs.mkdir(evidenceRoot,{recursive:true});await fs.writeFile(path.join(evidenceRoot,`${control}-${randomUUID()}.json`),JSON.stringify({origin:activationPresentation ? "IMPLEMENTER_PUBLIC_AUTHORED_ACTION_DEFAULT_NO" : editInputBaseline ? "IMPLEMENTER_PUBLIC_INPUT_SELECTED_BASELINE_EDIT_DISABLED" : positiveInput ? "IMPLEMENTER_PUBLIC_INPUT_ONBOARDING_DISABLED" : "IMPLEMENTER_DERIVED_PUBLIC_POLICY_WAIT",control,positiveInput,editInputBaseline,activationPresentation,transcript,publicOutput:stdout.mock.calls.map(([chunk])=>String(chunk)).join(""),menus,failures,responses,reports,questionSnapshots,inputSnapshots,editSnapshots,activationSnapshots,receiptEntry,receiptReads,receiptMappings,receiptConfirmations,receiptSnapshots,injected,
        persisted:persisted.map((result,index)=>({kind:["resume","disabled_actions","sources"][index],...(result.status==="fulfilled" ? {value:result.value} : {error:String(result.reason)} )}))},null,2));}
    await fs.rm(root,{recursive:true,force:true});
  }
}

it("public onboarding acknowledges the exact Input answer and completes reviewed disabled Read and Action drafts",async()=>{
  const result=await publicPolicyWait("healthy",false,true);expect(result.provider_calls).toBe(0);
},30_000);

it("public onboarding presents authored Action consent after explicit Read activation and keeps default-No proposal authority absent",async()=>{
  const result=await publicPolicyWait("healthy",false,true,false,true);expect(result.provider_calls).toBe(0);
},30_000);

it("public selected-baseline edit retains Input acknowledgement and changes only one independent reviewer requirement",async()=>{
  const result=await publicPolicyWait("healthy",false,true,true);expect(result.provider_calls).toBe(0);
},30_000);

it.each(["healthy","pause_restart","source_drift","schema_drift","role_drift","competing_resume","explicit_review"] as const)(
  "public Source owner wait persists the actual business question and protects its current answer: %s",async control=>{
    const result=await publicPolicyWait(control);expect(result.provider_calls).toBe(0);
  },30_000);

it.each(["client_keep","client_cancel"] as const)(
  "public start/CLI retains pending client duties and leaves the review without a prompt loop: %s",async control=>{
    const result=await publicPolicyWait(control);expect(result.provider_calls).toBe(0);
  },30_000);

it("public guided client cancellation checkpoints only its newly consumed and guarded-saved coverage reply",async()=>{
  const result=await publicPolicyWait("client_cancel",true);expect(result.provider_calls).toBe(0);
},30_000);

// Added regression; prior controls and their expectations stay intact.
it("public nested saved Review pauses before the outer stale checkpoint after attachment replacement",async()=>{
  const result=await publicPolicyWait("nested_source_review");expect(result.provider_calls).toBe(0);
},30_000);

it.each(["nested_competing_resume","nested_competing_source"] as const)(
  "public nested saved Review preserves genuine competing context refusal: %s",async control=>{
    const result=await publicPolicyWait(control);expect(result.provider_calls).toBe(0);
  },30_000);

it("public nested canceled attachment transfer preserves the ordinary disabled Save No path",async()=>{
  const result=await publicPolicyWait("nested_transfer_cancel");expect(result.provider_calls).toBe(0);
},30_000);

it("public cached activation refuses a concurrently replaced policy without generation consent",async()=>{
  const result=await publicPolicyWait("nested_cached_activate");expect(result.provider_calls).toBe(0);
},30_000);

it.each(["nested_review_role_drift","nested_review_schema_drift"] as const)(
  "public saved review refuses reader metadata drift during generation consent before submission: %s",async control=>{
    const result=await publicPolicyWait(control);expect(result.provider_calls).toBe(0);
  },30_000);

it.each(["nested_review_role_after_response","nested_review_role_client_back"] as const)(
  "public saved review retains pending coverage when reader role changes during a response or ownership wait: %s",async control=>{
    const result=await publicPolicyWait(control);expect(result.provider_calls).toBe(0);
  },30_000);

// Supplemental capability is explicit in Source and fixture configuration; the
// original studio proposal-only setup/activation rows above remain unchanged.
it.each(["setup", "edit"] as const)("supplemental studio public receipt binding through %s",async entry=>{
  const result=await publicPolicyWait("healthy",false,true,entry==="edit",false,entry);
  expect(result.provider_calls).toBe(0);
},30_000);

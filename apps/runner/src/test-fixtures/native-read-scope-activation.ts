/** Actual declared structural review -> controlled provider -> stored compiler analysis
 * -> generation consumption -> Resume CAS -> separately displayed scope decision.
 * No activation, imported confirmation, assessment boolean or seeded mapping.
 * Call reviewNativeReadScopeActivationFixture(f, true) explicitly for a confirmed
 * public-entry fixture; readSavedState() reloads the acknowledged native record. */
import { randomUUID } from "node:crypto";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { parseOperatorQuestion } from "../authoring-operator-question.js";
import { READ_SCOPE_PROTOCOL, resolveReadScopeProposal, readScopeProposalSchema, type ReadScopeRecord } from "../read-structured-scope.js";
import { READ_WORKLOAD_ANALYSIS_VERSION, type ReadWorkloadAnalysis } from "../read-workload-assist.js";

import { prepareReviewedReadScope } from "./reviewed-read-scope.js";
import { projectReadSubjectContext } from "../authoring-read-subject-context.js";
import { projectReadScopeHostContext } from "../read-current-evidence.js";
import { readWorkloadCatalog } from "../read-workload-model.js";
import { explorationBoundaryCandidateDigest } from "../auto-boundary.js";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadScopeQuestion, proposeReadScopeReview, confirmReadScopeReview, resolveNativeReadScope } from "../authoring-read-scope-question.js";
import { readScopeConsumption } from "../authoring-read-scope-binding.js";
import { captureOperatorAnswer, presentOperatorQuestion, leaveOperatorQuestionPending, parseOperatorQuestions } from "../authoring-operator-question.js";
import { authoringReadCheckpoint, configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery } from "../authoring-generation-recovery.js";
import { completedAuthoringQuestion, askToolSurfaceDigest, resolveAskProviderConfiguration, runAskProviderTurn, type AskToolDefinition } from "../model-ask.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, type BoundaryAuthoringResumeState } from "../boundary-authoring-resume.js";

// Actual controlled provider -> native generation consumption -> Resume CAS.
// This is not an OS/public CLI restart; reconstruction below uses disk records.
export async function nativeReadScopeActivationFixture(custom = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owned-native-scope-"));
  await fs.chmod(dir,0o700);
  const prepared=await prepareReviewedReadScope(dir, {resources:["work.items"],field:"label",review:{allow_reviewed_fields:["label"]}}), {context}=prepared;
  const nativeBinding={boundary_name:context.candidate.pack.name,generation_lock_fingerprint:context.candidate.generation_lock_fingerprint,
    schema_fingerprint:context.lock.schema_fingerprint,role_posture_fingerprint:context.lock.role_posture_fingerprint};
  const initial = { binding: nativeBinding, stage: "read_mapping" as const, jobIntent: "Show the signed-in person their item labels", provider: custom ? "openai_compatible" as const : "openai" as const, model: "controlled" };
  const destination = { provider: initial.provider, model: initial.model, ...(custom ? {baseUrl:"http://localhost:9876/v1"} : {}) };
  const input={...initial,...(custom ? {metadataDestinationDigest:d(authoringDestination(destination))} : {})};
  let state = buildBoundaryAuthoringResumeState({ ...input, authoringProtocol: { version: "synapsor.structured-authoring.v2" } });
  const projected=projectAuthoringReadScopeContext({resume:state,boundary:context.candidate,structuralReview:context,
    records:{questions:[],handoffs:[]}});
  const request=projected.references.find(ref=>ref.kind==="request")!;
  const {binding}=projected,inventory={references:projected.references,catalog:projected.catalog};
  const analysis=()=>structuredClone(prepared.analysis);
  const scopeDigest=ownerQuestionScopeDigest({job:input.jobIntent,model:{provider:input.provider,model:input.model,destination:authoringDestination(destination)}});
  const contextDigest=ownerQuestionContextDigest({scope:scopeDigest,binding:nativeBinding,candidate:context.candidate,
    readerSchema:schemaFingerprintForInspection(prepared.inspection),readerRole:rolePostureFingerprint(prepared.inspection)});
  const stored=await storeReadWorkloadAnalysis({projectRoot:dir,generatedBoundary:context.candidate,analysis:analysis(),source:{kind:"operator_exact_plan"}});
  await writeBoundaryAuthoringResumeState(dir, state, { expectedRevisionDigest: null });
  const persist = async (next: BoundaryAuthoringResumeState) => {
    await writeBoundaryAuthoringResumeState(dir, next, { expectedRevisionDigest: state.revision_digest }); state = next;
  };
  const save = async (q: ReturnType<typeof parseOperatorQuestion>) => persist(buildBoundaryAuthoringResumeState({ ...input, previous: state,
    operatorQuestions: state.operator_questions!.map(old => old.id === q.id ? q : old) }));
  const produce = async (predecessor?: ReturnType<typeof parseOperatorQuestion>) => withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => state.generation_recovery, current: async () => contextDigest,
      progress: () => {}, write: generationRecovery => persist(buildBoundaryAuthoringResumeState({ ...input, previous: state, generationRecovery })) });
    let submitted: ReadScopeRecord | undefined;
    const tools: AskToolDefinition[] = [{ name: "runner.propose_scope", title: "Propose scope", description: "No authority.",
      input_schema: { type: "object", additionalProperties: false, properties: { read_scope: readScopeProposalSchema }, required: ["read_scope"] } }];
    const result = await runAskProviderTurn({ configuration: resolveAskProviderConfiguration({ provider: input.provider, model: input.model, ...(custom ? {base_url:destination.baseUrl} : {}),
      api_key: "inert-local-credential", egress_acknowledged: true, authority_digest: askToolSurfaceDigest(tools) }, {}, new Date()),
      question: JSON.stringify({request:input.jobIntent,original_request:request.id,...inventory,declared_no_read:false}), history: [], tools, signal: new AbortController().signal, authorityDigest: askToolSurfaceDigest(tools),
      requiredInitialToolName: tools[0]!.name, completeAfterRequiredTool: true,
      gateway: { mode: "authoring", listTools: () => tools, close: async () => {}, callTool: async (_tool, args) => {
        submitted = resolveReadScopeProposal((args as { read_scope: unknown }).read_scope, { expectedBinding: binding,
          ...inventory, analysis: analysis() });
        return { ok: true, value: { proposed: true } };
      } },
      dependencies: { requestJson: async actual => {
        const find=(value:unknown):typeof inventory & {request:string;original_request:string;declared_no_read:boolean}|undefined=>{
          if(typeof value==="string") {
            // Runner prefixes its host-owned date notice. Parse only a complete
            // JSON line actually transmitted, never reconstruct hidden inputs.
            for(const line of value.split("\n"))try {const parsed=JSON.parse(line);if(parsed.request&&parsed.original_request&&parsed.catalog)return parsed;}catch{}
          }
          if(value&&typeof value==="object")for(const child of Object.values(value)){const found=find(child);if(found)return found;}
          return undefined;
        };
        const visible=find(actual.body);if(!visible)throw new Error("Actual provider request lacks the declared fixture inputs");
        const resource=visible.catalog.resources.find(resource=>resource.id==="work.items");
        const subject=visible.catalog.subject_scopes?.find(scope=>scope.root_resource===resource?.id);
        if(!resource||!subject)throw new Error("Actual provider catalog lacks the reviewed item scope");
        const proposal={protocol:READ_SCOPE_PROTOCOL,original_request:visible.original_request,
          applicability:visible.declared_no_read?"no_read_requested":"read_requested",requirements:visible.declared_no_read?[]:[{
            id:"items",intended_use:visible.request,references:[visible.original_request],disposition:"include",
            subjects:[{root_resource:resource.id,mode:"reviewed_resource",scope_reference:subject.reference}],
            targets:[{root_resource:resource.id,resource:resource.id,operation:"resource"},{root_resource:resource.id,resource:resource.id,operation:"return",field:"label"}],
          }]};
        return {status:200,body:{output:[{type:"function_call",call_id:randomUUID(),name:"runner__propose_scope",arguments:JSON.stringify({read_scope:proposal})}]}};
      } } });
    const completion = completedAuthoringQuestion(result); if (!completion) throw new Error("Missing actual completion");
    if (!submitted) throw new Error("Missing parsed actual submission");
    const q = createReadScopeQuestion({ id: randomUUID(), revision: predecessor ? predecessor.revision + 1 : 1,
      scope_digest: scopeDigest, context_digest: contextDigest,
      read_scope: { mode: "review", record: submitted, completion, ...(predecessor ? { predecessor_id: predecessor.id } : {}) } });
    const generationRecovery = authoringReadCheckpoint(state.generation_recovery, completion, readScopeConsumption(q.read_scope!));
    await persist(buildBoundaryAuthoringResumeState({ ...input, previous: state, generationRecovery, read:{analysis_id:stored.analysis_id,analysis_digest:stored.analysis_digest,scope_question_id:q.id}, operatorQuestions: [...(state.operator_questions ?? []), q] }));
    return q;
  });
  const readSavedState = async () => {
    const loaded = await readBoundaryAuthoringResumeState(dir, nativeBinding);
    if (loaded.status !== "ready") throw new Error("The actual saved native fixture is unavailable");
    return loaded.value;
  };
  return { dir, input, prepared, destination, scopeDigest, contextDigest, nativeBinding, binding,inventory,analysis,
    state: () => state, readSavedState, persist, save, produce };
}


import { expect } from "vitest";
import { schemaFingerprintForInspection, rolePostureFingerprint } from "@synapsor-runner/schema-inspector";
import { ownerQuestionScopeDigest, ownerQuestionContextDigest } from "../authoring-owner-question-binding.js";
import { projectAuthoringReadScopeContext } from "../authoring-read-scope-context.js";
import { authoringDestination } from "../authoring-policy-source.js";
import { storeReadWorkloadAnalysis } from "../read-workloads.js";
import { createReadScopeHost } from "../authoring-read-scope-host.js";
import { withProjectAuthorityMutation } from "../project-authority-mutation.js";

export async function reviewNativeReadScopeActivationFixture(f: Awaited<ReturnType<typeof nativeReadScopeActivationFixture>>, accepted: boolean | null) {
  const q=await f.produce();
  const host=createReadScopeHost({access:{
    mutate:operation=>withProjectAuthorityMutation(f.dir,operation),
    load:async questionId=>{
      const disk=await readBoundaryAuthoringResumeState(f.dir,f.nativeBinding);
      if(disk.status!=="ready")throw new Error("Expected genuine native state");
      return {questions:disk.value.operator_questions!,handoffs:disk.value.owner_handoffs??[],generation:disk.value.generation_recovery,
        question_id:questionId,expectedBinding:f.binding,...f.inventory,analysis:f.analysis(),resume_revision_digest:disk.value.revision_digest,
        context_digest:f.contextDigest,scope_digest:f.scopeDigest};
    },
    save:async(next,{permit})=>{
      const loaded=await readBoundaryAuthoringResumeState(f.dir,f.nativeBinding);
      if(loaded.status!=="ready")throw new Error("Saved review is unavailable");
      const prior=loaded.value;
      const state=buildBoundaryAuthoringResumeState({...f.input,previous:prior,read:prior.read,operatorQuestions:prior.operator_questions!.map(q=>q.id===next.id?next:q)});
      await writeBoundaryAuthoringResumeState(f.dir,state,{expectedRevisionDigest:prior.revision_digest,permit});
      // Reload through the actual native owner; f's retained state is not used by assessment.
    },
  },interact:async view=>{
    expect(view.kind).toBe("readback");expect(view).toMatchObject({defaultValue:false});
    return {kind:"decision",binding:view.binding,accepted};
  }});
  await host.review(q.id);
}

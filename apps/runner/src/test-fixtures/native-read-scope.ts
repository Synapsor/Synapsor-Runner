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
export async function nativeFixture(noRead = false, withoutAnalysis = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owned-native-scope-"));
  await fs.chmod(dir,0o700);
  const prepared=await prepareReviewedReadScope(dir), {context}=prepared;
  const nativeBinding={boundary_name:context.candidate.pack.name,generation_lock_fingerprint:context.candidate.generation_lock_fingerprint,
    schema_fingerprint:context.lock.schema_fingerprint,role_posture_fingerprint:context.lock.role_posture_fingerprint};
  const input = { binding: nativeBinding, stage: "read_mapping" as const, jobIntent: noRead ? "Prepare the program without any customer data access" : "Show the signed-in person their item labels", provider: "openai" as const, model: "controlled" };
  let state = buildBoundaryAuthoringResumeState({ ...input, authoringProtocol: { version: "synapsor.structured-authoring.v2" } });
  const request={id:`job:${d({created_at:state.created_at,boundary_name:nativeBinding.boundary_name})}`,text:input.jobIntent};
  const catalog=readWorkloadCatalog(context.candidate);
  const subjects=projectReadSubjectContext({context,sourceDigest:d(null)});
  if(!subjects.subject_scopes.length)throw new Error("Actual structural review established no subjects");
  const projected=projectReadScopeHostContext({request,catalog:{digest:catalog.digest,resources:catalog.resources,
    relationships:catalog.resources.flatMap(resource=>resource.relationships.map(link=>({id:link.id,from:resource.id,to:link.target_resource}))),
    subject_scopes:subjects.subject_scopes},binding:{meaning_digest:d({protocol:READ_SCOPE_PROTOCOL,request,source:null}),
    applicability_digest:d({request,purpose:"original_read_task"}),operation_digest:d({binding:nativeBinding,candidate:explorationBoundaryCandidateDigest(context.candidate)})}});
  const {binding}=projected,inventory={references:projected.references,catalog:projected.catalog};
  const analysis=()=>structuredClone(prepared.analysis);
  const scopeDigest=d({request,purpose:"original_read_task"}),contextDigest=d(projected);
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
    const result = await runAskProviderTurn({ configuration: resolveAskProviderConfiguration({ provider: "openai", model: "controlled",
      api_key: "inert-local-credential", egress_acknowledged: true, authority_digest: askToolSurfaceDigest(tools) }, {}, new Date()),
      question: JSON.stringify({request:input.jobIntent,original_request:request.id,...inventory,declared_no_read:noRead}), history: [], tools, signal: new AbortController().signal, authorityDigest: askToolSurfaceDigest(tools),
      requiredInitialToolName: tools[0]!.name, completeAfterRequiredTool: true,
      gateway: { mode: "authoring", listTools: () => tools, close: async () => {}, callTool: async (_tool, args) => {
        submitted = resolveReadScopeProposal((args as { read_scope: unknown }).read_scope, { expectedBinding: binding,
          ...inventory, ...(noRead || withoutAnalysis ? {} : { analysis: analysis() }) });
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
    await persist(buildBoundaryAuthoringResumeState({ ...input, previous: state, generationRecovery, operatorQuestions: [...(state.operator_questions ?? []), q] }));
    return q;
  });
  return { dir, input, nativeBinding, binding,inventory,analysis, state: () => state, persist, save, produce };
}


import { STRUCTURED_AUTHORING_PROTOCOL_VERSION } from "../authoring-protocol.js";
import type { BoundaryResourceReviewRequest } from "../read-authoring-contract-types.js";
import type { ProjectAuthorityMutationPermit } from "../project-authority-mutation.js";
import { randomUUID } from "node:crypto";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { parseOperatorQuestion } from "../authoring-operator-question.js";
import { READ_SCOPE_PROTOCOL, resolveReadScopeProposal, readScopeProposalSchema, type ReadScopeRecord } from "../read-structured-scope.js";
import { READ_WORKLOAD_ANALYSIS_VERSION, type ReadWorkloadAnalysis } from "../read-workload-assist.js";

import { prepareReviewedReadScope } from "./reviewed-read-scope.js";
import { projectAuthoringReadScopeContext } from "../authoring-read-scope-context.js";

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
export async function nativeFixture(noRead = false, withoutAnalysis = false,
  declared?: { resource: string; field: string; request: string; review?: NonNullable<Parameters<typeof prepareReviewedReadScope>[1]>["review"] & Pick<BoundaryResourceReviewRequest, "metadata" | "field_metadata"> }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owned-native-scope-"));
  await fs.chmod(dir,0o700);
  const target = declared ?? { resource: "work.items", field: "label" };
  const prepared=await prepareReviewedReadScope(dir, { resources: [target.resource], field: target.field, review: { allow_reviewed_fields: [target.field], ...declared?.review } }), {context}=prepared;
  const nativeBinding={boundary_name:context.candidate.pack.name,generation_lock_fingerprint:context.candidate.generation_lock_fingerprint,
    schema_fingerprint:context.lock.schema_fingerprint,role_posture_fingerprint:context.lock.role_posture_fingerprint};
  const input = { binding: nativeBinding, stage: "read_mapping" as const, jobIntent: noRead ? "Prepare the program without any customer data access" : declared?.request ?? "Show the signed-in person their item labels", provider: "openai" as const, model: "controlled" };
  let state = buildBoundaryAuthoringResumeState({ ...input, authoringProtocol: { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION } });
  // Use the production context owner, including its protocol/job identities;
  // a manually hashed approximation would be stale at nativeScope.assess.
  const projected=projectAuthoringReadScopeContext({ resume: state, boundary: context.candidate,
    structuralReview: context, records: { questions: state.operator_questions ?? [], handoffs: state.owner_handoffs ?? [],
      generation: state.generation_recovery }, answerQuestionIds: [] });
  if(!projected.catalog.subject_scopes?.length)throw new Error("Actual structural review established no subjects");
  const request=projected.references.find(reference=>reference.kind==="request");
  if(!request)throw new Error("Actual native context lacks its request reference");
  const {binding}=projected,inventory={references:projected.references,catalog:projected.catalog};
  const analysis=()=>structuredClone(prepared.analysis);
  const scopeDigest=d({request,purpose:"original_read_task"}),contextDigest=d(projected);
  await writeBoundaryAuthoringResumeState(dir, state, { expectedRevisionDigest: null });
  const persist = async (next: BoundaryAuthoringResumeState, permit?: ProjectAuthorityMutationPermit) => {
    await writeBoundaryAuthoringResumeState(dir, next, { expectedRevisionDigest: state.revision_digest, permit }); state = next;
  };
  const save = async (q: ReturnType<typeof parseOperatorQuestion>, permit?: ProjectAuthorityMutationPermit) => persist(buildBoundaryAuthoringResumeState({ ...input, previous: state,
    operatorQuestions: state.operator_questions!.map(old => old.id === q.id ? q : old) }), permit);
  const produce = async (predecessor?: ReturnType<typeof parseOperatorQuestion>) => withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => state.generation_recovery, current: async () => contextDigest,
      progress: () => {}, write: generationRecovery => persist(buildBoundaryAuthoringResumeState({ ...input, previous: state, generationRecovery })) });
    let submitted: ReadScopeRecord | undefined;
    const tools: AskToolDefinition[] = [{ name: "runner.propose_scope", title: "Propose scope", description: "No authority.",
      input_schema: { type: "object", additionalProperties: false, properties: { read_scope: readScopeProposalSchema }, required: ["read_scope"] } }];
    const result = await runAskProviderTurn({ configuration: resolveAskProviderConfiguration({ provider: "openai", model: "controlled",
      api_key: "inert-local-credential", egress_acknowledged: true, authority_digest: askToolSurfaceDigest(tools) }, {}, new Date()),
      question: JSON.stringify({request:input.jobIntent,original_request:request.id,...inventory,declared_no_read:noRead,
        declared_target: { resource: target.resource, field: target.field } }), history: [], tools, signal: new AbortController().signal, authorityDigest: askToolSurfaceDigest(tools),
      requiredInitialToolName: tools[0]!.name, completeAfterRequiredTool: true,
      gateway: { mode: "authoring", listTools: () => tools, close: async () => {}, callTool: async (_tool, args) => {
        submitted = resolveReadScopeProposal((args as { read_scope: unknown }).read_scope, { expectedBinding: binding,
          ...inventory, ...(noRead || withoutAnalysis ? {} : { analysis: analysis() }) });
        return { ok: true, value: { proposed: true } };
      } },
      dependencies: { requestJson: async actual => {
        const find=(value:unknown):typeof inventory & {request:string;original_request:string;declared_no_read:boolean;
          declared_target:{resource:string;field:string}}|undefined=>{
          if(typeof value==="string") {
            // Runner prefixes its host-owned date notice. Parse only a complete
            // JSON line actually transmitted, never reconstruct hidden inputs.
            for(const line of value.split("\n"))try {const parsed=JSON.parse(line);if(parsed.request&&parsed.original_request&&parsed.catalog)return parsed;}catch{}
          }
          if(value&&typeof value==="object")for(const child of Object.values(value)){const found=find(child);if(found)return found;}
          return undefined;
        };
        const visible=find(actual.body);if(!visible)throw new Error("Actual provider request lacks the declared fixture inputs");
        const resource=visible.catalog.resources.find(resource=>resource.id===visible.declared_target.resource);
        const field=resource?.fields.find(field=>field.id===visible.declared_target.field);
        const subject=visible.catalog.subject_scopes?.find(scope=>scope.root_resource===resource?.id);
        if(!resource||!field||!subject)throw new Error("Actual provider catalog lacks the declared reviewed resource, field, or subject scope");
        const proposal={protocol:READ_SCOPE_PROTOCOL,original_request:visible.original_request,
          applicability:visible.declared_no_read?"no_read_requested":"read_requested",requirements:visible.declared_no_read?[]:[{
            id:"items",intended_use:visible.request,references:[visible.original_request],disposition:"include",
            subjects:[{root_resource:resource.id,mode:"reviewed_resource",scope_reference:subject.reference}],
            targets:[{root_resource:resource.id,resource:resource.id,operation:"resource"},{root_resource:resource.id,resource:resource.id,operation:"return",field:field.id}],
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
  return { dir, input, nativeBinding, binding,inventory,analysis, boundary: () => structuredClone(context.candidate),
    state: () => state, persist, save, produce, scopeDigest, contextDigest };
}

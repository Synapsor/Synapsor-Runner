import { randomUUID } from "node:crypto";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { parseOperatorQuestion } from "../authoring-operator-question.js";
import { READ_SCOPE_PROTOCOL, resolveReadScopeProposal, readScopeProposalSchema, type ReadScopeRecord } from "../read-structured-scope.js";
import { READ_WORKLOAD_ANALYSIS_VERSION, type ReadWorkloadAnalysis } from "../read-workload-assist.js";

const target = { root_resource: "work.items", resource: "work.items", operation: "resource" as const };
export const binding = { request_digest: d("Show items"), source_digest: d("policy"), catalog_digest: d("catalog"),
  meaning_digest: d("meaning"), applicability_digest: d("use"), operation_digest: d("candidate") };
export const inventory = { references: [{ id: "job", kind: "request" as const, digest: binding.request_digest, text: "Show items" }],
  catalog: { resources: [{ id: "work.items", fields: [] }], relationships: [] } };
export function analysis(): ReadWorkloadAnalysis {
  return { schema_version: READ_WORKLOAD_ANALYSIS_VERSION, workload_digest: d("workloads"), workload_name: "items",
    status: "ready", allowed: [], forbidden: [], authority_atoms: [{ id: d(target), ...target }],
    coverage: { allowed_supported: 1, allowed_total: 1, forbidden_denied: 0, forbidden_total: 0 },
    exposure: { generated_resources: 1, candidate_resources: 1, generated_fields: 0, candidate_return_fields: 0,
      candidate_operation_fields: 0, candidate_relationships: 0 }, blockers: [], authority_granted: false,
    source_query_executed: false, explore_budget_consumed: false, source_database_changed: false };
}
export function question(noRead = false, withoutAnalysis = false) {
  const record = resolveReadScopeProposal({ protocol: READ_SCOPE_PROTOCOL, original_request: "job", applicability: noRead ? "no_read_requested" : "read_requested", requirements: noRead ? [] : [
    { id: "items", intended_use: "Show items", references: ["job"], disposition: "include", targets: [target] },
  ] }, { expectedBinding: binding, references: [{ id: "job", kind: "request", digest: binding.request_digest, text: "Show items" }],
    catalog: { resources: [{ id: "work.items", fields: [] }], relationships: [] }, ...(noRead || withoutAnalysis ? {} : { analysis: analysis() }) });
  const body = { version: 2, id: randomUUID(), revision: 1, kind: "read_scope", scope_digest: d("job-scope"),
    context_digest: d("current"), target: { phase: "read_scope", outcomes: [] }, material: [], evidence: [], continuation: "read_mapping",
    read_scope: { mode: "review", record, completion: { operation_id: randomUUID(), request_digest: d("request"),
      context_digest: d("producer-context"), response_digest: d("response") } } };
  return { ...body, digest: d(body) };
}
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
  const nativeBinding = { boundary_name: "work", generation_lock_fingerprint: d("lock"), schema_fingerprint: d("schema"), role_posture_fingerprint: d("roles") };
  const input = { binding: nativeBinding, stage: "read_mapping" as const, jobIntent: "Show items", provider: "openai" as const, model: "controlled" };
  let state = buildBoundaryAuthoringResumeState({ ...input, authoringProtocol: { version: "synapsor.structured-authoring.v2" } });
  await writeBoundaryAuthoringResumeState(dir, state, { expectedRevisionDigest: null });
  const persist = async (next: BoundaryAuthoringResumeState) => {
    await writeBoundaryAuthoringResumeState(dir, next, { expectedRevisionDigest: state.revision_digest }); state = next;
  };
  const save = async (q: ReturnType<typeof parseOperatorQuestion>) => persist(buildBoundaryAuthoringResumeState({ ...input, previous: state,
    operatorQuestions: state.operator_questions!.map(old => old.id === q.id ? q : old) }));
  const produce = async (predecessor?: ReturnType<typeof parseOperatorQuestion>) => withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => state.generation_recovery, current: async () => d("current"),
      progress: () => {}, write: generationRecovery => persist(buildBoundaryAuthoringResumeState({ ...input, previous: state, generationRecovery })) });
    const raw = question(noRead, withoutAnalysis);
    let submitted: ReadScopeRecord | undefined;
    const tools: AskToolDefinition[] = [{ name: "runner.propose_scope", title: "Propose scope", description: "No authority.",
      input_schema: { type: "object", additionalProperties: false, properties: { read_scope: readScopeProposalSchema }, required: ["read_scope"] } }];
    const result = await runAskProviderTurn({ configuration: resolveAskProviderConfiguration({ provider: "openai", model: "controlled",
      api_key: "inert-local-credential", egress_acknowledged: true, authority_digest: askToolSurfaceDigest(tools) }, {}, new Date()),
      question: JSON.stringify({ request: "Show items", original_request: "job", references: raw.read_scope.record.references,
        catalog: { resources: [{ id: "work.items", fields: [] }], relationships: [] } }), history: [], tools, signal: new AbortController().signal, authorityDigest: askToolSurfaceDigest(tools),
      requiredInitialToolName: tools[0]!.name, completeAfterRequiredTool: true,
      gateway: { mode: "authoring", listTools: () => tools, close: async () => {}, callTool: async (_tool, args) => {
        submitted = resolveReadScopeProposal((args as { read_scope: unknown }).read_scope, { expectedBinding: binding,
          references: raw.read_scope.record.references, catalog: { resources: [{ id: "work.items", fields: [] }], relationships: [] }, ...(noRead || withoutAnalysis ? {} : { analysis: analysis() }) });
        return { ok: true, value: { proposed: true } };
      } },
      dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: randomUUID(),
        name: "runner__propose_scope", arguments: JSON.stringify({ read_scope: raw.read_scope.record.proposal }) }] } }) } });
    const completion = completedAuthoringQuestion(result); if (!completion) throw new Error("Missing actual completion");
    if (!submitted) throw new Error("Missing parsed actual submission");
    const q = createReadScopeQuestion({ id: raw.id, revision: predecessor ? predecessor.revision + 1 : 1,
      scope_digest: raw.scope_digest, context_digest: raw.context_digest,
      read_scope: { mode: "review", record: submitted, completion, ...(predecessor ? { predecessor_id: predecessor.id } : {}) } });
    const generationRecovery = authoringReadCheckpoint(state.generation_recovery, completion, readScopeConsumption(q.read_scope!));
    await persist(buildBoundaryAuthoringResumeState({ ...input, previous: state, generationRecovery, operatorQuestions: [...(state.operator_questions ?? []), q] }));
    return q;
  });
  return { dir, input, nativeBinding, state: () => state, persist, save, produce };
}


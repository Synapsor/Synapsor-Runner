import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { parseOperatorQuestion, proposeOperatorAnswer } from "./authoring-operator-question.js";
import { READ_SCOPE_PROTOCOL, resolveReadScopeProposal, readScopeProposalSchema, type ReadScopeRecord } from "./read-structured-scope.js";
import { READ_WORKLOAD_ANALYSIS_VERSION, type ReadWorkloadAnalysis } from "./read-workload-assist.js";

const target = { root_resource: "work.items", resource: "work.items", operation: "resource" as const };
const binding = { request_digest: d("Show items"), source_digest: d("policy"), catalog_digest: d("catalog"),
  meaning_digest: d("meaning"), applicability_digest: d("use"), operation_digest: d("candidate") };
const inventory = { references: [{ id: "job", kind: "request" as const, digest: binding.request_digest, text: "Show items" }],
  catalog: { resources: [{ id: "work.items", fields: [] }], relationships: [] } };
function analysis(): ReadWorkloadAnalysis {
  return { schema_version: READ_WORKLOAD_ANALYSIS_VERSION, workload_digest: d("workloads"), workload_name: "items",
    status: "ready", allowed: [], forbidden: [], authority_atoms: [{ id: d(target), ...target }],
    coverage: { allowed_supported: 1, allowed_total: 1, forbidden_denied: 0, forbidden_total: 0 },
    exposure: { generated_resources: 1, candidate_resources: 1, generated_fields: 0, candidate_return_fields: 0,
      candidate_operation_fields: 0, candidate_relationships: 0 }, blockers: [], authority_granted: false,
    source_query_executed: false, explore_budget_consumed: false, source_database_changed: false };
}
function question(noRead = false) {
  const record = resolveReadScopeProposal({ protocol: READ_SCOPE_PROTOCOL, original_request: "job", applicability: noRead ? "no_read_requested" : "read_requested", requirements: noRead ? [] : [
    { id: "items", intended_use: "Show items", references: ["job"], disposition: "include", targets: [target] },
  ] }, { expectedBinding: binding, references: [{ id: "job", kind: "request", digest: binding.request_digest, text: "Show items" }],
    catalog: { resources: [{ id: "work.items", fields: [] }], relationships: [] }, ...(noRead ? {} : { analysis: analysis() }) });
  const body = { version: 2, id: randomUUID(), revision: 1, kind: "read_scope", scope_digest: d("job-scope"),
    context_digest: d("current"), target: { phase: "read_scope", outcomes: [] }, material: [], evidence: [], continuation: "read_mapping",
    read_scope: { mode: "review", record, completion: { operation_id: randomUUID(), request_digest: d("request"),
      context_digest: d("producer-context"), response_digest: d("response") } } };
  return { ...body, digest: d(body) };
}
describe("B64 native scope question", () => {
  it("records explicit no-Read review without fabricating an analyzed workload", () => {
    const original = question();
    const record = resolveReadScopeProposal({ protocol: READ_SCOPE_PROTOCOL, applicability: "no_read_requested", original_request: "job", requirements: [] },
      { expectedBinding: binding, references: original.read_scope.record.references, catalog: { resources: [], relationships: [] } });
    const { digest: _, ...body } = original;
    const qbody = { ...body, read_scope: { ...body.read_scope, record } };
    const q = parseOperatorQuestion({ ...qbody, digest: d(qbody) });
    const review = proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision, source_reference: d(q.read_scope),
      disposition: "proposed", value: { kind: "read_scope", scope_digest: record.digest } });
    expect(review.read_scope!.record.analysis_digest).toBeUndefined(); expect(review.confirmation).toBeUndefined();
  });
  it("retains a typed proposal in the existing question owner without inventing raw testimony", () => {
    const q = parseOperatorQuestion(question());
    expect(q.version).toBe(2); expect(q.raw_answer).toBeUndefined(); expect(q.confirmation).toBeUndefined();
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadScopeQuestion, proposeReadScopeReview, confirmReadScopeReview, resolveNativeReadScope } from "./authoring-read-scope-question.js";
import { readScopeConsumption } from "./authoring-read-scope-binding.js";
import { captureOperatorAnswer, presentOperatorQuestion, leaveOperatorQuestionPending, parseOperatorQuestions } from "./authoring-operator-question.js";
import { authoringReadCheckpoint, configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery } from "./authoring-generation-recovery.js";
import { completedAuthoringQuestion, askToolSurfaceDigest, resolveAskProviderConfiguration, runAskProviderTurn, type AskToolDefinition } from "./model-ask.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, type BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";

// Actual controlled provider -> native generation consumption -> Resume CAS.
// This is not an OS/public CLI restart; reconstruction below uses disk records.
async function nativeFixture(noRead = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owned-native-scope-"));
  const nativeBinding = { boundary_name: "work", generation_lock_fingerprint: d("lock"), schema_fingerprint: d("schema"), role_posture_fingerprint: d("roles") };
  const input = { binding: nativeBinding, stage: "read_mapping" as const, jobIntent: "Show items", provider: "openai" as const, model: "controlled" };
  let state = buildBoundaryAuthoringResumeState({ ...input, authoringProtocol: { version: "synapsor.structured-authoring.v1" } });
  await writeBoundaryAuthoringResumeState(dir, state, { expectedRevisionDigest: null });
  const persist = async (next: BoundaryAuthoringResumeState) => {
    await writeBoundaryAuthoringResumeState(dir, next, { expectedRevisionDigest: state.revision_digest }); state = next;
  };
  const save = async (q: ReturnType<typeof parseOperatorQuestion>) => persist(buildBoundaryAuthoringResumeState({ ...input, previous: state,
    operatorQuestions: state.operator_questions!.map(old => old.id === q.id ? q : old) }));
  const produce = async (predecessor?: ReturnType<typeof parseOperatorQuestion>) => withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => state.generation_recovery, current: async () => d("current"),
      progress: () => {}, write: generationRecovery => persist(buildBoundaryAuthoringResumeState({ ...input, previous: state, generationRecovery })) });
    const raw = question(noRead);
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
          references: raw.read_scope.record.references, catalog: { resources: [{ id: "work.items", fields: [] }], relationships: [] }, ...(noRead ? {} : { analysis: analysis() }) });
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

describe("B64 scope native persistence and reconstruction", () => {
  it("reviews an explicit no-Read interpretation without fabricating a workload analysis", async () => {
    const f = await nativeFixture(true);
    try {
      const q = await f.produce();
      expect(() => proposeReadScopeReview(q, binding, analysis(), inventory)).toThrow("READ_SCOPE_REVIEW_STALE");
      const proposal = proposeReadScopeReview(q, binding, undefined, inventory);
      const accepted = confirmReadScopeReview(proposal, binding, undefined, proposal.digest, inventory); await f.save(accepted);
      const scope = resolveNativeReadScope({ questions: f.state().operator_questions!, handoffs: [], generation: f.state().generation_recovery,
        question_id: q.id, expectedBinding: binding, ...inventory });
      expect(scope.status).toBe("confirmed"); expect(scope.record.analysis_digest).toBeUndefined();
      expect(scope.record.proposal.requirements).toEqual([]); expect(scope.authority_granted).toBe(false);
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
  it("requires the current host reference contents even when a copied digest is unchanged", async () => {
    const f = await nativeFixture();
    try {
      const q = await f.produce(), proposal = proposeReadScopeReview(q, binding, analysis(), inventory);
      const accepted = confirmReadScopeReview(proposal, binding, analysis(), proposal.digest, inventory); await f.save(accepted);
      const changed = { ...inventory, references: inventory.references.map(ref => ({ ...ref, text: "Do not show items" })) };
      expect(() => proposeReadScopeReview(q, binding, analysis(), changed)).toThrow("READ_SCOPE_PROVENANCE_STALE");
      expect(resolveNativeReadScope({ questions: f.state().operator_questions!, handoffs: [], generation: f.state().generation_recovery,
        question_id: q.id, expectedBinding: binding, ...changed, analysis: analysis() }).status).toBe("stale");
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
  it("saves only the explicit complete review and reconstructs it without a live provider registry", async () => {
    const f = await nativeFixture();
    try {
      const q = await f.produce();
      expect(() => captureOperatorAnswer(presentOperatorQuestion(q, "Review scope"), "yes")).toThrow();
      const proposal = proposeReadScopeReview(q, binding, analysis(), inventory); await f.save(proposal);
      expect(proposal.confirmation).toBeUndefined();
      const accepted = confirmReadScopeReview(proposal, binding, analysis(), proposal.digest, inventory); await f.save(accepted);
      const reopened = await readBoundaryAuthoringResumeState(f.dir, f.nativeBinding);
      expect(reopened.status).toBe("ready");
      if (reopened.status !== "ready") throw new Error("Native record unavailable");
      const scope = resolveNativeReadScope({ questions: reopened.value.operator_questions!, handoffs: [],
        generation: reopened.value.generation_recovery, question_id: q.id, expectedBinding: binding, ...inventory, analysis: analysis() });
      expect(scope.status).toBe("confirmed"); expect(scope.authority_granted).toBe(false);
      expect(scope.question.raw_answer).toBeUndefined(); expect(scope.question.handoff_id).toBeUndefined();
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
  it("checks exact current analysis, displayed revision and saved producer association", async () => {
    const f = await nativeFixture();
    try {
      const q = await f.produce(), proposal = proposeReadScopeReview(q, binding, analysis(), inventory);
      expect(() => confirmReadScopeReview(proposal, binding, { ...analysis(), workload_digest: d("changed") }, proposal.digest, inventory)).toThrow("READ_SCOPE_REVIEW_STALE");
      expect(() => confirmReadScopeReview(proposal, binding, analysis(), q.digest, inventory)).toThrow("READ_SCOPE_REVIEW_STALE");
      expect(() => parseOperatorQuestions([q], [])).toThrow("no exact committed native result");
      const accepted = confirmReadScopeReview(proposal, binding, analysis(), proposal.digest, inventory); await f.save(accepted);
      expect(resolveNativeReadScope({ questions: f.state().operator_questions!, handoffs: [], generation: f.state().generation_recovery,
        question_id: q.id, expectedBinding: binding, ...inventory, analysis: { ...analysis(), workload_digest: d("changed") } }).status).toBe("stale");
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
  it("a cancelled replacement never resurrects the earlier confirmed scope", async () => {
    const f = await nativeFixture();
    try {
      const q = await f.produce(), proposal = proposeReadScopeReview(q, binding, analysis(), inventory);
      const accepted = confirmReadScopeReview(proposal, binding, analysis(), proposal.digest, inventory); await f.save(accepted);
      const replacement = await f.produce(accepted); await f.save(leaveOperatorQuestionPending(replacement, "cancelled"));
      const scope = resolveNativeReadScope({ questions: f.state().operator_questions!, handoffs: [], generation: f.state().generation_recovery,
        question_id: q.id, expectedBinding: binding, ...inventory, analysis: analysis() });
      expect(scope.status).toBe("pending"); expect(scope.question.id).toBe(replacement.id);
      expect(f.state().operator_questions![0]!.confirmation).toEqual(accepted.confirmation);
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
});

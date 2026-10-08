import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { parseOperatorQuestion, proposeOperatorAnswer, captureOperatorAnswer, presentOperatorQuestion, leaveOperatorQuestionPending, parseOperatorQuestions } from "./authoring-operator-question.js";
import { READ_SCOPE_PROTOCOL, resolveReadScopeProposal } from "./read-structured-scope.js";
import { proposeReadScopeReview, confirmReadScopeReview, resolveNativeReadScope } from "./authoring-read-scope-question.js";
import { readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";

describe("B64 native scope question", () => {
  it("records explicit no-Read review without fabricating an analyzed workload", async () => {
    const f=await nativeFixture(true);
    try { const q=await f.produce(),record=q.read_scope!.record;
      const review=proposeOperatorAnswer(q,{question_id:q.id,revision:q.revision,source_reference:d(q.read_scope),disposition:"proposed",value:{kind:"read_scope",scope_digest:record.digest}});
      expect(review.read_scope!.record.analysis_digest).toBeUndefined();expect(review.confirmation).toBeUndefined();
    }finally{await fs.rm(f.dir,{recursive:true,force:true});}
  });
  it("retains a typed proposal in the existing question owner without inventing raw testimony", async () => {
    const f=await nativeFixture();try { const q=parseOperatorQuestion(await f.produce());
      expect(q.version).toBe(2);expect(q.raw_answer).toBeUndefined();expect(q.confirmation).toBeUndefined();
    }finally{await fs.rm(f.dir,{recursive:true,force:true});}
  });
});

describe("B64 scope native persistence and reconstruction", () => {
  it("keeps a genuine not-yet-mapped proposal pending instead of calling absent analysis stale", async () => {
    const f = await nativeFixture(false, true);
    const {binding,inventory,analysis}=f;
    try {
      const q = await f.produce();
      for (const actual of [undefined, analysis()]) {
        const resolved = resolveNativeReadScope({ questions: f.state().operator_questions!, handoffs: [], generation: f.state().generation_recovery,
          question_id: q.id, expectedBinding: binding, ...inventory, ...(actual ? { analysis: actual } : {}) });
        expect(resolved.status).toBe("pending"); expect(resolved.question.confirmation).toBeUndefined();
      }
      expect(() => proposeReadScopeReview(q, binding, analysis(), inventory)).toThrow("READ_SCOPE_REVIEW_STALE");
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
  it("reviews an explicit no-Read interpretation without fabricating a workload analysis", async () => {
    const f = await nativeFixture(true);
    const {binding,inventory,analysis}=f;
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
    const {binding,inventory,analysis}=f;
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
    const {binding,inventory,analysis}=f;
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
    const {binding,inventory,analysis}=f;
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
    const {binding,inventory,analysis}=f;
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

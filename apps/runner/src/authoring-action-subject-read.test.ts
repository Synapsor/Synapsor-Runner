import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import { canonicalJsonDigest as hash } from "@synapsor-runner/protocol";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";
import { proposeReadScopeReview, confirmReadScopeReview } from "./authoring-read-scope-question.js";
import { leaveOperatorQuestionPending } from "./authoring-operator-question.js";
import { actionSubjectOptionFromRead, resolveActionReadSubject } from "./authoring-action-subject-read.js";

describe("Action public subject reuses the actual current Read owner", () => {
  it("inherits the exact reviewed public subject and rejects effects, unknown roots and changed dependencies", async () => {
    const f = await nativeFixture();
    try {
      const q = await f.produce(), proposed = proposeReadScopeReview(q, f.binding, f.analysis(), f.inventory);
      const confirmed = confirmReadScopeReview(proposed, f.binding, f.analysis(), proposed.digest, f.inventory); await f.save(confirmed);
      const target = { kind: "verification_subject" as const, resource: "work.items", binding: "item" };
      const scope = f.inventory.catalog.subject_scopes!.find(s => s.root_resource === target.resource)!;
      const option = actionSubjectOptionFromRead(target, scope)!;
      const read = { questions: f.state().operator_questions!, handoffs: [], generation: f.state().generation_recovery,
        question_id: q.id, expectedBinding: f.binding, ...f.inventory, analysis: f.analysis() };
      const entry = resolveActionReadSubject({ target, options: [option], read });
      expect(entry).toMatchObject({ state: "proposed", target_digest: hash(target), scope_reference: option.reference,
        support: { kind: "read_subject", question_id: q.id, question_digest: confirmed.digest, scope_record_digest: confirmed.read_scope!.record.digest, requirement_id: "items" } });
      expect(actionSubjectOptionFromRead({ kind: "primary_effect", resource: target.resource }, scope)).toBeUndefined();
      expect(resolveActionReadSubject({ target: { kind: "primary_effect", resource: target.resource }, options: [option], read })).toBeUndefined();
      expect(resolveActionReadSubject({ target: { ...target, resource: "work.private" }, options: [option], read })).toBeUndefined();
      expect(resolveActionReadSubject({ target, options: [{ ...option, dependencies_digest: hash("changed") }], read })).toBeUndefined();
      expect(resolveActionReadSubject({ target, options: [option], read: { ...read, expectedBinding: { ...read.expectedBinding, request_digest: hash("another-job") } } })).toBeUndefined();
      expect(resolveActionReadSubject({ target, options: [option], read: { ...read, analysis: { ...read.analysis, workload_digest: hash("changed") } } })).toBeUndefined();
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
  it("keeps an unconfirmed or cancelled replacement pending instead of resurrecting the previous Yes", async () => {
    const f = await nativeFixture();
    try {
      const q = await f.produce(), target = { kind: "verification_subject" as const, resource: "work.items", binding: "item" };
      const option = actionSubjectOptionFromRead(target, f.inventory.catalog.subject_scopes![0]!)!;
      const read = () => ({ questions: f.state().operator_questions!, handoffs: [], generation: f.state().generation_recovery,
        question_id: q.id, expectedBinding: f.binding, ...f.inventory, analysis: f.analysis() });
      expect(resolveActionReadSubject({ target, options: [option], read: read() })).toBeUndefined();
      const proposal = proposeReadScopeReview(q, f.binding, f.analysis(), f.inventory);
      await f.save(confirmReadScopeReview(proposal, f.binding, f.analysis(), proposal.digest, f.inventory));
      expect(resolveActionReadSubject({ target, options: [option], read: read() })).toBeDefined();
      const replacement = await f.produce(f.state().operator_questions![0]);
      await f.save(leaveOperatorQuestionPending(replacement, "cancelled"));
      expect(resolveActionReadSubject({ target, options: [option], read: read() })).toBeUndefined();
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
});

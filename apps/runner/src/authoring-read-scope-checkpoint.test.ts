import { describe, expect, it } from "vitest";
import { projectReadScopeCheckpointSave } from "./authoring-read-scope-checkpoint.js";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";

describe("native Read checkpoint adapter projection", () => {
  const read = { analysis_id: "rw_original", analysis_digest: digest("saved analysis"), scope_question_id: "old_scope" };
  it("selects the exact successor without dropping unrelated pending work", () => {
    const pendingRevision = { instruction: "Keep a count", provenance: "operator_instruction" as const, privacy_only: false,
      result_received: false };
    const next = projectReadScopeCheckpointSave({ questions: [], read, pendingRevision, pendingRequest: "Keep a count" },
      { questions: [], read: { ...read, scope_question_id: "validated_successor" }, stage: "read_mapping",
        acknowledgeCompletedTurn: false, subject: "Exact successor" });
    expect(next.read).toEqual({ ...read, scope_question_id: "validated_successor" });
    expect(next.pendingRevision).toEqual(pendingRevision); expect(next.pendingRequest).toBe("Keep a count");
  });
  it("clears only the exact completed pending revision and refuses a different one", () => {
    const pendingRevision = { instruction: "Keep a count", provenance: "operator_instruction" as const, privacy_only: false,
      result_received: true, scope_question_id: "consumed_scope" };
    const current = { questions: [], read, pendingRevision, pendingRequest: pendingRevision.instruction };
    const request = { questions: [], read: { ...read, scope_question_id: "new_analyzed_scope" },
      completedReadRevision: { question_id: "consumed_scope" }, stage: "read_mapping" as const,
      acknowledgeCompletedTurn: false, subject: "Exact analyzed revision" };
    expect(projectReadScopeCheckpointSave(current, request)).toEqual({ questions: [], read: request.read });
    expect(() => projectReadScopeCheckpointSave(current, { ...request, completedReadRevision: { question_id: "other_scope" } }))
      .toThrow("READ_SCOPE_REVIEW_CHANGED");
    expect(current.pendingRevision).toEqual(pendingRevision);
  });
});

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createOperatorQuestion, presentOperatorQuestion } from "./authoring-operator-question.js";
import { assertVersionInteractionResponse, versionInteractionBinding,
  type VersionInteraction, type VersionInteractionResponse } from "./authoring-version-interaction.js";

function view(): VersionInteraction {
  const q = presentOperatorQuestion(createOperatorQuestion({ id: randomUUID(), revision: 1,
    handoff_id: "counter-handoff", kind: "writer_maintenance", scope_digest: canonicalJsonDigest("one current Action"),
    context_digest: canonicalJsonDigest("current inspected Source and baseline"),
    target: { phase: "changed_record_protection", resource: "dispatch.parcels", field: "revision", outcomes: ["dispatch.hold"] },
    material: ["This records an unverified owner statement, not execution permission."],
    evidence: [{ id: "version-structure", digest: canonicalJsonDigest("current integer counter proof") }],
    continuation: "version_mapping" }), "Does every application advance this record counter on each update?");
  return { kind: "question", binding: versionInteractionBinding({ turn_id: "owning-action-turn", root_question_id: q.id,
    question_id: q.id, handoff_id: q.handoff_id!, resource: q.target.resource!, field: q.target.field!,
    proof_digest: q.evidence[0]!.digest }, q), text: q.presentation!.text, material: q.material,
    preserveWhitespace: true, recordPolicyAnswer: false };
}

describe("Version view responses preserve the exact Action question binding", () => {
  it.each([null, " \t ", "I'm not sure", "  Every writer advances it. 😀\t "])("accepts only the exact raw words or cancellation: %j", raw => {
    const v = view();
    const response: VersionInteractionResponse = { kind: "answer", binding: v.binding, raw };
    expect(() => assertVersionInteractionResponse(v, response)).not.toThrow();
    expect(response.raw).toBe(raw);
  });
  it.each(["turn_id", "root_question_id", "question_id", "question_revision", "question_digest",
    "pending_version_digest", "context_digest", "scope_digest"] as const)("refuses a different %s", key => {
    const v = view(), binding = { ...v.binding, [key]: key === "question_revision" ? 2 : "changed" };
    expect(() => assertVersionInteractionResponse(v, { kind: "answer", binding, raw: "Yes" }))
      .toThrow(expect.objectContaining({ code: "ACTION_VERSION_QUESTION_STALE" }));
  });
  it("refuses a decision substituted for raw words", () => {
    const v = view();
    expect(() => assertVersionInteractionResponse(v, { kind: "decision", binding: v.binding, accepted: true }))
      .toThrow(expect.objectContaining({ code: "ACTION_VERSION_QUESTION_STALE" }));
  });
  it("binds a readback to its proposal and refuses a late decision", () => {
    const v = view(), binding = { ...v.binding, proposal_digest: canonicalJsonDigest("exact proposed maintenance statement") };
    const readback: VersionInteraction = { kind: "readback", binding, defaultValue: false, lines: ["Exact unverified owner statement"] };
    expect(() => assertVersionInteractionResponse(readback, { kind: "decision", binding, accepted: false })).not.toThrow();
    expect(() => assertVersionInteractionResponse(readback, { kind: "decision",
      binding: { ...binding, proposal_digest: canonicalJsonDigest("another statement") }, accepted: true }))
      .toThrow(expect.objectContaining({ code: "ACTION_VERSION_QUESTION_STALE" }));
  });
  it("keeps pending by default and cannot turn a blocked view into an answer", () => {
    const v = view(), pending: VersionInteraction = { kind: "pending", binding: v.binding,
      canAnswer: false, hasRawAnswer: false, defaultValue: "keep", material: [] };
    expect(() => assertVersionInteractionResponse(pending, { kind: "pending", binding: v.binding, choice: "keep" })).not.toThrow();
    expect(() => assertVersionInteractionResponse(pending, { kind: "pending", binding: v.binding, choice: "answer" }))
      .toThrow(expect.objectContaining({ code: "ACTION_VERSION_QUESTION_STALE" }));
  });
});

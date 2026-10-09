import { describe, expect, it } from "vitest";
import { ownerQuestionScopeDigest, ownerQuestionContextDigest, type AuthoringOwnerQuestionScopeInput, type AuthoringOwnerQuestionContextInput } from "./authoring-owner-question-binding.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";

// Exact pre-extraction projection from boundary-commands.ts at 3eb73a42.
// These are hash-characterization fixtures, not native review/authority fixtures.
function originalScope(input: any) {
  return canonicalJsonDigest({ job: (input.canonicalJob ?? input.job)?.trim(),
    request: input.pendingJobRevision ?? null, read_revision: input.pendingReadRevision ?? null,
    read_revision_request: input.readRevision ? { instruction: input.readRevision.instruction,
      provenance: input.readRevision.provenance, privacy_only: input.readRevision.privacy_only,
      vocabulary_only: input.readRevision.vocabulary_only ?? null,
      interpretation_instruction: input.readRevision.interpretation_instruction ?? null } : null,
    model: input.model && { provider: input.model.provider, model: input.model.model, destination: input.model.destination } });
}
function originalContext(input: any) {
  return canonicalJsonDigest({ scope: input.scope, binding: input.binding,
    candidate: input.candidate, source: input.sources?.snapshots.length ? input.sourceContext ?? input.sources : null,
    reader_schema: input.readerSchema, reader_role: input.readerRole,
    ...(input.inputActions ? { input_actions: input.inputActions } : {}),
    ...(input.policy ? { policy: input.policy } : {}) });
}
const model = { provider: "openai", model: "declared-model", destination: "openai[declared-model] at https://api.openai.com/v1" };
const scopeCases = [
  { job: "" }, { job: "  Read declared records.  " },
  { job: "new prose", canonicalJob: "  original job  ", pendingJobRevision: "change one rule" },
  { job: "Read records", pendingReadRevision: "change display label", readRevision: {
    instruction: "change display label", provenance: "operator", privacy_only: false } },
  { job: "Read records", pendingReadRevision: "review fields", readRevision: {
    instruction: "review fields", provenance: "guided", privacy_only: true, vocabulary_only: true,
    interpretation_instruction: "retain the declared use" }, model: {
      provider: "openai_compatible", model: "declared-model", destination: "openai_compatible[declared-model] at http://localhost:9999/v1" } },
].map(item => ({ model, ...item }));
const digest = canonicalJsonDigest("declared identity");
const contextBase = { scope: originalScope(scopeCases[1]), binding: {
  boundary_name: "declared", generation_lock_fingerprint: digest, schema_fingerprint: digest,
  role_posture_fingerprint: digest }, candidate: { schema_version: "synapsor.exploration-boundary.v2", declared: "entire candidate" },
  readerSchema: digest, readerRole: digest };
const source = { id: "declared-source", snapshots: [{ text: "declared policy", digest }], approvals: [] };
const contextCases = [contextBase, { ...contextBase, sources: { ...source, snapshots: [] } },
  { ...contextBase, sources: source }, { ...contextBase, sources: source, sourceContext: { ...source, operator_messages: ["exact testimony"] } },
  { ...contextBase, inputActions: { projectRoot: "/declared/project", drafts: { change: "exact draft" }, active: null } },
  { ...contextBase, policy: { authority: { projectRoot: "/declared/project", drafts: {}, active: "exact active" }, action_schema: digest, action_role: digest } },
];
describe("existing authoring owner question binding characterization", () => {
  it("refuses absent model rather than fabricating an identity", () => {
    expect(() => originalScope({ job: "Read" })).toThrow("undefined");
  });
  it("preserves original job trimming and canonical-job precedence only", () => {
    expect(originalScope({ model, job: " original job " })).toBe(originalScope({ model, job: "ignored", canonicalJob: "original job" }));
    expect(originalScope({ model, job: "Original job" })).not.toBe(originalScope({ model, job: "original job" }));
    expect(originalScope({ model, job: "a  b" })).not.toBe(originalScope({ model, job: "a b" }));
  });
  it("does not treat empty Source sessions as attached Source context", () => {
    expect(originalContext(contextCases[0])).toBe(originalContext(contextCases[1]));
    expect(originalContext(contextCases[2])).not.toBe(originalContext(contextCases[0]));
  });
  it("distinguishes pending edits, interpretation and resolved destination", () => {
    const base = scopeCases[4]!;
    expect(originalScope(base)).not.toBe(originalScope({ ...base, pendingReadRevision: "another edit" }));
    expect(originalScope(base)).not.toBe(originalScope({ ...base, model: { ...base.model, destination: "another exact endpoint" } }));
    expect(originalScope(base)).not.toBe(originalScope({ ...base, readRevision: { ...base.readRevision, interpretation_instruction: "another interpretation" } }));
  });
});

// Incomplete payloads here deliberately test only byte-identical projection;
// real native record validation remains with the protected caller/owners.
describe("shared owner projection parity", () => {
  it.each(scopeCases.map((input, i) => [i, input] as const))("preserves scope case %s", (_i, input) => {
    expect(ownerQuestionScopeDigest(input as AuthoringOwnerQuestionScopeInput)).toBe(originalScope(input));
  });
  it.each(contextCases.map((input, i) => [i, input] as const))("preserves context case %s", (_i, input) => {
    expect(ownerQuestionContextDigest(input as unknown as AuthoringOwnerQuestionContextInput)).toBe(originalContext(input));
  });
  it("retains missing job/model refusal and never mutates input", () => {
    expect(() => ownerQuestionScopeDigest({ job: "Read" })).toThrow("undefined");
    expect(() => ownerQuestionScopeDigest({ model })).toThrow("undefined");
    const input = structuredClone(scopeCases[4]) as AuthoringOwnerQuestionScopeInput;
    const before = structuredClone(input);
    ownerQuestionScopeDigest(input);
    expect(input).toEqual(before);
  });
  it("distinguishes every existing scope dependency", () => {
    const input = scopeCases[4] as AuthoringOwnerQuestionScopeInput;
    const original = ownerQuestionScopeDigest(input);
    for (const delta of [ { job: "different job" }, { pendingJobRevision: "new edit" },
      { pendingReadRevision: "new read edit" },
      ...["instruction", "provenance", "privacy_only", "vocabulary_only", "interpretation_instruction"].map(key => ({
        readRevision: { ...input.readRevision, [key]: key === "privacy_only" ? false : key === "vocabulary_only" ? undefined : "changed" } })),
      ...["provider", "model", "destination"].map(key => ({ model: { ...input.model, [key]: "changed" } })) ]) {
      expect(ownerQuestionScopeDigest({ ...input, ...delta } as AuthoringOwnerQuestionScopeInput)).not.toBe(original);
    }
  });
  it("distinguishes current candidate, structural binding, Source, reader and program posture", () => {
    const input = { ...contextCases[5], sources: source } as unknown as AuthoringOwnerQuestionContextInput;
    const original = ownerQuestionContextDigest(input);
    for (const delta of [ { scope: canonicalJsonDigest("other scope") },
      { binding: { ...input.binding, boundary_name: "other" } },
      { candidate: { ...input.candidate, description: "other candidate" } },
      { sources: { ...input.sources, operator_messages: ["changed declaration"] } },
      { readerSchema: "changed schema" }, { readerRole: "changed role" },
      { inputActions: { projectRoot: "/other", drafts: {}, active: null } },
      { policy: { ...input.policy, action_schema: "changed action schema" } },
      { policy: { ...input.policy, action_role: "changed action role" } },
      { policy: { ...input.policy, authority: { projectRoot: "/other", drafts: {}, active: null } } } ]) {
      expect(ownerQuestionContextDigest({ ...input, ...delta } as AuthoringOwnerQuestionContextInput)).not.toBe(original);
    }
    expect(input).toEqual({ ...contextCases[5], sources: source });
  });
});

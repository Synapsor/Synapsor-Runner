import { describe, expect, it } from "vitest";
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
    const base = scopeCases[4];
    expect(originalScope(base)).not.toBe(originalScope({ ...base, pendingReadRevision: "another edit" }));
    expect(originalScope(base)).not.toBe(originalScope({ ...base, model: { ...base.model, destination: "another exact endpoint" } }));
    expect(originalScope(base)).not.toBe(originalScope({ ...base, readRevision: { ...base.readRevision, interpretation_instruction: "another interpretation" } }));
  });
});

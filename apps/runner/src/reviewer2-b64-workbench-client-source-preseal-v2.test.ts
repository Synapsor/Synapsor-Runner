import vm from "node:vm";
import { expect, it, vi } from "vitest";
import { renderBoundaryWorkbench } from "./boundary-workbench.js";

// SOURCE-ONLY / NOTRUN preseal. These exercise existing rendered functions,
// not native persistence. ACK objects are explicit transport injections.
// Future typed-selection producer controls remain separately declared in JSON.
const bindingA = { repository_id: "repository", deployment_id: "deployment", project_id: "project", epoch: 7, revision_id: "displayed-A" };
const bindingB = { ...bindingA, epoch: 8, revision_id: "different-B" };
const ref = { kind: "deployment_profile", id: "host-id-A", input_digest: `sha256:${"a".repeat(64)}` };
const candidateA = { pack: { name: "displayed-A", resources: [] }, unresolved_decisions: [] };
const submission = { schema_version: "synapsor.boundary-review-submission.v1", candidate_digest: `sha256:${"b".repeat(64)}`, decisions: [ref] };
function script() { return renderBoundaryWorkbench("independent-csrf").match(/<script>([\s\S]*?)<\/script>/)![1]!; }
function postHarness() {
  const code = script(); const start = code.indexOf("const post=async"); const end = code.indexOf("const currentResource=", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  let response: { ok: boolean; payload: Record<string, unknown> } = { ok: true, payload: { ok: true } };
  const context = vm.createContext({ structuredClone, initial: bindingA,
    fetch: async (url: string, input: { body: string }) => { sent.push({ url, body: JSON.parse(input.body) }); return response; } });
  const api = vm.runInContext(`let authoringBinding=structuredClone(initial); const csrf="independent-csrf";
    const readPayload=async result=>result.payload; const handleSessionFailure=()=>false;
    ${code.slice(start, end)}
    ({post,binding:()=>authoringBinding,replaceBinding:value=>{authoringBinding=structuredClone(value)}});`, context) as {
      post(url: string, body: unknown): Promise<unknown>; binding(): unknown; replaceBinding(value: unknown): void;
    };
  return { api, sent, response: (next: typeof response) => { response = next; } };
}
it("WBCI01 exact caller-captured CAS binding cannot be replaced by a different browser view at send time", async () => {
  const h = postHarness(); const body = { candidate: candidateA, review_submission: submission, expected_revision: 4,
    authoring_binding: bindingA, actor: "displayed operator A" };
  h.api.replaceBinding(bindingB); await h.api.post("/api/boundary/progress", body);
  expect(h.sent).toEqual([{ url: "/api/boundary/progress", body }]);
});
it("WBCI02 transport preserves an explicitly empty typed submission without manufacturing Yes from prose", async () => {
  const h = postHarness(); const body = { candidate: { ...candidateA, unresolved_decisions: ["deployment profile: staging"] },
    review_submission: { ...submission, decisions: [] }, expected_revision: 4, authoring_binding: bindingA, actor: "operator" };
  await h.api.post("/api/boundary/progress", body);
  expect(h.sent[0]!.body).toEqual(body);expect(h.sent[0]!.body).not.toHaveProperty("confirmed_decisions");
});
it("WBCI03 a failed CAS response cannot acknowledge its supplied replacement binding", async () => {
  const h = postHarness();h.response({ ok: false, payload: { ok: false, error: "Native revision changed", authoring_binding: bindingB,
    revision: 900, confirmed_decisions: ["not an acknowledgement"] } });
  await expect(h.api.post("/api/boundary/progress", { candidate: candidateA, review_submission: submission,
    expected_revision: 4, authoring_binding: bindingA, actor: "operator" })).rejects.toThrow("Native revision changed");
  expect(h.api.binding()).toEqual(bindingA);
});
it("WBCI04 client advances binding only from successful host ACK, never the submitted preview", async () => {
  const h = postHarness(); const writer = { ...bindingA, epoch: 31, revision_id: "writer-returned" };
  h.response({ ok: true, payload: { ok: true, authoring_binding: writer, revision: 17 } });
  await h.api.post("/api/boundary/progress", { candidate: candidateA, review_submission: submission, expected_revision: 4,
    authoring_binding: bindingA, actor: "operator" });
  expect(h.api.binding()).toEqual(writer);expect(h.sent[0]!.body.review_submission).toEqual(submission);
});
function queueHarness(post: (url: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const code = script();const start = code.indexOf("function queueReviewProgressSave()");const end = code.indexOf("function renderResourceDetail()", start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  let release!: () => void;const held = new Promise<void>(resolve => { release = resolve; });
  const actor = { value: "displayed operator A" };const message = { className: "", textContent: "" };
  const producerStart=code.indexOf("const reviewDecision=id=>");const producerEnd=code.indexOf("const classificationFor=",producerStart);
  expect(producerStart).toBeGreaterThan(0);expect(producerEnd).toBeGreaterThan(producerStart);
  const typedPayload={review_decisions:[{...ref,decision:"Display only"}],review_candidate_digest:submission.candidate_digest,confirmed_review_ids:[]};
  const context = vm.createContext({ structuredClone, post, actor, message, held, initial: candidateA, bindingA,typedPayload,
    updateActivationState: vi.fn(), byId: (id: string) => id === "actor" ? actor : message });
  const api = vm.runInContext(`let candidate=structuredClone(initial),reviewReport={},confirmedDecisions=new Set(),
    progressSave=held,reviewRevision=4,authoringBinding=structuredClone(bindingA),reviewInvalidations=[],reviewProgressHealthy=true;
    let typedReviewDecisions=[],reviewCandidateDigest,reviewCandidateSnapshot;
    ${code.slice(producerStart,producerEnd)}
    adoptTypedReview(typedPayload);
    ${code.slice(start,end)}
    ({queueReviewProgressSave,drift:()=>{candidate.pack.name="different-B";reviewRevision=9;actor.value="different operator B"},
      state:()=>({revision:reviewRevision,healthy:reviewProgressHealthy,invalidations:reviewInvalidations})});`, context) as {
        queueReviewProgressSave(): Promise<void>;drift(): void;state(): { revision: number; healthy: boolean; invalidations: unknown[] };
      };
  return { api, release };
}
it("WBCI05 deferred queue snapshots candidate, current native CAS revision and operator together", async () => {
  const sent: Record<string, unknown>[] = [];const h = queueHarness(async (_url, body) => { sent.push(body);return { revision: 12, invalidated_decisions: [],review_decisions:[{...ref,decision:"Display only"}],review_candidate_digest:submission.candidate_digest,confirmed_review_ids:[] }; });
  const saving = h.api.queueReviewProgressSave();h.api.drift();h.release();await saving;
  expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({ candidate: candidateA, expected_revision: 4, actor: "displayed operator A" });
});
it("WBCI06 queued refusal leaves the displayed revision pending and never treats an error as ACK", async () => {
  const h = queueHarness(async () => { throw Object.assign(new Error("Native review drift"), { payload: { revision: 17, authoring_binding: bindingB } }); });
  const saving = h.api.queueReviewProgressSave();h.release();await saving;
  expect(h.api.state()).toEqual({ revision: 4, healthy: false, invalidations: [] });
});
it("WBCI07 queue uses writer-returned revision and invalidations rather than request preview", async () => {
  const h = queueHarness(async () => ({ revision: 23, invalidated_decisions: ["exact writer-returned invalidation"],review_decisions:[{...ref,decision:"Display only"}],review_candidate_digest:submission.candidate_digest,confirmed_review_ids:[] }));
  const saving = h.api.queueReviewProgressSave();h.release();await saving;
  expect(h.api.state()).toEqual({ revision: 23, healthy: true, invalidations: ["exact writer-returned invalidation"] });
});

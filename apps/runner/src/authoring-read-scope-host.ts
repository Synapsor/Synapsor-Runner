import { ReadScopeReviewError, nativeReadScopeFailure } from "./authoring-read-scope-error.js";
import { randomUUID } from "node:crypto";
import { assertReadScopeHistoricalReferences, type HistoricalReadScopeInventory } from "./authoring-read-scope-history.js";
import { assertReadScopeProvenance } from "./read-structured-scope.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { confirmReadScopeReview, createReadScopeQuestion, proposeReadScopeReview, resolveNativeReadScope } from "./authoring-read-scope-question.js";
import { leaveOperatorQuestionPending, operatorQuestionReadback, reopenOperatorQuestion,
  type OperatorQuestion } from "./authoring-operator-question.js";
import type { AuthoringQuestionInteraction } from "./authoring-question-interaction.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

type Digest = `sha256:${string}`;
export type ReadScopeReviewSnapshot = Parameters<typeof resolveNativeReadScope>[0] & {
  /** Actual acknowledged Resume revision, loaded with the records/analysis. */
  resume_revision_digest: Digest; context_digest: Digest; scope_digest: Digest;
  /** Exact historical references resolved by native owners, never model claims. */
  historical_inventory?: HistoricalReadScopeInventory;
};
export type ReadScopeReviewBinding = { requested_question_id: string; requested_question_digest: Digest;
  question_id: string; question_revision: number; question_digest: Digest;
  context_digest: Digest; scope_digest: Digest; current_context_digest: Digest; current_scope_digest: Digest;
  proposal_digest?: Digest; analysis_digest?: Digest; snapshot_digest: Digest };
type View = AuthoringQuestionInteraction<ReadScopeReviewBinding>;
export type ReadScopeInteraction = Extract<View, { kind: "readback" }>
  | (Omit<Extract<View, { kind: "pending" }>, "canAnswer"> & { canReview: boolean; canReplace: boolean });
export type ReadScopeInteractionResponse = { kind: "decision"; binding: ReadScopeReviewBinding; accepted: boolean | null }
  | { kind: "pending"; binding: ReadScopeReviewBinding; choice: "keep" | "review" | "replace" };
export type ReadScopeHostAccess = {
  /** Reload one coherent native revision; never substitute an arbitrary latest question. */
  load(questionId: string): Promise<ReadScopeReviewSnapshot>;
  loadHeld(questionId: string, permit: ProjectAuthorityMutationPermit): Promise<ReadScopeReviewSnapshot>;
  mutate<T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>): Promise<T>;
  /** Existing protected Resume CAS/rollback. No new persistence owner. */
  save(question: OperatorQuestion, options: { permit: ProjectAuthorityMutationPermit; expected: ReadScopeReviewSnapshot; subject: string }): Promise<void>;
};
function changed(): never { throw new ReadScopeReviewError("READ_SCOPE_REVIEW_CHANGED", "The displayed scope, analysis or native revision changed. No decision was saved."); }
function acknowledgementUnknown(cause?: unknown): never { throw new ReadScopeReviewError("READ_SCOPE_REVIEW_ACK_UNKNOWN",
  "The scope decision may have been saved, but its exact acknowledgement is unavailable. Inspect the saved job before another decision; no retry or replacement is authorized here.",
  "unknown", { cause }); }
function checked(snapshot: ReadScopeReviewSnapshot, questionId: string) {
  if (snapshot.question_id !== questionId) changed();
  const resolved = resolveNativeReadScope(snapshot), q = resolved.question;
  const requested = snapshot.questions.find(q => q.id === questionId);
  if (!requested) changed();
  // Loading historical testimony is separate from admitting a current decision.
  // Missing/forged native provenance is not an ordinary stale proposal.
  const historical = snapshot.historical_inventory ?? { binding: snapshot.expectedBinding,
    references: snapshot.references, catalog: snapshot.catalog };
  assertReadScopeHistoricalReferences(resolved.record, historical.references);
  assertReadScopeProvenance(resolved.record, { expectedBinding: historical.binding, ...historical });
  const applicability = resolved.status === "stale" || q.context_digest !== snapshot.context_digest
    || q.scope_digest !== snapshot.scope_digest ? "stale_inspectable" : "current";
  const binding: ReadScopeReviewBinding = { requested_question_id: requested.id, requested_question_digest: requested.digest,
    question_id: q.id, question_revision: q.revision, question_digest: q.digest,
    context_digest: q.context_digest, scope_digest: q.scope_digest,
    current_context_digest: snapshot.context_digest, current_scope_digest: snapshot.scope_digest,
    ...(q.proposal ? { proposal_digest: canonicalJsonDigest(q.proposal) } : {}),
    ...(snapshot.analysis ? { analysis_digest: canonicalJsonDigest(snapshot.analysis) } : {}),
    snapshot_digest: canonicalJsonDigest(snapshot) };
  return { snapshot, resolved, q, binding, applicability };
}
/** Grouped scope review only. The existing native question owns the proposal,
 * actual model completion and history; this adapter never drafts or activates. */
export function createReadScopeHost(input: { access: ReadScopeHostAccess;
  interact(view: ReadScopeInteraction, assertCurrent: () => Promise<void>): Promise<ReadScopeInteractionResponse> }) {
  const load = async (id: string) => checked(await input.access.load(id), id);
  const loadHeld = async (id: string, permit: ProjectAuthorityMutationPermit) => checked(await input.access.loadHeld(id, permit), id);
  const assertSame = (shown: ReturnType<typeof checked>, current: ReturnType<typeof checked>) => {
    if (canonicalJsonDigest(current.binding) !== canonicalJsonDigest(shown.binding)) changed();
    return current;
  };
  const assertDisplayed = async (shown: ReturnType<typeof checked>) => assertSame(shown, await load(shown.binding.requested_question_id));
  const assertDisplayedHeld = async (shown: ReturnType<typeof checked>, permit: ProjectAuthorityMutationPermit) =>
    assertSame(shown, await loadHeld(shown.binding.requested_question_id, permit));
  const save = async (shown: ReturnType<typeof checked>, transform: (q: OperatorQuestion, snapshot: ReadScopeReviewSnapshot) => OperatorQuestion,
    subject: string) => input.access.mutate(async permit => {
    const current = await assertDisplayedHeld(shown, permit), next = transform(current.q, current.snapshot);
    await input.access.save(next, { permit, expected: current.snapshot, subject });
    let acknowledged: ReturnType<typeof checked>;
    try { acknowledged = await loadHeld(current.binding.requested_question_id, permit); }
    catch (error) { return acknowledgementUnknown(error); }
    if (acknowledged.q.digest !== next.digest || acknowledged.q.revision !== next.revision) acknowledgementUnknown();
    return acknowledged;
  });
  const exchange = async (shown: ReturnType<typeof checked>, view: ReadScopeInteraction) => {
    await assertDisplayed(shown);
    // No mutation permit survives this wait.
    const response = await input.interact(structuredClone(view), async () => { await assertDisplayed(shown); });
    if (canonicalJsonDigest(response.binding) !== canonicalJsonDigest(view.binding)
      || view.kind === "readback" && (response.kind !== "decision" || ![true, false, null].includes(response.accepted))
      || view.kind === "pending" && (response.kind !== "pending" || !["keep", "review", "replace"].includes(response.choice)
        || response.choice === "review" && !view.canReview || response.choice === "replace" && !view.canReplace)) changed();
    await assertDisplayed(shown); return response;
  };
  const review = async (questionId: string): Promise<{ state: "confirmed" | "pending" | "replace_requested";
    question_id: string; question_digest: Digest }> => {
    let current = await load(questionId);
    const result = (state: "confirmed" | "pending" | "replace_requested") => ({ state, question_id: current.q.id, question_digest: current.q.digest });
    if (current.applicability === "current" && current.resolved.status === "confirmed") return result("confirmed");
    let canReview = current.applicability === "current" && !current.resolved.replacement_pending;
    try { if (canReview) proposeReadScopeReview(reopenOperatorQuestion(current.q), current.snapshot.expectedBinding,
      current.snapshot.analysis, current.snapshot); } catch (error) {
      if (nativeReadScopeFailure(error)?.code !== "READ_SCOPE_REVIEW_STALE") throw error;
      canReview = false;
    }
    if (!canReview || current.q.disposition) {
      const response = await exchange(current, { kind: "pending", binding: current.binding, canReview,
        canReplace: current.q.scope_digest === current.snapshot.scope_digest, defaultValue: "keep",
        material: [current.applicability === "stale_inspectable"
          ? "This saved scope is available for inspection, but its dependencies changed. It cannot be confirmed until ordinary replacement and current Read mapping are reviewed."
          : canReview ? "This complete scope remains unconfirmed." : "This scope still needs ordinary Read mapping before it can be confirmed.",
          ...current.q.read_scope!.record.proposal.requirements.map(r => `${r.disposition}: ${r.intended_use}${r.unresolved ? ` — ${r.unresolved}` : ""}`),
          "Keeping or replacing this proposal does not renew the model allowance or activate access."] });
      if (response.kind !== "pending" || response.choice === "keep") return result("pending");
      if (response.choice === "replace") {
        current = await save(current, (q, snapshot) => leaveOperatorQuestionPending(
          current.applicability === "stale_inspectable" ? createReadScopeQuestion({ id: randomUUID(), revision: q.revision + 1,
            scope_digest: q.scope_digest, context_digest: snapshot.context_digest,
            read_scope: { ...q.read_scope!, predecessor_id: q.id } }) : q, "declined"),
          "The scope kept pending for its ordinary replacement route");
        return result("replace_requested");
      }
    }
    if (!current.q.proposal || current.q.disposition) current = await save(current, (q, snapshot) =>
      proposeReadScopeReview(reopenOperatorQuestion(q), snapshot.expectedBinding, snapshot.analysis, snapshot), "The exact grouped Read scope proposal");
    const response = await exchange(current, { kind: "readback", binding: current.binding, defaultValue: false,
      lines: [...operatorQuestionReadback(current.q),
        ...(current.snapshot.analysis ? ["Exact analyzed allowed and forbidden plans:",
          JSON.stringify({ allowed: current.snapshot.analysis.allowed, forbidden: current.snapshot.analysis.forbidden })]
          : ["The proposed interpretation requests no Read work; no workload analysis was fabricated."]),
        "Yes confirms this scope interpretation only. Disabled save, policy review and activation remain separate."] });
    if (response.kind !== "decision") changed();
    current = await save(current, (q, snapshot) => response.accepted === true
      ? confirmReadScopeReview(q, snapshot.expectedBinding, snapshot.analysis, q.digest, snapshot)
      : leaveOperatorQuestionPending(q, response.accepted === null ? "cancelled" : "declined"), "The exact grouped Read scope decision");
    if (response.accepted === true && current.resolved.status !== "confirmed") acknowledgementUnknown();
    return result(response.accepted === true ? "confirmed" : "pending");
  };
  return { review };
}

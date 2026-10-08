import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { buildActionParameterReview, applyActionParameterEvent, type ActionParameterReviewInput } from "./authoring-action-parameter-review.js";
import { presentTypedAuthoringReview, confirmTypedAuthoringReview } from "./authoring-question-presenter.js";
import { parseTypedReviewView, validateTypedFieldEvent } from "./authoring-typed-review-codec.js";
import type { TypedFieldEvent, TypedReviewBinding, TypedReviewView } from "./authoring-typed-review.js";

type Digest = `sha256:${string}`;
export type ActionParameterNativeRef = Readonly<{ question_id: string; question_revision: number; question_digest: Digest }>;
export type ActionParameterCurrent = Readonly<{
  domain: ActionParameterReviewInput; native: ActionParameterNativeRef; view: TypedReviewView;
}>;
export type ActionParameterAcknowledgement = Readonly<{ native: ActionParameterNativeRef; binding: TypedReviewBinding }>;
export type ActionParameterInteractionPorts = Readonly<{
  /** Load current records under the existing host's read/currentness boundary.
   * No lock survives this call or any subsequent human wait. */
  loadCurrent(): Promise<ActionParameterCurrent>;
  assertCurrent(expected: ActionParameterAcknowledgement): Promise<void>;
  /** Reload/reapply/recompile natively; the renderer cannot submit compiled
   * authority. Resolve only after protected write + exact producer ACK. */
  submitField(input: Readonly<{ expected: ActionParameterAcknowledgement; event: TypedFieldEvent }>): Promise<ActionParameterAcknowledgement>;
  /** Existing grouped decision; false/null preserve pending. True is neither
   * activation nor Source adoption. The host owns actual trusted actor proof. */
  recordDecision(input: Readonly<{ expected: ActionParameterAcknowledgement; accepted: boolean | null }>): Promise<ActionParameterAcknowledgement>;
}>;
export type ActionParameterInteractionOutcome =
  | Readonly<{ kind: "paused"; current: ActionParameterAcknowledgement }>
  | Readonly<{ kind: "correction"; current: ActionParameterAcknowledgement; raw: string }>
  | Readonly<{ kind: "pending" | "confirmed"; acknowledged: ActionParameterAcknowledgement }>;
const equal = (left: unknown, right: unknown) => canonicalJsonDigest(left) === canonicalJsonDigest(right);
function stale(): never { throw new Error("ACTION_PARAMETER_INTERACTION_STALE: The exact acknowledged question or proposal changed. Reopen its current review; no later state was adopted."); }
function validNative(ref: ActionParameterNativeRef): void {
  if (!ref || Object.keys(ref).some(k => !["question_id", "question_revision", "question_digest"].includes(k))
    || typeof ref.question_id !== "string" || !ref.question_id.trim() || ref.question_id.length > 256
    || !Number.isSafeInteger(ref.question_revision) || ref.question_revision < 1
    || typeof ref.question_digest !== "string" || ref.question_digest.length !== 71 || !/^sha256:[a-f0-9]{64}$/u.test(ref.question_digest)) stale();
}
function expectation(current: ActionParameterCurrent): ActionParameterAcknowledgement {
  return structuredClone({ native: current.native, binding: current.view.binding });
}
function checkedCurrent(raw: ActionParameterCurrent): ActionParameterCurrent {
  validNative(raw.native);
  const domain = { ...raw.domain, baseline: structuredClone(raw.domain.baseline), working: structuredClone(raw.domain.working), targets: structuredClone(raw.domain.targets) };
  const view = parseTypedReviewView(raw.view), compiled = buildActionParameterReview(domain);
  if (!equal(view, compiled.view)) stale();
  return { domain, view, native: structuredClone(raw.native) };
}
function checkedAck(ack: ActionParameterAcknowledgement, prior: ActionParameterCurrent): ActionParameterAcknowledgement {
  validNative(ack?.native);
  if (!ack.binding || Object.keys(ack).some(k => !["native", "binding"].includes(k))
    || ack.native.question_id !== prior.native.question_id || ack.native.question_revision < prior.native.question_revision
    || ack.binding.proposal_id !== prior.view.binding.proposal_id || ack.binding.operation_id !== prior.view.binding.operation_id
    || ack.binding.applicability_digest !== prior.view.binding.applicability_digest) stale();
  // Reuse the strict binding parser via the unchanged structural view.
  parseTypedReviewView({ ...prior.view, binding: ack.binding });
  return structuredClone(ack);
}

/** Existing presenter/domain orchestration only. It holds no store or provider
 * capability and never treats Enter/navigation as a grouped decision. */
export async function runActionParameterInteraction(input: {
  ports: ActionParameterInteractionPorts;
  session: Parameters<typeof presentTypedAuthoringReview>[0]["session"];
}): Promise<ActionParameterInteractionOutcome> {
  let current = checkedCurrent(await input.ports.loadCurrent());
  for (;;) {
    const expected = expectation(current);
    const assertCurrent = () => input.ports.assertCurrent(expected);
    const response = await presentTypedAuthoringReview({ view: current.view, session: input.session, assertCurrent });
    await assertCurrent();
    if (response.kind === "pause") return { kind: "paused", current: expected };
    if (response.kind === "describe_correction") return { kind: "correction", current: expected, raw: response.raw };
    if (response.kind === "field_event") {
      const { event } = validateTypedFieldEvent(current.view, response.event);
      const local = applyActionParameterEvent(current.domain, event);
      const ack = checkedAck(await input.ports.submitField({ expected, event }), current);
      if (ack.binding.proposal_digest !== canonicalJsonDigest(local.candidate)) stale();
      // No display or caller advancement until the exact acknowledged state is
      // read back. A concurrent later revision is not adopted as the next form.
      const reread = checkedCurrent(await input.ports.loadCurrent());
      if (!equal(expectation(reread), ack)) stale();
      current = reread;
      continue;
    }
    const reviewed = checkedCurrent(await input.ports.loadCurrent());
    if (!equal(expectation(reviewed), expected) || !equal(reviewed.view, current.view)) stale();
    const decision = await confirmTypedAuthoringReview({ view: reviewed.view, session: input.session, assertCurrent });
    await assertCurrent();
    if (!equal(decision.binding, expected.binding)) stale();
    const ack = checkedAck(await input.ports.recordDecision({ expected, accepted: decision.accepted }), current);
    // A grouped decision records the displayed proposal, never a new proposal
    // or answer revision. Only its protected question digest may advance.
    if (!equal(ack.binding, expected.binding) || ack.native.question_revision !== expected.native.question_revision) stale();
    return { kind: decision.accepted === true ? "confirmed" : "pending", acknowledged: ack };
  }
}

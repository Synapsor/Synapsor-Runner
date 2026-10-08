import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readActionRuleReviewSubjects, parseStoredActionRuleAuthority, type ActionRuleReviewSubject } from "./action-rule-authority.js";
import { readBoundaryAuthoringResumeState, type BoundaryAuthoringResumeBinding } from "./boundary-authoring-resume.js";
import { actionRuleModelDraftFromAuthority, compileActionRuleModelDraft, type CompiledActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { actionRuleModelDraftFromCheckpoint } from "./action-rule-model.js";
import { actionLogicalTurnMaterialDigest, parseActionRuleAuthoringCheckpoint, type ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { assertTypedParameterGeneration, parseTypedParameterBinding, type TypedParameterBinding, type TypedParameterReference } from "./authoring-typed-parameter-binding.js";
import type { TypedParameterResolved } from "./authoring-typed-parameter-host.js";
import type { AuthoringTransportState } from "./authoring-generation-recovery.js";
export type TypedParameterCompilerContext = Omit<Parameters<typeof compileActionRuleModelDraft>[0], "draft">;
export type TypedParameterSourceRecords = {
  subjects: readonly ActionRuleReviewSubject[];
  checkpoints: readonly ActionRuleAuthoringCheckpoint[];
  generation?: AuthoringTransportState;
};
type Resolution = {
  binding: TypedParameterBinding;
  context: TypedParameterCompilerContext;
  /** Existing Runner-owned readback, no model or saving port. */
  businessLines(compiled: CompiledActionRuleModelDraftV1): readonly string[];
};
function stale(): never { throw new Error("TYPED_PARAMETER_SOURCE_STALE: The exact saved authority or consumed producer checkpoint is unavailable or changed. No substitute record was adopted."); }
const same = (a: unknown, b: unknown) => canonicalJsonDigest(a) === canonicalJsonDigest(b);
/** Pure loaded-record resolver for the native Resume owner: no recursive load,
 * authority mutation, model request or provenance created from matching text. */
export function resolveTypedParameterSourceRecords(input: Resolution & { records: TypedParameterSourceRecords }): TypedParameterResolved {
  const binding = parseTypedParameterBinding(input.binding);
  assertTypedParameterGeneration(binding, input.records.generation);
  const compile: TypedParameterResolved["compile"] = draft => {
    const compiled = compileActionRuleModelDraft({ ...input.context, draft });
    return { draft: compiled.draft, business_lines: [...input.businessLines(compiled)] };
  };
  const resolve = (ref: TypedParameterReference) => {
    let draft;
    if (ref.kind === "saved_authority") {
      const matches = input.records.subjects.filter(subject => same(subject.identity, ref.identity));
      if (matches.length !== 1) stale();
      const subject = parseStoredActionRuleAuthority(matches[0]!.authority);
      if (subject.digest !== ref.authority_digest) stale();
      const reviews = subject.reviews.filter(review => review.outcome === ref.outcome);
      if (reviews.length !== 1) stale();
      draft = actionRuleModelDraftFromAuthority({ authority: subject.authority, outcome: ref.outcome,
        review: reviews[0]!, preserveVerificationFields: true });
    } else {
      const matches = input.records.checkpoints.filter(checkpoint => checkpoint.digest === ref.checkpoint_digest);
      if (!matches.length || matches.some(checkpoint => !same(checkpoint, matches[0]))) stale();
      const checkpoint = parseActionRuleAuthoringCheckpoint(matches[0]!);
      const closed = checkpoint.logical_turns?.at(-1)?.completed;
      if (closed?.kind !== "compiled_draft" || !same(closed.completion, ref.completion)
        || closed.material_digest !== ref.material_digest || actionLogicalTurnMaterialDigest(checkpoint) !== ref.material_digest) stale();
      draft = actionRuleModelDraftFromCheckpoint(checkpoint);
    }
    const compiled = compile(draft).draft;
    if (compiled.outcome !== ref.outcome || canonicalJsonDigest(compiled) !== ref.draft_digest) stale();
    return compiled;
  };
  const baseline = resolve(binding.baseline), initial = resolve(binding.origin);
  if (canonicalJsonDigest(initial) !== binding.initial_candidate_digest) stale();
  return { baseline, initial, compile };
}
/** File-backed entry for the native host. The caller owns existing freshness and
 * CAS boundaries: call again under its protected mutation permit before save.
 * A semantic baseline never binds to the continually advancing Resume revision. */
export async function resolveTypedParameterSources(input: Resolution & {
  projectRoot: string; resumeBinding: BoundaryAuthoringResumeBinding;
}): Promise<TypedParameterResolved> {
  const binding = parseTypedParameterBinding(input.binding);
  const records: TypedParameterSourceRecords = { subjects: [], checkpoints: [] };
  if ([binding.baseline, binding.origin].some(ref => ref.kind === "saved_authority"))
    records.subjects = await readActionRuleReviewSubjects(input.projectRoot);
  if ([binding.baseline, binding.origin].some(ref => ref.kind === "compiled_checkpoint")) {
    const loaded = await readBoundaryAuthoringResumeState(input.projectRoot, input.resumeBinding);
    if (loaded.status !== "ready") stale();
    records.checkpoints = [loaded.value.action?.checkpoint, loaded.value.pending_action_revision?.checkpoint,
      loaded.value.pending_action_addition?.retained_action.checkpoint].filter((checkpoint): checkpoint is ActionRuleAuthoringCheckpoint => !!checkpoint);
    records.generation = loaded.value.generation_recovery;
  }
  return resolveTypedParameterSourceRecords({ ...input, binding, records });
}

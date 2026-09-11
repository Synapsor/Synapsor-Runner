import { isDeepStrictEqual } from "node:util";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import { compareGenerationLock, explorationBoundaryCandidateDigest, loadActivatedExplorationBoundaries,
  loadGenerationLockSnapshot, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import { buildActionRuleAuthorityDraft, readActionRuleAuthorityRevisionBaseline, writeActionRuleAuthorityDraftIfCurrent,
  type ActionRuleAuthorityActivationV1, type ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
import { prepareActionRuleReadRevision } from "./action-rule-read-revision.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

export async function savedActionReadReviewState(projectRoot: string, boundaryName: string,
  activeReads: ActivatedExplorationBoundary[]): Promise<"unavailable" | "pending" | "active"> {
  const authoring = await readProjectReadAuthoring(projectRoot).catch(error => {
    if (error instanceof Error && (error as Error & { code?: string }).code === "POLICY_READ_AUTHORING_MISSING") return undefined;
    throw error;
  });
  const candidate = authoring?.selected?.progress.candidate;
  if (!candidate || candidate.pack.name !== boundaryName) return "unavailable";
  const digest = explorationBoundaryCandidateDigest(candidate);
  return activeReads.some(read => read.pack.name === boundaryName && read.activation.digest === digest
    && read.generation_lock_fingerprint === candidate.generation_lock_fingerprint) ? "active" : "pending";
}

/** Operator-only metadata repair. Existing activation, rules and execution
 * authority remain immutable; only a recompiled disabled replacement is saved. */
export async function revalidateSavedActionReadDependencies(input: {
  projectRoot: string; boundaryName: string;
  current: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1;
  env?: NodeJS.ProcessEnv; inspect?: typeof inspectDatabase;
}): Promise<ActionRuleAuthorityDraftV1> {
  return withProjectAuthorityMutation(input.projectRoot, async held => {
    const fail = (reason: string): never => { throw new Error(`ACTION_READ_RECOVERY_REQUIRED: ${reason} Saved rules and active permissions are unchanged.`); };
    const baseline = await readActionRuleAuthorityRevisionBaseline(held.projectRoot, held);
    const expected = "activated_at" in input.current ? baseline.active : baseline.drafts[input.current.authority.name];
    if (expected !== canonicalJsonDigest(input.current)) fail("The selected Action revision changed. Reopen its review.");
    if ("activated_at" in input.current && baseline.drafts[input.current.authority.name]) {
      fail("A disabled replacement already exists. Reopen that draft so its edits are preserved.");
    }
    const before = await readProjectReadAuthoring(held.projectRoot);
    const selected = before?.selected;
    if (!selected || selected.progress.candidate.pack.name !== input.boundaryName) fail("Select and review the linked Read revision first.");
    const nextBoundary = selected!.progress.candidate;
    const digest = explorationBoundaryCandidateDigest(nextBoundary);
    const requireActiveRead = async () => {
      const reads = await loadActivatedExplorationBoundaries(held.projectRoot);
      if (!reads.some(read => read.pack.name === input.boundaryName && read.activation.digest === digest
        && read.generation_lock_fingerprint === nextBoundary.generation_lock_fingerprint)) {
        fail("The linked Read revision is not active at this exact review. Review Read access first.");
      }
    };
    await requireActiveRead();
    const lock = selected!.draft_lock;
    const inspection = await (input.inspect ?? inspectDatabase)({ engine: lock.engine, databaseUrlEnv: lock.source_env,
      ...(lock.inspected_schema ? { schema: lock.inspected_schema } : {}), env: input.env ?? process.env });
    const comparison = compareGenerationLock(lock, inspection);
    if (!comparison.current) fail(`The database changed again: ${comparison.changes.join("; ")}. Rescan and review access before retrying.`);
    const current = input.current;
    const existing = "activated_at" in current ? buildActionRuleAuthorityDraft({ name: current.authority.name,
      action_boundary_name: current.authority.action_boundary.name, catalog: structuredClone(current.authority.catalog),
      rules: current.authority.rules.map(({ activated_at: _at, ...rule }) => structuredClone(rule)),
      approval_classes: structuredClone(current.authority.approval_classes), reviews: structuredClone(current.reviews),
      now: current.activated_at }) : current;
    const replacement = prepareActionRuleReadRevision({ existing,
      previousLock: await loadGenerationLockSnapshot(held.projectRoot, existing.authority.catalog.generation_lock_fingerprint),
      nextLock: lock, nextBoundary, inspection, revalidateMetadata: true });
    if (!isDeepStrictEqual(await readProjectReadAuthoring(held.projectRoot), before)) {
      fail("The reviewed Read draft changed while checking metadata. Reopen this review.");
    }
    await requireActiveRead();
    await writeActionRuleAuthorityDraftIfCurrent(held.projectRoot, replacement, baseline, held);
    return replacement;
  });
}

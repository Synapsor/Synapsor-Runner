import {
  readBoundaryAuthoringResumeStateHeld,
  type BoundaryAuthoringResumeBinding,
  type BoundaryAuthoringResumeState,
} from "./boundary-authoring-resume.js";
import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";
import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import type { ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";

export const ACTION_RULE_INTENT_SKELETON_VERSION = "synapsor.action-rule-intent-skeleton.v1" as const;

type UnknownComponent = {
  state: "unknown";
  required: string[];
};
type CheckpointComponent = { state: "checkpoint" | "needs_revalidation"; component: Record<string, unknown> };

export type ActionRuleIntentSkeletonV1 = {
  schema_version: typeof ACTION_RULE_INTENT_SKELETON_VERSION;
  state: "incomplete";
  intent_index: number;
  intent: string;
  resume: {
    revision_digest: `sha256:${string}`;
    binding: BoundaryAuthoringResumeBinding;
  };
  candidates: {
    resources: BuiltActionRuleAuthoringCatalogV1["authoring"]["resources"];
    relationships: BuiltActionRuleAuthoringCatalogV1["authoring"]["relationships"];
    /** Scoped inspected resources that could be selected as a subject reference; no binding is inferred. */
    subject_ref_resource_candidates: string[];
  };
  verification: CheckpointComponent | (UnknownComponent & { required: ["select resource and subject binding", "select verification fields"] });
  effect: CheckpointComponent | (UnknownComponent & { required: ["select operation", "select target resource and fields", "define bounded effect"] });
  policy: CheckpointComponent | (UnknownComponent & { required: ["define eligibility", "define approval and limits", "define refusal and review behavior"] });
  checkpoint_rule?: CheckpointComponent;
  continuation: { state: "unprepared" } | { state: "exact_current_draft"; outcome: string; digest: `sha256:${string}`; draft: ActionRuleModelDraftV1 };
};

export type ActionRuleIntentSkeletonLoad = {
  resume: BoundaryAuthoringResumeState | undefined;
  skeletons: ActionRuleIntentSkeletonV1[];
};

/**
 * Reads only a saved job whose binding still exactly matches the reviewed Read
 * snapshot. Skeletons are incomplete authoring aids, never ActionRule drafts.
 */
type ActionRuleIntentSkeletonInput = {
  projectRoot: string;
  binding: BoundaryAuthoringResumeBinding;
  builtCatalog: BuiltActionRuleAuthoringCatalogV1;
  readBoundaryDigest: `sha256:${string}`;
  /** Current reviewed/draft authority drafts, supplied by the caller. */
  preparedDrafts: ReadonlyArray<{ outcome: string; digest: `sha256:${string}`; draft: ActionRuleModelDraftV1 }>;
};
export async function loadActionRuleIntentSkeletons(input: ActionRuleIntentSkeletonInput): Promise<ActionRuleIntentSkeletonLoad> {
  return withProjectAuthorityMutation(input.projectRoot, permit => loadActionRuleIntentSkeletonsHeld(input, permit));
}
/** Required access to the same coherent export/review snapshot; never reacquires. */
export async function loadActionRuleIntentSkeletonsHeld(input: ActionRuleIntentSkeletonInput,
  permit: ProjectAuthorityMutationPermit): Promise<ActionRuleIntentSkeletonLoad> {
  return withHeldProjectAuthorityAccess(input.projectRoot, permit, async access => {
  const saved = await readBoundaryAuthoringResumeStateHeld(input.projectRoot, input.binding, access);
  if (saved.status === "none") return { resume: undefined, skeletons: [] };
  if (saved.status === "stale") {
    throw new Error(`ACTION_RULE_INTENT_SKELETON_STALE: saved action intents belong to a changed Read snapshot (${saved.reason}). Revalidate the saved job and export again; Runner did not reuse stale components.`);
  }
  if (saved.status === "invalid") {
    throw new Error(`ACTION_RULE_INTENT_SKELETON_RESUME_INVALID: saved action intents cannot be exported (${saved.reason}). Repair or restart the saved job; Runner did not reuse invalid components.`);
  }
  return {
      resume: saved.value,
    skeletons: actionRuleIntentSkeletonsFromResume({
      resume: saved.value,
      builtCatalog: input.builtCatalog,
      readBoundaryDigest: input.readBoundaryDigest,
      preparedDrafts: input.preparedDrafts,
    }),
  };
  });
}

export function actionRuleIntentSkeletonsFromResume(input: {
  resume: BoundaryAuthoringResumeState;
  builtCatalog: BuiltActionRuleAuthoringCatalogV1;
  readBoundaryDigest: `sha256:${string}`;
  preparedDrafts: ReadonlyArray<{ outcome: string; digest: `sha256:${string}`; draft: ActionRuleModelDraftV1 }>;
}): ActionRuleIntentSkeletonV1[] {
  const action = input.resume.action;
  if (!action) return [];
  const intents = action.intents ?? [action.intent];
  const prepared = exactPreparedOutcomes({ intents, outcomes: action.completed_outcomes,
    checkpoint: action.checkpoint, drafts: input.preparedDrafts });
  const candidates = {
    resources: structuredClone(input.builtCatalog.authoring.resources),
    relationships: structuredClone(input.builtCatalog.authoring.relationships),
    subject_ref_resource_candidates: input.builtCatalog.catalog.resources
      .filter((resource) => resource.tenant_key !== undefined
        && input.builtCatalog.authoring.resources.find(r => r.name === resource.name)?.subject_reference?.obtainable !== false)
      .map((resource) => resource.name),
  };
  return intents.map((intent, index) => ({
    schema_version: ACTION_RULE_INTENT_SKELETON_VERSION,
    state: "incomplete",
    intent_index: index,
    intent,
    resume: {
      revision_digest: input.resume.revision_digest,
      binding: structuredClone(input.resume.binding),
    },
    candidates: structuredClone(candidates),
    ...checkpointComponents({ action, intent, index, builtCatalog: input.builtCatalog,
      readBoundaryDigest: input.readBoundaryDigest, preparedDrafts: input.preparedDrafts }),
    continuation: prepared[index] === undefined
      ? { state: "unprepared" as const }
      : { state: "exact_current_draft" as const, outcome: prepared[index]!.outcome, digest: prepared[index]!.digest,
        draft: structuredClone(prepared[index]!.draft) },
  }));
}

function exactPreparedOutcomes(input: {
  intents: readonly string[];
  outcomes: readonly string[] | undefined;
  checkpoint: ActionRuleAuthoringCheckpoint | undefined;
  drafts: ReadonlyArray<{ outcome: string; digest: `sha256:${string}`; draft: ActionRuleModelDraftV1 }>;
}): Array<{ outcome: string; digest: `sha256:${string}`; draft: ActionRuleModelDraftV1 } | undefined> {
  const byOutcome = new Map(input.drafts.map((draft) => [draft.outcome, draft]));
  if (input.checkpoint?.reopened_draft) {
    const reopened = input.checkpoint.reopened_draft;
    const draft = byOutcome.get(reopened.outcome);
    if (!draft || draft.digest !== reopened.digest) return input.intents.map(() => undefined);
    return input.intents.map((_intent, index) => reopened.covered_intent_indexes.includes(index) ? draft : undefined);
  }
  if (!input.outcomes || input.outcomes.length > input.intents.length
    || new Set(input.outcomes).size !== input.outcomes.length) {
    return input.intents.map(() => undefined);
  }
  return input.intents.map((_intent, index) => input.outcomes?.[index] ? byOutcome.get(input.outcomes[index]!) : undefined);
}

function checkpointComponents(input: {
  action: NonNullable<BoundaryAuthoringResumeState["action"]>;
  intent: string;
  index: number;
  builtCatalog: BuiltActionRuleAuthoringCatalogV1;
  readBoundaryDigest: `sha256:${string}`;
  preparedDrafts: ReadonlyArray<{ outcome: string; digest: `sha256:${string}`; draft: ActionRuleModelDraftV1 }>;
}): Pick<ActionRuleIntentSkeletonV1, "verification" | "effect" | "policy" | "checkpoint_rule"> {
  const unknown = {
    verification: { state: "unknown" as const, required: ["select resource and subject binding", "select verification fields"] as ["select resource and subject binding", "select verification fields"] },
    effect: { state: "unknown" as const, required: ["select operation", "select target resource and fields", "define bounded effect"] as ["select operation", "select target resource and fields", "define bounded effect"] },
    policy: { state: "unknown" as const, required: ["define eligibility", "define approval and limits", "define refusal and review behavior"] as ["define eligibility", "define approval and limits", "define refusal and review behavior"] },
  };
  const checkpoint = input.action.checkpoint;
  const partialIndex = input.action.completed_outcomes?.length ?? 0;
  if (!checkpoint || checkpoint.intent_digest !== canonicalJsonDigest(input.intent)) return unknown;
  const reopened = checkpoint.reopened_draft;
  const baseline = reopened
    ? input.preparedDrafts.find((draft) => draft.outcome === reopened.outcome && draft.digest === reopened.digest)?.draft
    : undefined;
  const boundToIntent = reopened
    ? reopened.covered_intent_indexes.includes(input.index)
    : input.index === partialIndex;
  const contextDigest = canonicalJsonDigest({
    catalog: input.builtCatalog.catalog,
    read: input.readBoundaryDigest,
    baseline: baseline ?? null,
    ...(reopened ? { pending_intents: input.action.intents ?? [input.action.intent] } : {}),
  });
  if (!boundToIntent || (reopened && !baseline)) return unknown;
  const state = checkpoint.context_digest === contextDigest ? "checkpoint" as const : "needs_revalidation" as const;
  const component = (name: "verification" | "effect" | "approval") => checkpoint.components[name]
    ? { state, component: structuredClone(checkpoint.components[name]!) }
    : undefined;
  return {
    verification: component("verification") ?? unknown.verification,
    effect: component("effect") ?? unknown.effect,
    policy: component("approval") ?? unknown.policy,
    ...(checkpoint.components.rule ? { checkpoint_rule: { state, component: structuredClone(checkpoint.components.rule) } } : {}),
  };
}

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import type { ControlPolicyCommit, ControlPolicyRevision, ControlPolicyScopeSnapshot } from "@synapsor-runner/proposal-store";
import { publishPolicyConfiguration } from "./control-policy-config-publication.js";
import { openBoundProjectControlPolicies, assertProjectControlPolicyBinding, commitImmutableControlPolicies,
  type BoundProjectPolicyStore } from "./control-policy-store.js";
import { OPERATOR_POLICY_RECORD_VERSION, assertOperatorPolicyRecord, storedOperatorPolicyRecord } from "./control-policy-record.js";
import {
  ACTION_RULE_AUTHORITY_VERSION,
  ACTION_AUTHORITY_LIMITS,
  createActionRuleAuthority,
  parseActionRuleAuthority,
  type ActionRuleAuthoritySourceV1,
  type ActionRuleApprovalClassSourceV1,
  type ActionRuleAuthorityV1,
  type ActionRuleCatalogV1,
  type LoadedActionRuleAuthorityV1,
} from "@synapsor-runner/action-rules";
import {
  canonicalJsonDigest,
  canonicalJsonStringify,
} from "@synapsor-runner/protocol";
import {
  loadActivatedExplorationBoundaries,
  type ActivatedExplorationBoundary,
} from "./auto-boundary.js";

export const ACTION_RULE_AUTHORITY_DRAFT_VERSION = "synapsor.action-rule-authority-draft.v1" as const;
export const ACTION_RULE_AUTHORITY_ACTIVATION_VERSION = "synapsor.action-rule-authority-activation.v1" as const;

export type ActionRuleAuthorityReviewV1 = {
  outcome: string;
  when: string;
  then: string;
  refused: string[];
  human_review: string;
  examples: Array<{
    kind: "eligible" | "ineligible" | "human_review";
    scenario: string;
    result: string;
  }>;
};

export type ActionRuleAuthorityDraftV1 = {
  schema_version: typeof ACTION_RULE_AUTHORITY_DRAFT_VERSION;
  state: "disabled";
  authority: ActionRuleAuthorityV1;
  digest: `sha256:${string}`;
  reviews: ActionRuleAuthorityReviewV1[];
  created_at: string;
};

export type ActionRuleAuthorityActivationV1 = {
  schema_version: typeof ACTION_RULE_AUTHORITY_ACTIVATION_VERSION;
  state: "active";
  authority: ActionRuleAuthorityV1;
  digest: `sha256:${string}`;
  reviews: ActionRuleAuthorityReviewV1[];
  actor: string;
  activated_at: string;
};

export type LoadedActiveActionRuleAuthorityV1 = LoadedActionRuleAuthorityV1 & {
  activation: ActionRuleAuthorityActivationV1;
  unavailable_outcomes?: string[];
};

type ExistingActionRuleAuthorityV1 =
  | ActionRuleAuthorityDraftV1
  | ActionRuleAuthorityActivationV1;

/** Validates stored revisions without activating, rebinding or refreshing them. */
export function parseStoredActionRuleAuthority(value: unknown): ExistingActionRuleAuthorityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidDraft();
  return (value as { state?: unknown }).state === "active" ? parseActivation(value) : parseDraft(value);
}

export function buildActionRuleAuthorityDraft(input: {
  name: string;
  action_boundary_name: string;
  catalog: ActionRuleCatalogV1;
  rules: Array<Omit<ActionRuleAuthoritySourceV1, "activated_at">>;
  approval_classes?: ActionRuleApprovalClassSourceV1[];
  reviews: ActionRuleAuthorityReviewV1[];
  now?: string;
}): ActionRuleAuthorityDraftV1 {
  const now = canonicalTimestamp(input.now);
  const loaded = createActionRuleAuthority({
    name: input.name,
    action_boundary_name: input.action_boundary_name,
    catalog: input.catalog,
    rules: input.rules.map((rule) => ({ ...rule, activated_at: now })),
    ...(input.approval_classes === undefined
      ? {}
      : { approval_classes: input.approval_classes }),
  });
  const reviews = normalizeReviews(input.reviews, loaded.authority, invalidDraft);
  return {
    schema_version: ACTION_RULE_AUTHORITY_DRAFT_VERSION,
    state: "disabled",
    authority: loaded.authority,
    digest: loaded.authority.digest,
    reviews,
    created_at: now,
  };
}

/**
 * Upserts reviewed outcomes into one replacement authority behind the fixed
 * semantic Action tools. Preserved rules are recompiled against the incoming
 * catalog and rebound only to an exact replacement of the same Read Boundary.
 */
export function mergeActionRuleAuthorityDraft(input: {
  existing?: ExistingActionRuleAuthorityV1;
  incoming: ActionRuleAuthorityDraftV1;
  now?: string;
}): ActionRuleAuthorityDraftV1 {
  const incoming = parseDraft(input.incoming);
  if (input.existing === undefined) return incoming;
  const existing = input.existing.state === "active"
    ? parseActivation(input.existing)
    : parseDraft(input.existing);
  if (existing.authority.name !== incoming.authority.name
    || existing.authority.action_boundary.name !== incoming.authority.action_boundary.name) {
    throw authorityError(
      "ACTION_RULE_AUTHORITY_NAMESPACE_CONFLICT",
      "The existing verified Action authority uses a different fixed authority or Action Boundary name.",
    );
  }

  const replacementOutcomes = new Set(incoming.authority.rules.map((rule) => rule.rule.outcome));
  const readRevisions = new Map<string, `sha256:${string}`>();
  for (const rule of incoming.authority.rules) {
    const prior = readRevisions.get(rule.read_boundary_name);
    if (prior !== undefined && prior !== rule.read_boundary_digest) {
      throw authorityError(
        "ACTION_RULE_READ_AUTHORITY_AMBIGUOUS",
        `Incoming outcomes disagree about the exact Read Boundary revision for ${rule.read_boundary_name}.`,
      );
    }
    readRevisions.set(rule.read_boundary_name, rule.read_boundary_digest);
  }
  const preservedRules = existing.authority.rules
    .filter((rule) => !replacementOutcomes.has(rule.rule.outcome))
    .map(({ activated_at: _activatedAt, ...rule }) => ({
      ...rule,
      ...(readRevisions.has(rule.read_boundary_name)
        ? { read_boundary_digest: readRevisions.get(rule.read_boundary_name)! }
        : {}),
    }));
  let incomingRules = incoming.authority.rules.map(({ activated_at: _activatedAt, ...rule }) =>
    structuredClone(rule));

  const preservedClasses = existing.authority.approval_classes.flatMap((approvalClass) => {
    const rules = approvalClass.rules.filter((rule) => !replacementOutcomes.has(rule.outcome));
    return rules.length === 0 ? [] : [{ ...approvalClass, rules }];
  });
  const approvalClasses = [...preservedClasses];
  for (const sourceClass of incoming.authority.approval_classes) {
    let incomingClass = structuredClone(sourceClass);
    const collision = approvalClasses.find((candidate) => candidate.name === incomingClass.name);
    if (collision === undefined) {
      approvalClasses.push(structuredClone(incomingClass));
      continue;
    }
    const { rules: _collisionRules, ...collisionPolicy } = collision;
    const { rules: _incomingRules, ...incomingPolicy } = incomingClass;
    if (canonicalJsonStringify(collisionPolicy) !== canonicalJsonStringify(incomingPolicy)) {
      const previousName = incomingClass.name;
      const replacementName = replacementApprovalClassName(incomingClass);
      const outcomes = new Set(incomingClass.rules.map((rule) => rule.outcome));
      incomingRules = incomingRules.map((rule) => {
        if (!outcomes.has(rule.rule.outcome)) return rule;
        if (rule.rule.approval_class !== previousName
          || !rule.effect_envelope.approval_classes.includes(previousName)) {
          throw authorityError(
            "ACTION_RULE_APPROVAL_CLASS_CONFLICT",
            `Outcome ${rule.rule.outcome} does not consistently reference approval class ${previousName}.`,
          );
        }
        return {
          ...rule,
          rule: { ...rule.rule, approval_class: replacementName },
          effect_envelope: {
            ...rule.effect_envelope,
            approval_classes: rule.effect_envelope.approval_classes.map((name) =>
              name === previousName ? replacementName : name),
          },
        };
      });
      incomingClass = { ...incomingClass, name: replacementName };
      if (approvalClasses.some((candidate) => candidate.name === replacementName)) {
        throw authorityError(
          "ACTION_RULE_APPROVAL_CLASS_CONFLICT",
          `The isolated approval authority for ${[...outcomes].join(", ")} conflicts with an existing reviewed class.`,
        );
      }
      approvalClasses.push(incomingClass);
      continue;
    }
    collision.rules = [...collision.rules, ...structuredClone(incomingClass.rules)];
  }
  const reviews = [
    ...existing.reviews.filter((review) => !replacementOutcomes.has(review.outcome)),
    ...structuredClone(incoming.reviews),
  ];
  return buildActionRuleAuthorityDraft({
    name: incoming.authority.name,
    action_boundary_name: incoming.authority.action_boundary.name,
    catalog: incoming.authority.catalog,
    rules: [...preservedRules, ...incomingRules],
    approval_classes: approvalClasses,
    reviews,
    now: input.now ?? incoming.created_at,
  });
}

function replacementApprovalClassName(
  approvalClass: ActionRuleApprovalClassSourceV1,
): string {
  const namespace = approvalClass.name.split(".")[0]!;
  const suffix = canonicalJsonDigest(approvalClass).slice("sha256:".length, "sha256:".length + 12);
  return `${namespace}.revision_${suffix}`;
}

async function withStoredActionPolicies<T>(projectRoot: string, supplied: BoundProjectPolicyStore | undefined,
  operation: (binding: BoundProjectPolicyStore, state: ControlPolicyScopeSnapshot) => Promise<T>): Promise<T | undefined> {
  const binding = supplied ?? await openBoundProjectControlPolicies(projectRoot);
  if (!binding) return undefined;
  try {
    if (supplied) await assertProjectControlPolicyBinding(projectRoot, supplied);
    const current = await binding.repository.scopeSnapshot({ deployment_id: binding.deployment_id,
      scope: { level: "operator" }, kinds: ["action"] });
    if (current.active.length > 1) throw invalidActivation();
    return await operation(binding, current);
  } finally { if (!supplied) await binding.close(); }
}

function actionKey(name: string) { return { scope: { level: "operator" as const }, kind: "action" as const, name: safeName(name) }; }
function actionPointer(revision: ControlPolicyRevision) { return { ...actionKey(revision.name), revision_id: revision.revision_id }; }
function storedActionRecord(authority: ExistingActionRuleAuthorityV1): ControlPolicyRevision {
  return storedOperatorPolicyRecord(actionKey(authority.authority.name), authority.digest,
    { schema_version: OPERATOR_POLICY_RECORD_VERSION, type: "action", authority });
}
function storedActionContent(revision: ControlPolicyRevision): unknown {
  const content = revision.content as Record<string, unknown>;
  if (!content || typeof content !== "object" || content.schema_version !== OPERATOR_POLICY_RECORD_VERSION
    || content.type !== "action" || Object.keys(content).sort().join(",") !== "authority,schema_version,type") throw invalidActivation();
  return content.authority;
}
function parseStoredActionDraft(revision: ControlPolicyRevision): ActionRuleAuthorityDraftV1 {
  const content = storedActionContent(revision);
  const draft = parseDraft(content);
  if (canonicalJsonDigest(content) !== canonicalJsonDigest(draft)) throw invalidDraft();
  assertOperatorPolicyRecord(revision, actionKey(draft.authority.name), draft.digest);
  return draft;
}
function parseStoredActionActivation(revision: ControlPolicyRevision): ReturnType<typeof parseActivationSnapshot> {
  const content = storedActionContent(revision);
  const parsed = parseActivationSnapshot(content);
  if (canonicalJsonDigest(content) !== canonicalJsonDigest(parsed.activation)) throw invalidActivation();
  assertOperatorPolicyRecord(revision, actionKey(parsed.activation.authority.name), parsed.activation.digest);
  return parsed;
}
function actionPolicyEvent(operation: "save_disabled_action" | "activate_action", actor: string,
  current: ControlPolicyScopeSnapshot, revision: ControlPolicyRevision) {
  const previous = operation === "save_disabled_action" ? current.drafts.find((entry) => entry.name === revision.name) : current.active[0];
  return { event_id: randomUUID(), actor, occurred_at: new Date().toISOString(), receipt: { operation,
    name: revision.name, before: previous?.revision_id ?? null, after: revision.revision_id, source_database_changed: false } };
}

async function checkedStoredActionResult(projectRoot: string, binding: BoundProjectPolicyStore, current: ControlPolicyScopeSnapshot,
  loaded: LoadedActionRuleAuthorityV1, activation: ActionRuleAuthorityActivationV1, options: ActiveAuthorityLoadOptions): Promise<LoadedActiveActionRuleAuthorityV1> {
  const reads = await loadActivatedExplorationBoundaries(projectRoot, binding).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  // Caller snapshots cannot replace current repository dependencies. The epoch
  // check also detects a revocation during the asynchronous Read load.
  const result = await checkLoadedReadDependencies(projectRoot, loaded, activation, { ...options, read_boundaries: reads });
  const latest = await binding.repository.deployment(binding.deployment_id);
  if (latest?.epoch !== current.epoch) throw authorityError("POLICY_REVISION_CONFLICT", "Action authority changed while loading its Read dependencies. Retry using the current revision.");
  return result;
}

export async function writeActionRuleAuthorityDraft(
  projectRootInput: string,
  draft: ActionRuleAuthorityDraftV1,
  permit?: ProjectAuthorityMutationPermit,
): Promise<string> {
  return withProjectAuthorityMutation(projectRootInput, (held) => writeActionRuleAuthorityDraftUnlocked(held.projectRoot, draft), { permit });
}

async function writeActionRuleAuthorityDraftUnlocked(projectRootInput: string, draft: ActionRuleAuthorityDraftV1): Promise<string> {
  const projectRoot = path.resolve(projectRootInput);
  parseDraft(draft);
  const target = draftPath(projectRoot, draft.authority.name);
  const stored = await withStoredActionPolicies(projectRoot, undefined, async (binding, current) => {
    const revision = storedActionRecord(parseDraft(draft));
    await commitImmutableControlPolicies(binding, { expected_epoch: current.epoch, revisions: [revision], active: [],
      drafts: [actionPointer(revision)], event: actionPolicyEvent("save_disabled_action", "local_operator", current, revision) });
    return true;
  });
  if (stored) {
    // This is a review export, never the authority source after migration.
    await writePrivateJsonAtomic(target, draft).catch(() => {
      throw authorityError("ACTION_RULE_EXPORT_FAILED", "The disabled Action revision is saved in the control store, but its optional file export could not be written. Authority is unchanged.");
    });
    return projectRelativePath(projectRoot, target);
  }
  await writePrivateJsonAtomic(target, draft);
  return projectRelativePath(projectRoot, target);
}

export async function readActionRuleAuthorityDraft(
  projectRootInput: string,
  name: string,
  policyStore?: BoundProjectPolicyStore,
): Promise<ActionRuleAuthorityDraftV1 | undefined> {
  safeName(name);
  const stored = await withStoredActionPolicies(projectRootInput, policyStore, async (_binding, current) => ({
    draft: current.drafts.find((revision) => revision.name === name),
  }));
  if (stored) return stored.draft ? parseStoredActionDraft(stored.draft) : undefined;
  const parsed = await readOptionalJson(draftPath(path.resolve(projectRootInput), safeName(name)));
  return parsed === undefined ? undefined : parseDraft(parsed);
}

export async function listActionRuleAuthorityDrafts(
  projectRootInput: string,
): Promise<ActionRuleAuthorityDraftV1[]> {
  const projectRoot = path.resolve(projectRootInput);
  const stored = await withStoredActionPolicies(projectRoot, undefined, async (_binding, current) => current.drafts.map(parseStoredActionDraft));
  if (stored) return stored;
  const root = path.join(stateRoot(projectRoot), "drafts");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const drafts: ActionRuleAuthorityDraftV1[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) =>
    left.name.localeCompare(right.name))) {
    const draft = await readActionRuleAuthorityDraft(projectRoot, safeName(entry.name));
    if (draft) drafts.push(draft);
  }
  return drafts;
}

export async function readActionRuleAuthorityActivation(
  projectRootInput: string,
  policyStore?: BoundProjectPolicyStore,
): Promise<ActionRuleAuthorityActivationV1 | undefined> {
  const projectRoot = path.resolve(projectRootInput);
  const stored = await withStoredActionPolicies(projectRoot, policyStore, async (_binding, current) => ({ active: current.active[0] }));
  if (stored) return stored.active ? parseStoredActionActivation(stored.active).activation : undefined;
  const parsed = await readOptionalJson(activePath(projectRoot));
  if (parsed === undefined) return undefined;
  const activation = parseActivation(parsed);
  const immutable = await readOptionalJson(revisionPath(projectRoot, activation.digest));
  if (immutable === undefined
    || canonicalJsonStringify(parseActivation(immutable)) !== canonicalJsonStringify(activation)) {
    throw invalidActivation();
  }
  return activation;
}

export async function activateActionRuleAuthority(input: {
  projectRoot: string;
  name: string;
  expected_digest: string;
  confirmation: string;
  actor: string;
  now?: string;
  mutationPermit?: ProjectAuthorityMutationPermit;
  /** Internal, already-validated runtime binding; never model-supplied authority. */
  runtimePublication?: { binding: BoundProjectPolicyStore; configPath: string; before: string | undefined; after: string };
}): Promise<ActionRuleAuthorityActivationV1> {
  return withProjectAuthorityMutation(input.projectRoot, (held) => activateActionRuleAuthorityUnlocked({ ...input,
    projectRoot: held.projectRoot, mutationPermit: held }), { permit: input.mutationPermit });
}

async function activateActionRuleAuthorityUnlocked(input: Parameters<typeof activateActionRuleAuthority>[0]): Promise<ActionRuleAuthorityActivationV1> {
  const projectRoot = path.resolve(input.projectRoot);
  const stored = await withStoredActionPolicies(projectRoot, input.runtimePublication?.binding, async (binding, current) => {
    const revision = current.drafts.find((entry) => entry.name === safeName(input.name));
    const draft = revision ? parseStoredActionDraft(revision) : undefined;
    const activation = await reviewedActionActivation(input, draft, () => loadActivatedExplorationBoundaries(projectRoot, binding));
    const active = storedActionRecord(activation);
    const change: Omit<ControlPolicyCommit, "deployment_id"> = { expected_epoch: current.epoch, revisions: [active],
      active: [...current.active.filter((entry) => entry.name !== active.name).map((entry) => ({ ...actionKey(entry.name), revision_id: null })), actionPointer(active)],
      drafts: [{ ...actionKey(active.name), revision_id: null }], event: actionPolicyEvent("activate_action", activation.actor, current, active) };
    if (input.runtimePublication) {
      await publishPolicyConfiguration({ projectRoot, ...input.runtimePublication, mutationPermit: input.mutationPermit, change });
    } else await commitImmutableControlPolicies(binding, change);
    return activation;
  });
  if (stored) return stored;
  if (input.runtimePublication) throw authorityError("POLICY_REPOSITORY_MISSING", "Runtime publication requires this project's governed policy repository.");
  const draft = await readActionRuleAuthorityDraft(projectRoot, input.name);
  const activation = await reviewedActionActivation(input, draft, () => loadActivatedExplorationBoundaries(projectRoot));
  const active = activePath(projectRoot);
  const revision = revisionPath(projectRoot, activation.digest);
  const previousActive = await readOptionalText(active);
  const revisionAlreadyExisted = await exists(revision);
  try {
    await writePrivateJsonAtomic(revision, activation);
    await writePrivateJsonAtomic(active, activation);
    await fs.rm(draftPath(projectRoot, activation.authority.name), { force: true });
  } catch (error) {
    if (previousActive === undefined) await fs.rm(active, { force: true }).catch(() => undefined);
    else await writePrivateTextAtomic(active, previousActive).catch(() => undefined);
    if (!revisionAlreadyExisted) await fs.rm(revision, { force: true }).catch(() => undefined);
    await writePrivateJsonAtomic(draftPath(projectRoot, activation.authority.name), draft).catch(() => undefined);
    throw error;
  }
  return activation;
}

async function reviewedActionActivation(input: Parameters<typeof activateActionRuleAuthority>[0], draft: ActionRuleAuthorityDraftV1 | undefined,
  readBoundaries: () => Promise<ActivatedExplorationBoundary[]>): Promise<ActionRuleAuthorityActivationV1> {
  if (!draft) throw authorityError("ACTION_RULE_DRAFT_REQUIRED", "No disabled Action Rule authority is ready to activate.");
  if (draft.digest !== input.expected_digest) {
    throw authorityError("ACTION_RULE_DRAFT_CHANGED", "The disabled Action Rule authority changed. Reload and review the exact current revision.");
  }
  if (input.confirmation !== `ACTIVATE ${draft.digest}`) {
    throw authorityError("ACTION_RULE_CONFIRMATION_REQUIRED", `Enter ACTIVATE ${draft.digest} to publish this exact Action Rule authority.`);
  }
  const loaded = parseActionRuleAuthority(draft.authority, draft.digest);
  assertReadDependenciesActive(loaded, await readBoundaries());
  return {
    schema_version: ACTION_RULE_AUTHORITY_ACTIVATION_VERSION,
    state: "active",
    authority: loaded.authority,
    digest: loaded.authority.digest,
    reviews: structuredClone(draft.reviews),
    actor: reviewedActor(input.actor),
    activated_at: canonicalTimestamp(input.now),
  };
}

export async function loadActiveActionRuleAuthority(
  projectRootInput: string,
  options: {
    read_boundaries?: ActivatedExplorationBoundary[];
    dependency_check?: "all" | "report";
    outcome?: string;
  } = {},
): Promise<LoadedActiveActionRuleAuthorityV1> {
  const projectRoot = path.resolve(projectRootInput);
  const stored = await withStoredActionPolicies(projectRoot, undefined, async (binding, current) => {
    const revision = current.active[0];
    if (!revision) throw Object.assign(new Error("No active semantic Action Rule authority is available."), { code: "ENOENT" });
    const { loaded, activation } = parseStoredActionActivation(revision);
    return checkedStoredActionResult(projectRoot, binding, current, loaded, activation, options);
  });
  if (stored) return stored;
  const activation = await readActionRuleAuthorityActivation(projectRoot);
  if (activation === undefined) {
    throw Object.assign(new Error("No active semantic Action Rule authority is available."), { code: "ENOENT" });
  }
  const loaded = parseActionRuleAuthority(activation.authority, activation.digest);
  return checkLoadedReadDependencies(projectRoot, loaded, activation, options);
}

type ActiveAuthorityLoadOptions = NonNullable<Parameters<typeof loadActiveActionRuleAuthority>[1]>;

/** A runtime owns one compiled snapshot. Files are checked by content on every
 * use, not mtime, claimed digest, or TTL; Read revocation is never cached. */
export function createActiveActionRuleAuthorityLoader(projectRootInput: string, policyStore?: BoundProjectPolicyStore) {
  const projectRoot = path.resolve(projectRootInput);
  let cached: { activeText: string; revisionText: string;
    loaded: LoadedActionRuleAuthorityV1; activation: ActionRuleAuthorityActivationV1 } | undefined;
  return async (options: ActiveAuthorityLoadOptions = {}): Promise<LoadedActiveActionRuleAuthorityV1> => {
    const stored = await withStoredActionPolicies(projectRoot, policyStore, async (binding, current) => {
      const revision = current.active[0];
      if (!revision) {
        cached = undefined;
        throw Object.assign(new Error("No active semantic Action Rule authority is available."), { code: "ENOENT" });
      }
      const text = canonicalJsonStringify(revision);
      let snapshot = cached;
      if (!snapshot || snapshot.activeText !== text) {
        const { activation, loaded } = parseStoredActionActivation(revision);
        freezeAuthoritySnapshot(activation); freezeAuthoritySnapshot(loaded);
        snapshot = { activeText: text, revisionText: text, activation, loaded };
      }
      const result = await checkedStoredActionResult(projectRoot, binding, current, snapshot.loaded, snapshot.activation, options);
      cached = snapshot;
      return result;
    });
    if (stored) return stored;
    const activeText = await readBoundedAuthorityText(activePath(projectRoot));
    if (activeText === undefined) {
      cached = undefined;
      throw Object.assign(new Error("No active semantic Action Rule authority is available."), { code: "ENOENT" });
    }
    let snapshot = cached;
    if (!snapshot || snapshot.activeText !== activeText) {
      const { activation, loaded } = parseActivationSnapshot(JSON.parse(activeText));
      const revisionText = await readBoundedAuthorityText(revisionPath(projectRoot, activation.digest));
      if (revisionText === undefined || (revisionText !== activeText
        && canonicalJsonStringify(parseActivation(JSON.parse(revisionText))) !== canonicalJsonStringify(activation))) {
        throw invalidActivation();
      }
      freezeAuthoritySnapshot(activation);
      freezeAuthoritySnapshot(loaded);
      snapshot = { activeText, revisionText, loaded, activation };
    }
    const result = await checkLoadedReadDependencies(projectRoot, snapshot.loaded, snapshot.activation, options);
    // Recheck both records after the asynchronous dependency load. A removed or
    // replaced pointer cannot be hidden behind a previously compiled snapshot.
    if (await readBoundedAuthorityText(activePath(projectRoot)) !== activeText
      || await readBoundedAuthorityText(revisionPath(projectRoot, snapshot.activation.digest)) !== snapshot.revisionText) {
      cached = undefined;
      throw invalidActivation();
    }
    cached = snapshot;
    return result;
  };
}

async function readBoundedAuthorityText(target: string): Promise<string | undefined> {
  const handle = await fs.open(target, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    const size = (await handle.stat()).size;
    if (size > ACTION_AUTHORITY_LIMITS.sourceBytes) throw invalidActivation();
    // Read at most the accepted size plus one byte, including concurrent growth.
    const bytes = Buffer.alloc(size + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > size) throw invalidActivation();
    return bytes.subarray(0, total).toString("utf8");
  } finally { await handle.close(); }
}

function freezeAuthoritySnapshot(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeAuthoritySnapshot(child);
  Object.freeze(value);
}

async function checkLoadedReadDependencies(
  projectRoot: string,
  loaded: LoadedActionRuleAuthorityV1,
  activation: ActionRuleAuthorityActivationV1,
  options: ActiveAuthorityLoadOptions,
): Promise<LoadedActiveActionRuleAuthorityV1> {
  const readBoundaries = options.read_boundaries
    ?? await loadActivatedExplorationBoundaries(projectRoot);
  const unavailable = unavailableReadDependencies(loaded, readBoundaries);
  if (options.outcome && !loaded.registry.rules.some((entry) => entry.compiled.outcome === options.outcome)) {
    throw authorityError("ACTION_RULE_OUTCOME_UNAVAILABLE", "The requested outcome is not active.");
  }
  const blocked = options.outcome ? unavailable.filter((outcome) => outcome === options.outcome) : unavailable;
  if (options.dependency_check !== "report" && blocked.length) throw staleReadDependency(blocked[0]!);
  // Preserve the exact signed registry and approval classes, including shared counters.
  // Availability is runtime state, never a rewritten authority or a new digest.
  return { ...loaded, activation, ...(unavailable.length ? { unavailable_outcomes: unavailable } : {}) };
}

export async function deactivateActionRuleAuthority(projectRootInput: string, permit?: ProjectAuthorityMutationPermit): Promise<boolean> {
  return withProjectAuthorityMutation(projectRootInput, (held) => deactivateActionRuleAuthorityUnlocked(held.projectRoot), { permit });
}

async function deactivateActionRuleAuthorityUnlocked(projectRootInput: string): Promise<boolean> {
  const stored = await withStoredActionPolicies(projectRootInput, undefined, async (binding, current) => {
    const active = current.active[0];
    if (!active) return { deactivated: false };
    parseStoredActionActivation(active);
    await commitImmutableControlPolicies(binding, { expected_epoch: current.epoch, revisions: [],
      active: [{ ...actionKey(active.name), revision_id: null }],
      event: { event_id: randomUUID(), actor: "local_operator", occurred_at: new Date().toISOString(),
        receipt: { operation: "deactivate_action", before: active.revision_id, after: null, source_database_changed: false } } });
    return { deactivated: true };
  });
  if (stored) return stored.deactivated;
  const target = activePath(path.resolve(projectRootInput));
  if (!await exists(target)) return false;
  await fs.rm(target, { force: true });
  return true;
}

function assertReadDependenciesActive(
  loaded: LoadedActionRuleAuthorityV1,
  boundaries: ActivatedExplorationBoundary[],
): void {
  const unavailable = unavailableReadDependencies(loaded, boundaries);
  if (unavailable.length) throw staleReadDependency(unavailable[0]!);
}

function staleReadDependency(outcome: string): Error {
  return authorityError("ACTION_RULE_READ_AUTHORITY_STALE",
    `Action Rule outcome ${outcome} is not bound to its exact active Read Boundary revision.`);
}

function unavailableReadDependencies(
  loaded: LoadedActionRuleAuthorityV1,
  boundaries: ActivatedExplorationBoundary[],
): string[] {
  const activeByName = new Map(boundaries.map((boundary) => [boundary.pack.name, boundary]));
  const unavailable: string[] = [];
  for (const activated of loaded.registry.rules) {
    const readBoundary = activeByName.get(activated.read_boundary_name);
    if (!readBoundary
      || readBoundary.activation.digest !== activated.read_boundary_digest
      || readBoundary.generation_lock_fingerprint !== activated.compiled.generation_lock_fingerprint
      || readBoundary.source !== activated.compiled.source) {
      unavailable.push(activated.compiled.outcome);
    }
  }
  return unavailable;
}

function parseDraft(value: unknown): ActionRuleAuthorityDraftV1 {
  const record = exactRecord(
    value,
    ["schema_version", "state", "authority", "digest", "reviews", "created_at"],
    invalidDraft,
  );
  if (record.schema_version !== ACTION_RULE_AUTHORITY_DRAFT_VERSION
    || record.state !== "disabled"
    || typeof record.digest !== "string"
    || typeof record.created_at !== "string") throw invalidDraft();
  const loaded = parseActionRuleAuthority(record.authority, record.digest);
  const reviews = normalizeReviews(record.reviews, loaded.authority, invalidDraft);
  canonicalTimestamp(record.created_at);
  return {
    schema_version: ACTION_RULE_AUTHORITY_DRAFT_VERSION,
    state: "disabled",
    authority: loaded.authority,
    digest: loaded.authority.digest,
    reviews,
    created_at: record.created_at,
  };
}

function parseActivation(value: unknown): ActionRuleAuthorityActivationV1 {
  return parseActivationSnapshot(value).activation;
}

function parseActivationSnapshot(value: unknown): {
  activation: ActionRuleAuthorityActivationV1; loaded: LoadedActionRuleAuthorityV1;
} {
  const record = exactRecord(
    value,
    ["schema_version", "state", "authority", "digest", "reviews", "actor", "activated_at"],
    invalidActivation,
  );
  if (record.schema_version !== ACTION_RULE_AUTHORITY_ACTIVATION_VERSION
    || record.state !== "active"
    || typeof record.digest !== "string"
    || typeof record.actor !== "string"
    || typeof record.activated_at !== "string") throw invalidActivation();
  const loaded = parseActionRuleAuthority(record.authority, record.digest);
  const reviews = normalizeReviews(record.reviews, loaded.authority, invalidActivation);
  canonicalTimestamp(record.activated_at);
  return { loaded, activation: {
    schema_version: ACTION_RULE_AUTHORITY_ACTIVATION_VERSION,
    state: "active",
    authority: loaded.authority,
    digest: loaded.authority.digest,
    reviews,
    actor: reviewedActor(record.actor),
    activated_at: record.activated_at,
  } };
}

function normalizeReviews(
  value: unknown,
  authority: ActionRuleAuthorityV1,
  invalid: () => Error,
): ActionRuleAuthorityReviewV1[] {
  if (!Array.isArray(value)) throw invalid();
  const outcomes = authority.action_boundary.rules.map((rule) => rule.outcome).sort();
  const seen = new Set<string>();
  const reviews = value.map((candidate): ActionRuleAuthorityReviewV1 => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw invalid();
    const record = exactRecord(
      candidate,
      ["outcome", "when", "then", "refused", "human_review", "examples"],
      invalid,
    );
    const outcome = safeName(text(record.outcome, "review outcome", 128, invalid));
    if (seen.has(outcome)) throw invalid();
    seen.add(outcome);
    if (!Array.isArray(record.refused) || record.refused.length < 1 || record.refused.length > 16) throw invalid();
    if (!Array.isArray(record.examples) || record.examples.length < 1 || record.examples.length > 16) throw invalid();
    return {
      outcome,
      when: text(record.when, "WHEN review", 1_000, invalid),
      then: text(record.then, "THEN review", 1_000, invalid),
      refused: record.refused.map((item) => text(item, "refusal review", 1_000, invalid)),
      human_review: text(record.human_review, "human-review description", 1_000, invalid),
      examples: record.examples.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
        const example = exactRecord(item, ["kind", "scenario", "result"], invalid);
        if (example.kind !== "eligible" && example.kind !== "ineligible" && example.kind !== "human_review") {
          throw invalid();
        }
        return {
          kind: example.kind,
          scenario: text(example.scenario, "review example scenario", 1_000, invalid),
          result: text(example.result, "review example result", 1_000, invalid),
        };
      }),
    };
  }).sort((left, right) => left.outcome.localeCompare(right.outcome));
  if (canonicalJsonStringify(reviews.map((review) => review.outcome).sort()) !== canonicalJsonStringify(outcomes)) {
    throw invalid();
  }
  return reviews;
}

function text(value: unknown, label: string, maximum: number, invalid: () => Error): string {
  if (typeof value !== "string") throw invalid();
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || [...normalized].length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw authorityError("ACTION_RULE_REVIEW_INVALID", `${label} must contain 1 through ${maximum} safe characters.`);
  }
  return normalized;
}

function exactRecord(value: unknown, keys: string[], invalid: () => Error): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (canonicalJsonStringify(Object.keys(record).sort()) !== canonicalJsonStringify([...keys].sort())) {
    throw invalid();
  }
  return record;
}

function invalidDraft(): Error {
  return authorityError("ACTION_RULE_DRAFT_INVALID", "The disabled Action Rule authority is invalid.");
}

function invalidActivation(): Error {
  return authorityError("ACTION_RULE_AUTHORITY_STALE", "The active Action Rule authority failed its integrity check.");
}

function authorityError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function safeName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(normalized)) {
    throw authorityError("ACTION_RULE_NAME_INVALID", "Action Rule authority names must be fixed reviewed identifiers.");
  }
  return normalized;
}

function reviewedActor(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > 128) {
    throw authorityError("ACTION_RULE_ACTOR_INVALID", "Operator identity must contain from 1 through 128 characters.");
  }
  return normalized;
}

function canonicalTimestamp(value?: string): string {
  const normalized = value ?? new Date().toISOString();
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    throw authorityError("ACTION_RULE_TIMESTAMP_INVALID", "Action Rule timestamps must use canonical UTC form.");
  }
  return normalized;
}

function stateRoot(projectRoot: string): string {
  return path.join(projectRoot, ".synapsor", "action-rules");
}

function draftPath(projectRoot: string, name: string): string {
  return path.join(stateRoot(projectRoot), "drafts", safeName(name), "authority.json");
}

function activePath(projectRoot: string): string {
  return path.join(stateRoot(projectRoot), "active.json");
}

function revisionPath(projectRoot: string, digest: `sha256:${string}`): string {
  return path.join(stateRoot(projectRoot), "revisions", digest.slice("sha256:".length), "authority.json");
}

async function readOptionalJson(target: string): Promise<unknown | undefined> {
  const text = await readOptionalText(target);
  return text === undefined ? undefined : JSON.parse(text) as unknown;
}

async function readOptionalText(target: string): Promise<string | undefined> {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writePrivateJsonAtomic(target: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > ACTION_AUTHORITY_LIMITS.sourceBytes) {
    throw authorityError("ACTION_RULE_AUTHORITY_TOO_LARGE", "The complete reviewed authority exceeds the supported 64 MiB storage budget.");
  }
  await writePrivateTextAtomic(target, text);
}

async function writePrivateTextAtomic(target: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, target);
}

function projectRelativePath(projectRoot: string, target: string): string {
  const relative = path.relative(projectRoot, target).replace(/\\/gu, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw authorityError("ACTION_RULE_PATH_INVALID", "Action Rule artifacts must remain inside the project.");
  }
  return `./${relative}`;
}

// Keep a direct version reference in the generated declarations and surface
// accidental package skew during compilation.
void ACTION_RULE_AUTHORITY_VERSION;

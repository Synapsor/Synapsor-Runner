import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { ActionRuleScalarTypeSpecV1 } from "@synapsor/spec";
import { buildActionRuleAuthoringCatalog, type BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";
import {
  buildActionRuleAuthorityDraft,
  mergeActionRuleAuthorityDraft,
  readActionRuleAuthorityActivation,
  readActionRuleAuthorityDraft,
  readActionRuleAuthorityRevisionBaseline,
  writeActionRuleAuthorityDraftIfCurrent,
  type ActionRuleAuthorityActivationV1,
  type ActionRuleAuthorityDraftV1,
} from "./action-rule-authority.js";
import { actionRuleDraftDiagnostics, actionRuleModelDraftFromAuthority, compileActionRuleModelDraft,
  type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { canonicalJsonDigest, type ActionBoundarySharedLimitV1 } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest,
  rolePostureFingerprint, schemaFingerprintForInspection } from "./auto-boundary.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { assertReadAuthoringBindings } from "./control-policy-record.js";
import { loadActionRuleIntentSkeletons, type ActionRuleIntentSkeletonV1 } from "./action-rule-intent-skeleton.js";
import type { BoundaryAccessNotice } from "./boundary-cli-picker.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

export type ManualSemanticActionPrompter = {
  choose(title: string, choices: Array<{ value: string; label: string; detail?: string; disabled?: boolean }>,
    context?: string[], initialValue?: string): Promise<string | undefined>;
  text(label: string, options?: { defaultValue?: string; title?: string; context?: string[] }): Promise<string | undefined>;
  message(title: string, lines: string[], backLabel?: string): Promise<void>;
};

type ManualIntegerType = Extract<ActionRuleScalarTypeSpecV1, { kind: "integer" }>;
type ManualComparison = Extract<ActionRuleModelDraftV1["require"], { kind: "compare" }>;

function manualEligibilityCondition(draft: ActionRuleModelDraftV1): ManualComparison | undefined {
  const binding = draft.verification.resources[0]?.binding;
  const input = draft.inputs?.[0];
  const conditions = draft.require.kind === "all" ? draft.require.expressions : [draft.require];
  let equality: ManualComparison | undefined;
  for (const condition of conditions) {
    if (condition.kind !== "compare" || condition.right.kind !== "literal") return undefined;
    if (condition.operator === "eq" && condition.left.kind === "field" && condition.left.binding === binding
      && manualEligibilityType(condition.right.value_type) && !equality) {
      equality = condition;
      continue;
    }
    // These guards repeat the input envelope. Any narrower or unrelated rule
    // needs the guided/advanced editor and must not disappear during a form edit.
    if (!input || condition.left.kind !== "input" || condition.left.name !== input.name
      || canonicalJsonDigest(condition.right.value_type) !== canonicalJsonDigest(input.type)
      || !((condition.operator === "gte" && input.minimum !== undefined && condition.right.value === input.minimum)
        || (condition.operator === "lte" && input.maximum !== undefined && condition.right.value === input.maximum))) return undefined;
  }
  return equality;
}

const overallLimit = (limit: ActionBoundarySharedLimitV1) => limit.scope === "capability" || limit.scope === "boundary";
const customerLimit = (limit: ActionBoundarySharedLimitV1) => limit.scope === "tenant" || limit.scope === "tenant_principal";

export type ManualActionValues = {
  intent: string;
  name: string;
  outcome: string;
  binding: string;
  resource: string;
  field: string;
  /** Exact inspected integer type for the selected target field, including its unit. */
  input_type: ManualIntegerType;
  input_name: string;
  input_description: string;
  minimum: number;
  maximum: number;
  eligibility_field: string;
  eligibility_value: string | number | boolean;
  eligibility_type: ActionRuleScalarTypeSpecV1;
  approval_mode: "human" | "policy";
  required_role: string;
  required_approvals: number;
  auto_maximum?: number;
  overall_maximum?: number;
  overall_window_seconds?: number;
  customer_maximum?: number;
  customer_window_seconds?: number;
  review: ActionRuleModelDraftV1["review"];
  /** Exact representable source retained while editing an existing outcome. */
  base?: ActionRuleModelDraftV1;
};

export function manualSemanticEditBlocker(draft: ActionRuleModelDraftV1): string | undefined {
  const resource = draft.verification.resources[0];
  if (draft.verification.resources.length !== 1 || !resource || resource.source.kind !== "subject_ref") {
    return "MANUAL_SEMANTIC_ACTION_UNSUPPORTED: this editor supports exactly one subject-referenced verification row.";
  }
  if (draft.effect.operation !== "update" || draft.effect.writeback !== "proposal_only" || draft.effect.atomic_updates?.length) {
    return "MANUAL_SEMANTIC_ACTION_UNSUPPORTED: this editor supports proposal-only single-row UPDATE actions without atomic companions.";
  }
  if (draft.effect.target_resource !== resource.resource || draft.effect.target_binding !== resource.binding
    || draft.effect.allowed_fields.length !== 1 || Object.keys(draft.effect.set).length !== 1) {
    return "MANUAL_SEMANTIC_ACTION_UNSUPPORTED: this editor requires one verified target row and one updated field.";
  }
  const updated = draft.effect.allowed_fields[0]!.name;
  const set = draft.effect.set[updated];
  if (!set || set.kind !== "input" || draft.inputs?.length !== 1 || draft.inputs[0]!.name !== set.name
    || draft.inputs[0]!.type.kind !== "integer"
    || Object.values(draft.derive).some((value) => value.kind !== "input" || value.name !== set.name)) {
    return "MANUAL_SEMANTIC_ACTION_UNSUPPORTED: this editor supports one bounded integer input, including unchanged input aliases, but not computed effects. Use guided revision for derived business expressions.";
  }
  if (!manualEligibilityCondition(draft)) {
    return "MANUAL_SEMANTIC_ACTION_UNSUPPORTED: this editor supports one inspected equality condition and explicit checks matching the input range. Use guided revision to preserve additional eligibility conditions.";
  }
  if (draft.approval.mode === "policy" && (!draft.approval.auto_approve_when
    || draft.approval.auto_approve_when.kind !== "compare" || draft.approval.auto_approve_when.operator !== "lte"
    || draft.approval.auto_approve_when.left.kind !== "input" || draft.approval.auto_approve_when.left.name !== draft.inputs[0]!.name
    || draft.approval.auto_approve_when.right.kind !== "literal" || draft.approval.shared_limits.length !== 2
    || draft.approval.shared_limits.some((limit) => limit.kind !== "count")
    || !draft.approval.shared_limits.some(overallLimit)
    || !draft.approval.shared_limits.some(customerLimit))) {
    return "MANUAL_SEMANTIC_ACTION_UNSUPPORTED: this editor supports one automatic input threshold with an overall and trusted-account/customer rolling count. Other limits require guided revision and are preserved unchanged.";
  }
  if (draft.approval.mode === "human" && draft.approval.shared_limits.length) {
    return "MANUAL_SEMANTIC_ACTION_UNSUPPORTED: human approval actions must not carry automatic rolling limits in this editor.";
  }
  return undefined;
}

export function manualSemanticActionDraft(values: ManualActionValues): ActionRuleModelDraftV1 {
  const base = values.base ? structuredClone(values.base) : undefined;
  if (base) {
    const blocker = manualSemanticEditBlocker(base);
    if (blocker) throw new Error(blocker);
  }
  const priorInput = base?.inputs?.[0];
  const inputType = structuredClone(values.input_type);
  const priorResource = base?.verification.resources[0];
  const priorField = base?.effect.allowed_fields[0];
  const verificationName = base?.verification.name ?? `${values.name}.verification`;
  const effectName = base?.effect.name ?? `${values.name}.effect`;
  const approvalName = base?.approval.class_name ?? `${values.name}.approval`;
  const preservedFields = priorResource?.fields ?? [];
  const verificationFields = [...new Set([...preservedFields, values.eligibility_field])];
  const approvalBase = base?.approval;
  const eligibility: ManualComparison = { kind: "compare", operator: "eq",
    left: { kind: "field", binding: values.binding, field: values.eligibility_field },
    right: { kind: "literal", value: values.eligibility_value, value_type: values.eligibility_type } };
  const requirement: ActionRuleModelDraftV1["require"] = base?.require.kind === "all"
    ? { ...base.require, expressions: base.require.expressions.map((condition) => {
      if (condition.kind === "compare" && condition.left.kind === "input" && condition.right.kind === "literal") {
        return { ...condition, left: { ...condition.left, name: values.input_name }, right: { ...condition.right,
          value_type: inputType, value: condition.operator === "gte" ? values.minimum : values.maximum } };
      }
      return eligibility;
    }) } : eligibility;
  return {
    ...(base ?? {}),
    schema_version: "synapsor.action-rule-model-draft.v1",
    name: values.name,
    outcome: values.outcome,
    inputs: [{ ...(priorInput ?? {}), name: values.input_name, description: values.input_description, type: inputType,
      minimum: values.minimum, maximum: values.maximum }],
    verification: { ...(base?.verification ?? {}), name: verificationName, resources: [{ ...(priorResource ?? {}), binding: values.binding, resource: values.resource,
      source: { kind: "subject_ref" }, fields: verificationFields }] },
    effect: { ...(base?.effect ?? {}), name: effectName, operation: "update", target_resource: values.resource,
      target_binding: values.binding, allowed_fields: [{ ...(priorField ?? {}), name: values.field, minimum: values.minimum, maximum: values.maximum }],
      set: { [values.field]: { kind: "input", name: values.input_name } }, writeback: "proposal_only" },
    require: requirement,
    derive: Object.fromEntries(Object.entries(base?.derive ?? {}).map(([name, value]) => [name, { ...value, name: values.input_name }])),
    approval: values.approval_mode === "human"
      ? { class_name: approvalName, mode: "human", required_role: values.required_role,
        required_approvals: values.required_approvals, shared_limits: [] }
      : { class_name: approvalName, mode: "policy", required_role: values.required_role,
        required_approvals: values.required_approvals,
        auto_approve_when: { kind: "compare", operator: "lte", left: { kind: "input", name: values.input_name },
          right: { kind: "literal", value: values.auto_maximum!, value_type: inputType } },
        shared_limits: policyLimits(approvalBase, values) },
    ttl_seconds: base?.ttl_seconds ?? 300,
    review: values.review,
  };
}

function policyLimits(base: ActionRuleModelDraftV1["approval"] | undefined,
  values: ManualActionValues): ActionBoundarySharedLimitV1[] {
  const existing = base?.mode === "policy" ? base.shared_limits : undefined;
  if (existing?.length === 2
    && existing.some(overallLimit)
    && existing.some(customerLimit)) {
    return existing.map((limit) => overallLimit(limit)
      ? { ...limit, maximum: values.overall_maximum!, window_seconds: values.overall_window_seconds! }
      : { ...limit, maximum: values.customer_maximum!, window_seconds: values.customer_window_seconds! });
  }
  return [
    { id: `${values.outcome}.overall`, kind: "count", scope: "capability", capability: values.outcome,
      maximum: values.overall_maximum!, window_seconds: values.overall_window_seconds! },
    { id: `${values.outcome}.customer`, kind: "count", scope: "tenant_principal", capability: values.outcome,
      maximum: values.customer_maximum!, window_seconds: values.customer_window_seconds! },
  ];
}

async function currentManualAuthority(projectRoot: string, name: string): Promise<ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1 | undefined> {
  const draft = await readActionRuleAuthorityDraft(projectRoot, name);
  if (draft) return draft;
  const active = await readActionRuleAuthorityActivation(projectRoot);
  return active?.authority.name === name ? active : undefined;
}

export function manualAuthoritySnapshotMatches(expected: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1 | undefined,
  current: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1 | undefined): boolean {
  return expected === undefined || current === undefined
    ? expected === current
    : canonicalJsonDigest(expected) === canonicalJsonDigest(current);
}

export function assertManualReadSnapshot(expected: NonNullable<Awaited<ReturnType<typeof readProjectReadAuthoring>>>,
  current: NonNullable<Awaited<ReturnType<typeof readProjectReadAuthoring>>>, inspection: SchemaInspection,
  candidateDigest: `sha256:${string}`): void {
  assertReadAuthoringBindings(expected.bindings, current.bindings);
  const selected = current.selected;
  if (!selected || explorationBoundaryCandidateDigest(selected.progress.candidate) !== candidateDigest
    || schemaFingerprintForInspection(inspection) !== selected.draft_lock.schema_fingerprint
    || rolePostureFingerprint(inspection) !== selected.draft_lock.role_posture_fingerprint) {
    throw new Error("MANUAL_ACTION_READ_REVIEW_CHANGED: the reviewed Read candidate or inspected database posture changed during manual Action editing. Reopen the current Read review; no Action draft was saved.");
  }
}

async function assertManualReadStillCurrent(projectRoot: string,
  expected: NonNullable<Awaited<ReturnType<typeof readProjectReadAuthoring>>>, inspection: SchemaInspection,
  candidateDigest: `sha256:${string}`): Promise<void> {
  const current = await readProjectReadAuthoring(projectRoot);
  if (!current) throw new Error("MANUAL_ACTION_READ_REVIEW_CHANGED: governed Read metadata is unavailable. Reopen the current Read review; no Action draft was saved.");
  assertManualReadSnapshot(expected, current, inspection, candidateDigest);
}

export async function runManualSemanticActionEditor(input: {
  projectRoot: string;
  prompter: ManualSemanticActionPrompter;
  inspection: SchemaInspection;
  existingAuthority?: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1;
  env?: NodeJS.ProcessEnv;
}): Promise<BoundaryAccessNotice> {
  const governed = await readProjectReadAuthoring(input.projectRoot);
  const selected = governed?.selected;
  if (!selected) return manualNotice("Manual semantic ActionRule needs reviewed Read metadata.", [
    "Select a governed Read Boundary before creating an ActionRule.",
    "No Action authority or source data changed.",
  ]);
  const boundary = selected.progress.candidate;
  const lock = selected.draft_lock;
  if (schemaFingerprintForInspection(input.inspection) !== lock.schema_fingerprint
    || rolePostureFingerprint(input.inspection) !== lock.role_posture_fingerprint) {
    return manualNotice("Manual semantic ActionRule needs a fresh Read review.", [
      "The inspected schema or database-role posture no longer matches this reviewed Read snapshot.",
      "Run the Read rescan/review, then reopen the manual ActionRule editor. No Action draft changed.",
    ]);
  }
  const readDigest = explorationBoundaryCandidateDigest(boundary);
  const expectedRead = structuredClone(governed);
  const expectedActionBaseline = await readActionRuleAuthorityRevisionBaseline(input.projectRoot);
  const authorityName = input.existingAuthority?.authority.name ?? `${boundary.pack.name}_rules`;
  const existing = await currentManualAuthority(input.projectRoot, authorityName);
  if (!manualAuthoritySnapshotMatches(input.existingAuthority, existing)) return manualNotice("Manual semantic ActionRule needs the current Action revision.", [
    "The Action draft changed before manual editing began. Reopen the current Action review; no Action draft or source data changed.",
  ]);
  if (existing?.authority.rules.some((rule) => rule.read_boundary_name !== boundary.pack.name)) {
    return manualNotice("Manual semantic edit refused.", [
      "The current Action authority has a different Read dependency. This editor will not rebind or drop unrelated outcomes.",
      "Open the original Read review for that outcome; no Action draft changed.",
    ]);
  }
  const built = buildActionRuleAuthoringCatalog({ boundary, inspection: input.inspection,
    ...(existing ? { retainedCatalog: existing.authority.catalog } : {}) });
  const mode = await input.prompter.choose("MANUAL SEMANTIC ACTIONRULE", [
    { value: "new", label: "Create a new current ActionRule", detail: "Starts from one saved business intent or a typed operator intent; no action is inferred." },
    ...(existing ? [{ value: "edit", label: "Edit one current ActionRule", detail: "Only the supported single-row UPDATE shape is editable; all other outcomes stay unchanged." }] : []),
    { value: "back", label: "Back" },
  ], ["This editor saves only a disabled replacement. It never activates, approves, applies, or queries source rows."], existing ? "edit" : "new");
  if (!mode || mode === "back") return manualNotice("Manual semantic ActionRule kept unchanged.", ["No Action authority or source data changed."]);
  let initial: ManualActionValues | undefined;
  if (mode === "edit") {
    const selectedOutcome = await selectEditableOutcome(input.prompter, existing!, built);
    if (!selectedOutcome) return manualNotice("Manual semantic edit kept unchanged.", ["No Action authority or source data changed."]);
    if (typeof selectedOutcome === "string") return manualNotice("Manual semantic edit refused.", [selectedOutcome, "The existing outcome remains unchanged."]);
    initial = selectedOutcome;
  } else {
    const skeletons = await loadActionRuleIntentSkeletons({ projectRoot: input.projectRoot,
      binding: { boundary_name: boundary.pack.name, generation_lock_fingerprint: boundary.generation_lock_fingerprint,
        schema_fingerprint: lock.schema_fingerprint, role_posture_fingerprint: lock.role_posture_fingerprint },
      builtCatalog: built, readBoundaryDigest: readDigest, preparedDrafts: preparedCurrentDrafts(existing) });
    const intent = await selectManualIntent(input.prompter, skeletons.skeletons);
    if (!intent) return manualNotice("Manual semantic ActionRule kept unchanged.", ["No Action authority or source data changed."]);
    initial = blankValues(intent.intent);
  }
  let edit = await collectManualActionEdit(input.prompter, built, initial, mode === "edit");
  if (!edit) return manualNotice("Manual semantic ActionRule kept unchanged.", ["No Action authority or source data changed."]);
  while (true) {
    const { draft, values } = edit;
    try {
    const compiled = compileActionRuleModelDraft({ draft, builtCatalog: built, readBoundary: boundary, readBoundaryDigest: readDigest,
      authorityName: existing?.authority.name ?? `${boundary.pack.name}_rules`,
      actionBoundaryName: existing?.authority.action_boundary.name ?? `${boundary.pack.name}_actions` });
    const incoming = buildActionRuleAuthorityDraft({ name: compiled.loaded.authority.name,
      action_boundary_name: compiled.loaded.authority.action_boundary.name, catalog: compiled.loaded.authority.catalog,
      rules: [{ read_boundary_name: boundary.pack.name, read_boundary_digest: readDigest,
        verification_boundary: compiled.verification_boundary, effect_envelope: compiled.effect_envelope, rule: compiled.rule }],
      approval_classes: [compiled.approval_class], reviews: [{ outcome: compiled.rule.outcome, ...compiled.review }] });
    const replacement = mergeActionRuleAuthorityDraft({ existing, incoming });
    await withProjectAuthorityMutation(input.projectRoot, async (held) => {
      await assertManualReadStillCurrent(input.projectRoot, expectedRead, input.inspection, readDigest);
      await writeActionRuleAuthorityDraftIfCurrent(input.projectRoot, replacement, expectedActionBaseline, held);
    });
      return { tone: "success", title: "Manual semantic ActionRule saved disabled.", lines: [
        `Outcome: ${compiled.rule.outcome}.`,
        existing ? `A disabled replacement preserves ${replacement.authority.rules.length - 1} unrelated current outcome(s).` : "No Action authority is active from this save.",
        "Review this exact disabled Verified Action Boundary separately before activation. No source data changed.",
      ] };
    } catch (error) {
      const recovery = await reviewManualActionFailure(error, { builtCatalog: built, verification: draft.verification }, input.prompter);
      if (recovery === "inspect") return manualNotice("Manual semantic ActionRule needs inspection.", [
        "The local compile or save did not finish normally. Reopen and inspect the saved revision before another save.",
        "No source database change was made by this editor.",
      ]);
      if (recovery !== "edit") return manualNotice("Manual semantic ActionRule was not saved.", ["The current authority and source data are unchanged."]);
      const revised = await collectManualActionEdit(input.prompter, built, values, mode === "edit");
      if (!revised) return manualNotice("Manual semantic ActionRule kept unchanged.", ["No Action authority or source data changed."]);
      edit = revised;
    }
  }
}

/** A local failure view owns no compile, save, retry or database authority. */
export async function reviewManualActionFailure(error: unknown,
  context: Parameters<typeof actionRuleDraftDiagnostics>[1], prompter: ManualSemanticActionPrompter): Promise<string | undefined> {
  const diagnostics = actionRuleDraftDiagnostics(error, context);
  const details = diagnostics.flatMap((diagnostic) => [
    `${diagnostic.code}${diagnostic.path ? ` at ${diagnostic.path}` : ""}: ${diagnostic.message}`,
    `Repair owner: ${diagnostic.repair}.`,
    ...(diagnostic.correction ? [
      `Reviewed correction: ${diagnostic.correction.operation} at ${diagnostic.correction.path}.`,
      `Evidence: ${diagnostic.correction.resource} (${diagnostic.correction.binding}); catalog ${diagnostic.correction.catalog_digest}.`,
    ] : []),
    ...(diagnostic.next_action ? [`Next: ${diagnostic.next_action}.`] : []),
  ]);
  if (!diagnostics.length || diagnostics.some(diagnostic => diagnostic.presentation !== "reviewed_grammar")) {
    await prompter.message("MANUAL ACTIONRULE NEEDS INSPECTION", details,
      "Reopen the saved revision before another save. This failure is not a collected-answer repair.");
    return "inspect";
  }
  await prompter.message("MANUAL ACTIONRULE NEEDS REPAIR", details, "Review repair options");
  return await prompter.choose("MANUAL ACTIONRULE NEEDS REPAIR", [
    { value: "edit", label: "Edit collected answers", detail: "Return to the supported manual fields. Runner will compile again; no authority is granted." },
    { value: "back", label: "Keep draft unchanged", detail: "Preserve current authority and leave this correction unresolved." },
  ], ["The diagnostic is evidence, not an automatic authority change."], "edit");

}

async function selectManualIntent(prompter: ManualSemanticActionPrompter,
  skeletons: ActionRuleIntentSkeletonV1[]): Promise<{ intent: string } | undefined> {
  const choice = await prompter.choose("SELECT BUSINESS INTENT", [
    ...skeletons.map((skeleton, index) => ({ value: String(index), label: skeleton.intent,
      detail: skeleton.continuation.state === "exact_current_draft"
        ? "Current draft is linked exactly; select every changed component explicitly."
        : "Incomplete skeleton only; select every action component explicitly." })),
    { value: "typed", label: "Enter a new business intent", detail: "Runner will not infer an outcome, target, field, policy, or limit." },
    { value: "back", label: "Back" },
  ], ["Saved skeletons are not ActionRules and cannot grant authority."]);
  if (!choice || choice === "back") return undefined;
  if (choice !== "typed") {
    const skeleton = skeletons[Number(choice)];
    if (!skeleton) return undefined;
    const checkpoint = manualCheckpointComponentLines(skeleton);
    if (checkpoint.length) {
      await prompter.message("SAVED REVIEWED COMPONENTS", [
        "Saved components are untrusted starting context only. This editor requires explicit current selections before it saves a replacement.",
        "Components marked Needs revalidation must be selected again from the current inspected catalog; the full compiler remains mandatory.",
        ...checkpoint,
      ]);
    }
    return { intent: skeleton.intent };
  }
  const intent = await requiredText(prompter, "Business intent", undefined, "Describe one bounded business change.");
  return intent ? { intent } : undefined;
}

/** Renders exact saved selections without making the terminal editor a JSON editor. */
export function manualCheckpointComponentLines(skeleton: ActionRuleIntentSkeletonV1): string[] {
  const phases = [
    ["Verification", skeleton.verification],
    ["Effect", skeleton.effect],
    ["Policy", skeleton.policy],
  ] as const;
  const lines: string[] = [];
  for (const [phase, state] of phases) {
    if (state.state !== "checkpoint" && state.state !== "needs_revalidation") continue;
    const component = state.component;
    const summary = checkpointComponentSummary(phase, component, state.state);
    lines.push(...summary);
  }
  if (skeleton.checkpoint_rule?.state === "checkpoint" || skeleton.checkpoint_rule?.state === "needs_revalidation") {
    lines.push(...checkpointComponentSummary("Rule", skeleton.checkpoint_rule.component, skeleton.checkpoint_rule.state));
  }
  return lines;
}

function checkpointComponentSummary(phase: string, component: Record<string, unknown>,
  state: "checkpoint" | "needs_revalidation"): string[] {
  const lines = [`${phase}: ${state === "checkpoint" ? "reviewed saved component" : "saved component needs revalidation"}.`];
  for (const key of ["name", "outcome", "operation", "target_resource", "target_binding", "class_name", "mode", "required_role", "required_approvals", "ttl_seconds"]) {
    const value = component[key];
    if (typeof value === "string" || typeof value === "number") lines.push(`${phase} ${key.replaceAll("_", " ")}: ${value}.`);
  }
  const resources = records(component.resources);
  for (const resource of resources) {
    const binding = stringValue(resource.binding), resourceName = stringValue(resource.resource);
    const fields = strings(resource.fields);
    if (binding && resourceName) lines.push(`${phase} resource: ${resourceName} as ${binding}${fields.length ? `; fields ${fields.join(", ")}` : ""}.`);
  }
  const fields = records(component.allowed_fields);
  if (fields.length) {
    const names = fields.map((field) => stringValue(field.name)).filter((name): name is string => name !== undefined);
    if (names.length) lines.push(`${phase} allowed fields: ${names.join(", ")}.`);
  }
  const limits = records(component.shared_limits);
  for (const limit of limits) {
    const scope = stringValue(limit.scope), maximum = numberValue(limit.maximum), window = numberValue(limit.window_seconds);
    if (scope && maximum !== undefined && window !== undefined) lines.push(`${phase} rolling limit: ${scope}, ${maximum} in ${window} seconds.`);
  }
  if (component.require !== undefined) lines.push(`${phase} eligibility predicate: reviewed saved predicate.`);
  if (component.auto_approve_when !== undefined) lines.push(`${phase} automatic predicate: reviewed saved predicate.`);
  return lines;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

function preparedCurrentDrafts(existing: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1 | undefined) {
  if (!existing) return [];
  return existing.authority.rules.flatMap((rule) => {
    const review = existing.reviews.find((entry) => entry.outcome === rule.rule.outcome);
    if (!review) return [];
    const draft = actionRuleModelDraftFromAuthority({ authority: existing.authority, outcome: rule.rule.outcome,
      review, preserveVerificationFields: true });
    return [{ outcome: draft.outcome, digest: canonicalJsonDigest(draft), draft }];
  });
}

async function selectEditableOutcome(prompter: ManualSemanticActionPrompter,
  existing: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1, built: BuiltActionRuleAuthoringCatalogV1): Promise<ManualActionValues | string | undefined> {
  const choices = existing.authority.rules.map((rule) => ({ value: rule.rule.outcome, label: rule.rule.outcome,
    detail: "Inspect the current semantic rule before deciding whether this bounded editor can represent it." })).concat([{ value: "back", label: "Back", detail: "Keep the current authority unchanged." }]);
  const outcome = await prompter.choose("EDIT CURRENT SEMANTIC ACTIONRULE", choices, ["Unsupported outcomes are preserved, never simplified."]);
  if (!outcome || outcome === "back") return undefined;
  const review = existing.reviews.find((entry) => entry.outcome === outcome);
  if (!review) return `MANUAL_SEMANTIC_ACTION_UNSUPPORTED: ${outcome} has no retained review summary.`;
  const draft = actionRuleModelDraftFromAuthority({ authority: existing.authority, outcome, review, preserveVerificationFields: true });
  const blocker = manualSemanticEditBlocker(draft);
  if (blocker) return blocker;
  return valuesFromSupportedDraft(draft, built);
}

function valuesFromSupportedDraft(draft: ActionRuleModelDraftV1, built: BuiltActionRuleAuthoringCatalogV1): ManualActionValues {
  const resource = draft.verification.resources[0]!;
  const input = draft.inputs![0]!;
  const effect = draft.effect.allowed_fields[0]!;
  const condition = manualEligibilityCondition(draft);
  const policy = draft.approval.mode === "policy" ? draft.approval : undefined;
  const overall = policy?.shared_limits.find(overallLimit);
  const customer = policy?.shared_limits.find(customerLimit);
  const field = built.authoring.resources.find((candidate) => candidate.name === resource.resource)?.fields
    .find((candidate) => candidate.name === effect.name);
  if (!field || field.type.kind !== "integer" || !condition || condition.right.kind !== "literal"
    || !manualEligibilityType(condition.right.value_type)) throw new Error("Manual editor preflight lost its supported field shape.");
  return {
    intent: draft.review.then, name: draft.name, outcome: draft.outcome, binding: resource.binding, resource: resource.resource,
    field: effect.name, input_type: structuredClone(field.type), input_name: input.name, input_description: input.description,
    minimum: input.minimum ?? effect.minimum ?? 0, maximum: input.maximum ?? effect.maximum ?? 1,
    eligibility_field: (condition.left as { field: string }).field, eligibility_value: condition.right.value as string | number | boolean,
    eligibility_type: structuredClone(condition.right.value_type),
    approval_mode: draft.approval.mode, required_role: draft.approval.required_role, required_approvals: draft.approval.required_approvals,
    ...(policy ? { auto_maximum: Number((policy.auto_approve_when as any).right.value), overall_maximum: overall!.maximum,
      overall_window_seconds: overall!.window_seconds, customer_maximum: customer!.maximum, customer_window_seconds: customer!.window_seconds } : {}),
    review: structuredClone(draft.review),
    base: structuredClone(draft),
  };
}

function blankValues(intent: string): ManualActionValues {
  return { intent, name: "", outcome: "", binding: "record", resource: "", field: "", input_name: "value",
    input_type: { kind: "integer" }, input_description: "", minimum: 0, maximum: 1, eligibility_field: "", eligibility_value: 0, eligibility_type: { kind: "integer" },
    approval_mode: "human", required_role: "", required_approvals: 1,
    review: { when: "", then: "", refused: [], human_review: "", examples: [] } };
}

export async function collectManualActionEdit(prompter: ManualSemanticActionPrompter, built: BuiltActionRuleAuthoringCatalogV1,
  initial: ManualActionValues, lockOutcome = false): Promise<{ values: ManualActionValues; draft: ActionRuleModelDraftV1 } | undefined> {
  if (lockOutcome && initial.base) {
    const blocker = manualSemanticEditBlocker(initial.base);
    if (blocker) {
      await prompter.message("MANUAL ACTIONRULE UNAVAILABLE", [blocker, "The existing outcome remains unchanged."]);
      return undefined;
    }
    const threshold = currentAutomaticThreshold(initial.base);
    const choice = await chooseExactValue(prompter, "EDIT CURRENT BUSINESS RULE", [
      ...(threshold ? [{ value: "automatic_maximum", label: "Automatic approval maximum",
        detail: `Current: ${threshold.value}. Edit this limit and review its wording; all other settings stay unchanged.` }] : []),
      { value: "full", label: "Edit all settings", detail: "Open the full supported manual form for changes to multiple settings." },
      { value: "back", label: "Back", detail: "Keep the current draft and live authority unchanged." },
    ], currentManualRuleSummary(initial.base), threshold ? "automatic_maximum" : "full");
    if (!choice || choice === "back") return undefined;
    if (choice === "automatic_maximum" && threshold) {
      const maximum = await integerText(prompter, "Automatic approval maximum", threshold.value, threshold.minimum, threshold.maximum);
      if (maximum === undefined) return undefined;
      const human = await requiredText(prompter, "Human review summary", initial.base.review.human_review,
        `Automatic approval now requires ${threshold.input} <= ${maximum} and the unchanged rolling limits. Review the wording for this limit. Other summaries and examples stay unchanged; check them in the separate exact activation review.`);
      if (!human) return undefined;
      // Do not reconstruct the rule through the full form: only these two
      // explicitly reviewed leaves may change in the focused path.
      const draft = structuredClone(initial.base);
      const condition = draft.approval.auto_approve_when;
      if (condition?.kind !== "compare" || condition.right.kind !== "literal") return undefined;
      condition.right.value = maximum;
      draft.review.human_review = human;
      return { draft, values: { ...initial, auto_maximum: maximum,
        review: structuredClone(draft.review), base: structuredClone(draft) } };
    }
  }
  const values = await collectManualActionValues(prompter, built, initial, lockOutcome);
  if (!values) return undefined;
  const draft = manualSemanticActionDraft(values);
  return { draft, values: lockOutcome ? { ...values, base: structuredClone(draft) } : values };
}

function currentAutomaticThreshold(draft: ActionRuleModelDraftV1) {
  const condition = draft.approval.auto_approve_when;
  const input = draft.inputs?.[0];
  if (draft.approval.mode !== "policy" || condition?.kind !== "compare" || condition.operator !== "lte"
    || condition.left.kind !== "input" || condition.left.name !== input?.name || condition.right.kind !== "literal"
    || input?.type.kind !== "integer" || condition.right.value_type.kind !== "integer"
    || canonicalJsonDigest(input.type) !== canonicalJsonDigest(condition.right.value_type)
    || typeof condition.right.value !== "number" || !Number.isSafeInteger(condition.right.value)
    || input.minimum === undefined || input.maximum === undefined
    || !Number.isSafeInteger(input.minimum) || !Number.isSafeInteger(input.maximum) || input.minimum > input.maximum) return undefined;
  return { input: input.name, value: condition.right.value, minimum: input.minimum, maximum: input.maximum };
}

function currentManualRuleSummary(draft: ActionRuleModelDraftV1): string[] {
  const input = draft.inputs![0]!;
  const condition = manualEligibilityCondition(draft)!;
  const threshold = currentAutomaticThreshold(draft);
  const equality = condition.left.kind === "field" && condition.right.kind === "literal"
    ? `${condition.left.binding}.${condition.left.field} = ${JSON.stringify(condition.right.value)}` : "Retained exact condition";
  return [
    `Outcome: ${draft.outcome}.`,
    `Proposal only: ${draft.effect.target_resource}.${draft.effect.allowed_fields[0]!.name}. No source write.`,
    `Allowed input ${input.name}: ${input.minimum ?? "not specified"} through ${input.maximum ?? "not specified"}${input.type.kind === "integer" && input.type.unit ? ` (${input.type.unit})` : ""}.`,
    `Eligibility: ${equality}; existing range and scope guards stay unchanged.`,
    ...(threshold ? [`Automatic approval: ${threshold.input} <= ${threshold.value}, within the rolling limits below.`] : []),
    `Human review${threshold ? " otherwise" : ""}: ${draft.approval.required_approvals} distinct ${draft.approval.required_role} approval(s).`,
    ...draft.approval.shared_limits.map(limit => `Rolling limit ${limit.id}: ${limit.maximum} in ${limit.window_seconds} seconds; scope ${limit.scope}${limit.capability ? `; outcome ${limit.capability}` : ""}.`),
    "Any saved change remains disabled until separate exact review and activation. Other summaries and examples are retained.",
  ];
}

export async function collectManualActionValues(prompter: ManualSemanticActionPrompter, built: BuiltActionRuleAuthoringCatalogV1,
  initial: ManualActionValues, lockOutcome = false): Promise<ManualActionValues | undefined> {
  const resources = built.authoring.resources.filter((resource) => resource.operations.update
    && resource.fields.some((field) => field.writable && field.type.kind === "integer"));
  if (!resources.length) { await prompter.message("MANUAL ACTIONRULE UNAVAILABLE", ["No reviewed resource has a source-proven versioned integer UPDATE field."]); return undefined; }
  const name = await requiredIdentifierText(prompter, "Action rule name", initial.name, "Use an operator-chosen qualified identifier.");
  const outcome = lockOutcome
    ? initial.outcome
    : await requiredIdentifierText(prompter, "Action outcome", initial.outcome, "This is the client-visible outcome identifier; Runner does not invent it.");
  if (!name || !outcome) return undefined;
  const resourceName = await chooseResource(prompter, resources, initial.resource); if (!resourceName) return undefined;
  const resource = resources.find((candidate) => candidate.name === resourceName)!;
  const fieldChoices = resource.fields.filter((candidate) => candidate.writable && candidate.type.kind === "integer")
    .map((candidate) => ({ value: candidate.name, label: candidate.label ? `${candidate.label} (${candidate.name})` : candidate.name,
      detail: "The exact bounded business input will update only this field." }));
  const field = await chooseExactValue(prompter, "SELECT UPDATED INTEGER FIELD", fieldChoices,
    ["Guard and private identifiers are excluded."], initial.field);
  if (!field) return undefined;
  const selectedField = resource.fields.find((candidate) => candidate.name === field && candidate.writable && candidate.type.kind === "integer");
  if (!selectedField || selectedField.type.kind !== "integer") return undefined;
  const binding = await requiredIdentifierText(prompter, "Verification binding", initial.binding, "Name this one selected row.");
  const inputName = await requiredIdentifierText(prompter, "Business input name", initial.input_name, "Name the integer value supplied with a proposal.");
  const description = await requiredText(prompter, "Business input description", initial.input_description, "Describe the value without source-row examples.");
  const minimum = await integerText(prompter, "Minimum allowed value", initial.minimum, 0, 1_000_000_000);
  const maximum = await integerText(prompter, "Maximum allowed value", initial.maximum, minimum ?? 0, 1_000_000_000);
  if (!binding || !inputName || !description || minimum === undefined || maximum === undefined) return undefined;
  const eligibility = resource.fields.filter((candidate) => manualEligibilityType(candidate.type)
    && ![resource.primary_key, resource.tenant_key, resource.principal_key, resource.selected_version_field].includes(candidate.name));
  const eligibilityField = await chooseExactValue(prompter, "SELECT ELIGIBILITY FIELD", eligibility.map((candidate) => ({ value: candidate.name,
    label: candidate.label ? `${candidate.label} (${candidate.name})` : candidate.name,
    detail: "The request is eligible only when this inspected field equals one explicit supported value." })),
    ["This is an integer, boolean, or declared-enum equality check; no range or inferred business condition is added."], initial.eligibility_field);
  if (!eligibilityField) return undefined;
  const selectedEligibility = eligibility.find((candidate) => candidate.name === eligibilityField)!;
  const eligibilityValue = await literalText(prompter, selectedEligibility.type, initial.eligibility_value);
  if (eligibilityValue === undefined) return undefined;
  const approval = await chooseExactValue(prompter, "SELECT APPROVAL FALLBACK", [
    { value: "human", label: "Human review for every valid request", detail: "No automatic approval or rolling limits." },
    { value: "policy", label: "Auto-approve below a threshold with rolling limits", detail: "All other valid requests require human review." },
  ], ["Approval is not apply. Execution remains disabled."], initial.approval_mode);
  if (approval !== "human" && approval !== "policy") return undefined;
  const role = await requiredIdentifierText(prompter, "Required reviewer role", initial.required_role, "Enter the trusted human-review role.");
  const approvals = await integerText(prompter, "Required distinct approvals", initial.required_approvals, 1, 8);
  if (!role || approvals === undefined) return undefined;
  const review = await collectManualActionReview(prompter, initial.review); if (!review) return undefined;
  if (approval === "human") return { ...initial, name, outcome, binding, resource: resource.name, field, input_name: inputName,
    input_type: structuredClone(selectedField.type), input_description: description, minimum, maximum, eligibility_field: eligibilityField, eligibility_value: eligibilityValue,
    eligibility_type: structuredClone(selectedEligibility.type),
    approval_mode: "human", required_role: role, required_approvals: approvals, review };
  const auto = await integerText(prompter, "Automatic approval maximum", initial.auto_maximum ?? maximum, minimum, maximum);
  const existingLimits = initial.base?.approval.shared_limits;
  if (existingLimits?.some((limit) => limit.scope === "boundary" || limit.scope === "tenant")) {
    await prompter.message("SHARED APPROVAL LIMITS", [
      "These counters are shared with other actions. Their scope and identity stay unchanged.",
      ...existingLimits.map((limit) => `${limit.id}: ${limit.maximum} approvals in ${limit.window_seconds} seconds; ${limit.scope === "boundary" ? "all actions in this bundle" : limit.scope === "tenant" ? "per trusted account" : limit.scope}.`),
      "Changing a shared counter requires all affected rules to agree; validation will not silently split or replace it.",
    ], "Continue");
  }
  const overall = await integerText(prompter, "Overall rolling approval cap", initial.overall_maximum ?? 10, 1, 1_000_000);
  const overallWindow = await integerText(prompter, "Overall rolling window seconds", initial.overall_window_seconds ?? 86_400, 60, 31_536_000);
  const customer = await integerText(prompter, "Trusted customer rolling approval cap", initial.customer_maximum ?? 3, 1, 1_000_000);
  const customerWindow = await integerText(prompter, "Trusted customer rolling window seconds", initial.customer_window_seconds ?? 86_400, 60, 31_536_000);
  if ([auto, overall, overallWindow, customer, customerWindow].some((value) => value === undefined)) return undefined;
  return { ...initial, name, outcome, binding, resource: resource.name, field, input_type: structuredClone(selectedField.type), input_name: inputName, input_description: description,
    minimum, maximum, eligibility_field: eligibilityField, eligibility_value: eligibilityValue, eligibility_type: structuredClone(selectedEligibility.type), approval_mode: "policy", required_role: role,
    required_approvals: approvals, auto_maximum: auto!, overall_maximum: overall!, overall_window_seconds: overallWindow!,
    customer_maximum: customer!, customer_window_seconds: customerWindow!, review };
}

async function chooseResource(prompter: ManualSemanticActionPrompter, resources: BuiltActionRuleAuthoringCatalogV1["authoring"]["resources"], initial: string) {
  return chooseExactValue(prompter, "SELECT UPDATE TARGET", resources.map((resource) => ({ value: resource.name,
    label: resource.label ? `${resource.label} (${resource.name})` : resource.name,
    detail: `Primary key ${resource.primary_key}; version ${resource.selected_version_field ?? "not available"}.` })),
  ["Only inspected, versioned UPDATE targets are listed. Selecting one grants nothing."], initial);
}

/** Captures the review evidence required to save a new disabled Action authority. */
export async function collectManualActionReview(prompter: ManualSemanticActionPrompter,
  initial: ActionRuleModelDraftV1["review"]): Promise<ActionRuleModelDraftV1["review"] | undefined> {
  const when = await requiredText(prompter, "Eligibility summary", initial.when, "State when this request is valid.");
  const then = await requiredText(prompter, "Proposal summary", initial.then, "State the proposal-only result.");
  const refused = await requiredText(prompter, "Refusal summary", initial.refused.join(" "), "State one or more refusal conditions.");
  const human = await requiredText(prompter, "Human review summary", initial.human_review, "State when human review is required.");
  if (!when || !then || !refused || !human) return undefined;
  if (initial.examples.length) {
    return { when, then, refused: refused === initial.refused.join(" ") ? [...initial.refused] : [refused], human_review: human, examples: structuredClone(initial.examples) };
  }
  const scenario = await requiredText(prompter, "Eligible example scenario", undefined,
    "Give one concrete in-scope request that this reviewed rule may accept.");
  const result = await requiredText(prompter, "Eligible example result", undefined,
    "State the reviewed proposal or automatic-approval result for that request.");
  if (!scenario || !result) return undefined;
  return { when, then, refused: [refused], human_review: human,
    examples: [{ kind: "eligible", scenario, result }] };
}

async function requiredText(prompter: ManualSemanticActionPrompter, label: string, defaultValue: string | undefined, context: string) {
  const value = await prompter.text(label, { ...(defaultValue ? { defaultValue } : {}), title: "MANUAL SEMANTIC ACTIONRULE", context: [context] });
  return value?.trim() || undefined;
}

async function requiredIdentifierText(prompter: ManualSemanticActionPrompter, label: string, defaultValue: string | undefined, context: string) {
  for (;;) {
    const value = await requiredText(prompter, label, defaultValue, context);
    if (value === undefined) return undefined;
    if (safeName(value)) return value;
    await prompter.message("INVALID ACTION IDENTIFIER", [
      "Names must be 1-200 characters of letters, digits, dot, underscore, colon, or hyphen.",
      "Previously entered manual answers are retained. Correct this field to continue.",
    ], "Correct this field");
    defaultValue = value;
  }
}

async function integerText(prompter: ManualSemanticActionPrompter, label: string, initial: number, minimum: number, maximum: number) {
  for (;;) {
    const value = await requiredText(prompter, label, String(initial), `Enter an integer from ${minimum} through ${maximum}.`);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (/^-?\d+$/u.test(value) && Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum) return parsed;
    await prompter.message("INVALID INTEGER", [
      `Enter an integer from ${minimum} through ${maximum}.`,
      "Previously entered manual answers are retained. Correct this field to continue.",
    ], "Correct this field");
  }
}

async function literalText(prompter: ManualSemanticActionPrompter, type: ActionRuleScalarTypeSpecV1, initial: string | number | boolean) {
  if (type.kind === "integer") return integerText(prompter, "Eligibility equality value", Number(initial), -1_000_000_000, 1_000_000_000);
  if (type.kind === "boolean") {
    const selected = await chooseExactValue(prompter, "ELIGIBILITY EQUALITY VALUE", [
      { value: "true", label: "true" }, { value: "false", label: "false" },
    ], ["Choose the exact reviewed boolean value."], String(initial));
    return selected === "true" ? true : selected === "false" ? false : undefined;
  }
  if (type.kind === "string" && type.comparison === "exact" && type.enum?.length) {
    return chooseExactValue(prompter, "ELIGIBILITY EQUALITY VALUE", type.enum.map((value) => ({ value, label: value })),
      ["Choose one inspected declared enum value. Runner does not accept free-form status text."], String(initial));
  }
  return undefined;
}

async function chooseExactValue(prompter: ManualSemanticActionPrompter, title: string,
  choices: Array<{ value: string; label: string; detail?: string; disabled?: boolean }>, context: string[], initialValue?: string): Promise<string | undefined> {
  const allowed = new Set(choices.filter((choice) => !choice.disabled).map((choice) => choice.value));
  for (;;) {
    const choice = await prompter.choose(title, choices, context, initialValue);
    if (choice === undefined) return undefined;
    if (allowed.has(choice)) return choice;
    await prompter.message("INVALID MANUAL SELECTION", [
      "Choose one of the inspected options shown for this field.",
      "Previously entered manual answers are retained. No authority or source data changed.",
    ], "Choose again");
  }
}

function manualEligibilityType(type: ActionRuleScalarTypeSpecV1): boolean {
  return type.kind === "integer" || type.kind === "boolean"
    || (type.kind === "string" && type.comparison === "exact" && Boolean(type.enum?.length));
}

function safeName(value: string) { return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value); }
function manualNotice(title: string, lines: string[]): BoundaryAccessNotice { return { tone: "warning", title, lines }; }

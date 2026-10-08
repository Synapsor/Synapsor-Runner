import { canonicalJsonDigest, canonicalJsonStringify } from "@synapsor-runner/protocol";
import type { ActionRuleBooleanExpressionV1 } from "@synapsor/spec";
import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import type { TypedFieldEvent, TypedFieldOrigin, TypedFieldValue, TypedReviewDigest, TypedReviewField, TypedReviewView } from "./authoring-typed-review.js";
import { decodeTypedFieldLiteral, isValidTypedFieldValue } from "./authoring-typed-field-codec.js";

type Compare = Extract<ActionRuleBooleanExpressionV1, { kind: "compare" }>;
type TargetCommon = Readonly<{
  label: string; explanation?: string;
  expected_baseline_approval_digest: TypedReviewDigest;
  expected_approval_digest: TypedReviewDigest;
}>;
export type ActionParameterTarget = TargetCommon & (
  | Readonly<{ kind: "required_approvals" }>
  | Readonly<{ kind: "approval_threshold" | "approval_comparator"; input_name: string;
      expected_expression_digest: TypedReviewDigest; expected_input_digest: TypedReviewDigest; money_scale?: number }>
);
export type ActionParameterCompilation = Readonly<{
  /** Actual compileActionRuleModelDraft output.draft, not assistant assertions. */
  draft: ActionRuleModelDraftV1;
  /** Existing Runner-owned semanticActionBusinessReviewLines projection. */
  business_lines: readonly string[];
}>;
export type ActionParameterReviewInput = Readonly<{
  baseline: ActionRuleModelDraftV1; working: ActionRuleModelDraftV1;
  expected_baseline_digest: TypedReviewDigest;
  proposal_id: string; proposal_revision: number; applicability_digest: TypedReviewDigest; operation_id: string;
  origin: TypedFieldOrigin; baseline_origin: TypedFieldOrigin; targets: readonly ActionParameterTarget[];
  /** Existing compiler validates full proposal; this port cannot save/adopt it. */
  compile: (draft: ActionRuleModelDraftV1) => ActionParameterCompilation;
}>;
export type ActionParameterChange = Readonly<{
  component: string; label: string; before: unknown; after: unknown; before_present: boolean; after_present: boolean; digest: TypedReviewDigest;
}>;
export type ActionParameterProjection = Readonly<{
  view: TypedReviewView & { technical_lines: readonly string[] };
  candidate: ActionRuleModelDraftV1;
  canonical_changes: readonly ActionParameterChange[];
  preserved_components: readonly string[];
}>;
const componentLabels: Record<keyof ActionRuleModelDraftV1, string> = {
  schema_version: "Draft format", name: "Action identity", outcome: "Business outcome", discovery: "Agent-facing discovery",
  inputs: "Request values and constraints", verification: "Private verification and scope", effect: "Allowed effects and execution",
  require: "Eligibility requirements and exclusions", derive: "Calculated business values", approval: "Approval conditions, reviewers and limits",
  ttl_seconds: "Request expiry", review: "Retained original review wording",
};
const comparatorLabels: Record<Compare["operator"], string> = {
  eq: "Exactly equal to", neq: "Different from", lt: "Less than", lte: "At most (includes the threshold)",
  gt: "Greater than", gte: "At least (includes the threshold)",
};
function fail(code: "STALE" | "UNSUPPORTED" | "INVALID", message: string): never {
  throw new Error(`ACTION_PARAMETER_REVIEW_${code}: ${message}`);
}
function exact(a: unknown, b: unknown): boolean { return canonicalJsonDigest(a) === canonicalJsonDigest(b); }
function simplePredicate(draft: ActionRuleModelDraftV1, name: string): Compare {
  const expression = draft.approval.auto_approve_when;
  if (draft.approval.mode !== "policy" || expression?.kind !== "compare"
    || expression.left.kind !== "input" || expression.left.name !== name || expression.right.kind !== "literal"
    || !["integer", "money_minor"].includes(expression.right.value_type.kind)
    || !Number.isSafeInteger(expression.right.value)) fail("UNSUPPORTED", "Only the exact existing input-versus-literal approval comparison is editable here. Preserve other shapes for ordinary guided review.");
  const input = draft.inputs?.filter(item => item.name === name);
  if (input?.length !== 1 || !exact(input[0]!.type, expression.right.value_type))
    fail("UNSUPPORTED", "The approval input and literal must have one exact existing numeric type and currency.");
  return expression;
}
function resolveField(input: ActionParameterReviewInput, target: ActionParameterTarget): TypedReviewField {
  if (target.expected_baseline_approval_digest !== canonicalJsonDigest(input.baseline.approval)
    || target.expected_approval_digest !== canonicalJsonDigest(input.working.approval)) fail("STALE", "The exact approval component changed; reopen its current review.");
  const base = { id: target.kind, target_digest: canonicalJsonDigest({ outcome: input.working.outcome, target }),
    dependencies_digest: canonicalJsonDigest({ baseline: input.expected_baseline_digest, working: input.working,
      applicability: input.applicability_digest, operation: input.operation_id }),
    label: target.label, ...(target.explanation ? { explanation: target.explanation } : {}), required: true };
  if (target.kind === "required_approvals") return { ...base, kind: "integer", minimum: 1, maximum: 10,
    current: { origin: input.baseline_origin, value: { kind: "integer", value: input.baseline.approval.required_approvals } },
    suggestion: { origin: input.origin, value: { kind: "integer", value: input.working.approval.required_approvals } } };
  const expression = simplePredicate(input.working, target.input_name), previous = simplePredicate(input.baseline, target.input_name);
  const declared = input.working.inputs!.find(item => item.name === target.input_name)!;
  if (target.expected_expression_digest !== canonicalJsonDigest(expression) || target.expected_input_digest !== canonicalJsonDigest(declared))
    fail("STALE", "The exact threshold expression or request value changed.");
  if (expression.right.kind !== "literal" || previous.right.kind !== "literal" || !exact(expression.right.value_type, previous.right.value_type))
    fail("UNSUPPORTED", "A different threshold type or currency needs its own reviewed change.");
  if (target.kind === "approval_comparator") return { ...base, kind: "choice",
    options: Object.entries(comparatorLabels).map(([value, label]) => ({ value, label })),
    current: { origin: input.baseline_origin, value: { kind: "choice", value: previous.operator } },
    suggestion: { origin: input.origin, value: { kind: "choice", value: expression.operator } } };
  if (expression.right.value_type.kind === "integer") return { ...base, kind: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER,
    current: { origin: input.baseline_origin, value: { kind: "integer", value: previous.right.value as number } },
    suggestion: { origin: input.origin, value: { kind: "integer", value: expression.right.value as number } } };
  if (expression.right.value_type.kind !== "money_minor" || target.money_scale === undefined)
    fail("UNSUPPORTED", "Money needs an explicit supported currency scale from the current domain owner.");
  const currency = expression.right.value_type.currency, scale = target.money_scale;
  return { ...base, kind: "money", currency, scale, minimum_minor: Number.MIN_SAFE_INTEGER, maximum_minor: Number.MAX_SAFE_INTEGER,
    current: { origin: input.baseline_origin, value: { kind: "money", minor_units: previous.right.value as number, currency, scale } },
    suggestion: { origin: input.origin, value: { kind: "money", minor_units: expression.right.value as number, currency, scale } } };
}

/** A bounded projection over actual compiled values. No persistence, JSON patch,
 * provider, counter or boolean-expression rewriting capability exists here. */
export function buildActionParameterReview(input: ActionParameterReviewInput): ActionParameterProjection {
  if (canonicalJsonDigest(input.baseline) !== input.expected_baseline_digest
    || input.baseline.name !== input.working.name || input.baseline.outcome !== input.working.outcome)
    fail("STALE", "The selected baseline or Action identity changed.");
  if (!Number.isSafeInteger(input.proposal_revision) || input.proposal_revision < 1 || !input.targets.length
    || new Set(input.targets.map(target => target.kind)).size !== input.targets.length) fail("INVALID", "Use unique supported targets and an exact proposal revision.");
  const compiled = input.compile(structuredClone(input.working));
  // Normalization is host-owned; target expectations must bind what is displayed.
  const current = { ...input, working: compiled.draft };
  const fields = current.targets.map(target => resolveField(current, target));
  const keys = [...new Set([...Object.keys(input.baseline), ...Object.keys(compiled.draft)])].sort();
  const changes: ActionParameterChange[] = [], preserved: string[] = [];
  for (const key of keys) {
    const before = (input.baseline as unknown as Record<string, unknown>)[key] ?? null;
    const after = (compiled.draft as unknown as Record<string, unknown>)[key] ?? null;
    const label = componentLabels[key as keyof ActionRuleModelDraftV1] ?? `Additional component ${key}`;
    const before_present = Object.hasOwn(input.baseline, key), after_present = Object.hasOwn(compiled.draft, key);
    if (before_present === after_present && exact(before, after)) preserved.push(label);
    else changes.push({ component: key, label, before: structuredClone(before), after: structuredClone(after), before_present, after_present,
      digest: canonicalJsonDigest({ component: key, before, after, before_present, after_present }) });
  }
  const technical_lines = changes.flatMap(change => [change.label, `Change fingerprint: ${change.digest}`,
    `Before: ${change.before_present ? canonicalJsonStringify(change.before) : "(absent)"}`, `After: ${change.after_present ? canonicalJsonStringify(change.after) : "(absent)"}`]);
  const normalized_lines = [...compiled.business_lines, `Exact Action: ${compiled.draft.outcome}`,
    ...preserved.map(label => `${label}: identical to selected baseline (canonical comparison).`),
    "Original review wording is retained as history; the current compiled values above control this proposal."];
  const change_lines = changes.map(change => `${change.label} changed — ${change.digest}; inspect exact before/after in details.`);
  const unresolved = fields.filter(field => !field.suggestion || !isValidTypedFieldValue(field, field.suggestion.value)).map(field => `${field.label} has no valid exact value.`);
  const body = { decision_kind: "business_review" as const, status: "unconfirmed" as const, title: "Review Action business values", fields,
    normalized_lines, change_lines, unresolved, technical_lines };
  const binding = { proposal_id: input.proposal_id, proposal_revision: input.proposal_revision, proposal_digest: canonicalJsonDigest(compiled.draft),
    applicability_digest: input.applicability_digest, operation_id: input.operation_id,
    view_digest: canonicalJsonDigest({ ...body, baseline: input.expected_baseline_digest }) };
  return { view: { ...body, binding }, candidate: structuredClone(compiled.draft), canonical_changes: changes, preserved_components: preserved };
}

/** Existing protected owner must re-read input/currentness before calling, then
 * persist this unconfirmed result and exact event under its normal CAS. */
export function applyActionParameterEvent(input: ActionParameterReviewInput, event: TypedFieldEvent): {
  state: "unconfirmed"; candidate: ActionRuleModelDraftV1; event: TypedFieldEvent;
} {
  const eventKeys = ["kind", "binding", "field_id", "target_digest", "dependencies_digest",
    ...(event.kind === "replace_literal" ? ["raw"] : event.kind === "select_option" ? ["value"] : [])];
  if (Object.keys(event).some(key => !eventKeys.includes(key))) fail("INVALID", "Only the exact typed operator event is accepted; confirmation and invented raw provenance are not field edits.");
  const projected = buildActionParameterReview(input), field = projected.view.fields.find(item => item.id === event.field_id);
  if (!field || !exact(event.binding, projected.view.binding) || event.target_digest !== field.target_digest
    || event.dependencies_digest !== field.dependencies_digest) fail("STALE", "The event does not belong to the exact current target, dependencies and proposal.");
  let value: TypedFieldValue | undefined;
  if (event.kind === "keep_suggestion") {
    if (!field.suggestion || !isValidTypedFieldValue(field, field.suggestion.value)) fail("INVALID", "There is no valid displayed suggestion to retain.");
    value = field.suggestion.value;
  } else if (event.kind === "replace_literal") {
    const decoded = decodeTypedFieldLiteral(field, event.raw);
    if (!decoded.ok) fail("INVALID", decoded.message);
    value = decoded.value;
  } else if (event.kind === "select_option") {
    if (field.kind !== "choice") fail("INVALID", "Only a declared choice field accepts an option.");
    const decoded = decodeTypedFieldLiteral(field, event.value);
    if (!decoded.ok) fail("INVALID", decoded.message);
    value = decoded.value;
  } else if (event.kind !== "leave_pending") fail("INVALID", "Unknown operator event.");
  const next = structuredClone(projected.candidate);
  if (value && event.kind !== "keep_suggestion") {
    switch (field.id) {
      case "required_approvals":
        if (value.kind !== "integer") fail("INVALID", "Reviewer count requires an integer.");
        next.approval.required_approvals = value.value; break;
      case "approval_threshold": {
        const expression = next.approval.auto_approve_when;
        if (expression?.kind !== "compare" || expression.right.kind !== "literal" || value.kind === "choice") fail("STALE", "Threshold target changed.");
        expression.right.value = value.kind === "money" ? value.minor_units : value.value; break;
      }
      case "approval_comparator": {
        const expression = next.approval.auto_approve_when;
        if (expression?.kind !== "compare" || value.kind !== "choice" || !(value.value in comparatorLabels)) fail("STALE", "Comparison target changed.");
        expression.operator = value.value as Compare["operator"]; break;
      }
      default: fail("INVALID", "Unsupported fixed Action parameter.");
    }
  }
  const revalidated = input.compile(next);
  if (!exact(next, revalidated.draft)) fail("INVALID", "Compilation changed the normalized proposal beyond this exact amendment; review the complete new proposal before proceeding.");
  return { state: "unconfirmed", candidate: structuredClone(revalidated.draft), event: structuredClone(event) };
}

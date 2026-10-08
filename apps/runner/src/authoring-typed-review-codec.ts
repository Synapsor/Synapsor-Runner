import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { TypedFieldEvent, TypedFieldValue, TypedReviewField, TypedReviewView } from "./authoring-typed-review.js";
import { decodeTypedFieldLiteral, isValidTypedFieldValue } from "./authoring-typed-field-codec.js";

function invalid(message: string): never { throw new Error(`TYPED_REVIEW_INVALID: ${message}`); }
function stale(): never { throw new Error("TYPED_REVIEW_STALE: Reopen the exact current proposal, field and dependencies before submitting this value."); }
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
    || Object.keys(value).some(key => !keys.includes(key) || (value as Record<string, unknown>)[key] === undefined))
    invalid("Unknown fields, non-record values and omitted-as-undefined fields are not supported.");
}
function text(value: unknown, maximum: number, blank = false): asserts value is string {
  if (typeof value !== "string" || value.length > maximum || !blank && !value.trim()) invalid("A bounded exact text value is required.");
}
function digest(value: unknown): void {
  if (typeof value !== "string" || value.length !== 71 || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid("A canonical lowercase sha256 binding is required.");
}
function safeInteger(value: unknown, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum || Object.is(value, -0)) invalid("An exact bounded safe integer is required.");
}
function binding(value: unknown): void {
  object(value, ["proposal_id", "proposal_revision", "proposal_digest", "applicability_digest", "operation_id", "view_digest"]);
  text(value.proposal_id, 256); safeInteger(value.proposal_revision, 1); text(value.operation_id, 256);
  digest(value.proposal_digest); digest(value.applicability_digest); digest(value.view_digest);
}
function lines(value: unknown): void {
  if (!Array.isArray(value) || value.length > 512) invalid("The complete display must fit the bounded line count; content is not silently dropped.");
  value.forEach(line => text(line, 32768, true));
}
function fieldValue(value: unknown): asserts value is TypedFieldValue {
  if (!value || typeof value !== "object") invalid("A typed field value is required.");
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "integer") { object(value, ["kind", "value"]); safeInteger(value.value); }
  else if (kind === "money") {
    object(value, ["kind", "minor_units", "currency", "scale"]); safeInteger(value.minor_units); safeInteger(value.scale, 0, 18);
    if (typeof value.currency !== "string" || value.currency.length !== 3 || !/^[A-Z]{3}$/u.test(value.currency)) invalid("Money requires the exact declared currency.");
  } else if (kind === "choice") { object(value, ["kind", "value"]); text(value.value, 256); }
  else invalid("Unsupported field value kind.");
}
function selection(value: unknown, field: Record<string, unknown>): void {
  object(value, ["value", "origin"]); fieldValue(value.value);
  if (!["saved_confirmed", "saved_unconfirmed", "model_proposal", "operator_edit"].includes(value.origin as string)) invalid("Unknown value provenance.");
  if (value.value.kind !== field.kind || value.value.kind === "money" && (value.value.currency !== field.currency || value.value.scale !== field.scale))
    invalid("The displayed value must belong to its exact field type, currency and scale.");
}
function field(value: unknown): void {
  if (!value || typeof value !== "object") invalid("A host field view is required.");
  const kind = (value as { kind?: unknown }).kind;
  const common = ["id", "target_digest", "dependencies_digest", "label", "explanation", "required", "current", "suggestion", "kind"];
  object(value, [...common, ...(kind === "integer" ? ["minimum", "maximum"] : kind === "money" ? ["currency", "scale", "minimum_minor", "maximum_minor"] : kind === "choice" ? ["options"] : [])]);
  text(value.id, 256); digest(value.target_digest); digest(value.dependencies_digest); text(value.label, 1000);
  if (value.explanation !== undefined) text(value.explanation, 4000);
  if (typeof value.required !== "boolean") invalid("Requiredness is host-defined, not inferred.");
  if (kind === "integer") { safeInteger(value.minimum); safeInteger(value.maximum); if (value.minimum > value.maximum) invalid("Invalid integer bounds."); }
  else if (kind === "money") {
    safeInteger(value.minimum_minor); safeInteger(value.maximum_minor); safeInteger(value.scale, 0, 18);
    if (value.minimum_minor > value.maximum_minor || typeof value.currency !== "string" || value.currency.length !== 3 || !/^[A-Z]{3}$/u.test(value.currency)) invalid("Invalid money bounds/currency.");
  } else if (kind === "choice") {
    if (!Array.isArray(value.options) || !value.options.length || value.options.length > 64) invalid("A bounded nonempty choice set is required.");
    for (const option of value.options) { object(option, ["value", "label"]); text(option.value, 256); text(option.label, 1000); }
    if (new Set(value.options.map(option => option.value)).size !== value.options.length) invalid("Duplicate option identities are not allowed.");
  } else invalid("Unsupported field kind.");
  if (value.current !== undefined) selection(value.current, value);
  if (value.suggestion !== undefined) selection(value.suggestion, value);
}
function boundedDocument(value: unknown): void {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { invalid("The view/event must be a finite JSON record."); }
  if (encoded! === undefined || Buffer.byteLength(encoded!) > 512 * 1024) invalid("Inspection data exceeds the supported bounded record size.");
}

/** Syntax/provenance-shape validation only: actual authorization and canonical
 * view/proposal currentness remain with the domain host. A safe out-of-range
 * suggestion may be displayed as invalid; it cannot be kept or confirmed. */
export function parseTypedReviewView(value: unknown): TypedReviewView {
  boundedDocument(value);
  object(value, ["binding", "decision_kind", "status", "title", "fields", "normalized_lines", "change_lines", "unresolved", "technical_lines"]);
  binding(value.binding);
  if (value.decision_kind !== "business_review" || !["proposed", "unconfirmed"].includes(value.status as string)) invalid("Only an unconfirmed business-review view is supported.");
  text(value.title, 1000);
  if (!Array.isArray(value.fields) || value.fields.length > 64) invalid("The host field set exceeds its bound.");
  value.fields.forEach(field);
  if (new Set(value.fields.map(item => item.id)).size !== value.fields.length) invalid("Duplicate field identities are not allowed.");
  lines(value.normalized_lines); lines(value.change_lines); lines(value.unresolved);
  if (value.technical_lines !== undefined) lines(value.technical_lines);
  return structuredClone(value) as TypedReviewView;
}
export function parseTypedFieldEvent(value: unknown): TypedFieldEvent {
  boundedDocument(value);
  if (!value || typeof value !== "object") invalid("A typed operator field event is required.");
  const kind = (value as { kind?: unknown }).kind;
  object(value, ["kind", "binding", "field_id", "target_digest", "dependencies_digest", ...(kind === "replace_literal" ? ["raw"] : kind === "select_option" ? ["value"] : [])]);
  if (!["keep_suggestion", "replace_literal", "select_option", "leave_pending"].includes(kind as string)) invalid("Field events cannot confirm or activate.");
  binding(value.binding); text(value.field_id, 256); digest(value.target_digest); digest(value.dependencies_digest);
  if (kind === "replace_literal") text(value.raw, 512, true);
  if (kind === "select_option") text(value.value, 256);
  return structuredClone(value) as TypedFieldEvent;
}
export function validateTypedFieldEvent(viewInput: unknown, eventInput: unknown): { event: TypedFieldEvent; value?: TypedFieldValue } {
  const view = parseTypedReviewView(viewInput), event = parseTypedFieldEvent(eventInput);
  const field = view.fields.find(item => item.id === event.field_id);
  if (!field || canonicalJsonDigest(view.binding) !== canonicalJsonDigest(event.binding)
    || event.target_digest !== field.target_digest || event.dependencies_digest !== field.dependencies_digest) stale();
  if (event.kind === "leave_pending") return { event };
  if (event.kind === "keep_suggestion") {
    if (!field.suggestion || !isValidTypedFieldValue(field, field.suggestion.value)) invalid("No valid displayed suggestion exists for this exact field.");
    return { event, value: structuredClone(field.suggestion.value) };
  }
  if (event.kind === "select_option" && field.kind !== "choice") invalid("Only a declared choice field accepts an option event.");
  const decoded = decodeTypedFieldLiteral(field, event.kind === "replace_literal" ? event.raw : event.value);
  if (!decoded.ok) invalid(decoded.message);
  return { event, value: decoded.value };
}

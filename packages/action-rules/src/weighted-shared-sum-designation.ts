import { canonicalJsonDigest, canonicalJsonStringify } from "@synapsor-runner/protocol";
import { ActionRuleError } from "./errors.js";

export const WEIGHTED_SHARED_SUM_DESIGNATION_VERSION = "synapsor.shared-sum-designation.v2" as const;
export const REVIEWED_WEIGHTED_SHARED_SUM_VERSION = "synapsor.reviewed-shared-sum.v2" as const;
type Digest = `sha256:${string}`;
type Field = { resource: string; field: string };
export type WeightedSharedSumUnitV2 = { kind: "integer"; unit: string } | { kind: "money_minor"; currency: string };
export type WeightedSharedSumValuationV2 = {
  input_unit: WeightedSharedSumUnitV2; output_unit: WeightedSharedSumUnitV2;
  numerator: string; denominator: string; version: string;
  provenance: { source_session: string; source_digest: Digest; store_digest: Digest; start: number; end: number };
};
export type WeightedSharedSumPopulationV2 = { id: string; resource: string; guard_relationship: string };
export type WeightedSharedSumMeasureV2 = {
  id: string; population: string; field: string; input_unit: WeightedSharedSumUnitV2; meaning: string;
  valuation: WeightedSharedSumValuationV2; raw_cap?: Field;
};
/** Closed business proposal DATA. Physical integer representation, inspected
 * original units, actual unique guard, complete FK populations, period row and
 * activation/worker ordering remain independently established prerequisites. */
export type WeightedSharedSumDesignationV2 = {
  schema_version: typeof WEIGHTED_SHARED_SUM_DESIGNATION_VERSION; kind: "weighted_shared_sum"; source: string;
  scope: { tenant_field: string; principal_field: string };
  guard: { resource: string; identity_field: string; period_start_field: string; period_end_field: string };
  populations: WeightedSharedSumPopulationV2[]; measures: WeightedSharedSumMeasureV2[];
  limit: Field & { unit: WeightedSharedSumUnitV2; meaning: string };
  period: { kind: "utc_calendar_month"; interval: "half_open"; attribution: "host_execution_admission" };
  revaluation: "complete_selected_period_current_state"; external_writers: "participating_only";
  participating_outcomes: string[];
};
/** Retained confirmation references are serializable DATA. Main authenticates
 * the actual protected Question, current complete authority and same Held save;
 * parsing this record cannot manufacture consent, technical proof or cutover. */
export type ReviewedWeightedSharedSumV2 = {
  schema_version: typeof REVIEWED_WEIGHTED_SHARED_SUM_VERSION; designation: WeightedSharedSumDesignationV2;
  confirmation: {
    actor: "local_installation_operator"; decision: "new_attributed_decision"; recorded_at: string;
    question: { id: string; revision: number; digest: Digest }; proposal_digest: Digest; context_digest: Digest;
    source_digest: Digest; catalog_digest: Digest; generation_lock_fingerprint: Digest;
    read_dependencies: Array<{ name: string; digest: Digest }>; designation_digest: Digest;
  };
};
const same = (a: unknown, b: unknown) => canonicalJsonDigest(a) === canonicalJsonDigest(b);
function invalid(): never { throw new ActionRuleError("ACTION_RULE_INVALID", "The exact closed weighted designation or confirmation references are invalid.", "authority.shared_sum.weighted"); }
function exact(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key))) invalid();
  return record;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > maximum) invalid(); return value;
}
function name(value: unknown): string { const result = text(value, 128); if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(result)) invalid(); return result; }
function digest(value: unknown): Digest { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid(); return value as Digest; }
function uuid(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) invalid(); return value; }
function integer(value: unknown, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) invalid(); return value as number; }
function field(value: unknown): Field { const f = exact(value, ["resource", "field"]); return { resource: name(f.resource), field: name(f.field) }; }
function unit(value: unknown): WeightedSharedSumUnitV2 {
  const u = value as Record<string, unknown> | undefined;
  if (u?.kind === "integer") { exact(u, ["kind", "unit"]); return { kind: "integer", unit: text(u.unit, 256) }; }
  if (u?.kind === "money_minor") { exact(u, ["kind", "currency"]); const currency = text(u.currency, 3); if (!/^[A-Z]{3}$/u.test(currency)) invalid(); return { kind: "money_minor", currency }; }
  invalid();
}
function positiveDecimal(value: unknown): string { if (typeof value !== "string" || !/^[1-9][0-9]{0,11}$/u.test(value)) invalid(); return value; }
function valuation(value: unknown): WeightedSharedSumValuationV2 {
  const r = exact(value, ["input_unit", "output_unit", "numerator", "denominator", "version", "provenance"]);
  const numerator = positiveDecimal(r.numerator), denominator = positiveDecimal(r.denominator);
  let a = BigInt(numerator), b = BigInt(denominator); while (b !== 0n) [a, b] = [b, a % b]; if (a !== 1n) invalid();
  const p = exact(r.provenance, ["source_session", "source_digest", "store_digest", "start", "end"]);
  const start = integer(p.start, 600), end = integer(p.end, 600); if (end < start) invalid();
  return { input_unit: unit(r.input_unit), output_unit: unit(r.output_unit), numerator, denominator, version: name(r.version),
    provenance: { source_session: uuid(p.source_session), source_digest: digest(p.source_digest), store_digest: digest(p.store_digest), start, end } };
}
function list(value: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid(); return value;
}
export function parseWeightedSharedSumDesignation(value: unknown): WeightedSharedSumDesignationV2 {
  if (Buffer.byteLength(canonicalJsonStringify(value)) > 96 * 1024) invalid();
  const r = exact(value, ["schema_version", "kind", "source", "scope", "guard", "populations", "measures", "limit", "period", "revaluation", "external_writers", "participating_outcomes"]);
  if (r.schema_version !== WEIGHTED_SHARED_SUM_DESIGNATION_VERSION || r.kind !== "weighted_shared_sum"
    || r.revaluation !== "complete_selected_period_current_state" || r.external_writers !== "participating_only") invalid();
  const s = exact(r.scope, ["tenant_field", "principal_field"]), scope = { tenant_field: name(s.tenant_field), principal_field: name(s.principal_field) };
  const g = exact(r.guard, ["resource", "identity_field", "period_start_field", "period_end_field"]), guard = { resource: name(g.resource), identity_field: name(g.identity_field), period_start_field: name(g.period_start_field), period_end_field: name(g.period_end_field) };
  if (scope.tenant_field === scope.principal_field || new Set([guard.identity_field, guard.period_start_field, guard.period_end_field]).size !== 3) invalid();
  const populations = list(r.populations, 1, 8).map(value => { const p = exact(value, ["id", "resource", "guard_relationship"]); return { id: name(p.id), resource: name(p.resource), guard_relationship: name(p.guard_relationship) }; });
  if (new Set(populations.map(p => p.id)).size !== populations.length || new Set(populations.map(p => p.resource)).size !== populations.length
    || populations.some(p => p.resource === guard.resource)) invalid();
  const l = exact(r.limit, ["resource", "field", "unit", "meaning"]), limit = { resource: name(l.resource), field: name(l.field), unit: unit(l.unit), meaning: text(l.meaning, 2000) };
  if (limit.resource !== guard.resource) invalid();
  const measures = list(r.measures, 2, 8).map(value => {
    const m = exact(value, ["id", "population", "field", "input_unit", "meaning", "valuation"], ["raw_cap"]);
    return { id: name(m.id), population: name(m.population), field: name(m.field), input_unit: unit(m.input_unit), meaning: text(m.meaning, 2000),
      valuation: valuation(m.valuation), ...(m.raw_cap === undefined ? {} : { raw_cap: field(m.raw_cap) }) };
  });
  if (new Set(measures.map(m => m.id)).size !== measures.length || new Set(measures.map(m => canonicalJsonStringify([m.population, m.field]))).size !== measures.length
    || populations.some(p => !measures.some(m => m.population === p.id)) || measures.some(m => !populations.some(p => p.id === m.population)
      || !same(m.input_unit, m.valuation.input_unit) || !same(m.valuation.output_unit, limit.unit) || m.raw_cap && m.raw_cap.resource !== guard.resource)) invalid();
  const p = exact(r.period, ["kind", "interval", "attribution"]);
  if (p.kind !== "utc_calendar_month" || p.interval !== "half_open" || p.attribution !== "host_execution_admission") invalid();
  const participating_outcomes = list(r.participating_outcomes, 1, 64).map(name); if (new Set(participating_outcomes).size !== participating_outcomes.length) invalid();
  const result: WeightedSharedSumDesignationV2 = { schema_version: WEIGHTED_SHARED_SUM_DESIGNATION_VERSION, kind: "weighted_shared_sum", source: name(r.source), scope, guard,
    populations, measures, limit, period: { kind: "utc_calendar_month", interval: "half_open", attribution: "host_execution_admission" },
    revaluation: "complete_selected_period_current_state", external_writers: "participating_only", participating_outcomes };
  if (!same(result, value)) invalid(); return structuredClone(result);
}
export function parseReviewedWeightedSharedSum(value: unknown): ReviewedWeightedSharedSumV2 {
  if (Buffer.byteLength(canonicalJsonStringify(value)) > 128 * 1024) invalid();
  const r = exact(value, ["schema_version", "designation", "confirmation"]); if (r.schema_version !== REVIEWED_WEIGHTED_SHARED_SUM_VERSION) invalid();
  const designation = parseWeightedSharedSumDesignation(r.designation), c = exact(r.confirmation, ["actor", "decision", "recorded_at", "question", "proposal_digest", "context_digest", "source_digest", "catalog_digest", "generation_lock_fingerprint", "read_dependencies", "designation_digest"]);
  const q = exact(c.question, ["id", "revision", "digest"]), recorded_at = text(c.recorded_at, 128);
  if (c.actor !== "local_installation_operator" || c.decision !== "new_attributed_decision" || !Number.isFinite(Date.parse(recorded_at))
    || new Date(recorded_at).toISOString() !== recorded_at || digest(c.designation_digest) !== canonicalJsonDigest(designation)) invalid();
  const read_dependencies = list(c.read_dependencies, 1, 4096).map(value => { const d = exact(value, ["name", "digest"]); return { name: name(d.name), digest: digest(d.digest) }; });
  if (new Set(read_dependencies.map(r => r.name)).size !== read_dependencies.length) invalid();
  return { schema_version: REVIEWED_WEIGHTED_SHARED_SUM_VERSION, designation, confirmation: { actor: "local_installation_operator", decision: "new_attributed_decision", recorded_at,
    question: { id: uuid(q.id), revision: integer(q.revision, Number.MAX_SAFE_INTEGER), digest: digest(q.digest) }, proposal_digest: digest(c.proposal_digest), context_digest: digest(c.context_digest),
    source_digest: digest(c.source_digest), catalog_digest: digest(c.catalog_digest), generation_lock_fingerprint: digest(c.generation_lock_fingerprint), read_dependencies, designation_digest: digest(c.designation_digest) } };
}
function label(unit: WeightedSharedSumUnitV2): string { return unit.kind === "integer" ? unit.unit : `${unit.currency} minor units`; }
export function weightedSharedSumReadback(input: WeightedSharedSumDesignationV2): string[] {
  const d = parseWeightedSharedSumDesignation(input);
  return [`Proposed weighted bound: ${d.limit.resource}.${d.limit.field} in ${label(d.limit.unit)}. ${d.limit.meaning}`,
    ...d.measures.map(m => { const p = d.populations.find(p => p.id === m.population)!; return `${m.id}: SUM(${p.resource}.${m.field}) in original ${label(m.input_unit)}, valued at exact ${m.valuation.numerator}/${m.valuation.denominator} ${label(m.valuation.output_unit)} per ${label(m.valuation.input_unit)}; immutable version ${m.valuation.version}.${m.raw_cap ? ` Individual raw-unit cap: ${m.raw_cap.resource}.${m.raw_cap.field}.` : ""} ${m.meaning}`; }),
    `Period: actual ${d.guard.resource} row, ${d.guard.period_start_field} to ${d.guard.period_end_field}; UTC calendar month, half-open interval, host execution admission time. This does not claim commit-time attribution.`,
    "A rate edit will revalue the complete selected current-period state before activation; a violating replacement remains pending and keeps the old active policy. No admission rounding.",
    `Participating Actions: ${d.participating_outcomes.join(", ")}.`,
    "Deployment requires one qualified PostgreSQL Source, an inspected unique customer-period guard, complete bounded scoped populations, all relevant participating writers, and enforced activation/worker ordering. These prerequisites require technical proof.",
    "Confirmation records business meaning separately from activation. Ordinary eligibility and independently reviewed local caps continue to apply. Unknown execution outcomes remain unknown; external nonparticipants are outside this guarantee."];
}

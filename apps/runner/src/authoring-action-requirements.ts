import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";

const name = z.string().min(1).max(256).refine(value => value.trim() === value);
export const actionRequirementDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(value => value as `sha256:${string}`);
const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const window = integer.min(60).max(31_536_000);
const scope = z.enum(["boundary", "capability", "tenant", "tenant_principal", "tenant_object"]);
const scalar = z.union([z.string().max(4096), integer, z.boolean(), z.null()]);
const unknown = z.object({ state: z.literal("unknown"), reason: z.enum(["missing_meaning", "unsupported_basis", "unsupported_unit", "unsupported_transition"]) }).strict();
const inventoryLimit = z.object({ id: name, kind: z.enum(["count", "total"]), scope, maximum: integer.min(1),
  window_seconds: window, capability: name.optional(), field: name.optional() }).strict();
const inventory = z.array(inventoryLimit).max(64);
const countTarget = z.union([
  z.object({ slot: z.literal("approval.shared_limits"), outcome: name, limit_id: name }).strict(),
  z.object({ slot: z.literal("suggestion.approval_policy_proposal.shared_limits"), outcome: name, limit_id: name }).strict(),
  z.object({ slot: z.literal("resource.policy.shared_limits"), resource: name, limit_id: name }).strict(),
]);
const columnTarget = z.object({ slot: z.literal("catalog.column"), resource: name, field: name, type_fingerprint: actionRequirementDigestSchema }).strict();
const transitionTarget = z.object({ slot: z.enum(["patches", "proposal.patch"]), resource: name, field: name,
  type_fingerprint: actionRequirementDigestSchema }).strict();
const selector = z.discriminatedUnion("kind", [z.object({ kind: z.literal("all_outcomes") }).strict(),
  z.object({ kind: z.literal("outcome"), outcome: name }).strict()]);
const proposal = z.discriminatedUnion("kind", [
  z.object({ id: name, kind: z.literal("approval_count"), target: countTarget, intent: z.enum(["retain", "replace"]), previous_limits: inventory,
    value: z.union([unknown, z.object({ state: z.literal("proposed"), basis: z.literal("rolling_approved_events"), scope,
      maximum: integer.min(1), window_seconds: window, selector }).strict()]) }).strict(),
  z.object({ id: name, kind: z.literal("execution"), target: z.object({ slot: z.literal("effect.writeback"), outcome: name }).strict(),
    value: z.union([unknown, z.object({ state: z.literal("proposed"), mode: z.enum(["proposal_only", "supervised"]) }).strict()]) }).strict(),
  z.object({ id: name, kind: z.literal("trusted_scope_duration"), target: z.object({ slot: z.literal("resource.policy.shared_limits"), resource: name, limit_id: name }).strict(),
    previous_limits: inventory, value: z.union([unknown, z.object({ state: z.literal("proposed"), scope,
      window_seconds: window }).strict()]) }).strict(),
  z.object({ id: name, kind: z.literal("column_unit"), target: columnTarget,
    value: z.union([unknown, z.object({ state: z.literal("proposed"), kind: z.literal("integer"), unit: name, scale: z.literal(1),
      meaning: z.string().min(1).max(2000) }).strict()]) }).strict(),
  z.object({ id: name, kind: z.literal("transition"), target: transitionTarget,
    value: z.union([unknown, z.object({ state: z.literal("proposed"), to: scalar, allowed_from: z.array(scalar).min(1).max(64) }).strict()]) }).strict(),
]);
export const actionRequirementProposalsSchema = z.array(proposal).min(1).max(64);
export type ActionRequirementProposal = z.infer<typeof proposal>;
export type ActionRequirementProposals = ActionRequirementProposal[];
const equal = (a: unknown, b: unknown) => canonicalJsonDigest(a) === canonicalJsonDigest(b);
function invalid(): never { throw new Error("AUTHORING_ACTION_REQUIREMENTS_INVALID: Retain the exact closed requirement targets and supported values; unsupported meaning remains pending."); }

/** Proposal DATA only. Freeform business meaning is display material, never a
 * classifier, schema proof, trust assignment, confirmation or permission. */
export function parseActionRequirementProposals(value: unknown): ActionRequirementProposals {
  const result = actionRequirementProposalsSchema.safeParse(value);
  if (!result.success || !equal(result.data, value) || Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) invalid();
  const proposals = result.data;
  if (new Set(proposals.map(p => p.id)).size !== proposals.length
    || new Set(proposals.map(p => canonicalJsonDigest({ kind: p.kind, target: p.target }))).size !== proposals.length) invalid();
  for (const p of proposals) {
    if (p.kind === "approval_count" || p.kind === "trusted_scope_duration") {
      if (new Set(p.previous_limits.map(l => l.id)).size !== p.previous_limits.length
        || p.previous_limits.some(l => l.kind === "count" ? l.field !== undefined : l.field === undefined)) invalid();
    }
    if (p.kind === "approval_count" && p.value.state === "proposed" && p.intent === "retain") {
      const old = p.previous_limits.find(l => l.id === p.target.limit_id), v = p.value;
      if (!old || old.kind !== "count" || old.scope !== v.scope || old.maximum !== v.maximum || old.window_seconds !== v.window_seconds
        || (v.selector.kind === "all_outcomes" ? old.capability !== undefined : old.capability !== v.selector.outcome)) invalid();
    }
    if (p.kind === "trusted_scope_duration" && p.value.state === "proposed") {
      const value = p.value;
      if (!p.previous_limits.some(l => l.id === p.target.limit_id && l.scope === value.scope)) invalid();
    }
    if (p.kind === "transition" && p.value.state === "proposed") {
      const value = p.value;
      if (new Set(value.allowed_from.map(v => canonicalJsonDigest(v))).size !== value.allowed_from.length
        || value.allowed_from.some(v => equal(v, value.to))) invalid();
    }
  }
  return structuredClone(proposals);
}

export function actionRequirementsPending(proposals: ActionRequirementProposals): string[] {
  return parseActionRequirementProposals(proposals).filter(p => p.value.state === "unknown").map(p => p.id);
}
/** Stable named targets permit a later actual native clarification to replace
 * an unknown value, while its exact new proposal requires another review. */
export function actionRequirementTargetsDigest(proposals: ActionRequirementProposals) {
  return canonicalJsonDigest(parseActionRequirementProposals(proposals).map(p => ({ id: p.id, kind: p.kind, target: p.target })));
}
export function actionRequirementsReadback(proposals: ActionRequirementProposals): string[] {
  return ["Review the exact Action requirement targets. Confirmation saves meaning for review; it does not activate or execute an Action.",
    ...parseActionRequirementProposals(proposals).flatMap(p => {
      const target = `${p.target.slot}: ${"outcome" in p.target ? p.target.outcome : p.target.resource}${"field" in p.target ? `.${p.target.field}` : ""}${"limit_id" in p.target ? ` / ${p.target.limit_id}` : ""}`;
      let meaning: string;
      if (p.value.state === "unknown") meaning = `Pending: ${p.value.reason}.`;
      else if (p.kind === "execution") meaning = `Execution setting: ${p.value.mode}.`;
      else if (p.kind === "approval_count") meaning = `At most ${p.value.maximum} approved events per rolling ${p.value.window_seconds} seconds; scope ${p.value.scope}; ${p.value.selector.kind === "all_outcomes" ? "all participating outcomes" : `only ${p.value.selector.outcome}`}; ${p.intent} the selected limit.`;
      else if (p.kind === "trusted_scope_duration") meaning = `Scope ${p.value.scope}; rolling window ${p.value.window_seconds} seconds.`;
      else if (p.kind === "column_unit") meaning = `Integer unit ${p.value.unit}; scale ${p.value.scale}. Proposed business meaning: ${p.value.meaning}`;
      else meaning = `Fixed destination ${JSON.stringify(p.value.to)}; allowed previous values ${JSON.stringify(p.value.allowed_from)}.`;
      return [`${p.id} / ${target}. ${meaning}`, ...("previous_limits" in p ? p.previous_limits.map(l =>
        `Existing limit ${l.id}: ${l.kind} maximum ${l.maximum}, scope ${l.scope}, rolling ${l.window_seconds} seconds, ${l.capability === undefined ? "all participating outcomes" : `only ${l.capability}`}${l.field === undefined ? "" : `, field ${l.field}`}.`) : [])];
    })];
}

/** Host-inspected projection. A model-supplied scalar type is never inspection.
 * Main authenticates this projection under the existing Held boundary. */
export const actionRequirementColumnSchema = z.object({ resource: name, field: name, source: name, physical_identity: name,
  nullable: z.boolean(), scalar_type: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("integer"), unit: name.optional() }).strict(),
    z.object({ kind: z.literal("money_minor"), currency: name }).strict(),
    z.object({ kind: z.literal("boolean") }).strict(),
    z.object({ kind: z.literal("string"), comparison: z.literal("exact"), max_length: integer.min(1), min_length: integer.min(0).optional(), enum: z.array(z.string()).min(1).max(4096).optional() }).strict(),
    z.object({ kind: z.literal("date") }).strict(), z.object({ kind: z.literal("timestamp") }).strict(),
    z.object({ kind: z.literal("unknown") }).strict(),
  ]), minimum: integer.optional(), maximum: integer.optional(), values: z.array(scalar).min(1).max(4096).optional(),
}).strict();
export type ActionRequirementColumn = z.infer<typeof actionRequirementColumnSchema>;
function legalValue(value: z.infer<typeof scalar>, column: ActionRequirementColumn): boolean {
  const t = column.scalar_type;
  if (t.kind === "unknown") return false;
  if (value === null) return column.nullable;
  if (t.kind === "boolean" && typeof value !== "boolean" || ["integer", "money_minor"].includes(t.kind) && typeof value !== "number"
    || ["string", "date", "timestamp"].includes(t.kind) && typeof value !== "string") return false;
  if (typeof value === "number" && (column.minimum !== undefined && value < column.minimum || column.maximum !== undefined && value > column.maximum)) return false;
  if (t.kind === "string" && typeof value === "string" && (value.length > t.max_length || value.length < (t.min_length ?? 0) || t.enum && !t.enum.includes(value))) return false;
  if (t.kind === "date" && typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  if (t.kind === "timestamp" && typeof value === "string" && !Number.isFinite(Date.parse(value))) return false;
  return !column.values || column.values.some(v => equal(v, value));
}
/** Domain checks supplement, never replace, the existing compiler/guard
 * predicates or current trustedLimitScopes(resource) inspection. */
export function assertActionRequirementColumns(proposals: ActionRequirementProposals, columns: ActionRequirementColumn[]): void {
  const inspected = z.array(actionRequirementColumnSchema).max(4096).parse(columns);
  if (!equal(inspected, columns) || new Set(columns.map(c => `${c.resource}/${c.field}`)).size !== columns.length) invalid();
  for (const p of parseActionRequirementProposals(proposals)) {
    if (p.kind !== "column_unit" && p.kind !== "transition") continue;
    const c = columns.find(c => c.resource === p.target.resource && c.field === p.target.field);
    if (!c || canonicalJsonDigest(c) !== p.target.type_fingerprint) invalid();
    if (p.value.state !== "proposed") continue;
    if (p.kind === "column_unit" ? c.scalar_type.kind !== "integer" : !legalValue(p.value.to, c) || p.value.allowed_from.some(v => !legalValue(v, c))) invalid();
  }
}

/** The supported model grammar. Semantic equality, retained inventory and
 * inspected type/target checks still run through the parsers above. */
export function actionRequirementProposalsJsonSchema(): Record<string, unknown> {
  const text = { type: "string", minLength: 1, maxLength: 256 }, number = { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
  const fixed = (value: string) => ({ const: value });
  const obj = (properties: Record<string, unknown>, optional: string[] = []) => ({ type: "object", additionalProperties: false,
    required: Object.keys(properties).filter(key => !optional.includes(key)), properties });
  const choices = (values: string[]) => ({ type: "string", enum: values });
  const scope = choices(["boundary", "capability", "tenant", "tenant_principal", "tenant_object"]);
  const window = { ...number, minimum: 60, maximum: 31_536_000 }, maximum = { ...number, minimum: 1 };
  const hash = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };
  const pending = obj({ state: fixed("unknown"), reason: choices(["missing_meaning", "unsupported_basis", "unsupported_unit", "unsupported_transition"]) });
  const value = (properties: Record<string, unknown>) => ({ oneOf: [pending, obj({ state: fixed("proposed"), ...properties })] });
  const scalar = { anyOf: [{ type: "string", maxLength: 4096 }, number, { type: "boolean" }, { type: "null" }] };
  const previous = { type: "array", maxItems: 64, items: obj({ id: text, kind: choices(["count", "total"]), scope, maximum,
    window_seconds: window, capability: text, field: text }, ["capability", "field"]) };
  const limitTarget = { oneOf: [
    obj({ slot: fixed("approval.shared_limits"), outcome: text, limit_id: text }),
    obj({ slot: fixed("suggestion.approval_policy_proposal.shared_limits"), outcome: text, limit_id: text }),
    obj({ slot: fixed("resource.policy.shared_limits"), resource: text, limit_id: text }),
  ] };
  const entry = (kind: string, properties: Record<string, unknown>) => obj({ id: text, kind: fixed(kind), ...properties });
  return { type: "array", minItems: 1, maxItems: 64, items: { oneOf: [
    entry("approval_count", { target: limitTarget, intent: choices(["retain", "replace"]), previous_limits: previous,
      value: value({ basis: fixed("rolling_approved_events"), scope, maximum, window_seconds: window,
        selector: { oneOf: [obj({ kind: fixed("all_outcomes") }), obj({ kind: fixed("outcome"), outcome: text })] } }) }),
    entry("execution", { target: obj({ slot: fixed("effect.writeback"), outcome: text }), value: value({ mode: choices(["proposal_only", "supervised"]) }) }),
    entry("trusted_scope_duration", { target: obj({ slot: fixed("resource.policy.shared_limits"), resource: text, limit_id: text }), previous_limits: previous,
      value: value({ scope, window_seconds: window }) }),
    entry("column_unit", { target: obj({ slot: fixed("catalog.column"), resource: text, field: text, type_fingerprint: hash }),
      value: value({ kind: fixed("integer"), unit: text, scale: { const: 1 }, meaning: { type: "string", minLength: 1, maxLength: 2000 } }) }),
    entry("transition", { target: obj({ slot: choices(["patches", "proposal.patch"]), resource: text, field: text, type_fingerprint: hash }),
      value: value({ to: scalar, allowed_from: { type: "array", minItems: 1, maxItems: 64, items: scalar } }) }),
  ] } };
}

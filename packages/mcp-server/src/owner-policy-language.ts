import { z } from "zod";

const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u);
const text = z.string().min(1).max(240).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const scalar = z.union([z.string().max(256), z.number().finite().safe(), z.boolean()]);
const compare = z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]);
export type OwnerPredicate =
  | { kind: "all"; conditions: OwnerPredicate[] }
  | { kind: "any"; conditions: OwnerPredicate[] }
  | { kind: "not"; condition: OwnerPredicate }
  | { kind: "compare"; fact: string; operator: z.infer<typeof compare>; value: string | number | boolean }
  | { kind: "compare_facts"; fact: string; operator: z.infer<typeof compare>; other_fact: string }
  | { kind: "one_of"; fact: string; values: Array<string | number | boolean> }
  | { kind: "is_present"; fact: string };
export const ownerPredicateSchema: z.ZodType<OwnerPredicate> = z.lazy(() => z.union([
  z.object({ kind: z.literal("all"), conditions: z.array(ownerPredicateSchema).min(1).max(16) }).strict(),
  z.object({ kind: z.literal("any"), conditions: z.array(ownerPredicateSchema).min(1).max(16) }).strict(),
  z.object({ kind: z.literal("not"), condition: ownerPredicateSchema }).strict(),
  z.object({ kind: z.literal("compare"), fact: name, operator: compare, value: scalar }).strict(),
  z.object({ kind: z.literal("compare_facts"), fact: name, operator: compare, other_fact: name }).strict(),
  z.object({ kind: z.literal("one_of"), fact: name, values: z.array(scalar).min(1).max(32) }).strict(),
  z.object({ kind: z.literal("is_present"), fact: name }).strict(),
]));

export const ownerFactSchema = z.object({
  name, title: text,
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("field"), binding: name, field: name }).strict(),
    z.object({ kind: z.literal("derived"), name }).strict(),
    z.object({ kind: z.literal("input"), name }).strict(),
    z.object({ kind: z.literal("trusted"), binding: z.literal("transaction_time") }).strict(),
  ]),
  operators: z.array(z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "one_of", "is_present"])).min(1).max(8),
  literal_range: z.object({ minimum: z.number().safe(), maximum: z.number().safe() }).strict().optional(),
  literal_values: z.array(scalar).min(1).max(32).optional(),
}).strict();

export const ownerPolicyParentSchema = z.object({
  schema_version: z.literal("synapsor.owner-policy-parent.v1"),
  agents: z.array(name).min(1).max(64),
  outcomes: z.array(z.object({
    outcome: name,
    compiled_plan_digest: digest,
    facts: z.array(ownerFactSchema).min(1).max(32),
    require: ownerPredicateSchema.optional(),
    allow_automatic_approval: z.boolean(),
  }).strict()).min(1).max(32),
}).strict();
export type OwnerPolicyParent = z.infer<typeof ownerPolicyParentSchema>;
export type OwnerPolicyFact = z.infer<typeof ownerFactSchema>;

export const ownerPolicyDefinitionSchema = z.object({
  schema_version: z.literal("synapsor.owner-policy.v1"),
  agents: z.array(name).min(1).max(64),
  rules: z.array(z.object({
    outcome: name,
    require: ownerPredicateSchema,
    approval: z.enum(["inherit", "human"]),
    auto_approve_when: ownerPredicateSchema.optional(),
  }).strict()).min(1).max(32),
}).strict();
export type OwnerPolicyDefinition = z.infer<typeof ownerPolicyDefinitionSchema>;

/** Check structural work BEFORE a recursive schema parser or serialization.
 * No arbitrary recursive model document can exhaust the compiler stack. */
export function assertBoundedOwnerPolicyInput(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  const objects = new Set<object>();
  let nodes = 0, characters = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 8_192 || item.depth > 24) throw new Error("OWNER_POLICY_COMPLEXITY_LIMIT");
    if (typeof item.value === "string") characters += item.value.length;
    else if (typeof item.value === "object" && item.value !== null) {
      if (objects.has(item.value)) throw new Error("OWNER_POLICY_COMPLEXITY_LIMIT");
      objects.add(item.value);
      const entries = Object.entries(item.value);
      if (entries.length > (Array.isArray(item.value) ? 512 : 128)) throw new Error("OWNER_POLICY_COMPLEXITY_LIMIT");
      for (const [key, nested] of entries) { characters += key.length; pending.push({ value: nested, depth: item.depth + 1 }); }
    }
    if (characters > 65_536) throw new Error("OWNER_POLICY_COMPLEXITY_LIMIT");
  }
}

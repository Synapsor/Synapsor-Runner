import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseSharedSumDesignation, type SharedSumDesignationV1 } from "@synapsor-runner/action-rules";
import { validateAuthoringTransportState, type AuthoringTransportState } from "./authoring-generation-recovery.js";

type Digest = `sha256:${string}`;
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(value => value as Digest);
const name = z.string().min(1).max(256).refine(value => value.trim() === value);
const completion = z.object({ operation_id: z.string().uuid(), request_digest: hash, context_digest: hash, response_digest: hash }).strict();
const material = z.object({ intent_digest: hash, context_digest: hash,
  components: z.object({ verification: z.record(z.unknown()), effect: z.record(z.unknown()), rule: z.record(z.unknown()), approval: z.record(z.unknown()) }).strict(),
  question: z.object({ question: z.string(), operator_message: z.string(), policy_source_digest: hash.nullable() }).strict().nullable(),
}).strict();
const dependencies = z.object({ context_digest: hash, source_digest: hash, catalog_digest: hash, generation_lock_fingerprint: hash,
  read_dependencies: z.array(z.object({ name, digest: hash }).strict()).min(1).max(4096),
  participating_outcomes: z.array(name).min(1).max(64),
}).strict();
const schema = z.object({ version: z.literal(1), designation: z.unknown(), dependencies,
  origin: z.object({ completion, material }).strict(),
  predecessor: z.object({ question_id: z.string().uuid(), question_digest: hash }).strict().optional(),
}).strict();

/** Retained DATA in the existing Question. Main resolves authentic protected
 * producer custody and current dependencies before consuming confirmation.
 * The precompiled D2 stage has no supported origin in this version. */
export type SharedSumQuestionBinding = Omit<z.infer<typeof schema>, "designation"> & { designation: SharedSumDesignationV1 };
function invalid(): never { throw new Error("AUTHORING_SHARED_SUM_INVALID: The exact proposal, producer material or native origin is unavailable. No authority was accepted."); }
const equal = (a: unknown, b: unknown) => canonicalJsonDigest(a) === canonicalJsonDigest(b);
export function parseSharedSumQuestionBinding(value: unknown): SharedSumQuestionBinding {
  const parsed = schema.safeParse(value);
  if (!parsed.success || !equal(parsed.data, value)) invalid();
  const raw = parsed.data, designation = parseSharedSumDesignation(raw.designation);
  if (new Set(raw.dependencies.read_dependencies.map(read => read.name)).size !== raw.dependencies.read_dependencies.length
    || new Set(raw.dependencies.participating_outcomes).size !== raw.dependencies.participating_outcomes.length
    || !equal(designation, raw.origin.material.components.rule.shared_sum_proposal)
    || !raw.dependencies.participating_outcomes.includes(raw.origin.material.components.rule.outcome as string)) invalid();
  return structuredClone({ ...raw, designation });
}

/** Historical identity validation, not a currentness check or permission.
 * The full original tuple uses the existing actionLogicalTurnMaterialDigest
 * domain; a descriptor-only digest cannot borrow a genuine completion. */
export function assertSharedSumQuestionGeneration(input: SharedSumQuestionBinding, generation?: AuthoringTransportState): void {
  const binding = parseSharedSumQuestionBinding(input);
  if (!generation) invalid();
  validateAuthoringTransportState(generation);
  const c = binding.origin.completion, op = generation.operations.find(op => op.id === c.operation_id);
  if (!op || op.state !== "checkpointed" || !op.checkpoint_seen || op.request_digest !== c.request_digest
    || op.context_digest !== c.context_digest || op.attempts.at(-1)?.outcome !== "response"
    || !equal(op.action_checkpoint, { consumer: "action_rule_components", kind: "compiled_draft",
      material_digest: canonicalJsonDigest(binding.origin.material), response_digest: c.response_digest })) invalid();
}

export function sharedSumQuestionReadback(input: SharedSumQuestionBinding): string[] {
  const binding = parseSharedSumQuestionBinding(input), d = binding.designation;
  return [
    `Review this current-state shared total: SUM(${d.populations[0].resource}.${d.populations[0].field}) + SUM(${d.populations[1].resource}.${d.populations[1].field}).`,
    `Limit and guard parent: ${d.limit.resource}.${d.limit.field}.`,
    `Scope: ${d.scope.tenant_field} and ${d.scope.principal_field}; Source: ${d.source}.`,
    `Integer units: ${d.unit.unit}. Proposed business meaning: ${d.unit.meaning}`,
    `Participating Actions: ${binding.dependencies.participating_outcomes.join(", ")}.`,
    "Changes exceeding the freshly read limit are refused. Unsupported or uninspectable effects are refused.",
    "Deployment: one Source, two complete scoped populations, bounded participating INSERT/UPDATE writers, and an inspected atomic Source receipt. External writers are outside this guarantee.",
    "Confirming meaning does not establish the technical proof, activate authority, or apply a change. Unknown commit outcomes remain unknown and cannot be replayed as a confirmed success.",
  ];
}

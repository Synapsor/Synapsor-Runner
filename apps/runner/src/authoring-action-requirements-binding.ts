import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { actionRequirementDigestSchema as hash, actionRequirementColumnSchema, parseActionRequirementProposals,
  assertActionRequirementColumns, type ActionRequirementProposals } from "./authoring-action-requirements.js";
import { parseActionRuleAuthoringCheckpoint, actionLogicalTurnMaterialDigest, type ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { validateAuthoringTransportState, type AuthoringTransportState } from "./authoring-generation-recovery.js";
const name = z.string().min(1).max(256).refine(value => value.trim() === value);
const completion = z.object({ operation_id: z.string().uuid(), request_digest: hash, context_digest: hash, response_digest: hash }).strict();
const scopes = z.enum(["boundary", "capability", "tenant", "tenant_principal", "tenant_object"]);
const dependencies = z.object({ root_digest: hash, source_digest: hash, store_digest: hash, session_digest: hash,
  context_digest: hash, catalog_digest: hash, generation_lock_fingerprint: hash, resume_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  read_dependencies: z.array(z.object({ name, digest: hash }).strict()).min(1).max(4096), participating_outcomes: z.array(name).min(1).max(64),
  source_locator: z.object({ source_session: z.string().uuid(), source_digest: hash, store_digest: hash,
    start: z.number().int().min(1).max(600), end: z.number().int().min(1).max(600) }).strict(),
  baseline_ast: z.record(z.unknown()), intended_ast: z.record(z.unknown()), columns: z.array(actionRequirementColumnSchema).max(4096),
  trusted_scopes: z.array(z.object({ resource: name, scopes: z.array(scopes).max(5) }).strict()).max(64),
}).strict();
const schema = z.object({ version: z.literal(1), proposals: z.unknown(), dependencies,
  origin: z.object({ kind: z.enum(["ordinary_clarification", "compiled_draft"]), checkpoint: z.unknown(), completion }).strict(),
  predecessor: z.object({ question_id: z.string().uuid(), question_digest: hash }).strict().optional() }).strict();
export type ActionRequirementsQuestionBinding = Omit<z.infer<typeof schema>, "proposals" | "origin"> & {
  proposals: ActionRequirementProposals; origin: Omit<z.infer<typeof schema>["origin"], "checkpoint"> & { checkpoint: ActionRuleAuthoringCheckpoint } };
const equal = (a: unknown, b: unknown) => canonicalJsonDigest(a) === canonicalJsonDigest(b);
function invalid(): never { throw new Error("AUTHORING_ACTION_REQUIREMENTS_INVALID: The exact original typed submission, partial material, target or current dependency binding is unavailable."); }

/** Serializable DATA. The protected native producer/save/current host inspection
 * is owned by Main; a copied checkpoint or this parser grants no authority. */
export function parseActionRequirementsQuestionBinding(value: unknown): ActionRequirementsQuestionBinding {
  const result = schema.safeParse(value);
  if (!result.success || !equal(result.data, value)) invalid();
  const raw = result.data, proposals = parseActionRequirementProposals(raw.proposals), checkpoint = parseActionRuleAuthoringCheckpoint(raw.origin.checkpoint);
  const closed = checkpoint.logical_turns?.at(-1)?.completed, deps = raw.dependencies;
  if (checkpoint.schema_version !== "synapsor.action-authoring-checkpoint.v4" || checkpoint.pending_version
    || !closed || closed.kind !== raw.origin.kind || !equal(closed.completion, raw.origin.completion)
    || closed.material_digest !== actionLogicalTurnMaterialDigest(checkpoint) || !equal(checkpoint.requirement_proposals, proposals)
    || checkpoint.context_digest !== deps.context_digest
    || (raw.origin.kind === "ordinary_clarification" ? !checkpoint.pending_question || !equal(checkpoint.pending_question.completion, raw.origin.completion)
      : !!checkpoint.pending_question || ["verification", "effect", "rule", "approval"].some(phase => !checkpoint.components[phase as keyof typeof checkpoint.components])
        || !equal(checkpoint.components.rule?.requirement_proposals, proposals))
    || deps.source_locator.source_digest !== deps.source_digest || deps.source_locator.store_digest !== deps.store_digest
    || deps.source_locator.end < deps.source_locator.start
    || new Set(deps.read_dependencies.map(r => r.name)).size !== deps.read_dependencies.length
    || new Set(deps.participating_outcomes).size !== deps.participating_outcomes.length
    || new Set(deps.trusted_scopes.map(r => r.resource)).size !== deps.trusted_scopes.length
    || deps.trusted_scopes.some(r => new Set(r.scopes).size !== r.scopes.length)) invalid();
  assertActionRequirementColumns(proposals, deps.columns);
  for (const p of proposals) {
    if ("outcome" in p.target && !deps.participating_outcomes.includes(p.target.outcome)) invalid();
    if (p.kind === "approval_count" && p.value.state === "proposed" && p.value.selector.kind === "outcome"
      && !deps.participating_outcomes.includes(p.value.selector.outcome)) invalid();
    if (p.kind === "approval_count" && p.value.state === "proposed" && "resource" in p.target
      && !deps.trusted_scopes.find(r => "resource" in p.target && r.resource === p.target.resource)?.scopes.includes(p.value.scope)) invalid();
    if (p.kind === "trusted_scope_duration" && p.value.state === "proposed"
      && !deps.trusted_scopes.find(r => r.resource === p.target.resource)?.scopes.includes(p.value.scope)) invalid();
  }
  return structuredClone({ ...raw, proposals, origin: { ...raw.origin, checkpoint } });
}

/** Historical native identity only. Main must additionally authenticate the
 * original decoder/held Question and reinspect all dependencies after UI wait
 * and again at save. Never stamp an ACK from a copied completion. */
export function assertActionRequirementsQuestionGeneration(input: ActionRequirementsQuestionBinding, generation?: AuthoringTransportState): void {
  const b = parseActionRequirementsQuestionBinding(input);
  if (!generation) invalid();
  validateAuthoringTransportState(generation);
  const c = b.origin.completion, op = generation.operations.find(op => op.id === c.operation_id);
  if (!op || op.state !== "checkpointed" || !op.checkpoint_seen || op.request_digest !== c.request_digest
    || op.context_digest !== c.context_digest || op.attempts.at(-1)?.outcome !== "response") invalid();
  if (b.origin.kind === "ordinary_clarification") {
    // The original handoff is append-only history after an actual answer. Its
    // answer does not confirm these proposals or authorize another completion.
    const h = op.question_handoff, original = b.origin.checkpoint;
    if (!h || h.consumer !== "action_rule_clarification" || h.checkpoint_digest !== original.digest
      || h.question !== original.pending_question!.question || h.question_digest !== canonicalJsonDigest(original.pending_question!.question)
      || h.response_digest !== c.response_digest) invalid();
  } else if (!equal(op.action_checkpoint, { consumer: "action_rule_components", kind: "compiled_draft",
    material_digest: actionLogicalTurnMaterialDigest(b.origin.checkpoint), response_digest: c.response_digest })) invalid();
}

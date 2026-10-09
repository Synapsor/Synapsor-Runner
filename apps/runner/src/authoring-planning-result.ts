import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { BoundaryJobPlan } from "./boundary-job-model.js";
import { parseReadScopeRecord } from "./read-structured-scope.js";
import { assertReviewOperationShape } from "./boundary-job-operation-contract.js";
import { isAuthoringClientPlan } from "./authoring-client-plan.js";
import { AUTHORING_PROGRAM_CAPACITY } from "./authoring-program-capacity.js";
import { assertAuthoringPlanningCheckpoint, type AuthoringQuestionCompletion, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0);
export const PLANNING_RESULT_VERSION = "synapsor.authoring-planning-result.v1" as const;
export const PLANNING_INVOCATION_VERSION = "synapsor.authoring-planning-invocation.v1" as const;
const invocationSchema = z.object({ version: z.literal(PLANNING_INVOCATION_VERSION),
  provider: z.enum(["openai", "anthropic", "openrouter", "openai_compatible"]), model: text(200),
  destination_digest: digest, options_digest: digest, tool_digest: digest, input_digest: digest, scope_digest: digest, prompt_digest: digest, history_digest: digest, continuation_history_digest: digest,
}).strict();
export type BoundaryPlanningInvocation = z.infer<typeof invocationSchema>;
const completionSchema = z.object({ operation_id: text(200), request_digest: digest,
  context_digest: digest, response_digest: digest }).strict();
const planSchema = z.object({ state: z.literal("planned"), operation: z.literal("review_rules").optional(),
  intended_client: z.string().refine(isAuthoringClientPlan).optional(),
  read_mode: z.enum(["create", "resume", "reuse", "revise", "none"]), read_intent: text(4000).optional(),
  read_scope: z.unknown(), action_mode: z.enum(["create", "reuse", "revise", "remove", "none"]),
  action_intent: text(4000).optional(), action_intents: z.array(text(4000)).min(1).max(AUTHORING_PROGRAM_CAPACITY.totalActions).optional(),
  action_outcomes: z.array(text(200)).min(1).max(AUTHORING_PROGRAM_CAPACITY.totalActions).optional(), action_outcome: text(200).optional(),
  action_strategy: z.enum(["discretionary", "rule_derived"]).optional(), summary: text(4000), correction_used: z.boolean(),
  authority_granted: z.literal(false), source_database_changed: z.literal(false),
}).strict();
export type BoundaryPlannedMaterial = Omit<Extract<BoundaryJobPlan, { state: "planned" }>, "completion" | "planning_invocation">;
export type BoundaryPlanningResult = { schema_version: typeof PLANNING_RESULT_VERSION; plan: BoundaryPlannedMaterial;
  completion: AuthoringQuestionCompletion; invocation: BoundaryPlanningInvocation; material_digest: `sha256:${string}`;
  read_scope_question_id: string };
const invalid = (): never => { throw new Error("AUTHORING_PLANNING_RESULT_INVALID: Preserve this job; its exact completed planning material is unavailable or changed."); };
export function parseBoundaryPlanningInvocation(value: unknown): BoundaryPlanningInvocation {
  const parsed = invocationSchema.safeParse(value); if (!parsed.success) return invalid();
  return parsed.data;
}
export function parseBoundaryPlannedMaterial(value: unknown): BoundaryPlannedMaterial {
  const parsed = planSchema.safeParse(value); if (!parsed.success) return invalid();
  const p = parsed.data, scope = parseReadScopeRecord(p.read_scope);
  if (p.operation) {
    const { state: _state, read_scope: _scope, correction_used: _correction, authority_granted: _authority,
      source_database_changed: _changed, ...routing } = p;
    assertReviewOperationShape({ status: "planned", ...routing });
  }
  if (scope.analysis_digest || (p.read_mode === "none" && scope.proposal.applicability !== "no_read_requested")
    || (["create", "revise"].includes(p.read_mode) && (!p.read_intent || scope.proposal.applicability !== "read_requested"))
    || (! ["create", "revise"].includes(p.read_mode) && p.read_intent !== undefined)
    || (["create", "revise"].includes(p.action_mode) && (!p.action_intent || !p.action_strategy))
    || (! ["create", "revise"].includes(p.action_mode) && (p.action_intent !== undefined || p.action_strategy !== undefined))
    || (p.action_mode === "remove" && (!p.action_outcome || !["none", "reuse"].includes(p.read_mode)))
    || (p.action_intents && (p.action_mode !== "create" || p.action_intents[0] !== p.action_intent
      || new Set(p.action_intents).size !== p.action_intents.length))
    || (p.action_outcomes && (!p.action_intents || p.action_outcomes.length !== p.action_intents.length
      || new Set(p.action_outcomes).size !== p.action_outcomes.length))) return invalid();
  return { ...p, read_scope: scope } as BoundaryPlannedMaterial;
}
/** Codec only; applicability additionally requires native consumption and current invocation. */
export function parseBoundaryPlanningResult(value: unknown): BoundaryPlanningResult {
  const parsed = z.object({ schema_version: z.literal(PLANNING_RESULT_VERSION), plan: z.unknown(), completion: completionSchema,
    invocation: invocationSchema, material_digest: digest, read_scope_question_id: text(200) }).strict().safeParse(value);
  if (!parsed.success) return invalid();
  const plan = parseBoundaryPlannedMaterial(parsed.data.plan);
  if (canonicalJsonDigest(plan) !== parsed.data.material_digest) return invalid();
  return structuredClone({ ...parsed.data, plan }) as BoundaryPlanningResult;
}
// Live producer provenance, not a recoverable or caller-created historical ACK.
const completedPlans = new WeakMap<object, { plan: BoundaryPlannedMaterial; invocation: BoundaryPlanningInvocation; completion: AuthoringQuestionCompletion }>();
export function registerCompletedBoundaryPlan(result: Extract<BoundaryJobPlan, { state: "planned" }>, invocation: BoundaryPlanningInvocation): void {
  if (!result.completion) return;
  const { completion, planning_invocation: _binding, ...material } = result;
  completedPlans.set(result, structuredClone({ plan: parseBoundaryPlannedMaterial(material),
    invocation: parseBoundaryPlanningInvocation(invocation), completion }));
}
export function createBoundaryPlanningResult(result: Extract<BoundaryJobPlan, { state: "planned" }>, questionId: string): BoundaryPlanningResult {
  const registered = completedPlans.get(result);
  const { completion, planning_invocation, ...material } = result;
  if (!registered || canonicalJsonDigest(material) !== canonicalJsonDigest(registered.plan)
    || canonicalJsonDigest(completion ?? null) !== canonicalJsonDigest(registered.completion)
    || canonicalJsonDigest(planning_invocation ?? null) !== canonicalJsonDigest(registered.invocation)) return invalid();
  return parseBoundaryPlanningResult({ schema_version: PLANNING_RESULT_VERSION, plan: registered.plan,
    completion: registered.completion, invocation: registered.invocation, material_digest: canonicalJsonDigest(registered.plan),
    read_scope_question_id: questionId });
}
export function assertBoundaryPlanningResultNative(value: BoundaryPlanningResult, generation: AuthoringTransportState | undefined,
  questions: readonly OperatorQuestion[]): void {
  const result = parseBoundaryPlanningResult(value);
  assertAuthoringPlanningCheckpoint(generation, result.completion, result.material_digest);
  const q = questions.find(question => question.id === result.read_scope_question_id);
  if (!q || q.kind !== "read_scope" || q.read_scope?.mode !== "review"
    || canonicalJsonDigest(q.read_scope.record) !== canonicalJsonDigest(result.plan.read_scope)
    || canonicalJsonDigest(q.read_scope.completion) !== canonicalJsonDigest(result.completion)) return invalid();
}
export function restoreBoundaryPlanningResult(value: BoundaryPlanningResult, generation: AuthoringTransportState | undefined,
  questions: readonly OperatorQuestion[], current: BoundaryPlanningInvocation): Extract<BoundaryJobPlan, { state: "planned" }> {
  const result = parseBoundaryPlanningResult(value);
  assertBoundaryPlanningResultNative(result, generation, questions);
  if (canonicalJsonDigest(parseBoundaryPlanningInvocation(current)) !== canonicalJsonDigest(result.invocation))
    throw new Error("AUTHORING_PLANNING_RESULT_STALE: The original planning invocation changed; no completed request was replayed.");
  return structuredClone({ ...result.plan, completion: result.completion, planning_invocation: result.invocation });
}

/** Bounded audit history in the same Resume record. Selection is not permission. */
export function appendBoundaryPlanningResult(history: readonly BoundaryPlanningResult[], next?: BoundaryPlanningResult): BoundaryPlanningResult[] {
  const parsed = history.map(parseBoundaryPlanningResult);
  const keys = parsed.map(item => item.completion.operation_id);
  if (parsed.length > 64 || new Set(keys).size !== keys.length) return invalid();
  if (!next) return parsed;
  const record = parseBoundaryPlanningResult(next), existing = parsed.find(item => item.completion.operation_id === record.completion.operation_id);
  if (existing) { if (canonicalJsonDigest(existing) !== canonicalJsonDigest(record)) return invalid(); return parsed; }
  if (parsed.length === 64) return invalid();
  return [...parsed, record];
}
export function assertBoundaryPlanningHistoryAdvance(previous: readonly BoundaryPlanningResult[], next: readonly BoundaryPlanningResult[]): void {
  const before = appendBoundaryPlanningResult(previous), after = appendBoundaryPlanningResult(next);
  if (after.length < before.length || before.some((item, index) => canonicalJsonDigest(item) !== canonicalJsonDigest(after[index]))) return invalid();
}

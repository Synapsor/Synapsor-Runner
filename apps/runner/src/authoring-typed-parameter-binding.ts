import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { actionRuleModelDraftJsonSchema } from "./action-rule-model.js";
import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import type { ActionParameterTarget } from "./authoring-action-parameter-review.js";
import { parseTypedReviewView, parseTypedFieldEvent, validateTypedFieldEvent } from "./authoring-typed-review-codec.js";
import type { TypedFieldEvent, TypedReviewView } from "./authoring-typed-review.js";
import type { AuthoringTransportState } from "./authoring-generation-recovery.js";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(v => v as `sha256:${string}`);
const text = z.string().trim().min(1).max(256);
const completion = z.object({ operation_id: text, request_digest: digest, context_digest: digest, response_digest: digest }).strict();
const reference = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("compiled_checkpoint"), checkpoint_digest: digest, material_digest: digest, completion, outcome: text, draft_digest: digest }).strict(),
    z.object({ kind: z.literal("saved_authority"), identity: z.object({ location: z.enum(["disabled", "active"]), record: text, store: digest }).strict(), authority_digest: digest, outcome: text, draft_digest: digest }).strict(),
]);
const common = { label: text, explanation: z.string().min(1).max(4000).optional(), expected_baseline_approval_digest: digest, expected_approval_digest: digest };
const comparison = { ...common, input_name: text, expected_expression_digest: digest, expected_input_digest: digest, money_scale: z.number().int().min(0).max(18).optional() };
const target = z.discriminatedUnion("kind", [
    z.object({ ...common, kind: z.literal("required_approvals") }).strict(),
    z.object({ ...comparison, kind: z.literal("approval_threshold") }).strict(),
    z.object({ ...comparison, kind: z.literal("approval_comparator") }).strict(),
]);
const bindingSchema = z.object({ version: z.literal(1), baseline: reference, origin: reference, initial_candidate_digest: digest, proposal_id: text, operation_id: text, applicability_digest: digest, targets: z.array(target).min(1).max(3), predecessor: z.object({ question_id: z.string().uuid(), question_digest: digest }).strict().optional() }).strict();
export type TypedParameterReference = z.infer<typeof reference>;
export type TypedParameterBinding = {
    version: 1;
    baseline: TypedParameterReference;
    origin: TypedParameterReference;
    initial_candidate_digest: `sha256:${string}`;
    proposal_id: string;
    operation_id: string;
    applicability_digest: `sha256:${string}`;
    targets: ActionParameterTarget[];
    predecessor?: {
        question_id: string;
        question_digest: `sha256:${string}`;
    };
};
export type TypedParameterRecord = {
    candidate: ActionRuleModelDraftV1;
    view: TypedReviewView;
    event?: TypedFieldEvent;
    predecessor_proposal_digest?: `sha256:${string}`;
};
function fail(): never { throw new Error("AUTHORING_QUESTION_INVALID: The typed parameter proposal, provenance or retained event sequence is invalid."); }
const equal = (a: unknown, b: unknown) => canonicalJsonDigest(a) === canonicalJsonDigest(b);
let validator: ValidateFunction | undefined;
/** Lazy: the existing strict Action grammar imports the Question owner. */
function parseDraft(value: unknown): ActionRuleModelDraftV1 {
    validator ??= new Ajv2020({ strict: false, allErrors: true }).compile(actionRuleModelDraftJsonSchema({ purpose: "compiled_checkpoint" }));
    if (!validator(value))
        fail();
    return structuredClone(value) as ActionRuleModelDraftV1;
}
export function parseTypedParameterBinding(value: unknown): TypedParameterBinding {
    const result = bindingSchema.safeParse(value);
    if (!result.success)
        fail();
    const b = result.data as TypedParameterBinding;
    if (!equal(b, value))
        fail();
    if (b.origin.draft_digest !== b.initial_candidate_digest || b.baseline.outcome !== b.origin.outcome || new Set(b.targets.map(t => t.kind)).size !== b.targets.length)
        fail();
    return structuredClone(b);
}
export function parseTypedParameterRecord(value: unknown, binding: TypedParameterBinding): TypedParameterRecord {
    const raw = z.object({ candidate: z.unknown(), view: z.unknown(), event: z.unknown().optional(), predecessor_proposal_digest: digest.optional() }).strict().safeParse(value);
    if (!raw.success)
        fail();
    const candidate = parseDraft(raw.data.candidate), view = parseTypedReviewView(raw.data.view);
    if (candidate.outcome !== binding.origin.outcome || view.binding.proposal_id !== binding.proposal_id || view.binding.operation_id !== binding.operation_id || view.binding.applicability_digest !== binding.applicability_digest || view.binding.proposal_digest !== canonicalJsonDigest(candidate))
        fail();
    return { candidate, view, ...(raw.data.event === undefined ? {} : { event: parseTypedFieldEvent(raw.data.event) }), ...(raw.data.predecessor_proposal_digest ? { predecessor_proposal_digest: raw.data.predecessor_proposal_digest } : {}) };
}
export function assertTypedParameterSequence(binding: TypedParameterBinding, proposals: readonly {
    value?: unknown;
}[]): TypedParameterRecord[] {
    if (!proposals.length)
        fail();
    const records: TypedParameterRecord[] = [];
    let previous: TypedParameterRecord | undefined;
    for (let i = 0; i < proposals.length; i++) {
        const value = proposals[i]!.value as {
            kind?: unknown;
            record?: unknown;
        } | undefined;
        if (!value || value.kind !== "typed_parameters")
            fail();
        const record = parseTypedParameterRecord(value.record, binding);
        if (record.view.binding.proposal_revision !== i + 1)
            fail();
        if (!previous) {
            if (record.event || record.predecessor_proposal_digest || canonicalJsonDigest(record.candidate) !== binding.initial_candidate_digest)
                fail();
        }
        else {
            if (!record.event || record.predecessor_proposal_digest !== canonicalJsonDigest(proposals[i - 1]))
                fail();
            validateTypedFieldEvent(previous.view, record.event);
        }
        records.push(record);
        previous = record;
    }
    return records;
}
/** Verify exact existing consumption; this never mints or rewrites a checkpoint. */
export function assertTypedParameterGeneration(binding: TypedParameterBinding, generation?: AuthoringTransportState): void {
    for (const ref of [binding.baseline, binding.origin]) {
        if (ref.kind !== "compiled_checkpoint")
            continue;
        const c = ref.completion, op = generation?.operations.find(o => o.id === c.operation_id);
        if (!op || op.state !== "checkpointed" || op.checkpoint_seen !== true || op.request_digest !== c.request_digest || op.context_digest !== c.context_digest || op.attempts.at(-1)?.outcome !== "response" || !equal(op.action_checkpoint, { consumer: "action_rule_components", kind: "compiled_draft", material_digest: ref.material_digest, response_digest: c.response_digest }))
            fail();
    }
}
export function typedParameterPendingFields(records: readonly TypedParameterRecord[]): string[] {
    const pending = new Set<string>();
    for (const r of records) {
        if (!r.event)
            continue;
        if (r.event.kind === "leave_pending")
            pending.add(r.event.field_id);
        else
            pending.delete(r.event.field_id);
    }
    return [...pending].sort();
}

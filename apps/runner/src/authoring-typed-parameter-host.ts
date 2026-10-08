import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { buildActionParameterReview, applyActionParameterEvent, type ActionParameterReviewInput } from "./authoring-action-parameter-review.js";
import type { ActionParameterInteractionPorts, ActionParameterAcknowledgement } from "./authoring-action-parameter-interaction.js";
import { parseOperatorQuestion, parseOperatorQuestions, proposeOperatorAnswer, confirmOperatorAnswer, leaveOperatorQuestionPending, reopenOperatorQuestion, assertOperatorQuestionsAdvance, type OperatorQuestion } from "./authoring-operator-question.js";
import { parseTypedParameterBinding, parseTypedParameterRecord, typedParameterPendingFields, type TypedParameterBinding, type TypedParameterRecord } from "./authoring-typed-parameter-binding.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { AuthoringTransportState } from "./authoring-generation-recovery.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import type { TypedFieldEvent } from "./authoring-typed-review.js";
type Digest = `sha256:${string}`;
export type TypedParameterResolved = {
    baseline: ActionParameterReviewInput["baseline"];
    initial: ActionParameterReviewInput["working"];
    compile: ActionParameterReviewInput["compile"];
};
export type TypedParameterHostAccess = {
    readQuestions(): readonly OperatorQuestion[];
    readHandoffs(): readonly AuthoringOwnerHandoff[];
    readRecovery(): AuthoringTransportState | undefined;
    /** Re-load exact protected source record/checkpoint and current compiler context.
     * A saved-reference string or caller supplied candidate is not provenance. */
    resolve(binding: TypedParameterBinding, permit?: ProjectAuthorityMutationPermit): Promise<TypedParameterResolved>;
    assertFresh(binding: TypedParameterBinding, permit?: ProjectAuthorityMutationPermit): Promise<void>;
    mutate<T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>): Promise<T>;
    installQuestions(questions: OperatorQuestion[]): void;
    /** Existing owning Resume save/CAS. Enclosing mutate restores memory on failure. */
    save(permit: ProjectAuthorityMutationPermit): Promise<void>;
};
const equal = (a: unknown, b: unknown) => canonicalJsonDigest(a) === canonicalJsonDigest(b);
function stale(): never { throw new Error("TYPED_PARAMETER_QUESTION_STALE: The protected proposal, baseline or origin changed. No answer or new allowance was adopted."); }
function domain(binding: TypedParameterBinding, resolved: TypedParameterResolved, working: ActionParameterReviewInput["working"], revision: number, pending: string[]): ActionParameterReviewInput {
    if (canonicalJsonDigest(resolved.baseline) !== binding.baseline.draft_digest || canonicalJsonDigest(resolved.initial) !== binding.initial_candidate_digest || resolved.baseline.outcome !== binding.baseline.outcome)
        stale();
    const targets = binding.targets.map(target => {
        if (target.expected_baseline_approval_digest !== canonicalJsonDigest(resolved.baseline.approval) || target.expected_approval_digest !== canonicalJsonDigest(resolved.initial.approval))
            stale();
        if (target.kind !== "required_approvals") {
            const initialExpression = resolved.initial.approval.auto_approve_when, initialInput = resolved.initial.inputs?.find(i => i.name === target.input_name);
            if (!initialInput || canonicalJsonDigest(initialExpression) !== target.expected_expression_digest || canonicalJsonDigest(initialInput) !== target.expected_input_digest)
                stale();
            const input = working.inputs?.find(i => i.name === target.input_name);
            if (!input)
                stale();
            return { ...target, expected_approval_digest: canonicalJsonDigest(working.approval), expected_expression_digest: canonicalJsonDigest(working.approval.auto_approve_when), expected_input_digest: canonicalJsonDigest(input) };
        }
        return { ...target, expected_approval_digest: canonicalJsonDigest(working.approval) };
    });
    return { baseline: resolved.baseline, working, expected_baseline_digest: binding.baseline.draft_digest, proposal_id: binding.proposal_id, proposal_revision: revision, operation_id: binding.operation_id, applicability_digest: binding.applicability_digest, origin: revision > 1 ? "operator_edit" : binding.origin.kind === "compiled_checkpoint" ? "model_proposal" : "saved_unconfirmed", baseline_origin: binding.baseline.kind === "compiled_checkpoint" ? "model_proposal" : binding.baseline.identity.location === "active" ? "saved_confirmed" : "saved_unconfirmed", targets, pending_fields: pending, compile: resolved.compile };
}
export function createTypedParameterQuestion(input: {
    id: string;
    revision: number;
    scope_digest: Digest;
    context_digest: Digest;
    binding: TypedParameterBinding;
    resolved: TypedParameterResolved;
}): OperatorQuestion {
    const binding = parseTypedParameterBinding(input.binding), projected = buildActionParameterReview(domain(binding, input.resolved, input.resolved.initial, 1, []));
    if (canonicalJsonDigest(projected.candidate) !== binding.initial_candidate_digest)
        stale();
    const body = { version: 2 as const, id: input.id, revision: input.revision, kind: "typed_parameters" as const, typed_parameters: binding, scope_digest: input.scope_digest, context_digest: input.context_digest, target: { phase: "typed_parameters", outcomes: [binding.origin.outcome] }, material: [], evidence: [], continuation: "action_rule_review" as const,
        proposal: { question_id: input.id, revision: input.revision, source_reference: canonicalJsonDigest(binding), disposition: "proposed" as const, value: { kind: "typed_parameters" as const, record: { candidate: projected.candidate, view: projected.view } } } };
    return parseOperatorQuestion({ ...body, digest: canonicalJsonDigest(body) });
}
/** Recompile the entire candidate and every retained amendment against the actual
 * current baseline. No renderer-supplied normalized candidate is trusted. */
export function revalidateTypedParameterQuestion(value: OperatorQuestion, resolved: TypedParameterResolved) {
    const q = parseOperatorQuestion(value), binding = q.typed_parameters;
    if (!binding || q.proposal?.value?.kind !== "typed_parameters")
        stale();
    const proposals = [...(q.proposal_history ?? []), q.proposal], records: TypedParameterRecord[] = [];
    let working = resolved.initial, current: ActionParameterReviewInput | undefined;
    for (let index = 0; index < proposals.length; index++) {
        const value = proposals[index]!.value;
        if (value?.kind !== "typed_parameters")
            stale();
        const record = parseTypedParameterRecord(value.record, binding);
        if (record.event) {
            if (!current)
                stale();
            working = applyActionParameterEvent(current, record.event).candidate;
        }
        records.push(record);
        current = domain(binding, resolved, working, index + 1, typedParameterPendingFields(records));
        const projected = buildActionParameterReview(current);
        if (!equal(projected.candidate, record.candidate) || !equal(projected.view, record.view))
            stale();
    }
    return { question: q, domain: current!, view: records.at(-1)!.view, records };
}
function ack(question: OperatorQuestion, view: TypedParameterRecord["view"]): ActionParameterAcknowledgement { return { native: { question_id: question.id, question_revision: question.revision, question_digest: question.digest }, binding: structuredClone(view.binding) }; }
export function createTypedParameterHost(input: {
    question_id: string;
    access: TypedParameterHostAccess;
}): ActionParameterInteractionPorts {
    const { access } = input;
    const read = async (permit?: ProjectAuthorityMutationPermit) => {
        const questions = parseOperatorQuestions(access.readQuestions(), access.readHandoffs(), access.readRecovery());
        const q = questions.find(q => q.id === input.question_id);
        if (!q?.typed_parameters || questions.some(next => next.typed_parameters?.predecessor?.question_id === q.id))
            stale();
        await access.assertFresh(q.typed_parameters, permit);
        const resolved = await access.resolve(q.typed_parameters, permit), checked = revalidateTypedParameterQuestion(q, resolved);
        return { ...checked, questions, resolved };
    };
    const checkExpected = (current: Awaited<ReturnType<typeof read>>, expected: ActionParameterAcknowledgement) => { if (!equal(ack(current.question, current.view), expected))
        stale(); };
    const save = async (current: Awaited<ReturnType<typeof read>>, next: OperatorQuestion, permit: ProjectAuthorityMutationPermit) => {
        const questions = current.questions.map(q => q.id === next.id ? next : q);
        assertOperatorQuestionsAdvance(current.questions, questions);
        parseOperatorQuestions(questions, access.readHandoffs(), access.readRecovery());
        access.installQuestions(questions);
        await access.save(permit);
        const stored = access.readQuestions().find(q => q.id === next.id);
        if (!stored || stored.digest !== next.digest)
            stale();
        return ack(next, (next.proposal!.value as {
            kind: "typed_parameters";
            record: TypedParameterRecord;
        }).record.view);
    };
    return {
        loadCurrent: async () => { const c = await read(); return { domain: c.domain, native: ack(c.question, c.view).native, view: c.view }; },
        assertCurrent: async (expected) => { checkExpected(await read(), expected); },
        submitField: request => access.mutate(async (permit) => {
            const c = await read(permit);
            checkExpected(c, request.expected);
            if (c.question.confirmation)
                stale();
            const applied = applyActionParameterEvent(c.domain, request.event), event = structuredClone(applied.event);
            const pending = typedParameterPendingFields([...c.records, { candidate: applied.candidate, view: c.view, event }]);
            const nextDomain = domain(c.question.typed_parameters!, c.resolved, applied.candidate, c.view.binding.proposal_revision + 1, pending);
            const projection = buildActionParameterReview(nextDomain);
            let q = c.question;
            if (q.disposition)
                q = reopenOperatorQuestion(q);
            q = proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision, source_reference: canonicalJsonDigest(q.typed_parameters), disposition: "proposed", value: { kind: "typed_parameters", record: { candidate: projection.candidate, view: projection.view, event, predecessor_proposal_digest: canonicalJsonDigest(c.question.proposal) } } });
            revalidateTypedParameterQuestion(q, c.resolved);
            return save(c, q, permit);
        }),
        recordDecision: request => access.mutate(async (permit) => {
            const c = await read(permit);
            checkExpected(c, request.expected);
            if (c.question.confirmation)
                stale();
            if (request.accepted !== true && request.accepted !== false && request.accepted !== null)
                stale();
            let q = c.question;
            if (request.accepted === true) {
                if (c.view.unresolved.length)
                    throw new Error("TYPED_PARAMETER_PENDING: Explicitly pending fields cannot be confirmed.");
                if (q.disposition)
                    q = reopenOperatorQuestion(q);
                q = confirmOperatorAnswer(q);
            }
            else
                q = leaveOperatorQuestionPending(q, request.accepted === false ? "declined" : "cancelled");
            return save(c, q, permit);
        }),
    };
}

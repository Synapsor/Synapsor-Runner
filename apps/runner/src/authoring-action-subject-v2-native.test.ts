import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { projectActionSubjectStructural, type ActionSubjectStructuralReviewAck } from "./authoring-action-subject-proof.js";
import { reviewRequiredPrincipalScopes } from "./authoring-principal-scope-host.js";
import { saveReviewedDisabledBoundary } from "./authoring-read-review-save.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { authoringActionCheckpoint, configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery } from "./authoring-generation-recovery.js";
import { askToolSurfaceDigest, completedAuthoringQuestion, resolveAskProviderConfiguration, runAskProviderTurn, type AskToolDefinition } from "./model-ask.js";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { actionSubjectOriginDigest, type ActionSubjectHostMaterial } from "./authoring-action-subject-binding.js";
import { createActionSubjectQuestion } from "./authoring-action-subject.js";
import { createActionSubjectHost } from "./authoring-action-subject-host.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";

it.each([1, 2])("v2 native requested-scope ACK, No, %s cold replacements and separate Yes", async replacements => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-action-v2-native-")); await fs.chmod(root, 0o700);
  try {
    const fixture = await prepareReviewedReadScope(root);
    await commitBoundaryResourceReviewMutation(root, await prepareBoundaryResourceReviewMutation(root,
      { resource_id: "work.items", principal_key: null, actor: "declared source owner", reason: "Declared tenant-only starting point" }, async () => fixture.inspection));
    const before = await loadBoundaryReviewContext(root), original = projectActionSubjectStructural({ context: before, sourceDigest: d(null) });
    let nativeBinding = { boundary_name: before.candidate.pack.name, generation_lock_fingerprint: before.candidate.generation_lock_fingerprint,
      schema_fingerprint: before.lock.schema_fingerprint, role_posture_fingerprint: before.lock.role_posture_fingerprint };
    const base = { stage: "action_drafting" as const, jobIntent: "Change the signed-in person's item label", provider: "openai" as const, model: "controlled" };
    let state = buildBoundaryAuthoringResumeState({ ...base, binding: nativeBinding, authoringProtocol: { version: "synapsor.structured-authoring.v2" } });
    await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
    const contextDigest = d("declared actual Action request context"), turn = randomUUID(), target = { kind: "primary_effect" as const, resource: "work.items" };
    const material: ActionSubjectHostMaterial = { version: 2, structural: original.reference, outcome: "revise_label", logical_turn_id: turn, baseline: null,
      request_digest: d(base.jobIntent), applicability_digest: d({ request: base.jobIntent, source: null }), candidate_digest: d({}),
      targets: [{ target, target_digest: d(target), options: [] }] };
    const entries = [{ state: "awaiting" as const, target_digest: d(target) }];
    const persist = async (changes: Partial<Parameters<typeof buildBoundaryAuthoringResumeState>[0]>, permit?: import("./project-authority-mutation.js").ProjectAuthorityMutationPermit) => {
      const next = buildBoundaryAuthoringResumeState({ ...base, binding: nativeBinding, previous: state, ...changes });
      await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: state.revision_digest, ...(permit ? { permit } : {}) }); state = next;
    };
    const recovery = <T>(run: () => Promise<T>) => withAuthoringGenerationRecovery(async () => {
      configureAuthoringGenerationRecovery({ available: () => true, current: async () => contextDigest, read: () => state.generation_recovery,
        write: generationRecovery => persist({ generationRecovery }) }); return run();
    });
    const qref = (q: OperatorQuestion) => ({ id: q.id, revision: q.revision, question_digest: q.digest });
    const first = await recovery(async () => {
      const tools: AskToolDefinition[] = [{ name: "runner.stage_subject", title: "Stage exact subject", description: "No authority", input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] } }];
      const result = await runAskProviderTurn({ configuration: resolveAskProviderConfiguration({ provider: "openai", model: "controlled", api_key: "inert-local-credential",
        egress_acknowledged: true, authority_digest: askToolSurfaceDigest(tools) }, {}, new Date()), question: JSON.stringify({ material, entries }), history: [], tools,
        signal: new AbortController().signal, authorityDigest: askToolSurfaceDigest(tools), requiredInitialToolName: tools[0]!.name, completeAfterRequiredTool: true,
        gateway: { mode: "authoring", listTools: () => tools, close: async () => {}, callTool: async () => ({ ok: true, value: { staged: true } }) },
        dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "initial", name: "runner__stage_subject", arguments: "{}" }] } }) } });
      const completion = completedAuthoringQuestion(result); if (!completion) throw Error("No genuine completion");
      const q = createActionSubjectQuestion({ binding: { version: 2, material, origin: { completion, material_digest: actionSubjectOriginDigest(material, entries) } }, entries,
        scope_digest: material.request_digest, context_digest: contextDigest });
      await persist({ operatorQuestions: [q], generationRecovery: authoringActionCheckpoint(state.generation_recovery!, completion,
        { consumer: "action_rule_components", kind: "subject_proposal", material_digest: q.action_subject!.origin.material_digest }),
        action: { intent: base.jobIntent, outcome: material.outcome, strategy: "rule_derived", checkpoint: actionRuleAuthoringCheckpoint({
          authoring_protocol: state.authoring_protocol, intent_digest: material.request_digest, context_digest: contextDigest, components: {}, subject_question: qref(q),
          logical_turns: [{ id: turn, origin_context_digest: contextDigest, iterations_used: 1, tool_calls_used: 1 }] }) } });
      return q;
    });
    let calls = 0, structuralWrites = 0, signoffs = 0, held = false;
    const makeHost = (accept: boolean) => {
      let shown = 0;
      return createActionSubjectHost({ access: {
        load: async () => {
          const loaded = await readBoundaryAuthoringResumeState(root, nativeBinding); if (loaded.status !== "ready") throw Error(JSON.stringify(loaded));
          state = loaded.value;
          const structural = projectActionSubjectStructural({ context: await loadBoundaryReviewContext(root), sourceDigest: d(null) });
          const currentMaterial = { ...material, structural: structural.reference, targets: material.targets.map(t => ({ ...t,
            options: structural.scopes.filter(scope => scope.root_resource === t.target.resource).map(scope => ({ target_digest: t.target_digest, kind: scope.kind,
              reference: d({ target: t.target, scope }), dependencies_digest: d(scope) })) })) };
          return { questions: state.operator_questions!, handoffs: state.owner_handoffs ?? [], generation: state.generation_recovery,
            checkpoint: state.action!.checkpoint!, resume_revision_digest: state.revision_digest, material: currentMaterial, structural };
        }, mutate: async operation => withProjectAuthorityMutation(root, async permit => {
          expect(held).toBe(false); held = true; try { return await operation(permit); } finally { held = false; }
        }), save: async (q, save) => {
          expect(held).toBe(true); expect(save.expected.resume_revision_digest).toBe(state.revision_digest);
          if (save.structuralTransition) {
            expect(save.completion).toBeUndefined();
            const after = save.structuralTransition.review.after;
            expect(after).toEqual(projectActionSubjectStructural({ context: await loadBoundaryReviewContext(root), sourceDigest: d(null) }).reference);
            nativeBinding = { ...nativeBinding, generation_lock_fingerprint: after.binding.generation_lock_fingerprint };
          }
          let generationRecovery = state.generation_recovery;
          if (save.completion) {
            if (q.proposal?.value?.kind !== "action_subject") throw Error("missing");
            generationRecovery = authoringActionCheckpoint(generationRecovery!, save.completion, { consumer: "action_rule_components", kind: "subject_proposal",
              material_digest: d({ binding: q.action_subject, record: q.proposal.value.record }) });
          }
          const questions = [...state.operator_questions!], index = questions.findIndex(item => item.id === q.id);
          if (index < 0) questions.push(q); else questions[index] = q;
          const { digest: _, ...checkpoint } = state.action!.checkpoint!;
          await persist({ operatorQuestions: questions, generationRecovery, action: { ...state.action!, checkpoint: actionRuleAuthoringCheckpoint({ ...checkpoint, subject_question: qref(q) }) } }, save.permit);
        }
      }, structural: {
        prepare: async input => {
          expect(held).toBe(false); await input.assertCurrent();
          const result = await reviewRequiredPrincipalScopes({ projectRoot: root, schemaInspector: async () => fixture.inspection,
            resourceIds: input.resources, jobIntent: base.jobIntent, actor: () => "declared source owner",
            resolveRequirement: async resources => { await input.assertCurrent(); return { required: [...resources], unresolved: [] }; },
            onPrepared: input.onPrepared, onCommitted: async value => { structuralWrites++; await input.onCommitted({ ...value, context: await loadBoundaryReviewContext(root) }); },
            session: { promptText: async () => undefined, chooseResource: async () => undefined, editFieldTiers: async () => undefined,
              confirm: async (_message, options) => { expect(options?.defaultValue).toBe(false); return true; },
              chooseOption: async (_title, choices) => choices.find(choice => choice.label.includes("principal_id"))!.value } });
          return result.state;
        }, reviewRemaining: async input => {
          expect(held).toBe(false); await input.assertCurrent();
          let ack: ActionSubjectStructuralReviewAck | undefined;
          await saveReviewedDisabledBoundary({ projectRoot: root, context: await loadBoundaryReviewContext(root), actor: "declared source owner",
            reason: "Declared structural component test review", onReviewSignoff: async (context, committed) => { signoffs++; ack = { before: input.before, context, committed }; } });
          return ack;
        }
      }, model: { egressAcknowledged: true, reserveCorrection: async () => false, env: {}, actionLogicalTurnBudget: {
        admitIteration: async () => { const { digest: _, ...cp } = state.action!.checkpoint!; await persist({ action: { ...state.action!, checkpoint: actionRuleAuthoringCheckpoint({ ...cp,
          logical_turns: cp.logical_turns!.map(t => ({ ...t, iterations_used: t.iterations_used + 1 })) }) } }); },
        reserveToolBatch: async count => { const { digest: _, ...cp } = state.action!.checkpoint!; await persist({ action: { ...state.action!, checkpoint: actionRuleAuthoringCheckpoint({ ...cp,
          logical_turns: cp.logical_turns!.map(t => ({ ...t, tool_calls_used: t.tool_calls_used + count })) }) } }); }
      }, session: { provider: "openai", model: "controlled", apiKey: "inert-local-credential", dependencies: { requestJson: async request => {
        expect(held).toBe(false); calls++;
        const lines: string[] = [], walk = (value: unknown): void => { if (typeof value === "string") lines.push(...value.split("\n")); else if (value && typeof value === "object") Object.values(value).forEach(walk); }; walk(request.body);
        const visible = JSON.parse(lines.find(line => line.startsWith("Current exact subject targets/options and retained typed entries: "))!.split(": ").slice(1).join(": "));
        const question = JSON.parse(lines.find(line => line.startsWith("Current question: "))!.slice("Current question: ".length));
        // Prepared responder uses only the actual request and declared answer.
        expect(question.raw_answer).toBe("Only the signed-in person's records");
        const entries = visible.material.targets.map((t: { target_digest: string; options: Array<{kind:string;reference:string}> }) => {
          const option = (visible.effective_options?.find((r: {target_digest:string}) => r.target_digest === t.target_digest)?.options ?? t.options).find((o:{kind:string}) => o.kind === "principal");
          return option ? { state: "proposed", target_digest: t.target_digest, meaning: "trusted_principal", scope_reference: option.reference }
            : { state: "requested", target_digest: t.target_digest, requested_kind: "principal" };
        });
        return { status: 200, body: { output: [{ type: "function_call", call_id: randomUUID(), name: "runner__propose_operator_decision", arguments: JSON.stringify({
          question_id: question.question_id, revision: question.revision, answer_id: question.answer_id, status: "subject_interpretation", entries }) }] } };
      } } } }, present: async (view, assertCurrent) => { expect(held).toBe(false); await assertCurrent(); shown++;
        return shown === 1 ? { kind: "describe_correction", binding: view.binding, raw: "Only the signed-in person's records" } : { kind: "review", binding: view.binding }; },
      confirm: async (view, assertCurrent) => { expect(held).toBe(false); await assertCurrent(); return { kind: "decision", binding: view.binding, accepted: accept }; }
      });
    };
    expect(await recovery(() => makeHost(false).review(first.id))).toBeUndefined();
    const old = structuredClone(state.operator_questions![0]!);
    expect(old.disposition).toBe("declined"); expect(old.confirmation).toBeUndefined(); expect(structuralWrites).toBe(1); expect(signoffs).toBe(1);
    let currentId = first.id;
    for (let attempt = 1; attempt < replacements; attempt++) {
      expect(await recovery(() => makeHost(false).review(currentId))).toBeUndefined();
      currentId = state.operator_questions!.at(-1)!.id;
      expect(state.operator_questions!.at(-1)!.confirmation).toBeUndefined();
    }
    const accepted = await recovery(() => makeHost(true).review(currentId));
    expect(accepted?.revision).toBe(replacements + 1); expect(accepted?.confirmation).toBeDefined();
    expect(state.operator_questions![0]).toEqual(old); expect(state.operator_questions).toHaveLength(replacements + 1);
    expect(structuralWrites).toBe(1); expect(signoffs).toBe(1); expect(calls).toBe(replacements + 1);
    expect(state.action!.checkpoint!.logical_turns).toHaveLength(1);
    expect(state.action!.checkpoint!.logical_turns![0]).toMatchObject({ id: turn, iterations_used: replacements + 2, tool_calls_used: replacements + 2 });
    expect(state.generation_recovery!.operations).toHaveLength(replacements + 2);
    expect(state.generation_recovery!.operations.every(operation => operation.state === "checkpointed")).toBe(true);
    const disk = await readBoundaryAuthoringResumeState(root, nativeBinding); expect(disk.status).toBe("ready");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

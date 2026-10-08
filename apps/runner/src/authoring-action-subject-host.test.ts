import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { authoringActionCheckpoint, configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery } from "./authoring-generation-recovery.js";
import { askToolSurfaceDigest, completedAuthoringQuestion, resolveAskProviderConfiguration, runAskProviderTurn, type AskToolDefinition } from "./model-ask.js";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { actionSubjectOriginDigest, type ActionSubjectHostMaterial } from "./authoring-action-subject-binding.js";
import { createActionSubjectQuestion } from "./authoring-action-subject.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { projectActionSubjectStructural } from "./authoring-action-subject-proof.js";
import { createActionSubjectHost } from "./authoring-action-subject-host.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";

it.each([1, 2] as const)("v%s maps retained vague answer, replaces it after reconstruction, and acknowledges genuine completions through native Resume CAS", async version => {
  const f = await nativeFixture(), turn = randomUUID(), context = d("controlled current Action context");
  const target = { kind: "primary_effect" as const, resource: "work.items" }, targetDigest = d(target);
  const structural = projectActionSubjectStructural({ context: await loadBoundaryReviewContext(f.dir), sourceDigest: d(null) });
  const scope = structural.scopes.find(s => s.root_resource === target.resource && s.kind === "principal")!;
  const material: ActionSubjectHostMaterial = { version, ...(version === 2 ? { structural: structural.reference } : {}), outcome: "revise_label", logical_turn_id: turn, baseline: null,
    request_digest: d("Change the signed-in person's item label"), applicability_digest: d(f.nativeBinding), candidate_digest: d({}),
    targets: [{ target, target_digest: targetDigest, options: [{ reference: version === 2 ? d({ target, scope }) : d({ target, principal: true }), target_digest: targetDigest,
      kind: "principal", dependencies_digest: version === 2 ? d(scope) : d(f.nativeBinding) }] }] };
  const entries = [{ state: "awaiting" as const, target_digest: targetDigest }];
  const input = { ...f.input, stage: "action_drafting" as const };
  let held = false, calls = 0;
  const persist = (changes: Partial<Parameters<typeof buildBoundaryAuthoringResumeState>[0]>) => f.persist(buildBoundaryAuthoringResumeState({
    ...input, previous: f.state(), ...changes }));
  const recovery = <T>(run: () => Promise<T>) => withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, current: async () => context,
      read: () => f.state().generation_recovery, write: generationRecovery => persist({ generationRecovery }) });
    return run();
  });
  const qref = (q: OperatorQuestion) => ({ id: q.id, revision: q.revision, question_digest: q.digest });
  const checkpoint = (q: OperatorQuestion) => actionRuleAuthoringCheckpoint({ authoring_protocol: f.state().authoring_protocol,
    intent_digest: material.request_digest, context_digest: context, components: {}, subject_question: qref(q),
    logical_turns: [{ id: turn, origin_context_digest: context, iterations_used: 1, tool_calls_used: 1 }] });
  try {
    const first = await recovery(async () => {
      const tools: AskToolDefinition[] = [{ name: "runner.stage_subject", title: "Stage exact subject", description: "No authority", input_schema: {
        type: "object", additionalProperties: false, properties: {}, required: [] } }];
      const result = await runAskProviderTurn({ configuration: resolveAskProviderConfiguration({ provider: "openai", model: "controlled",
        api_key: "inert-local-credential", egress_acknowledged: true, authority_digest: askToolSurfaceDigest(tools) }, {}, new Date()),
        question: JSON.stringify({ material, entries }), history: [], tools, signal: new AbortController().signal,
        authorityDigest: askToolSurfaceDigest(tools), requiredInitialToolName: tools[0]!.name, completeAfterRequiredTool: true,
        gateway: { mode: "authoring", listTools: () => tools, close: async () => {}, callTool: async () => ({ ok: true, value: { staged: true } }) },
        dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "initial-subject",
          name: "runner__stage_subject", arguments: "{}" }] } }) } });
      const completion = completedAuthoringQuestion(result); if (!completion) throw Error("No actual initial completion");
      const q = createActionSubjectQuestion({ binding: { version, material, origin: { completion, material_digest: actionSubjectOriginDigest(material, entries) } },
        entries, scope_digest: material.request_digest, context_digest: context });
      await persist({ generationRecovery: authoringActionCheckpoint(f.state().generation_recovery!, completion, {
        consumer: "action_rule_components", kind: "subject_proposal", material_digest: q.action_subject!.origin.material_digest }),
        operatorQuestions: [q], action: { intent: "Change the signed-in person's item label", outcome: material.outcome, strategy: "rule_derived", checkpoint: checkpoint(q) } });
      return q;
    });
    const makeHost = (raw: string, pause: boolean) => {
      let presented = 0;
      return createActionSubjectHost({ access: {
        load: async () => {
          const loaded = await readBoundaryAuthoringResumeState(f.dir, f.nativeBinding); if (loaded.status !== "ready") throw Error(JSON.stringify(loaded)); const state = loaded.value; if (!state?.action?.checkpoint) throw Error("Missing native Action");
          return { questions: state.operator_questions ?? [], handoffs: state.owner_handoffs ?? [], generation: state.generation_recovery,
            checkpoint: state.action.checkpoint, resume_revision_digest: state.revision_digest, material, ...(version === 2 ? { structural } : {}) };
        }, mutate: async operation => { expect(held).toBe(false); held = true; try { return await operation({} as never); } finally { held = false; } },
        save: async (q, save) => {
          expect(held).toBe(true); expect(save.expected.resume_revision_digest).toBe(f.state().revision_digest);
          const previous = f.state(), old = previous.action!.checkpoint!;
          let generationRecovery = previous.generation_recovery;
          if (save.completion) {
            if (q.proposal?.value?.kind !== "action_subject") throw Error("Missing mapped record");
            generationRecovery = authoringActionCheckpoint(generationRecovery!, save.completion, { consumer: "action_rule_components", kind: "subject_proposal",
              material_digest: d({ binding: q.action_subject, record: q.proposal.value.record }) });
          }
          const questions = [...(previous.operator_questions ?? [])], index = questions.findIndex(item => item.id === q.id);
          if (index < 0) questions.push(q); else questions[index] = q;
          const { digest: _, ...body } = old;
          await persist({ generationRecovery, operatorQuestions: questions, action: { ...previous.action!,
            checkpoint: actionRuleAuthoringCheckpoint({ ...body, subject_question: qref(q) }) } });
        }
      }, model: { egressAcknowledged: true, reserveCorrection: async () => false, env: {}, actionLogicalTurnBudget: {
        admitIteration: async () => {
          const action = f.state().action!, { digest: _, ...body } = action.checkpoint!;
          await persist({ action: { ...action, checkpoint: actionRuleAuthoringCheckpoint({ ...body,
            logical_turns: body.logical_turns!.map(t => ({ ...t, iterations_used: t.iterations_used + 1 })) }) } });
        }, reserveToolBatch: async count => {
          const action = f.state().action!, { digest: _, ...body } = action.checkpoint!;
          await persist({ action: { ...action, checkpoint: actionRuleAuthoringCheckpoint({ ...body,
            logical_turns: body.logical_turns!.map(t => ({ ...t, tool_calls_used: t.tool_calls_used + count })) }) } });
        } }, session: { provider: "openai", model: "controlled", apiKey: "inert-local-credential", dependencies: { requestJson: async request => {
          expect(held).toBe(false); calls++;
          const lines: string[] = [], walk = (v: unknown): void => { if (typeof v === "string") lines.push(...v.split("\n")); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
          walk(request.body);
          const value = (prefix: string) => JSON.parse(lines.find(line => line.startsWith(prefix))!.slice(prefix.length));
          const question = value("Current question: "), visible = value("Current exact subject targets/options and retained typed entries: ");
          const interpreted = visible.material.targets.map((t: { target_digest: string; options: Array<{ reference: string; kind: string }> }) =>
            question.raw_answer === "Only the signed-in person's records" ? { state: "proposed", target_digest: t.target_digest,
              meaning: "trusted_principal", scope_reference: t.options.find(o => o.kind === "principal")!.reference }
              : { state: "unresolved", target_digest: t.target_digest, question: "Do you mean the signed-in person's records?" });
          return { status: 200, body: { output: [{ type: "function_call", call_id: randomUUID(), name: "runner__propose_operator_decision",
            arguments: JSON.stringify({ question_id: question.question_id, revision: question.revision, answer_id: question.answer_id,
              status: "subject_interpretation", entries: interpreted }) }] } };
        } } } }, present: async (view, current) => {
          expect(held).toBe(false); await current(); presented++;
          return presented === 1 ? { kind: "describe_correction", binding: view.binding, raw }
            : pause ? { kind: "pause", binding: view.binding } : { kind: "review", binding: view.binding };
        }, confirm: async (view, current) => { expect(held).toBe(false); await current(); return { kind: "decision", binding: view.binding, accepted: true }; } });
    };
    expect(await recovery(() => makeHost("some people, I guess", true).review(first.id))).toBeUndefined();
    const paused = await readBoundaryAuthoringResumeState(f.dir, f.nativeBinding); if (paused.status !== "ready") throw Error(JSON.stringify(paused)); const oldQuestion = paused.value.operator_questions![0]!;
    expect(oldQuestion.confirmation).toBeUndefined(); expect(oldQuestion.raw_answer?.text).toBe("some people, I guess"); expect(calls).toBe(1);
    const accepted = await recovery(() => makeHost("Only the signed-in person's records", false).review(first.id));
    expect(accepted?.confirmation).toBeDefined(); expect(accepted?.revision).toBe(2); expect(calls).toBe(2);
    const finalRead = await readBoundaryAuthoringResumeState(f.dir, f.nativeBinding); if (finalRead.status !== "ready") throw Error(JSON.stringify(finalRead)); const final = finalRead.value;
    expect(final!.operator_questions![0]).toEqual(oldQuestion);
    expect(final!.operator_questions).toHaveLength(2);
    expect(final!.action!.checkpoint!.logical_turns).toHaveLength(1);
    expect(final!.action!.checkpoint!.logical_turns![0]).toMatchObject({ id: turn, iterations_used: 3, tool_calls_used: 3 });
    expect(final!.action!.checkpoint!.logical_turns![0]!.completed).toBeUndefined();
    expect(final!.generation_recovery!.operations).toHaveLength(3);
    expect(final!.generation_recovery!.operations.every(op => op.state === "checkpointed" && op.checkpoint_seen)).toBe(true);
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});

import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { nativeFixture } from "./test-fixtures/native-read-scope.js";
import { loadBoundaryReviewContext } from "./boundary-commands.js";
import { explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { generateModelReadWorkload, type ModelReadScopeContext } from "./read-workload-model.js";
import { READ_SCOPE_PROTOCOL, type ReadScopeReference } from "./read-structured-scope.js";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery } from "./authoring-generation-recovery.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { createReadAssistanceCheckpointHost, type ReadAssistanceCheckpointUpdate } from "./authoring-read-assistance-checkpoint-host.js";
import { createReadMeaningHost, type ReadMeaningRecordUpdate } from "./authoring-read-meaning-host.js";
import { createReadScopeHost } from "./authoring-read-scope-host.js";
import { leaveOperatorQuestionPending, type OperatorQuestion } from "./authoring-operator-question.js";
import { storeReadWorkloadAnalysis, type ReadWorkloadView } from "./read-workloads.js";
import type { ReadScopeReplacementOwner } from "./read-current-evidence.js";

// Genuine mapping completion and native saved history, not a fabricated dispatch.
// The operator's declared correction only changes the requested row limit.
describe("Read post-review replacement producer", () => {
  it.each(["ordinary", "captured_before_restart", "cancel_then_resume", "changed_model", "changed_task"] as const)("continues %s with one new mapping call, retained history and separate default-No review", async mode => {
    const f = await nativeFixture();
    try {
      const boundary = (await loadBoundaryReviewContext(f.dir)).candidate;
      const scopeDigest = d({ job: f.input.jobIntent }), contextDigest = d({ binding: f.binding });
      let staged: ReadAssistanceCheckpointUpdate & ReadMeaningRecordUpdate = {};
      let questions: OperatorQuestion[] = [], lastAnalysis: ReadWorkloadView | undefined, locked = false;
      const references = (): ReadScopeReference[] => [...f.inventory.references, ...questions.flatMap(q => q.read_scope?.mode === "replacement_answer" && q.raw_answer
        ? [{ kind: "answer" as const, id: `answer:${q.id}:${q.revision}:${q.raw_answer.id}`, question_id: q.id, question_revision: q.revision,
          answer_id: q.raw_answer.id, digest: d(q.raw_answer), text: q.raw_answer.text }] : [])];
      const current = (): ModelReadScopeContext => ({ binding: f.binding, catalog: f.inventory.catalog, references: references(),
        ...(f.state().read ? { native: { questions: f.state().operator_questions ?? [], handoffs: f.state().owner_handoffs ?? [],
          generation: f.state().generation_recovery, question_id: f.state().read!.scope_question_id!, analysis: lastAnalysis!.analysis } } : {}) });
      const saveQuestion = (question: OperatorQuestion) => f.persist(buildBoundaryAuthoringResumeState({ ...f.input,
        previous: f.state(), read: f.state().read, operatorQuestions: f.state().operator_questions!.map(q => q.id === question.id ? question : q) }));
      const mutate = async <T,>(operation: (permit: never) => Promise<T>) => { expect(locked).toBe(false); locked = true;
        try { return await operation({ testPermit: true } as never); } finally { locked = false; } };
      const save = async () => {
        expect(locked).toBe(true);
        await f.persist(buildBoundaryAuthoringResumeState({ ...f.input, previous: f.state(),
          readAssistanceCheckpoint: "checkpoint" in staged ? staged.checkpoint ?? null : f.state().read_assistance,
          read: staged.read ?? f.state().read, generationRecovery: staged.recovery ?? f.state().generation_recovery,
          operatorQuestions: staged.questions ?? questions, ownerHandoffs: staged.handoffs ?? f.state().owner_handoffs }));
        questions = f.state().operator_questions ?? []; staged = {};
      };
      const checkpoint = createReadAssistanceCheckpointHost({ access: {
        mutate, scopeDigest: () => scopeDigest, contextDigest: async () => contextDigest,
        currentCandidate: async () => ({ candidate_digest: explorationBoundaryCandidateDigest(boundary) }),
        readPreparedRead: () => f.state().read,
        readCheckpoint: () => "checkpoint" in staged ? staged.checkpoint : f.state().read_assistance,
        scopeInventory: async () => ({ binding: f.binding, catalog: f.inventory.catalog, references: references() }),
        readHandoffs: () => staged.handoffs ?? f.state().owner_handoffs ?? [], readQuestions: () => questions,
        readRecovery: () => staged.recovery ?? f.state().generation_recovery, readConversation: () => undefined,
        readReviewedRelationshipAnswer: () => undefined, install: update => { staged = { ...staged, ...update }; },
        storeAnalysis: async input => { lastAnalysis = await storeReadWorkloadAnalysis({ ...input, projectRoot: f.dir }); return lastAnalysis; },
        appendSourceMessage: async () => { throw new Error("No Source edit requested"); }, save,
        checkpointFailure: message => new Error(message),
      } });
      let prompts = 0, calls = 0, cancelAnswer = false;
      const raw = "Show one item label at a time; keep the same signed-in person's records and all other restrictions.";
      const meaning = createReadMeaningHost({ answerTooLarge: () => {}, access: {
        mutate, readQuestions: () => staged.questions ?? questions, readHandoffs: () => staged.handoffs ?? f.state().owner_handoffs ?? [],
        readCheckpoint: () => f.state().read_assistance, readRecovery: () => f.state().generation_recovery,
        readConversationTurns: () => [], scopeDigest: () => scopeDigest, contextDigest: async () => contextDigest,
        assertFresh: async () => {}, checkpointFailure: message => new Error(message),
        install: update => { staged = { ...staged, ...update }; }, save,
      }, interact: async view => { expect(locked).toBe(false); prompts++; return { kind: "answer", binding: view.binding, raw: cancelAnswer ? null : raw }; } });
      const run = (owner?: ReadScopeReplacementOwner) => withAuthoringGenerationRecovery(async () => {
        configureAuthoringGenerationRecovery({ available: () => true, read: () => f.state().generation_recovery,
          current: async () => contextDigest, progress: () => {}, write: generationRecovery => f.persist(buildBoundaryAuthoringResumeState({
            ...f.input, previous: f.state(), read: f.state().read, generationRecovery })) });
        return generateModelReadWorkload({ name: "items", allowedQuestions: [owner && mode === "changed_task" ? "Show every person their labels" : f.input.jobIntent], operatorNamingContext: f.input.jobIntent,
          provider: "openai", model: owner && mode === "changed_model" ? "another-controlled-model" : "controlled", apiKey: "inert-local-credential", egressAcknowledged: true, generatedBoundary: boundary, deferNarration: true,
          ...(owner ? { postReviewReplacement: owner } : {}), onCheckpoint: checkpoint.persist,
          structuredScope: { protocol: READ_SCOPE_PROTOCOL, current,
            replacementAnswer: meaning.answerScopeReplacement, resolveReplacementAnswer: meaning.resolveScopeReplacementAnswer },
          dependencies: { requestJson: async request => {
            calls++;
            const strings: string[] = [];
            const collect = (value: unknown) => { if (typeof value === "string") strings.push(value);
              else if (value && typeof value === "object") Object.values(value).forEach(collect); }; collect(request.body);
            const line = (prefix: string) => { const match = strings.flatMap(s => s.split("\n")).find(s => s.startsWith(prefix));
              if (!match) throw new Error(`Actual request lacks ${prefix}`); return JSON.parse(match.slice(prefix.length)); };
            const refs: ReadScopeReference[] = line("Host scope reference inventory: ");
            const subjects = line("Host reviewed subject scope inventory: ");
            const catalog = line("Structural catalog: ");
            const requestRef = refs.find(r => r.kind === "request")!, answer = refs.find(r => r.kind === "answer");
            const resource = catalog.resources.find((r: {id:string}) => r.id === "work.items");
            const subject = subjects.find((s: {root_resource:string}) => s.root_resource === resource.id);
            if (!resource.fields.some((field: {id:string}) => field.id === "label")) throw new Error("Declared label unavailable");
            if (owner) expect(answer?.text).toBe(raw); else expect(answer).toBeUndefined();
            return { status: 200, body: { output: [{ type: "function_call", call_id: randomUUID(), name: "runner__submit_read_workloads",
              arguments: JSON.stringify({ allowed: [{ id: "items", description: answer?.text ?? requestRef.text,
                plan: { kind: "rows", resource: resource.id, select: ["label"], ...(answer ? { limit: 1 } : {}) } }], forbidden: [],
                read_scope: { protocol: READ_SCOPE_PROTOCOL, applicability: "read_requested", original_request: requestRef.id,
                  requirements: [{ id: "items", intended_use: answer?.text ?? requestRef.text,
                    references: [requestRef.id, ...(answer ? [answer.id] : [])], disposition: "include",
                    subjects: [{ root_resource: resource.id, mode: "reviewed_resource", scope_reference: subject.reference }],
                    targets: [{ root_resource: resource.id, resource: resource.id, operation: "resource" },
                      { root_resource: resource.id, resource: resource.id, operation: "return", field: "label" }] }] } }) }] } };
          } } });
      });
      await run();
      expect(calls).toBe(1); expect(f.state().read!.assistance_history!.state.call_count).toBe(1);
      const old = questions[0]!; await saveQuestion(leaveOperatorQuestionPending(old, "declined")); questions = f.state().operator_questions!;
      const reloadOwner = async (): Promise<ReadScopeReplacementOwner> => {
        const disk = await readBoundaryAuthoringResumeState(f.dir, f.nativeBinding);
        if (disk.status !== "ready") throw new Error("Cold native load unavailable");
        return { read: disk.value.read!, questions: disk.value.operator_questions!, handoffs: disk.value.owner_handoffs ?? [],
          generation: disk.value.generation_recovery, question_id: old.id, analysis: lastAnalysis!.analysis };
      };
      if (mode === "changed_model" || mode === "changed_task") {
        const before = d(f.state());
        await expect(run(await reloadOwner())).rejects.toThrow("READ_SCOPE_REPLACEMENT_PRODUCER_CHANGED");
        expect(calls).toBe(1); expect(prompts).toBe(0); expect(d(f.state())).toBe(before); return;
      }
      if (mode === "captured_before_restart") await meaning.answerScopeReplacement(old.id);
      if (mode === "cancel_then_resume") {
        cancelAnswer = true;
        const generation = d(f.state().generation_recovery), history = d(f.state().read!.assistance_history);
        await expect(run(await reloadOwner())).rejects.toThrow("operator correction is still pending");
        expect(calls).toBe(1); expect(d(f.state().generation_recovery)).toBe(generation);
        expect(d(f.state().read!.assistance_history)).toBe(history); cancelAnswer = false;
      }
      const result = await run(await reloadOwner());
      expect(calls).toBe(2); expect(prompts).toBe(mode === "cancel_then_resume" ? 2 : 1); expect(result.read_scope_predecessor_id).toBe(old.id);
      expect(f.state().read!.assistance_history!.state.call_count).toBe(2);
      expect(f.state().generation_recovery!.operations).toHaveLength(2);
      expect(f.state().read!.assistance_history!.state.scope_replacements).toHaveLength(1);
      expect(result.workload.allowed[0]!.plan).toMatchObject({ limit: 1 });
      const next = questions.at(-1)!;
      expect(next.read_scope!.predecessor_id).toBe(old.id); expect(next.confirmation).toBeUndefined();
      expect(questions.find(q => q.id === old.id)!.confirmation).toBeUndefined();
      let reviewed = false;
      const group = createReadScopeHost({ access: { mutate,
        load: async question_id => ({ ...current().native!, question_id, expectedBinding: f.binding, references: references(), catalog: f.inventory.catalog,
          resume_revision_digest: f.state().revision_digest, context_digest: contextDigest, scope_digest: scopeDigest }),
        save: async (question, { expected }) => { expect(expected.resume_revision_digest).toBe(f.state().revision_digest); await saveQuestion(question); },
      }, interact: async view => { expect(view.kind).toBe("readback"); expect(view.defaultValue).toBe(false); reviewed = true;
        return { kind: "decision", binding: view.binding, accepted: true }; } });
      expect((await group.review(next.id)).state).toBe("confirmed"); expect(reviewed).toBe(true);
      expect(calls).toBe(2); expect(f.state().operator_questions!.find(q => q.id === old.id)!.disposition).toBe("declined");
    } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  });
});

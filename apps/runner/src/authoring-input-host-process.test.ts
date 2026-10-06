import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import { INPUT_PROCESS_FACTS } from "./test-fixtures/source-input-process-contract.js";
import { inputProcessRuntime, runInputProcess, type InputProcessResult as ProcessResult,
  type InputProcessRuntime } from "./test-fixtures/source-input-process-driver.js";

type Stop = "onset" | "unanswered" | "raw" | "proposal" | "confirmation" | "append-before-ack" | "returned" | "none";
const cwd = fileURLToPath(new URL("../../../", import.meta.url));
let root: string, runtime: InputProcessRuntime, baseline: ProcessResult;

async function child(projectRoot: string, mode: "start" | "restart", stop: Stop): Promise<ProcessResult> {
  return runInputProcess(runtime, projectRoot, mode, stop);
}

function finalMeaning(result: ProcessResult) {
  const root = result.resume.operator_questions![0]!, q = result.resume.operator_questions!.at(-1)!;
  return { stage: result.resume.stage, sourceText: result.sources.snapshots[0]!.text,
    sourceDigest: result.sources.snapshots[0]!.digest, sourceReviewCount: result.sources.input_policy_reviews!.length,
    root: { kind: root.kind, target: root.target, material: root.material, budget: root.budget },
    child: { kind: q.kind, target: q.target, presentation: q.presentation?.text, raw: q.raw_answer?.text,
      value: q.proposal?.value, confirmation: q.confirmation?.decision, disposition: q.disposition },
    handoffs: result.resume.owner_handoffs!.map(h => ({ consumer: h.consumer, question: h.question, state: h.state, answer: h.answer, actor: h.actor })),
    reviews: result.sources.input_policy_reviews!.map(r => ({ outcomes: r.outcomes, requirements: r.requirements, decision: r.decision,
      actor: r.actor, verified: r.verified, basis: r.question_reference?.basis })),
    operations: result.resume.generation_recovery!.operations.map(op => ({ state: op.state, attempts: op.attempts.length,
      checkpoint_seen: op.checkpoint_seen, answered: op.question_handoff?.answered && {
        actor: op.question_handoff.answered.actor, answer: op.question_handoff.answered.answer } })),
    authorityGranted: result.resume.authority_granted, sourceChanged: result.resume.source_database_changed };
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-input-fresh-process-"));
  runtime = await inputProcessRuntime(cwd, root, process.env.B51_INPUT_PROCESS_CAPTURE_DIR);
  baseline = await child(path.join(root, "uninterrupted"), "start", "none");
  expect(baseline.counts.requests).toBe(2);
  expect(baseline.counts.prompts).toBe(1);
  expect(baseline.counts.confirmations).toBe(1);
  expect(baseline.sources.input_policy_reviews).toHaveLength(1);
}, 30_000);
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("production Input host across genuine saved boundaries and fresh processes", () => {
  it.each(["onset", "unanswered", "raw", "proposal", "confirmation", "append-before-ack", "returned"] as const)(
    "continues from %s without reconstructing an accepted result or resetting history", async stop => {
      const project = path.join(root, stop);
      const interrupted = await child(project, "start", stop);
      expect(interrupted.state).toBe("interrupted");
      const beforeRoot = interrupted.resume.operator_questions![0]!;
      const beforeQuestion = interrupted.resume.operator_questions!.at(-1)!;
      if (stop === "onset") expect(beforeQuestion.raw_answer).toBeUndefined();
      if (stop === "unanswered") {
        expect(beforeQuestion.presentation?.text).toBe(INPUT_PROCESS_FACTS.question);
        expect(beforeQuestion.raw_answer).toBeUndefined();
        expect(interrupted.resume.owner_handoffs!.at(-1)?.state).toBe("waiting");
      }
      if (["raw", "proposal", "confirmation", "append-before-ack", "returned"].includes(stop)) {
        expect(beforeQuestion.raw_answer?.text).toBe(INPUT_PROCESS_FACTS.raw);
        expect(interrupted.resume.owner_handoffs!.at(-1)?.state).toBe("answered");
      }
      if (stop === "raw") expect(beforeQuestion.proposal).toBeUndefined();
      if (stop === "proposal") expect(beforeQuestion.confirmation).toBeUndefined();
      if (["confirmation", "append-before-ack", "returned"].includes(stop)) expect(beforeQuestion.confirmation?.decision).toBe("new_attributed_decision");
      if (stop === "append-before-ack") {
        expect(interrupted.counts.acknowledgements).toBe(0);
        expect(interrupted.sources.input_policy_reviews).toHaveLength(1);
        expect(interrupted.resume.stage).toBe("action_drafting");
      }
      const restarted = await child(project, "restart", "none");
      expect(restarted.pid).not.toBe(interrupted.pid);
      expect(["saved", "reused"]).toContain(restarted.state);
      expect(restarted.resume.operator_questions![0]!.id).toBe(beforeRoot.id);
      if (stop !== "onset") expect(restarted.resume.operator_questions!.at(-1)!.id).toBe(beforeQuestion.id);
      if (beforeQuestion.raw_answer) expect(restarted.resume.operator_questions!.at(-1)!.raw_answer).toEqual(beforeQuestion.raw_answer);
      if (beforeQuestion.proposal) expect(restarted.resume.operator_questions!.at(-1)!.proposal).toEqual(beforeQuestion.proposal);
      if (beforeQuestion.confirmation) expect(restarted.resume.operator_questions!.at(-1)!.confirmation).toEqual(beforeQuestion.confirmation);
      if (stop !== "onset") expect(restarted.resume.owner_handoffs!.at(-1)!.id).toBe(interrupted.resume.owner_handoffs!.at(-1)!.id);
      for (const op of interrupted.resume.generation_recovery?.operations ?? []) {
        const retained = restarted.resume.generation_recovery!.operations.find(current => current.id === op.id)!;
        expect(retained).toBeDefined();
        expect(retained.attempts).toEqual(op.attempts);
        if (op.question_handoff?.answered) expect(retained.question_handoff).toEqual(op.question_handoff);
      }
      expect(interrupted.counts.requests + restarted.counts.requests).toBe(2);
      expect(interrupted.counts.prompts + restarted.counts.prompts).toBe(1);
      expect(interrupted.counts.confirmations + restarted.counts.confirmations).toBe(1);
      expect(finalMeaning(restarted)).toEqual(finalMeaning(baseline));
      expect(restarted.sources.input_policy_reviews).toHaveLength(1);
      if (stop === "append-before-ack" || stop === "returned") {
        expect(restarted.counts.requests).toBe(0); expect(restarted.counts.prompts).toBe(0); expect(restarted.counts.confirmations).toBe(0);
        expect(restarted.sources).toEqual(interrupted.sources);
        expect(restarted.sources.input_policy_reviews![0]!.digest).toBe(interrupted.sources.input_policy_reviews![0]!.digest);
      }
      const q = restarted.resume.operator_questions!.at(-1) as OperatorQuestion;
      expect(restarted.sources.input_policy_reviews![0]!.question_reference).toMatchObject({ id: q.id, digest: q.digest,
        root_id: beforeRoot.id, proposal_digest: canonicalJsonDigest(q.proposal), answer_id: q.raw_answer!.id });
    }, 45_000);
});

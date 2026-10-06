import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import type { PolicySourceSession } from "./authoring-policy-source.js";
import type { ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
import { inputProcessRuntime, runAuthoringProcess } from "./test-fixtures/source-input-process-driver.js";
import { ACTION_PUBLIC_PROCESS_FACTS as facts, type ActionPublicProcessStop } from "./test-fixtures/source-action-public-process-contract.js";

type Result = { pid: number; projectRoot: string; code?: number; error?: string;
  counts: { requests: number; actionRequests: number; prompts: number; confirmations: number };
  fault?: { stop: string; after_real_rename: boolean; proposed_resume_bytes: string };
  resume_bytes: string; resume: BoundaryAuthoringResumeState; sources: PolicySourceSession;
  actions: ActionRuleAuthorityDraftV1[]; activation?: unknown;
  frames: unknown[]; menus: unknown[]; events: unknown[]; transcript: string };
const cwd = fileURLToPath(new URL("../../../", import.meta.url));
async function fixture(label: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `owned-action-public-cold-${label}-`));
  const runtime = await inputProcessRuntime(cwd, root, process.env.B51_ACTION_PROCESS_CAPTURE_DIR ?? path.join(root, "captures"));
  const project = path.join(root, "program");
  const child = (mode: "start" | "restart", stop: ActionPublicProcessStop) =>
    runAuthoringProcess<Result>(runtime, "source-action-public-process.ts", project, mode, stop);
  return { project, child };
}
const question = (result: Result) => result.resume.operator_questions!.filter(q => q.target.phase === "action_rule_components").at(-1)!;

it("a native public Action question resumes cold through disabled save, whole Source review and ordinary caller", async () => {
  const f = await fixture("answered"), before = await f.child("start", "unanswered");
  expect(before.error, before.transcript).toBeUndefined(); expect(before.code).toBe(0);
  expect(before.resume, before.transcript).toBeDefined();
  const q = question(before), h = before.resume.owner_handoffs!.find(h => h.id === q.handoff_id)!;
  expect(q.presentation!.text).toBe(facts.question); expect(q.raw_answer).toBeUndefined();
  expect(h.state).toBe("waiting"); expect(h.completion).toBeUndefined();
  const cp = before.resume.action!.checkpoint!, pending = cp.pending_question!;
  expect(pending.completion).toBeDefined();
  expect(q.evidence.find(e => e.id === "action-producer-question")?.digest).toBe(canonicalJsonDigest({
    intent: cp.intent_digest, context: cp.context_digest, question: pending }));
  expect(cp.logical_turns!.at(-1)!.completed).toMatchObject({ kind: "ordinary_clarification", completion: pending.completion });
  expect(before.resume.action!.completed_outcomes).toEqual([facts.outcomes[0]]);
  expect(before.actions[0]!.authority.rules.map(rule => rule.rule.outcome)).toEqual([facts.outcomes[0]]);
  expect(before.sources.operator_messages ?? []).not.toContain(facts.raw);
  const after = await f.child("restart", "none");
  expect(after.pid).not.toBe(before.pid); expect(after.error).toBeUndefined(); expect(after.code).toBe(0);
  const accepted = after.resume.operator_questions!.find(row => row.id === q.id)!;
  expect(accepted.raw_answer!.text).toBe(facts.raw); expect(accepted.confirmation).toBeDefined();
  expect(after.resume.owner_handoffs!.find(row => row.id === h.id)).toMatchObject({ state: "answered", answer: facts.raw });
  expect(after.sources.operator_messages!.filter(message => message === facts.raw)).toHaveLength(1);
  expect(after.resume.action!.intended_outcomes).toEqual(facts.outcomes);
  expect(after.resume.action!.completed_outcomes).toEqual(facts.outcomes);
  expect(after.resume.action!.checkpoint).toBeUndefined(); expect(after.resume.stage).toBe("authority_review");
  const rules = after.actions[0]!.authority.rules;
  expect(rules.map(rule => rule.rule.outcome)).toEqual(facts.outcomes);
  const { activated_at: _before, ...peer } = before.actions[0]!.authority.rules[0]!;
  const { activated_at: _after, ...retained } = rules[0]!;
  expect(retained).toEqual(peer);
  expect(after.actions[0]!.authority.approval_classes.map(c => [c.name, c.required_approvals])).toEqual(facts.reviewClasses.map(name => [name, 1]));
  expect(after.sources.application_assignments!.every(record => record.verified === false)).toBe(true);
  expect(after.sources.coverage!.passages.find(p => p.start === 3)).toMatchObject({ disposition: "implemented", operator_clarification: facts.raw });
  expect(after.activation).toBeUndefined(); expect(after.resume.authority_granted).toBe(false);
  expect(after.resume.source_database_changed).toBe(false);
  expect(after.transcript).toContain("disabled");
}, 60_000);

it.each(["raw-beforewrite", "raw-lostack"] as const)("cold Action retains actual raw-only %s without recapture or initial producer resend", async stop => {
  const f = await fixture(stop), before = await f.child("start", stop);
  expect(before.fault).toMatchObject({ stop, after_real_rename: stop === "raw-lostack" });
  const q = question(before);
  expect(q.proposal).toBeUndefined(); expect(q.confirmation).toBeUndefined();
  if (stop === "raw-lostack") expect(q.raw_answer!.text).toBe(facts.raw);
  else expect(q.raw_answer).toBeUndefined();
  expect(before.sources.operator_messages ?? []).not.toContain(facts.raw);
  const after = await f.child("restart", "none");
  expect(after.pid).not.toBe(before.pid); expect(after.error).toBeUndefined();
  const current = after.resume.operator_questions!.find(row => row.id === q.id)!;
  if (q.raw_answer) expect(current.raw_answer).toEqual(q.raw_answer);
  expect(current.raw_answer!.text).toBe(facts.raw); expect(current.confirmation).toBeDefined();
  expect(after.counts.prompts).toBe(stop === "raw-lostack" ? 0 : 1);
  expect(after.sources.operator_messages!.filter(message => message === facts.raw)).toHaveLength(1);
  expect(after.resume.action!.completed_outcomes).toEqual(facts.outcomes);
  expect(after.activation).toBeUndefined();
}, 60_000);

it.each(["source-beforewrite", "source-lostack"] as const)("actual Source append before %s preserves committed words and a fresh native fence", async stop => {
  const f = await fixture(stop), before = await f.child("start", stop);
  expect(before.fault).toMatchObject({ stop, after_real_rename: stop === "source-lostack" });
  expect(before.sources.operator_messages!.filter(message => message === facts.raw)).toHaveLength(1);
  const after = await f.child("restart", "none");
  expect(after.pid).not.toBe(before.pid);
  expect(after.counts).toMatchObject({ requests: 0, actionRequests: 0, prompts: 0, confirmations: 0 });
  expect(after.sources).toEqual(before.sources);
  const { updated_at: priorTime, revision_digest: priorDigest, stage: priorStage, ...priorResume } = before.resume;
  const { updated_at: currentTime, revision_digest: currentDigest, stage: currentStage, ...currentResume } = after.resume;
  expect(currentResume).toEqual(priorResume);
  expect(priorStage).toBe(stop === "source-lostack" ? "authority_review" : "action_drafting");
  expect(currentStage).toBe("action_drafting");
  expect(Date.parse(currentTime)).toBeGreaterThanOrEqual(Date.parse(priorTime));
  expect(currentDigest).toBeDefined(); expect(priorDigest).toBeDefined();
  expect(after.actions).toEqual(before.actions); expect(after.activation).toBeUndefined();
  // The exact native diagnostic is evidence, not an assumed recovery success.
  expect(after.transcript + JSON.stringify(after.events) + (after.error ?? "")).toMatch(/ACTION_AUTHORING_QUESTION_STALE/iu);
}, 60_000);

it("a genuinely spent Action turn refuses extra dispatch in a fresh public process", async () => {
  const f = await fixture("spent"), before = await f.child("start", "spent");
  const turns = before.resume.action!.checkpoint!.logical_turns!;
  expect(turns.at(-1)).toMatchObject({ iterations_used: 12, tool_calls_used: 12 });
  expect(before.counts.actionRequests).toBe(12); expect(before.actions).toEqual([]);
  const after = await f.child("restart", "none");
  expect(after.pid).not.toBe(before.pid); expect(after.counts.requests).toBe(0);
  const { updated_at: priorTime, revision_digest: priorDigest, ...priorResume } = before.resume;
  const { updated_at: currentTime, revision_digest: currentDigest, ...currentResume } = after.resume;
  expect(currentResume).toEqual(priorResume);
  expect(Date.parse(currentTime)).toBeGreaterThanOrEqual(Date.parse(priorTime));
  expect(currentDigest).toBeDefined(); expect(priorDigest).toBeDefined();
  expect(after.sources).toEqual(before.sources);
  expect(after.actions).toEqual([]); expect(after.activation).toBeUndefined();
}, 60_000);

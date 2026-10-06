import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import type { PolicySourceSession } from "./authoring-policy-source.js";
import { inputProcessRuntime, runAuthoringProcess } from "./test-fixtures/source-input-process-driver.js";
import { READ_PROCESS_FACTS as facts } from "./test-fixtures/source-read-process-contract.js";

type Result = { pid: number; state: string; code: number;
  counts: { requests: number; readRequests: number; narrations: number; prompts: number; confirmations: number; pendingViews: number; acceptedReturns: number };
  resume: BoundaryAuthoringResumeState; sources: PolicySourceSession; transcript: string };
const cwd = fileURLToPath(new URL("../../../", import.meta.url));

it("a genuine public Read question resumes cold through accepted remap and ordinary Read review", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-read-cold-public-"));
  const runtime = await inputProcessRuntime(cwd, root, process.env.B51_READ_PROCESS_CAPTURE_DIR ?? path.join(root, "captures"));
  const project = path.join(root, "read-question");
  const before = await runAuthoringProcess<Result>(runtime, "source-read-process.ts", project, "start", "unanswered");
  expect(before.state).toBe("closed");
  expect(before.counts).toMatchObject({ requests: 1, readRequests: 1, narrations: 0, prompts: 1, confirmations: 0, acceptedReturns: 0 });
  expect(before.resume.read_assistance?.stage).toBe("waiting");
  const question = before.resume.operator_questions!.at(-1)!;
  expect(question.presentation!.text).toBe(facts.question);
  expect(question.raw_answer).toBeUndefined(); expect(question.confirmation).toBeUndefined();
  expect(before.resume.owner_handoffs!.at(-1)!.completion).toBeDefined();
  expect(before.sources.operator_messages ?? []).toHaveLength(0);
  const after = await runAuthoringProcess<Result>(runtime, "source-read-process.ts", project, "restart", "returned");
  expect(after.pid).not.toBe(before.pid); expect(after.state).toBe("closed");
  expect(after.counts).toMatchObject({ requests: 2, readRequests: 1, narrations: 1, prompts: 1, confirmations: 1, acceptedReturns: 1 });
  const accepted = after.resume.operator_questions!.find(q => q.id === question.id)!;
  expect(accepted.raw_answer!.text).toBe(facts.raw); expect(accepted.confirmation).toBeDefined();
  expect(after.resume.read_assistance).toBeUndefined(); expect(after.resume.read?.analysis_id).toBeDefined();
  expect(after.resume.read?.assistance_history?.state.call_count).toBe(2);
  expect(after.resume.read?.assistance_history?.state.correction_used).toBe(false);
  expect(after.resume.stage).toBe("authority_review");
  expect(after.sources.operator_messages).toHaveLength(1);
  expect(JSON.parse(after.sources.operator_messages![0]!)).toMatchObject({ kind: "confirmed_read_meaning",
    statements: [{ resource: "studio.parcels", field: "units", question: facts.question, raw_answer: facts.raw }] });
  expect(after.resume.authority_granted).toBe(false); expect(after.resume.source_database_changed).toBe(false);
  expect(after.transcript).not.toContain("AUTHORING_QUESTION_CONTEXT_CHANGED");
  expect(after.transcript).toContain("Read draft is validated and remains disabled.");
  expect(after.transcript).toContain("READ REVIEW SUMMARY");
  expect(after.transcript).toContain("READ BOUNDARY LEFT DISABLED");
  // Actual caller/Source/CAS records and both distinct child captures are retained.
}, 60_000);

it.each(["proposal", "confirmed"] as const)("cold Read Resume from durable %s uses the retained words and ordinary accepted callback", async stop => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `owned-read-cold-${stop}-`));
  const runtime = await inputProcessRuntime(cwd, root, process.env.B51_READ_PROCESS_CAPTURE_DIR ?? path.join(root, "captures"));
  const project = path.join(root, `read-${stop}`);
  const before = await runAuthoringProcess<Result>(runtime, "source-read-process.ts", project, "start", stop);
  expect(before.counts).toMatchObject({ requests: 1, readRequests: 1, narrations: 0, prompts: 1, confirmations: 1, acceptedReturns: 0 });
  const question = before.resume.operator_questions!.at(-1)!;
  expect(question.raw_answer!.text).toBe(facts.raw);
  expect(question.proposal?.value).toEqual({ kind: "attributed_meaning" });
  expect(before.sources.operator_messages ?? []).toHaveLength(0);
  expect(before.resume.read?.analysis_id).toBeUndefined();
  expect(before.resume.authority_granted).toBe(false);
  if (stop === "proposal") {
    expect(question.confirmation).toBeUndefined();
    expect(question.disposition).toBe("declined");
    expect(before.resume.read_assistance?.stage).toBe("waiting");
  } else {
    expect(question.confirmation).toBeDefined();
    expect(before.resume.read_assistance?.stage).toBe("decided");
  }
  const after = await runAuthoringProcess<Result>(runtime, "source-read-process.ts", project, "restart", "returned");
  expect(after.pid).not.toBe(before.pid);
  expect(after.counts).toMatchObject({ requests: 2, readRequests: 1, narrations: 1, prompts: 0,
    confirmations: stop === "proposal" ? 1 : 0, acceptedReturns: 1 });
  const accepted = after.resume.operator_questions!.find(q => q.id === question.id)!;
  expect(accepted.raw_answer).toEqual(question.raw_answer);
  expect(accepted.confirmation).toBeDefined();
  if (stop === "confirmed") expect(accepted.confirmation).toEqual(question.confirmation);
  expect(after.resume.read_assistance).toBeUndefined();
  expect(after.resume.read?.analysis_id).toBeDefined();
  expect(after.resume.read?.assistance_history?.state).toMatchObject({ call_count: 2, correction_used: false });
  expect(after.resume.stage).toBe("authority_review");
  expect(after.sources.operator_messages).toHaveLength(1);
  expect(JSON.parse(after.sources.operator_messages![0]!)).toMatchObject({ kind: "confirmed_read_meaning",
    statements: [{ resource: "studio.parcels", field: "units", raw_answer: facts.raw }] });
  expect(after.resume.authority_granted).toBe(false);
  expect(after.resume.source_database_changed).toBe(false);
  expect(after.transcript).toContain("Read draft is validated and remains disabled.");
  expect(after.transcript).toContain("READ REVIEW SUMMARY");
  expect(after.transcript).toContain("READ BOUNDARY LEFT DISABLED");
}, 60_000);

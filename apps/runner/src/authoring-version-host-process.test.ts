import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { inputProcessRuntime, runAuthoringProcess } from "./test-fixtures/source-input-process-driver.js";
import { VERSION_PROCESS_FACTS as facts } from "./test-fixtures/source-version-process-contract.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { loadPolicySources, policyTextSnapshot, savePolicySources } from "./authoring-policy-source.js";

type Result = { pid: number; state: string; errorMessage?: string; counts: { requests: number; prompts: number;
  confirmations: number; pendingViews: number; commits: number; ordinaryPrompts: number }; resume: BoundaryAuthoringResumeState; sources: unknown };
const cwd = fileURLToPath(new URL("../../../", import.meta.url));
async function fixture(label: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `owned-version-${label}-`));
  const runtime = await inputProcessRuntime(cwd, root, process.env.B51_VERSION_PROCESS_CAPTURE_DIR);
  const project = path.join(root, label);
  const child = (mode: "start" | "restart", stop: string, controls?: object) => {
    const execute = async () => {
      const file = controls ? path.join(root, `control-${Date.now()}-${Math.random().toString(16).slice(2)}.json`) : undefined;
      if (file) await fs.writeFile(file, JSON.stringify(controls), { mode: 0o600, flag: "wx" });
      return runAuthoringProcess<Result>(runtime, "source-version-process.ts", project, mode, stop, file);
    };
    return execute();
  };
  return { project, child };
}

it("cold native Action→Version→Action retains root, raw evidence and the owning allowance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-version-fresh-process-"));
  const runtime = await inputProcessRuntime(cwd, root, process.env.B51_VERSION_PROCESS_CAPTURE_DIR);
  const project = path.join(root, "program");
  const first = await runAuthoringProcess<Result>(runtime, "source-version-process.ts", project, "start", "raw");
  expect(first.state).toBe("interrupted");
  const marker = first.resume.action!.checkpoint!.pending_version!;
  const question = first.resume.operator_questions!.find(q => q.id === marker.question_id)!;
  expect(question.raw_answer!.text).toBe(facts.raw); expect(question.proposal).toBeUndefined();
  expect(first.resume.owner_handoffs!.at(-1)!.state).toBe("answered");
  expect(first.resume.action!.checkpoint!.logical_turns!.at(-1)).toMatchObject({ iterations_used: 2, tool_calls_used: 2 });
  const next = await runAuthoringProcess<Result>(runtime, "source-version-process.ts", project, "restart", "returned");
  expect(next.state).toBe("interrupted"); expect(next.pid).not.toBe(first.pid);
  expect(next.counts).toMatchObject({ requests: 2, prompts: 0, confirmations: 1, ordinaryPrompts: 1 });
  expect(next.resume.operator_questions![0]!.id).toBe(marker.root_question_id);
  expect(next.resume.operator_questions![0]!.raw_answer).toEqual(question.raw_answer);
  expect(next.resume.operator_questions![0]!.confirmation).toBeDefined();
  expect(next.resume.action!.checkpoint!.pending_version).toBeUndefined();
  expect(next.resume.action!.checkpoint!.reviewed_version_fields).toHaveLength(1);
  expect(next.resume.action!.checkpoint!.pending_question!.question).toBe(facts.nextQuestion);
  expect(next.resume.action!.checkpoint!.logical_turns!.at(-1)).toMatchObject({ id: marker.turn_id, iterations_used: 4, tool_calls_used: 4 });
  for (const op of first.resume.generation_recovery!.operations) {
    const retained = next.resume.generation_recovery!.operations.find(row => row.id === op.id)!;
    expect(retained.attempts).toEqual(op.attempts); expect(retained.state).toBe("checkpointed");
  }
  expect(next.sources).toEqual(first.sources);
  expect(next.resume.authority_granted).toBe(false); expect(next.resume.source_database_changed).toBe(false);
  // Retain the actual CAS/journal and both child captures for diagnosis.
}, 60_000);

it.each(["root", "unanswered", "proposal", "confirmed", "mapped"] as const)(
  "cold %s handoff resumes the real producer without repeating completed Version work", async stop => {
    const f = await fixture(stop), before = await f.child("start", stop);
    expect(before.state).toBe("interrupted");
    const cp = before.resume.action!.checkpoint!, q = before.resume.operator_questions![0]!;
    if (stop === "root") expect(q.presentation).toBeUndefined();
    if (stop === "unanswered") { expect(q.presentation).toBeDefined(); expect(q.raw_answer).toBeUndefined(); }
    if (stop === "proposal") { expect(q.proposal).toBeDefined(); expect(q.confirmation).toBeUndefined(); }
    if (["confirmed", "mapped"].includes(stop)) expect(q.confirmation).toBeDefined();
    const after = await f.child("restart", "returned");
    expect(after.pid).not.toBe(before.pid); expect(after.state).toBe("interrupted");
    expect(after.resume.operator_questions![0]!.id).toBe(q.id);
    for (const key of ["raw_answer", "proposal", "confirmation"] as const)
      if (q[key]) expect(after.resume.operator_questions![0]![key]).toEqual(q[key]);
    expect(before.counts.requests + after.counts.requests).toBe(4);
    expect(before.counts.prompts + after.counts.prompts).toBe(1);
    expect(before.counts.confirmations + after.counts.confirmations).toBe(1);
    expect(after.counts.ordinaryPrompts).toBe(1);
    expect(after.resume.action!.checkpoint!.logical_turns!.at(-1)).toMatchObject({
      id: cp.logical_turns!.at(-1)!.id, iterations_used: 4, tool_calls_used: 4 });
    expect(after.resume.action!.checkpoint!.reviewed_version_fields).toHaveLength(1);
    expect(after.sources).toEqual(before.sources);
    expect(after.resume.authority_granted).toBe(false);
  }, 60_000);

it.each([
  { label: "EOF", controls: { raw: null }, disposition: "cancelled", sends: 2 },
  { label: "blank", controls: { raw: " \t " }, disposition: "unknown", sends: 2 },
  { label: "unknown", controls: { raw: "  I’m not sure.\t " }, disposition: "unknown", sends: 2 },
  { label: "decline", controls: { accepted: false }, disposition: "declined", sends: 3 },
] as const)("$label remains pending in a fresh process without a new opinion", async ({ label, controls, disposition, sends }) => {
  const f = await fixture(label), before = await f.child("start", "none", controls);
  expect(before.state).toBe("pending"); expect(before.counts.requests).toBe(sends);
  const q = before.resume.operator_questions![0]!;
  expect(q.disposition).toBe(disposition); expect(q.confirmation).toBeUndefined();
  expect(before.resume.reviewed_version_fields).toBeUndefined();
  const after = await f.child("restart", "none");
  expect(after.state).toBe("pending"); expect(after.pid).not.toBe(before.pid);
  expect(after.counts).toMatchObject({ requests: 0, prompts: 0, confirmations: 0, pendingViews: 1, commits: 0 });
  expect(after.resume).toEqual(before.resume); expect(after.sources).toEqual(before.sources);
}, 60_000);

it.each(["blank", "answered"] as const)("cold %s answer replacement keeps old evidence and owning counters", async label => {
  const f = await fixture(`replace-${label}`);
  const before = await f.child("start", "none", label === "blank" ? { raw: " \t " } : { accepted: false });
  const old = before.resume.operator_questions![0]!, cp = before.resume.action!.checkpoint!;
  const after = await f.child("restart", "returned", { pendingChoice: "answer" });
  expect(after.state).toBe("interrupted"); expect(after.resume.operator_questions).toHaveLength(2);
  expect(after.resume.operator_questions![0]).toEqual(old);
  const next = after.resume.operator_questions![1]!;
  expect(next.id).not.toBe(old.id); expect(next.revision).toBe(old.revision + 1);
  expect(next.raw_answer!.text).toBe(facts.raw); expect(next.confirmation).toBeDefined();
  expect(after.resume.action!.checkpoint!.logical_turns!.at(-1)).toMatchObject({ id: cp.logical_turns!.at(-1)!.id,
    iterations_used: cp.logical_turns!.at(-1)!.iterations_used + 2, tool_calls_used: cp.logical_turns!.at(-1)!.tool_calls_used + 2 });
  expect(after.counts).toMatchObject({ requests: 2, prompts: 1, confirmations: 1, ordinaryPrompts: 1 });
  expect(after.resume.owner_handoffs![0]).toEqual(label === "answered" ? before.resume.owner_handoffs![0]
    : expect.objectContaining({ id: before.resume.owner_handoffs![0]!.id, state: "answered" }));
}, 60_000);

it.each(["Source", "Read", "role", "scope", "counter-shape"] as const)(
  "current %s drift refuses before a resumed model or operator callback", async kind => {
    const f = await fixture(`stale-${kind}`), before = await f.child("start", "raw");
    const resumeFile = path.join(f.project, ".synapsor/boundary-authoring/resume.json");
    const bytes = await fs.readFile(resumeFile);
    if (kind === "Source") {
      const sourceId = JSON.parse(await fs.readFile(path.join(f.project, "fixture-context.json"), "utf8")).sourceId;
      const sources = await loadPolicySources(f.project, sourceId), expectedDigest = canonicalJsonDigest(sources);
      sources.snapshots.push(policyTextSnapshot(Buffer.from("The policy was changed after this question."), "changed-rules.txt", 2));
      sources.active = 2; await savePolicySources(f.project, sources, { expectedDigest });
    } else {
      const file = path.join(f.project, "current-context.json"), current = JSON.parse(await fs.readFile(file, "utf8"));
      if (kind === "Read") current.readBoundary.pack.resources[0].selectable_fields = [];
      if (kind === "role") current.inspection.current_user = "different_reader";
      if (kind === "scope") current.scope = canonicalJsonDigest("Different owning job");
      if (kind === "counter-shape") current.inspection.tables[0].columns.find((c: { name: string }) => c.name === "c09").nullable = true;
      await fs.writeFile(file, JSON.stringify(current));
    }
    await expect(f.child("restart", "none")).rejects.toThrow(kind === "Source" ? /saved counter question or its source changed/ : /CURRENT_STRUCTURE_READ_ROLE_SCOPE_CHANGED/);
    expect(await fs.readFile(resumeFile)).toEqual(bytes);
    const events = (await fs.readFile(path.join(f.project, "process-events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const closed = events.filter(row => row.kind === "closed").at(-1);
    expect(closed.value.counts).toMatchObject({ requests: 0, prompts: 0, confirmations: 0 });
    expect(before.resume.operator_questions![0]!.confirmation).toBeUndefined();
  }, 60_000);

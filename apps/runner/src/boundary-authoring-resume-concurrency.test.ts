import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  buildBoundaryAuthoringResumeState, clearBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState,
  revalidateBoundaryAuthoringResume, writeBoundaryAuthoringResumeState, assertBoundaryAuthoringResumeCurrent,
  type BoundaryAuthoringResumeBinding, type BoundaryAuthoringResumeState,
} from "./boundary-authoring-resume.js";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { askToolSurfaceDigest, resolveAskProviderConfiguration, runAskProviderTurn, completedAuthoringQuestion } from "./model-ask.js";
import { withAuthoringGenerationRecovery, configureAuthoringGenerationRecovery, authoringQuestionCheckpoint,
  authoringQuestionAnswerCheckpoint, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const binding: BoundaryAuthoringResumeBinding = {
  boundary_name: "reviewed", generation_lock_fingerprint: canonicalJsonDigest("generation"),
  schema_fingerprint: canonicalJsonDigest("schema"), role_posture_fingerprint: canonicalJsonDigest("role"),
};
const resumeFile = (root: string) => path.join(root, ".synapsor/boundary-authoring/resume.json");
async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-resume-cas-")); roots.push(root); return root;
}
function state(answer = "Original reviewed answer.", previous?: BoundaryAuthoringResumeState) {
  return buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting", jobIntent: "Retain the complete saved job.",
    provider: "openai", model: "test", action: { intent: "Adjust the reserve.", intents: ["Adjust the reserve."] },
    conversation: [{ kind: "clarification", question: "Reviewed business meaning?", answer }], previous,
    now: "2026-09-11T00:00:00.000Z" });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("authoring resume filesystem compare-and-save", () => {
  it("allows only one of two competing same-base writes", async () => {
    const root = await project(), base = state();
    await writeBoundaryAuthoringResumeState(root, base);
    const drafts = [state("First session answer.", base), state("Second session answer.", base)];
    const results = await Promise.allSettled(drafts.map(next => writeBoundaryAuthoringResumeState(root, next,
      { expectedRevisionDigest: base.revision_digest })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" }) }),
    ]);
    const winner = results.findIndex(result => result.status === "fulfilled");
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: drafts[winner] });
  });

  it("does not overwrite another session's explicit complete removal on the same Read", async () => {
    const root = await project(), base = state();
    await writeBoundaryAuthoringResumeState(root, base);
    const removed = buildBoundaryAuthoringResumeState({ binding, stage: "planning", jobIntent: "Only inspect records now.",
      provider: "openai", model: "test", previous: base });
    await writeBoundaryAuthoringResumeState(root, removed, { expectedRevisionDigest: base.revision_digest });
    const before = await fs.readFile(resumeFile(root));
    await expect(writeBoundaryAuthoringResumeState(root, state("Late private consent.", base),
      { expectedRevisionDigest: base.revision_digest })).rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    expect(await fs.readFile(resumeFile(root))).toEqual(before);
    expect((await readBoundaryAuthoringResumeState(root, binding))).toEqual({ status: "ready", value: removed });
  });

  it("requires absence for a fresh save and does not recreate a concurrently cleared job", async () => {
    const root = await project(), base = buildBoundaryAuthoringResumeState({ binding, stage: "planning", jobIntent: "Read records.",
      provider: "openai", model: "test" });
    await writeBoundaryAuthoringResumeState(root, base, { expectedRevisionDigest: null });
    await expect(writeBoundaryAuthoringResumeState(root, state(), { expectedRevisionDigest: null }))
      .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    expect(await clearBoundaryAuthoringResumeState(root)).toBe(false);
    // Model the external removal this CAS test protects against; current
    // structured jobs are never silently discarded by normal cleanup.
    await fs.unlink(resumeFile(root));
    await expect(writeBoundaryAuthoringResumeState(root, state(), { expectedRevisionDigest: base.revision_digest }))
      .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "none" });
  });

  it("compares the old disk revision while saving explicitly revalidated metadata", async () => {
    const root = await project(), base = state();
    await writeBoundaryAuthoringResumeState(root, base);
    const nextBinding = { ...binding, generation_lock_fingerprint: canonicalJsonDigest("rescanned") };
    const next = revalidateBoundaryAuthoringResume(base, nextBinding);
    await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: base.revision_digest });
    expect(await readBoundaryAuthoringResumeState(root, nextBinding)).toEqual({ status: "ready", value: next });
    await expect(writeBoundaryAuthoringResumeState(root, base, { expectedRevisionDigest: base.revision_digest }))
      .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
  });

  it("refuses an invalid file rather than treating it as no saved job", async () => {
    const root = await project();
    await writeBoundaryAuthoringResumeState(root, state());
    await fs.writeFile(resumeFile(root), "{ invalid preserved file");
    await expect(writeBoundaryAuthoringResumeState(root, state(), { expectedRevisionDigest: null }))
      .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    expect(await fs.readFile(resumeFile(root), "utf8")).toBe("{ invalid preserved file");
  });

  it.each([false, true])("keeps the caller's old baseline after a failed acknowledgement (rename committed=%s)", async committed => {
    const root = await project(), base = state(), next = state("Exact newly reviewed answer.", base);
    await writeBoundaryAuthoringResumeState(root, base);
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      if (committed) await rename(from, to);
      throw Object.assign(new Error("TEST_CHECKPOINT_EACCES"), { code: "EACCES" });
    });
    await expect(writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: base.revision_digest }))
      .rejects.toMatchObject({ code: "EACCES" });
    expect(await fs.readdir(path.dirname(resumeFile(root)))).toEqual(["resume.json"]);
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: committed ? next : base });
    if (committed) {
      await expect(writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: base.revision_digest }))
        .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    } else await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: base.revision_digest });
    const restarted = await readBoundaryAuthoringResumeState(root, binding);
    if (restarted.status !== "ready") throw new Error("Expected durable resume");
    await writeBoundaryAuthoringResumeState(root, state("Explicit next command.", restarted.value),
      { expectedRevisionDigest: restarted.value.revision_digest });
  });

  it("does not acknowledge a no-op rename or advance the expected revision", async () => {
    const root = await project(), base = state(), next = state("New exact consent.", base);
    await writeBoundaryAuthoringResumeState(root, base);
    vi.spyOn(fs, "rename").mockResolvedValueOnce(undefined);
    await expect(writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: base.revision_digest }))
      .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_NOT_SAVED" });
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: base });
    await writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: base.revision_digest });
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: next });
  });

  it("checks retained intent and exact pending revision before consent, including an already saved removal veto", async () => {
    const root = await project(), base = state();
    await writeBoundaryAuthoringResumeState(root, base);
    await expect(assertBoundaryAuthoringResumeCurrent(root, base, { intent: base.action!.intent })).resolves.toBeUndefined();
    await expect(assertBoundaryAuthoringResumeCurrent(root, base, { intent: "A removed action." }))
      .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    const revision = { outcome: "reserve.adjust", instruction: "Lower the automatic allowance.", baseline_digest: canonicalJsonDigest("draft") };
    const pending = buildBoundaryAuthoringResumeState({ binding, stage: "authority_review", jobIntent: base.job_intent,
      provider: "openai", model: "test", previous: base, pendingActionRevision: revision });
    await writeBoundaryAuthoringResumeState(root, pending, { expectedRevisionDigest: base.revision_digest });
    await expect(assertBoundaryAuthoringResumeCurrent(root, base, { intent: base.action!.intent }))
      .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    await expect(assertBoundaryAuthoringResumeCurrent(root, pending, { revision })).resolves.toBeUndefined();
    await expect(assertBoundaryAuthoringResumeCurrent(root, pending, { revision: { ...revision,
      instruction: "  Lower the\n automatic allowance.  " } })).resolves.toBeUndefined();
    await expect(assertBoundaryAuthoringResumeCurrent(root, pending, { revision: { ...revision,
      instruction: "Raise the automatic allowance." } })).rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    await expect(assertBoundaryAuthoringResumeCurrent(root, pending, { revision: { ...revision, baseline_digest: canonicalJsonDigest("another draft") } }))
      .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    const removed = buildBoundaryAuthoringResumeState({ binding, stage: "authority_review", jobIntent: base.job_intent,
      provider: "openai", model: "test", previous: pending, pendingActionRevision: revision,
      pendingActionRemoval: { outcome: revision.outcome, authority_name: "reviewed_rules", draft_digest: revision.baseline_digest } });
    await writeBoundaryAuthoringResumeState(root, removed, { expectedRevisionDigest: pending.revision_digest });
    await expect(assertBoundaryAuthoringResumeCurrent(root, removed, { revision }))
      .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
  });

  it("rechecks a concurrent removal after consent and refuses stale private proof save", async () => {
    const root = await project(), base = state();
    await writeBoundaryAuthoringResumeState(root, base);
    await assertBoundaryAuthoringResumeCurrent(root, base, { intent: base.action!.intent });
    const removed = buildBoundaryAuthoringResumeState({ binding, stage: "planning", jobIntent: "Read records only.", provider: "openai", model: "test", previous: base });
    await writeBoundaryAuthoringResumeState(root, removed, { expectedRevisionDigest: base.revision_digest });
    await expect(assertBoundaryAuthoringResumeCurrent(root, base, { intent: base.action!.intent }))
      .rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    await expect(writeBoundaryAuthoringResumeState(root, state("Consent obtained against old job.", base),
      { expectedRevisionDigest: base.revision_digest })).rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: removed });
  });

  it("freezes the requested save before waiting for the existing project lock and supports its permit", async () => {
    const root = await project(), base = state();
    await withProjectAuthorityMutation(root, async permit => {
      await writeBoundaryAuthoringResumeState(root, base, { expectedRevisionDigest: null, permit });
    });
    const next = state("Reviewed answer before lock wait.", base), frozen = structuredClone(next);
    let pending!: Promise<string>;
    await withProjectAuthorityMutation(root, async () => {
      pending = writeBoundaryAuthoringResumeState(root, next, { expectedRevisionDigest: base.revision_digest });
      next.conversation = [];
    });
    await pending;
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: frozen });
  });

  it("serializes real independent processes using the same saved revision and canonical project alias", async () => {
    const root = await project(), aliasRoot = await project(), alias = path.join(aliasRoot, "same-project"), base = state();
    await fs.symlink(root, alias, "dir");
    await writeBoundaryAuthoringResumeState(root, base);
    const drafts = [state("Process one answer.", base), state("Process two answer.", base)];
    const writers = drafts.map((next, i) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import { writeBoundaryAuthoringResumeState } from ${JSON.stringify(new URL("./boundary-authoring-resume.ts", import.meta.url).href)};
        import { once } from 'node:events';
        const start = once(process, 'message'); process.send('ready'); await start;
        try { await writeBoundaryAuthoringResumeState(${JSON.stringify(i ? alias : root)}, ${JSON.stringify(next)},
          { expectedRevisionDigest: ${JSON.stringify(base.revision_digest)} }); process.send('saved'); }
        catch (error) { process.send(error.code ?? error.message); }
        process.disconnect();
      `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      children.push(child);
      const messages: unknown[] = []; let diagnostics = "";
      child.on("message", message => messages.push(message));
      child.stderr?.on("data", chunk => { diagnostics = `${diagnostics}${chunk}`.slice(-4000); });
      return { child, messages, diagnostics: () => diagnostics, exited: once(child, "exit") };
    });
    await vi.waitFor(() => {
      for (const writer of writers) expect(writer.messages, writer.diagnostics()).toContain("ready");
    }, { timeout: 10_000 });
    for (const writer of writers) writer.child.send("start");
    await Promise.all(writers.map(writer => writer.exited));
    expect(writers.flatMap(writer => writer.messages).filter(message => message !== "ready").sort())
      .toEqual(["BOUNDARY_AUTHORING_RESUME_CHANGED", "saved"]);
    const winner = writers.findIndex(writer => writer.messages.includes("saved"));
    expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: drafts[winner] });
  }, 15_000);
});


// Composed real decoder -> exact handoff -> filesystem CAS evidence. The public
// UI/installed process restart is independently tested; these faults isolate the
// single-file commit boundary rather than stubbing an outer guard.
describe("B33 pending-question atomic resume persistence", () => {
  async function questionPair() {
    const root=await project();let current=state();
    await writeBoundaryAuthoringResumeState(root,current);
    const build=(recovery:AuthoringTransportState,checkpoint?:ReturnType<typeof actionRuleAuthoringCheckpoint>)=>buildBoundaryAuthoringResumeState({
      binding,stage:"action_drafting",jobIntent:current.job_intent,provider:"openai",model:"test",previous:current,
      action:{...current.action!,...(checkpoint?{checkpoint}:{})},generationRecovery:recovery});
    return withAuthoringGenerationRecovery(async()=>{
      configureAuthoringGenerationRecovery({available:()=>true,read:()=>current.generation_recovery,
        current:async()=>canonicalJsonDigest(binding),write:async recovery=>{
          const next=build(recovery);await writeBoundaryAuthoringResumeState(root,next,{expectedRevisionDigest:current.revision_digest});current=next;
        }});
      const tools=[{name:"runner.inspect",description:"DERIVED",input_schema:{type:"object",properties:{},additionalProperties:false}}];
      const authorityDigest=askToolSurfaceDigest(tools);
      const configuration=resolveAskProviderConfiguration({provider:"openai",model:"test",api_key:"DERIVED-key",authority_digest:authorityDigest,egress_acknowledged:true},{},new Date());
      const result=await runAskProviderTurn({configuration,question:"DERIVED",history:[],tools,authorityDigest,signal:new AbortController().signal,
        gateway:{mode:"authoring",listTools:()=>tools,close:async()=>{},callTool:async()=>{throw new Error("No callback allowed");}},
        dependencies:{requestJson:async()=>({status:200,body:{status:"completed",output:[{type:"message",content:[{type:"output_text",text:"Which reviewed role handles exceptions?"}]}]}})}});
      const cp=actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v1" },intent_digest:canonicalJsonDigest(current.action!.intent),context_digest:canonicalJsonDigest(binding),components:{},
        pending_question:{question:result.answer,operator_message:current.action!.intent,completion:completedAuthoringQuestion(result)}});
      const next=build(authoringQuestionCheckpoint(current.generation_recovery,cp)!,cp);
      return {root,base:current,next,cp};
    });
  }
  it.each([false,true])("lost handoff acknowledgement leaves exactly the old fence or whole committed question (rename %s)",async committed=>{
    const {root,base,next}=await questionPair();
    expect(base.generation_recovery!.operations[0]!.state).toBe("handled");
    const rename=fs.rename;
    vi.spyOn(fs,"rename").mockImplementationOnce(async(from,to)=>{if(committed)await rename(from,to);throw Object.assign(new Error("DERIVED lost acknowledgement"),{code:"EACCES"});});
    await expect(writeBoundaryAuthoringResumeState(root,next,{expectedRevisionDigest:base.revision_digest})).rejects.toMatchObject({code:"EACCES"});
    const restored=await readBoundaryAuthoringResumeState(root,binding);
    expect(restored).toEqual({status:"ready",value:committed?next:base});
    if(restored.status!=="ready")throw new Error("Expected preserved state");
    expect(Boolean(restored.value.action?.checkpoint?.pending_question)).toBe(committed);
    expect(Boolean(restored.value.generation_recovery!.operations[0]!.question_handoff)).toBe(committed);
  });
  it.each([false,true])("lost answer acknowledgement preserves exact committed-or-unanswered state (rename %s)",async committed=>{
    const {root,base,next,cp}=await questionPair();
    await writeBoundaryAuthoringResumeState(root,next,{expectedRevisionDigest:base.revision_digest});
    const answered=actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v1" },intent_digest:cp.intent_digest,context_digest:cp.context_digest,components:cp.components,operator_messages:["One scoped reviewer."]});
    const successor=buildBoundaryAuthoringResumeState({binding,stage:"action_drafting",jobIntent:next.job_intent,provider:"openai",model:"test",previous:next,
      action:{...next.action!,checkpoint:answered},generationRecovery:authoringQuestionAnswerCheckpoint(next.generation_recovery,cp,answered)});
    const rename=fs.rename;
    vi.spyOn(fs,"rename").mockImplementationOnce(async(from,to)=>{if(committed)await rename(from,to);throw Object.assign(new Error("DERIVED answer acknowledgement lost"),{code:"EACCES"});});
    await expect(writeBoundaryAuthoringResumeState(root,successor,{expectedRevisionDigest:next.revision_digest})).rejects.toMatchObject({code:"EACCES"});
    expect(await readBoundaryAuthoringResumeState(root,binding)).toEqual({status:"ready",value:committed?successor:next});
    if(committed)await expect(writeBoundaryAuthoringResumeState(root,successor,{expectedRevisionDigest:next.revision_digest})).rejects.toMatchObject({code:"BOUNDARY_AUTHORING_RESUME_CHANGED"});
  });
  it("commits only one of two competing answers with its matching operation history",async()=>{
    const {root,base,next,cp}=await questionPair();
    await writeBoundaryAuthoringResumeState(root,next,{expectedRevisionDigest:base.revision_digest});
    const answers=["One scoped reviewer.","Two scoped reviewers."];
    const successors=answers.map(answer=>{
      const answered=actionRuleAuthoringCheckpoint({ authoring_protocol: { version: "synapsor.structured-authoring.v1" },intent_digest:cp.intent_digest,context_digest:cp.context_digest,components:cp.components,operator_messages:[answer]});
      return buildBoundaryAuthoringResumeState({binding,stage:"action_drafting",jobIntent:next.job_intent,provider:"openai",model:"test",previous:next,
        action:{...next.action!,checkpoint:answered},generationRecovery:authoringQuestionAnswerCheckpoint(next.generation_recovery,cp,answered)});
    });
    const results=await Promise.allSettled(successors.map(candidate=>writeBoundaryAuthoringResumeState(root,candidate,{expectedRevisionDigest:next.revision_digest})));
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(r=>r.status==="rejected")).toEqual([expect.objectContaining({reason:expect.objectContaining({code:"BOUNDARY_AUTHORING_RESUME_CHANGED"})})]);
    const winner=results.findIndex(r=>r.status==="fulfilled");
    expect(await readBoundaryAuthoringResumeState(root,binding)).toEqual({status:"ready",value:successors[winner]});
    expect(successors[winner]!.generation_recovery!.operations[0]!.question_handoff!.answered!.answer).toBe(answers[winner]);
    expect(successors[winner]!.action!.checkpoint!.pending_question).toBeUndefined();
  });
});

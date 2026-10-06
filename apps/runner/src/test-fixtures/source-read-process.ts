/** Actual public initial Read entry in a fresh child. Only structural inspection,
 * operator IO and provider transport are synthetic. No question/completion/raw
 * mapping is seeded and no internal activation or authority actor is invented. */
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { onboard } from "../guided-start.js";
import { boundaryAuthoringResumeBinding, boundaryReviewCommand, loadBoundaryReviewContext } from "../boundary-commands.js";
import { createBoundaryAuthoringChat } from "../boundary-authoring-chat.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "../boundary-authoring-resume.js";
import { authoringDestination, newPolicySourceSession, policyTextSnapshot, savePolicySources, loadPolicySources } from "../authoring-policy-source.js";
import { generateModelReadWorkload } from "../read-workload-model.js";
import { ownedProgramInspection } from "./owned-authoring-program.js";
import { modelVisibleUserText } from "./model-visible-frame.js";
import { READ_PROCESS_FACTS as facts } from "./source-read-process-contract.js";
import type { BoundaryReviewInteractiveSession } from "../boundary-cli-picker.js";

const [root, mode, stop] = process.argv.slice(2);
if (!root || !["start", "restart"].includes(mode!) || !["unanswered", "proposal", "confirmed", "returned", "replace", "keep"].includes(stop!))
  throw new Error("Owned root/mode/stop required.");
const inspection = ownedProgramInspection();
process.env.OWNED_READ_PROCESS_URL = "postgresql://fixture.invalid/never-opened";
globalThis.fetch = async () => { throw new Error("External transport forbidden."); };
const resumePath = path.join(root, ".synapsor/boundary-authoring/resume.json");
let transcript = "", requests = 0, readRequests = 0, narrations = 0, prompts = 0, confirmations = 0, pendingViews = 0, acceptedReturns = 0;
const menus: unknown[] = [], frames: { body: unknown; reply?: unknown }[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown) => { transcript += String(chunk); return true; }) as typeof process.stdout.write;
const localRead = async () => {
  const saved = JSON.parse(await fs.readFile(resumePath, "utf8"));
  const question = saved.operator_questions?.at(-1);
  if (question?.kind !== "attributed_meaning" || question.target.resource !== "studio.parcels" || question.target.field !== "units")
    throw new Error("Only the declared business question has a supplied answer.");
  prompts++;
  return stop === "unanswered" ? undefined : stop === "replace" ? facts.replacementRaw : facts.raw;
};
const select = async (choice: { title?: string; message?: string; initialValue?: string; options: { value: string }[] }) => {
  const values = choice.options.map(option => option.value);
  const title = choice.title ?? choice.message ?? "";
  const prompt = choice.message ?? title;
  let selected: string | undefined;
  if (prompt === "Record these exact words as the meaning for this task?") {
    assert.equal(choice.initialValue, "no"); confirmations++; selected = stop === "proposal" || stop === "keep" ? "no" : "yes";
  } else if (title === "SAVED MEANING IS STILL PENDING") { pendingViews++; selected = stop === "replace" ? "replace" : stop === "keep" ? "keep" : "review"; }
  else if (title === "START BOUNDARY DRAFTING") selected = "resume";
  else if (/Send this Boundary-authoring conversation|Allow the assistant to send|reviewed structural context/u.test(title)) {
    assert.equal(choice.initialValue, "no"); selected = "yes";
  } else if (values.includes("pause")) selected = "pause";
  else if (values.includes("finish")) selected = "finish";
  else if (values.includes("back")) selected = "back";
  else selected = choice.initialValue;
  menus.push({ ...choice, selected });
  if (selected !== undefined && !values.includes(selected)) throw new Error(`Unknown local choice: ${title}/${selected}`);
  return selected;
};
const session: BoundaryReviewInteractiveSession = {
  chooseResource: async () => undefined, editFieldTiers: async () => undefined,
  promptText: localRead,
  chooseOption: async (title, options, config) => select({ title, options, initialValue: config?.initialValue }),
  confirm: async (title, options) => {
    if (title === "Record these exact words as the meaning for this task?") {
      assert.equal(options?.defaultValue, false); confirmations++; return stop !== "proposal" && stop !== "keep";
    }
    return false;
  },
  confirmActivation: async () => false, confirmReviewedDisabled: async () => false,
  present: (title, lines) => { transcript += `${title}\n${lines.join("\n")}\n`; },
};
try {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (mode === "start") {
    await onboard(["db", "--project-root", root, "--from-env", "OWNED_READ_PROCESS_URL", "--schema", "studio", "--json"],
      { interactive: false, schemaInspector: async () => structuredClone(inspection) });
    const context = await loadBoundaryReviewContext(root);
    const sources = newPolicySourceSession(); sources.snapshots = [policyTextSnapshot(Buffer.from(facts.policy), "read-rules.txt")];
    sources.active = 1; sources.approvals = [{ digest: sources.snapshots[0]!.digest, destination: authoringDestination({ provider: "openai", model: "owned-read-offline" }) }];
    await savePolicySources(root, sources, { expectedDigest: null });
    await writeBoundaryAuthoringResumeState(root, buildBoundaryAuthoringResumeState({
      binding: boundaryAuthoringResumeBinding(context.bundle),
      stage: "read_mapping", jobIntent: facts.job, readIntent: facts.job, provider: "openai", model: "owned-read-offline", policySourceSession: sources.id,
    }), { expectedRevisionDigest: null });
    await fs.writeFile(path.join(root, "ORIGIN.json"), JSON.stringify({ kind: "SCRIPTED_METADATA_BOOTSTRAP_AND_NATIVE_READ_STAGE",
      no_planning_evidence: true, no_target_question_answer_mapping_seeded: true }), { flag: "wx", mode: 0o600 });
  }
  const code = await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], async () => structuredClone(inspection), session,
    undefined, { startWithAgentJob: true, exitAfterAgentJob: true, actionProjectInspector: async () => structuredClone(inspection),
      modelAuthoringSession: { provider: "openai", model: "owned-read-offline", apiKey: "inert-offline-key", dependencies: {
        requestJson: async request => {
          const frame = { body: request.body } as { body: unknown; reply?: unknown };
          frames.push(frame);
          requests++;
          const body = request.body, text = modelVisibleUserText(body);
          if (!body.tools) {
            assert.equal(++narrations, 1, "Only the ordinary post-remap summary is supplied.");
            assert(text.includes("Runner completed and validated the Read draft for this job."));
            assert(text.includes("Read authority remains off"));
            const next = text.match(/Exact next question: ("[^\n]+")/u);
            assert(next, "Narration uses the actual Runner next question.");
            const reply = { status: 200, body: { status: "completed", output: [{ type: "message", role: "assistant",
              content: [{ type: "output_text", text: `The Read draft is validated and remains disabled. ${JSON.parse(next[1]!)}` }] }] } };
            frame.reply = reply; return reply;
          }
          assert(++readRequests <= 2, "Only the two declared Read provider turns are supplied.");
          if (!Array.isArray(body.tools) || !body.tools.some((tool: { name?: string }) => tool.name === "runner__submit_read_workloads")) throw new Error("Undeclared provider stage.");
          const catalogLine = text.split("\n").find(line => line.startsWith("Structural catalog: "));
          if (!catalogLine) throw new Error("Actual transmitted catalog required.");
          const catalog = JSON.parse(catalogLine.slice("Structural catalog: ".length));
          const resource = catalog.resources.find((entry: { id: string }) => entry.id === "studio.parcels");
          if (!resource || !JSON.stringify(resource).includes('"units"') || !JSON.stringify(resource).includes('"label"')) throw new Error("Declared catalog fields are absent.");
          const refsLine = text.split("\n").find(line => line.startsWith("Runner-confirmed answer references: "));
          const references = refsLine ? JSON.parse(refsLine.slice("Runner-confirmed answer references: ".length)) : [];
          const reference = references.find((entry: { resource: string; field?: string }) => entry.resource === resource.id && entry.field === "units");
          const args = reference ? { allowed: [{ id: "parcel_name_count", description: "List parcel public name and requested count.",
            plan: { kind: "rows", resource: resource.id, select: ["label", "units"] } }], forbidden: [],
            operator_meanings: [{ resource: resource.id, field: "units", answer_reference: reference.answer_reference }] }
            : { clarification_request: { resource: resource.id, field: "units", reason: "This operational measure has no established meaning for the task.", question: facts.question } };
          const reply = { status: 200, body: { output: [{ type: "function_call" as const, call_id: `read-child-${process.pid}-${requests}`,
            name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } };
          frame.reply = reply; return reply;
        },
      } },
      modelReadWorkloadGenerator: async input => generateModelReadWorkload({ ...input, onCheckpoint: async (checkpoint, boundary, accepted) => {
        await input.onCheckpoint?.(checkpoint, boundary, accepted);
        if (checkpoint?.stage === "decided" && stop === "confirmed") throw new Error("OWNED_STOP_AFTER_NATIVE_CONFIRMED_CHECKPOINT");
        if (!checkpoint && accepted) acceptedReturns++;
      } }),
      boundaryAuthoringChatFactory: selection => createBoundaryAuthoringChat({ ...selection, color: false, streamLineDelayMs: 0,
        io: { write: text => { transcript += text; }, read: localRead, readConversation: localRead, choose: select,
          columns: () => 110, onInterrupt: () => () => {}, close: () => {}, isTerminal: () => false } }),
    });
  const resume = JSON.parse(await fs.readFile(resumePath, "utf8"));
  const sources = await loadPolicySources(root, resume.policy_source_session);
  originalWrite(JSON.stringify({ pid: process.pid, code, state: "closed", counts: { requests, readRequests, narrations, prompts, confirmations, pendingViews, acceptedReturns },
    resume, sources, frames, menus, transcript }) + "\n");
} catch (error) {
  originalWrite(JSON.stringify({ pid: process.pid, state: "harness_failure", error: error instanceof Error ? error.stack : String(error), transcript, menus, frames }) + "\n");
  process.exitCode = 1;
} finally { process.stdout.write = originalWrite; }

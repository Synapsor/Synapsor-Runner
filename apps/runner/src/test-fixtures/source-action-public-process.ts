/** Ordinary public Action caller in a real child process. Synthetic inspection,
 * declared operator IO and local model transport are the only positive adapters.
 * Faults wrap the actual atomic file rename; no host/presenter/ACK is replaced. */
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { onboard, start } from "../guided-start.js";
import { boundaryAssistCommand, boundaryReviewCommand, loadBoundaryReviewContext } from "../boundary-commands.js";
import { saveInstantBoundaryReviewBaseline } from "../boundary-review-persistence.js";
import { READ_WORKLOAD_SET_VERSION } from "../read-workload-assist.js";
import { createBoundaryAuthoringChat } from "../boundary-authoring-chat.js";
import { listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation } from "../action-rule-authority.js";
import { loadPolicySources } from "../authoring-policy-source.js";
import { modelVisibleJsonLine, modelVisibleUserText } from "./model-visible-frame.js";
import { ownedProgramDraft } from "./owned-authoring-program.js";
import { ACTION_PUBLIC_PROCESS_FACTS as facts, actionPublicProcessInspection, type ActionPublicProcessStop } from "./source-action-public-process-contract.js";
import type { BoundaryReviewInteractiveSession } from "../boundary-cli-picker.js";

const [root, mode, stopValue] = process.argv.slice(2);
const stops = ["unanswered", "raw-beforewrite", "raw-lostack", "source-beforewrite", "source-lostack", "spent", "none"];
assert(root && ["start", "restart"].includes(mode!) && stops.includes(stopValue!), "Owned root/mode/stop required.");
const stop = stopValue as ActionPublicProcessStop;
const inspection = actionPublicProcessInspection(), inspect = async () => structuredClone(inspection);
const resumePath = path.join(root!, ".synapsor/boundary-authoring/resume.json");
const sourceFile = path.join(root!, "action-rules.txt");
const frames: Array<{ body: unknown; reply?: unknown }> = [], menus: unknown[] = [], events: unknown[] = [];
let transcript = "", requests = 0, actionRequests = 0, prompts = 0, confirmations = 0;
let versionPending = false, nativeQuestion: string | undefined, fault: unknown;
const originalWrite = process.stdout.write.bind(process.stdout), originalRename = fs.rename.bind(fs);
process.stdout.write = ((chunk: unknown) => { transcript += String(chunk); return true; }) as typeof process.stdout.write;
globalThis.fetch = async () => { throw new Error("External model/DB transport forbidden."); };
process.env.OWNED_ACTION_PUBLIC_PROCESS_URL = "postgresql://fixture.invalid/never-opened";

const diskResume = async () => JSON.parse(await fs.readFile(resumePath, "utf8"));
const diskSource = async () => { const resume = await diskResume(); return resume.policy_source_session
  ? loadPolicySources(root!, resume.policy_source_session) : undefined; };
const snapshot = async (label: string) => {
  const bytes = await fs.readFile(resumePath, "utf8").catch(() => undefined);
  events.push({ label, resume_bytes: bytes, sources: bytes ? await diskSource() : undefined });
};
// Only fault selection/evidence reads disk. The successful responder below has
// no disk access; its input is the actual transmitted body and declared facts.
fs.rename = async (from, to) => {
  if (!fault && mode === "start" && String(to) === resumePath && /^(?:raw|source)-/u.test(stop)) {
    const bytes = await fs.readFile(from, "utf8"), next = JSON.parse(bytes);
    const q = next.operator_questions?.filter((q: any) => q.target.phase === "action_rule_components").at(-1);
    const rawOnly = q?.raw_answer?.text === facts.raw && !q.proposal;
    const sources = stop.startsWith("source-") && q?.confirmation ? await diskSource() : undefined;
    const appended = sources?.operator_messages?.includes(facts.raw) && q?.confirmation
      && next.owner_handoffs?.some((h: any) => h.id === q.handoff_id && h.state === "answered");
    if (stop.startsWith("raw-") ? rawOnly : appended) {
      await snapshot("before-target-rename");
      if (stop.endsWith("lostack")) await originalRename(from, to);
      fault = { stop, after_real_rename: stop.endsWith("lostack"), proposed_resume_bytes: bytes };
      await snapshot("after-controlled-fault");
      throw Object.assign(new Error(`CONTROLLED_PUBLIC_ACTION_${stop}`), { code: "EIO" });
    }
  }
  await originalRename(from, to);
};

const inputs = mode === "start" ? [`/attach ${sourceFile}`, facts.job] : [];
const read = async () => {
  if (versionPending) { versionPending = false; return facts.sourceLines[6]; }
  if (inputs.length) return inputs.shift();
  // An answer is supplied only for the actual displayed availability question.
  // On restart it comes from the presenter, not a private checkpoint lookup.
  const shown = transcript.slice(-12_000);
  if ((nativeQuestion && shown.includes(nativeQuestion)) || /(?:should|must).{0,100}parcel.{0,100}availab/iu.test(shown)) {
    prompts++; await snapshot("operator-question-before-raw");
    return stop === "unanswered" ? undefined : facts.raw;
  }
  return undefined;
};
const select = async (choice: any) => {
  const values = choice.options.map((option: any) => option.value), title = choice.title ?? "", prompt = choice.message ?? choice.title ?? "";
  let selected: string | undefined;
  if (title === "START BOUNDARY DRAFTING") selected = mode === "start" ? "program" : "resume";
  else if (title === "CLIENT FOR THIS JOB") selected = "later";
  else if (title === "SEND ATTACHED RULES") { assert.equal(choice.initialValue, "cancel"); selected = "send"; }
  else if (title === "USE THE SAVED ATTACHMENT") selected = "continue";
  else if (prompt === "Use this complete intended Action inventory?") { assert.equal(choice.initialValue, "no"); selected = "yes"; }
  else if (title === "REVIEW DECLARED TEXT INPUT BOUNDS") selected = "none";
  else if (prompt === "REVIEW CHANGED-RECORD PROTECTION") { assert.equal(choice.initialValue, "pending"); selected = "confirm"; }
  else if (prompt === "Record this planned counter maintenance for the current setup?") { assert.equal(choice.initialValue, "no"); selected = "yes"; }
  else if (prompt === "Save this exact attributed input-policy interpretation?") { assert.equal(choice.initialValue, "no"); selected = "yes"; }
  else if (prompt === "Record this exact statement for the current question?") {
    assert.equal(choice.initialValue, "no"); assert(transcript.includes(facts.raw.replace(/\t/gu, "\\u0009").trim()));
    confirmations++; await snapshot("readback-before-explicit-yes"); selected = "yes";
  } else if (title === "SAVED BUSINESS STATEMENT") { assert.equal(choice.initialValue, "keep"); selected = "review"; }
  else if (prompt === "Run a new bounded model review?") { assert.equal(choice.initialValue, "no"); selected = "yes"; }
  else if (title === "CLIENT INTEGRATION RESPONSIBILITIES") { assert.equal(choice.initialValue, "back"); selected = "assign"; }
  else if (values.includes("yes") && /Send this Boundary-authoring conversation|Allow the assistant to send|reviewed structural context|Allow the assistant to read|Allow the reviewed change requests/u.test(prompt)) {
    assert.equal(choice.initialValue, "no"); selected = "yes";
  } else if (values.includes("activate")) selected = values.includes("finish") ? "finish" : values.includes("back") ? "back" : undefined;
  else if (values.includes("pause")) selected = "pause";
  else if (values.includes("back")) selected = "back";
  else if (values.includes("finish")) selected = "finish";
  menus.push({ ...choice, selected });
  if (selected !== undefined) assert(values.includes(selected), `Choice not present: ${title}/${selected}`);
  return selected;
};
const reply = (name: string | undefined, args: unknown, text?: string) => ({ status: 200, body: { output: name
  ? [{ type: "function_call", name, call_id: `action-child-${process.pid}-${requests}`, arguments: JSON.stringify(args) }]
  : [{ type: "message", content: [{ type: "output_text", text }] }] } });
const jsonLine = <T,>(body: unknown, label: string) => modelVisibleJsonLine<T>(body, label);
const requestJson = async (request: any) => {
  assert(++requests <= 60, "Declared finite local response bound exceeded.");
  const body = request.body, text = modelVisibleUserText(body), names = (body.tools ?? []).map((tool: any) => tool.name ?? tool.function?.name);
  const frame: { body: unknown; reply?: unknown } = { body }; frames.push(frame);
  let name: string | undefined, args: any, narration: string | undefined;
  if (names.includes("runner__plan_boundary_job")) {
    assert(text.includes(facts.job)); const current = jsonLine<any>(body, "Current reviewed state");
    assert(current.read.exact_reusable_revision_count > 0);
    name = "runner__plan_boundary_job";
    args = { status: "planned", read_mode: "reuse", action_mode: "create", action_strategy: "rule_derived",
      action_intents: facts.outcomes.map((outcome, index) => `${outcome} records caller units from 1 to 10; ${index === 0 ? "require availability" : "ask the current owner about availability"}. Propose only, one parcel reviewer, independent ${facts.reviewClasses[index]}.`),
      action_outcomes: [...facts.outcomes], summary: "Prepare both independent disabled parcel proposals; obtain the missing second eligibility decision." };
    args.action_intent = args.action_intents[0];
  } else if (names.includes("runner__propose_operator_decision")) {
    const q = jsonLine<any>(body, "Current question");
    name = "runner__propose_operator_decision";
    if (q.kind === "input_bounds") {
      // This ordinary Source review precedes Action production even when no
      // text input is declared. The complete actual Source establishes integer
      // units only; an empty attributed text-bound interpretation needs its
      // own explicit default-No confirmation and is not a business answer.
      assert.deepEqual(q.target.outcomes, facts.outcomes); assert(q.source_binding);
      assert.equal(jsonLine<string>(body, "Complete saved Source text (no truncation)"), facts.sourceLines.join("\n"));
      assert.equal(q.source_binding.lines, facts.sourceLines.length);
      args = { question_id: q.question_id, revision: q.revision, source_reference: q.source_reference,
        status: "proposal", disposition: "proposed", value: { kind: "input_bounds", requirements: [] } };
    } else {
      assert.equal(q.kind, "writer_maintenance"); assert.equal(q.target.resource, "studio.parcels"); assert.equal(q.target.field, "version");
      args = q.answer_id === undefined
      ? { question_id: q.question_id, revision: q.revision, status: "needs_information", question: "Do all parcel applications advance this change counter on every update?" }
      : { question_id: q.question_id, revision: q.revision, answer_id: q.answer_id, status: "proposal", disposition: "proposed", value: { kind: "writer_maintenance", maintenance: "all_writers_increment" } };
      if (q.answer_id === undefined) versionPending = true;
      else assert.equal(q.raw_answer, facts.sourceLines[6]);
    }
  } else if (names.includes("runner__submit_action_rule_draft")) {
    actionRequests++;
    const contract = jsonLine<any>(body, "Current work-unit contract"), outcome = contract.identity.intended_outcome;
    const index = facts.outcomes.indexOf(outcome); assert(index >= 0);
    const catalog = jsonLine<any>(body, "Current normalized structural catalog");
    const resource = catalog.resources.find((resource: any) => resource.name === "studio.parcels"); assert(resource);
    const initial = jsonLine<any>(body, "Current disabled draft");
    const results = (body.input ?? []).filter((item: any) => item.type === "function_call_output").map((item: any) => JSON.parse(item.output));
    const current = results.filter((result: any) => result.status === "disabled_component_saved" || result.status === "disabled_revision_opened").at(-1) ?? initial;
    assert.equal(current.intended_outcome, outcome);
    const answers = jsonLine<string[]>(body, "Earlier business answers for this exact outcome");
    if (stop === "spent") { name = "runner__inspect_action_draft"; args = {}; }
    else if (index === 1 && !answers.includes(facts.raw.trim())) {
      assert(text.includes(facts.sourceLines[2]));
      nativeQuestion = facts.question;
      name = "runner__submit_action_rule_draft"; args = { status: "clarification", question: nativeQuestion };
    } else {
      // This is the pre-existing declared fixture payload, checked against the
      // actual transmitted identity/catalog before native compiler submission.
      const draft = ownedProgramDraft(index + 1); draft.approval.class_name = facts.reviewClasses[index]!;
      assert.equal(draft.outcome, outcome); assert(resource.version_field_options.includes("version"));
      // Validate the pre-existing payload's business basis against the actual
      // transmitted declaration/catalog, not against a saved expected draft.
      for (const line of facts.sourceLines) assert(text.includes(line), `Declared Source absent from Action frame: ${line}`);
      const units = resource.fields.find((field: any) => field.name === "units"), available = resource.fields.find((field: any) => field.name === "available");
      assert.equal(units?.type.kind, "integer"); assert.equal(units?.writable, true);
      assert.equal(available?.type.kind, "boolean"); assert.equal(available?.role, "runner_verification_only");
      assert.equal(resource.tenant_scope, "direct"); assert.equal(resource.tenant_key, "tenant_id");
      assert.equal(resource.principal_scope, "none"); assert.equal(resource.principal_key, undefined);
      assert.deepEqual(draft.inputs?.map(input => [input.name, input.minimum, input.maximum]), [[units.name, 1, 10]]);
      assert.deepEqual(draft.effect.allowed_fields, [{ name: units.name, minimum: 1, maximum: 10 }]);
      assert.equal(draft.effect.writeback, "proposal_only"); assert.equal(draft.ttl_seconds, 300);
      assert.equal(draft.approval.class_name, facts.reviewClasses[index]); assert.equal(draft.approval.required_approvals, 1);
      assert.equal(draft.approval.required_role, "parcel_reviewer"); assert.deepEqual(draft.approval.shared_limits, []);
      assert.deepEqual(draft.verification.resources[0]?.fields, [available.name]);
      assert(index === 0 ? text.includes(facts.sourceLines[1]) : answers.includes(facts.raw.trim()));
      const components = current.components;
      const versionPrepared = results.some((result: any) => result.status === "counter_mapping_prepared");
      if (!versionPrepared && !components.verification) { name = "runner__review_version_field"; args = { resource: resource.name, field: resource.version_field_options.find((field: string) => field === "version") }; }
      else if (current.missing.includes("verification")) { name = "runner__submit_verification_boundary_draft"; args = { status: "draft", ...draft.verification }; }
      else if (current.missing.includes("effect")) { name = "runner__submit_effect_envelope_draft"; args = { status: "draft", ...draft.effect }; }
      else if (current.missing.includes("rule")) { const { schema_version: _v, verification: _verification, effect: _effect, approval: _approval, ...rule } = draft;
        name = "runner__submit_action_rule_draft"; args = { status: "draft", ...rule }; }
      else if (current.missing.includes("approval")) { name = "runner__submit_approval_policy_draft"; args = { status: "draft", ...draft.approval }; }
      else if (results.at(-1)?.status === "ready_for_review") {
        assert.equal(results.at(-1).outcome, outcome); assert.equal(results.at(-1).authority_granted, false);
        narration = "The structurally validated parcel proposal stays disabled for exact Source and client-duty review.";
      } else { name = "runner__validate_action_draft"; args = {}; }
    }
  } else if (names.includes("runner__review_policy_coverage")) {
    for (const [index, line] of facts.sourceLines.entries())
      assert(text.split("\n").includes(`${index + 1}: ${line}`), `Actual numbered Source line changed: ${index + 1}`);
    const draft = jsonLine<any>(body, "Current draft (JSON pointer root)");
    const refs = jsonLine<string[]>(body, "Exact coverage references (select, do not invent paths)");
    const messages = jsonLine<any[]>(body, "Indexed operator messages for supporting clarifications or explicit overrides (not source text or model narration)");
    const supporting = messages.find(message => message.message === facts.raw);
    assert.equal(draft.actions.length, 2); assert(supporting);
    const both = (suffix: string) => draft.actions.map((_: unknown, index: number) => `/actions/${index}/${suffix}`);
    const fields = draft.actions.map((action: any) => `/runner_evidence/actions/${action.outcome}/scoped_bindings/parcel/fields/available`);
    const counters = draft.actions.map((action: any) => `/runner_evidence/actions/${action.outcome}/effect/source_counter_maintenance`);
    const passages = [
      { start: 1, end: 1, disposition: "implemented", responsibility: "runner", interpretation: "Both independent declared outcomes are represented.", draft_paths: both("outcome") },
      { start: 2, end: 2, disposition: "implemented", responsibility: "runner", interpretation: "The first proposal retains required availability.", draft_paths: ["/actions/0/require"] },
      { start: 3, end: 3, disposition: "implemented", responsibility: "runner", interpretation: "The exact recorded current owner answer establishes the second proposal's availability requirement.", draft_paths: ["/actions/1/require"], operator_message_id: supporting.operator_message_id },
      { start: 4, end: 4, disposition: "implemented", responsibility: "runner", interpretation: "Only labels and units have reviewed public Read.", draft_paths: ["/read"] },
      { start: 5, end: 5, disposition: "implemented", responsibility: "runner", interpretation: "Both retain bounded units, proposal-only effects, 300-second expiry, trusted subject scope and no execution.", draft_paths: [...both("inputs"), ...both("effect"), ...both("ttl_seconds"), ...draft.actions.map((action: any) => `/runner_evidence/actions/${action.outcome}/scoped_bindings/parcel`)] },
      { start: 6, end: 6, disposition: "implemented", responsibility: "runner", interpretation: "Both independent classes retain one parcel reviewer and no shared or automatic limits.", draft_paths: both("approval") },
      { start: 7, end: 7, disposition: "implemented", responsibility: "operator", interpretation: "The current counter-maintenance testimony is recorded and remains unverified.", draft_paths: counters },
      { start: 8, end: 8, disposition: "implemented", responsibility: "runner", interpretation: "Availability remains private to Runner verification.", draft_paths: fields, field_checks: [{ resource: "studio.parcels", field: "available", expectation: "private" }] },
      { start: 9, end: 9, disposition: "needs_decision", responsibility: "application", interpretation: "The client owns customer selection and truthful status presentation; behavior is unverified.",
        draft_paths: ["/runner_evidence/runtime_contract/application_obligations/customer_selection", "/runner_evidence/runtime_contract/application_obligations/status_presentation"], application_obligations: ["customer_selection", "status_presentation"] },
    ];
    for (const passage of passages) for (const pointer of passage.draft_paths) assert(refs.includes(pointer), `Exact coverage pointer unavailable: ${pointer}`);
    name = "runner__review_policy_coverage"; args = { passages };
  } else if (!names.length) {
    // Narration is selected from the actual rendered pending question when one
    // exists; a structural status message adds no answer or completion proof.
    const label = ["Exact next question", "Pending business meaning to clarify"]
      .find(label => text.split("\n").some(line => line.startsWith(`${label}: `)));
    narration = label ? jsonLine<string>(body, label)
      : "The current disabled record remains subject to its normal operator review; no activation or execution is claimed.";
  }
  else throw new Error(`Unsupported actual native tool surface: ${names.join(",")}`);
  if (name) assert(names.includes(name), `Selected tool absent: ${name}`);
  const result = reply(name, args, narration); frame.reply = result; return result;
};

const outer: BoundaryReviewInteractiveSession = {
  chooseResource: async () => undefined, editFieldTiers: async () => undefined, promptText: async () => undefined,
  confirm: async () => false, confirmActivation: async () => false,
  chooseOption: async (title, options, config) => { events.push({ title, options, context: config?.context }); return options.some(option => option.value === "pause") ? "pause" : undefined; },
  rememberDetails: (title, lines) => { events.push({ title, lines }); },
};
const options = { startWithAgentJob: true, exitAfterAgentJob: true, actionProjectInspector: inspect,
  modelAuthoringSession: { provider: "openai" as const, model: facts.model, apiKey: "inert-fixture-only", dependencies: { requestJson } },
  boundaryAuthoringChatFactory: (selection: any) => createBoundaryAuthoringChat({ ...selection, color: false, streamLineDelayMs: 0,
    io: { write: text => { transcript += text; }, writeChunk: text => { transcript += text; }, read, readConversation: read, choose: select,
      columns: () => 110, isTerminal: () => false, onInterrupt: () => () => {}, close: () => {}, setStatus: () => {}, clearStatus: () => {} } }),
};
let code: number | undefined, error: string | undefined;
try {
  await fs.mkdir(root!, { recursive: true, mode: 0o700 });
  if (mode === "start") {
    await fs.writeFile(sourceFile, facts.sourceLines.join("\n"), { flag: "wx", mode: 0o600 });
    await onboard(["db", "--project-root", root!, "--from-env", "OWNED_ACTION_PUBLIC_PROCESS_URL", "--schema", "studio", "--json"], { interactive: false, schemaInspector: inspect });
    const workload = path.join(root!, "initial-private-read.json");
    await fs.writeFile(workload, JSON.stringify({ schema_version: READ_WORKLOAD_SET_VERSION, name: "owned_private_availability",
      allowed: [{ id: "parcel_labels_units", description: "Read parcel labels and units.", plan: { kind: "rows", resource: "studio.parcels", select: ["label", "units"] } }],
      forbidden: [{ id: "private_available", description: "Never return availability.", plan: { kind: "rows", resource: "studio.parcels", select: ["available"] } }], source: { kind: "operator_exact_plan" } }), { flag: "wx", mode: 0o600 });
    const offset = transcript.length;
    await boundaryAssistCommand(["--project-root", root!, "--workload", workload, "--actor", "owned-structural-fixture", "--reason", "Keep availability private while reading labels and units.", "--json"], inspect);
    const preview = JSON.parse(transcript.slice(offset)); assert.equal(preview.preview.authority_activated, false);
    await boundaryAssistCommand(["--project-root", root!, "--analysis", preview.workload.analysis_id, "--actor", "owned-structural-fixture", "--reason", "Keep availability private while reading labels and units.", "--apply", "--confirm", `APPLY WORKLOAD ${preview.preview.decision_digest}`, "--json"], inspect);
    const context = await loadBoundaryReviewContext(root!);
    await saveInstantBoundaryReviewBaseline({ projectRoot: root!, draft: context.draft, candidate: context.candidate, actor: "owned-structural-fixture", expectedAuthoring: context.bundle.mutation_bindings.authoring });
    await fs.writeFile(path.join(root!, "ORIGIN.json"), JSON.stringify({ kind: "SYNTHETIC_METADATA_AND_PUBLIC_PRIVATE_READ_WORKLOAD_BOOTSTRAP",
      no_physical_db_evidence: true, no_action_question_completion_answer_final_draft_seeded: true, active_authority: false }), { flag: "wx", mode: 0o600 });
    code = await start(["--project-root", root!, "--from-env", "OWNED_ACTION_PUBLIC_PROCESS_URL", "--schema", "studio", "--cli"], { interactive: true, schemaInspector: inspect,
      runBoundaryReview: (args, inspector) => boundaryReviewCommand(args, inspector, outer, undefined, options) });
  } else code = await boundaryReviewCommand(["--project-root", root!, "--access", "--job-first"], inspect, outer, undefined, options);
} catch (failure) { error = failure instanceof Error ? failure.stack : String(failure); }
finally { fs.rename = originalRename; process.stdout.write = originalWrite; }
const resumeBytes = await fs.readFile(resumePath, "utf8").catch(() => undefined);
const resume = resumeBytes && JSON.parse(resumeBytes), sources = resume ? await diskSource() : undefined;
originalWrite(JSON.stringify({ pid: process.pid, projectRoot: root, code, error, counts: { requests, actionRequests, prompts, confirmations }, fault,
  resume_bytes: resumeBytes, resume, sources, actions: await listActionRuleAuthorityDrafts(root!), activation: await readActionRuleAuthorityActivation(root!), frames, menus, events, transcript }) + "\n");

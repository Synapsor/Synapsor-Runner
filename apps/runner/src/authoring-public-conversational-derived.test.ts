import { nativeAuthoringRefusal } from "./test-fixtures/native-authoring-refusal.js";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { canonicalJsonDigest, createTaskContextMeter } from "@synapsor-runner/protocol";
import { expect, it, vi } from "vitest";
import { start } from "./guided-start.js";
import { boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation, loadActiveActionRuleAuthority } from "./action-rule-authority.js";
import { loadPolicySources, savePolicySources, policyTextSnapshot } from "./authoring-policy-source.js";
import { AskError, secureAskJsonRequest } from "./model-ask.js";
import { ownedProgramDraft, ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";

/** Implementer DERIVED source regression. Only transport replies and terminal IO
 * are simulated. Production planners/parsers/saves/reviews/publication run normally.
 * No imported authority, ready flag, state injection, DB, key, or provider call. */
const evidenceRoot = process.env.OWNED_CONVERSATIONAL_EVIDENCE ?? path.join(process.env.SYNAPSOR_TEST_EVIDENCE_DIR ?? os.tmpdir(), `owned-public-conversational-${randomUUID()}`);
const count = Number(process.env.OWNED_CONVERSATIONAL_ACTIONS ?? 13);
const existingProject = process.env.OWNED_CONVERSATIONAL_EXISTING_PROJECT;
const editIndex = count === 50 ? 37 : count;
// Sealed synthetic operator plan, consumed only through the ordinary menu. This
// records planned ownership; it does not attest to an implemented/live client.
const derivedClientPlan = { owner: "client_application", duties: ["customer_selection", "status_presentation"], verified: false } as const;
const strings = (value: any): string[] => typeof value === "string" ? [value]
  : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
const lineJson = (text: string, prefix: string): any => {
  const line = text.split("\n").find(line => line.startsWith(prefix));
  return line ? JSON.parse(line.slice(prefix.length)) : undefined;
};
const rename = <T,>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll("studio", "workshop").replaceAll("parcel", "card").replaceAll("pack_card", "adjust_card"));
const inspection = async () => rename(ownedProgramInspection());
const baseDraftFor = (index: number) => rename(ownedProgramDraft(index));
const intentFor = (index: number) => `Action ${index}: workshop.adjust_card_${index} records caller-supplied units from 1 to 10 for an available card; unavailable cards are refused. It proposes only and requires one human card_reviewer.`;
const editRequest = `Revise workshop.adjust_card_${editIndex} ttl_seconds from 300 to 240; preserve every original exception, global responsibility, unit input bound, effect, and human approval requirement in the complete selected program.`;
const removeRequest = "Remove workshop.adjust_card_50 from the selected program and explicitly withdraw its requested Action 50 source clause. Retain every other source clause, early exception and global responsibility.";

async function runPublicConversational(testControl?: "no" | "escape" | "source_drift", inputBounds = false, interruption?: "edit_cancel" | "midpoint_cancel", reopenInput = false, ordinaryTopReview = false) {
  const draftFor = (index:number) => { const draft=baseDraftFor(index); if(inputBounds)draft.inputs!.push({name:"operator_note",description:"The caller note required by the source.",type:{kind:"string",min_length:1,max_length:64,comparison:"exact"}}); return draft; };
  const agendaControl = testControl ?? process.env.OWNED_CONVERSATIONAL_AGENDA_CONTROL;
  const evidence = ordinaryTopReview ? `${evidenceRoot}-ordinary-input-review` : reopenInput ? `${evidenceRoot}-reopen-input` : interruption ? `${evidenceRoot}-${interruption}` : testControl ? `${evidenceRoot}-${testControl}` : inputBounds ? `${evidenceRoot}-input-bounds` : evidenceRoot;
  if (![13, 32, 50].includes(count)) throw new Error("A finite public count is required.");
  await fs.mkdir(evidence, { recursive: false });
  const root = existingProject ?? path.join(evidence, "project");
  if (!existingProject) await fs.mkdir(root);
  const sourceLines = [
    "Workshop card adjustment program.",
    "Early exception: every retained Action refuses a card when available is false.",
    "Global obligation: every retained Action proposes only and requires one human card_reviewer; no automatic approval or execution.",
    "The assistant may read card labels and unit counts. workshop.cards is the card register; workshop.cards.label is the public card name; workshop.cards.units is the requested unit count.",
    "Every retained Action accepts caller-supplied units between 1 and 10 inclusive and changes only the business field units, together with Runner's maintained version counter." + (inputBounds ? " Every retained Action also requires a caller-supplied operator_note string of 1..64 UTF-16 units; do not trim it or store it as a source effect." : ""),
    "Synthetic source-owner operating fact: every workshop.cards writer increments the integer version counter on each update. This fixture fact is an owner assertion, not independently observed enforcement.",
    ...Array.from({ length: count }, (_, i) => intentFor(i + 1)),
  ];
  const sourceText = sourceLines.join("\n");
  const sourceFile = path.join(root, "workshop-rules.txt");
  if (existingProject) expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
  else await fs.writeFile(sourceFile, sourceText);
  const intents = Array.from({ length: count }, (_, i) => intentFor(i + 1));
  // This is an actual operator job, constrained by the unchanged public 4000-char
  // bound. The complete action list is also in the approved attached source.
  const boundedJob = `Prepare all ${count} selected workshop.adjust_card_1 through workshop.adjust_card_${count} Actions in the attached rules, preserving the early exception and shared human-review obligation. Read labels and unit counts from workshop.cards. workshop.cards is the card register; workshop.cards.label is the public card name; workshop.cards.units is the requested unit count.`;
  expect(boundedJob.length).toBeLessThan(4000);
  let transcript = "", requests = 0, coverageRequests = 0, stage = existingProject ? "resume_create" : "create", actionReplyIndex = new Map<string, number>();
  let publicationDeclined = false, midpointPaused = false, editInterrupted = false, editSaveDeclined = false;
  let versionAnswerPending: { question_id: string; revision: number } | undefined;
  const versionQuestion = "Do all your applications advance the card change counter every time they change a card?";
  const decisions: any[] = [], notices: any[] = [], bodies: any[] = [];
  let interrupt: (() => void) | undefined;
  // The connected Source interpretation reads the same explicit line5 bounds;
  // obsolete manual registration keys must not become a later writer answer.
  let answers = existingProject ? [] : [`/attach ${sourceFile}`, boundedJob];
  const write = (text: string) => { transcript += text; appendFileSync(path.join(evidence, "live-transcript.txt"), text); };
  const fail = (message: string): never => { throw new Error(`${message}\nTRANSCRIPT TAIL\n${transcript.slice(-12000)}`); };
  const io: any = {
    write, writeChunk: write, columns: () => 110, isTerminal: () => false,
    onInterrupt: (handler: () => void) => { interrupt = handler; return () => { interrupt = undefined; }; }, close: () => { decisions.push({ kind: "chat_closed", stage }); }, setStatus: () => {}, clearStatus: () => {},
    review: async (title: string, lines: string[]) => { write(`\nREVIEW ${title}\n${lines.join("\n")}\n`); },
    read: async (prompt: string) => {
      if (versionAnswerPending) {
        const saved = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
        const question = saved.operator_questions.find((q: any) => q.id === versionAnswerPending!.question_id);
        expect(question).toMatchObject({ revision: versionAnswerPending.revision, kind: "writer_maintenance",
          presentation: { text: versionQuestion }, target: { resource: "workshop.cards", field: "version" } });
        expect(question.raw_answer).toBeUndefined();
        expect(saved.owner_handoffs.find((h: any) => h.id === question.handoff_id)?.state).toBe("waiting");
        versionAnswerPending = undefined;
        decisions.push({ kind: "answer", prompt, answer: sourceLines[5], origin: "existing_source_line6", unresolved: false });
        return sourceLines[5];
      }
      const answer = answers.shift(); decisions.push({ kind: "answer", prompt, answer, unresolved: answer === undefined }); if (answer === undefined) interrupt?.(); return answer;
    },
    readConversation: async (prompt: string) => io.read(prompt),
    choose: async (choice: any) => {
      appendFileSync(path.join(evidence, "live-menus.jsonl"), `${JSON.stringify(choice)}\n`);
      const values = choice.options.map((o: any) => o.value);
      let selected: string | undefined;
      if (choice.title === "START BOUNDARY DRAFTING") selected = stage === "create" ? "program" : ["edit_prepare", "remove_request", "reopen_input"].includes(stage) ? "model" : ["remove_review", "reopen_input_review"].includes(stage) ? "review_rules" : "resume";
      else if (choice.title === "REVIEW DECLARED TEXT INPUT BOUNDS") {
        expect(choice.initialValue).toBe("pending"); selected = inputBounds ? "register" : "none"; // Exact DERIVED source meaning, supplied through public controls.
      }
      else if (choice.message === "Register another distinct input requirement?") { expect(choice.initialValue).toBe("no"); selected="no"; }
      else if (choice.message === "Save this exact attributed input-policy interpretation?") {
        expect(choice.initialValue).toBe("no");
        selected = "yes";
      }
      else if (choice.title === "SAVED INPUT-POLICY DECISION") { expect(choice.initialValue).toBe("keep"); selected = "answer"; }
      else if (choice.title === "VERIFIED ACTION BOUNDARY") selected = stage === "remove_resume" && values.includes("activate") ? "activate" : "back";
      else if (choice.title === "SETUP NEEDS ATTENTION" && interruption) selected = "pause";
      else if (choice.title === "CLIENT FOR THIS JOB") selected = "later";
      else if (choice.title === "SEND ATTACHED RULES") { expect(choice.initialValue).toBe("cancel"); selected = "send"; }
      else if (choice.title === "USE THE SAVED ATTACHMENT") selected = stage === "reopen_input" ? "review" : "continue";
      else if (choice.message === "Use this complete intended Action inventory?") {
        expect(choice.initialValue).toBe("no");
        for (let i = 1; i <= count; i++) expect(transcript).toContain(`workshop.adjust_card_${i}`);
        if (agendaControl === "source_drift") {
          const saved = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
          const sources = await loadPolicySources(root, saved.policy_source_session);
          const next = policyTextSnapshot(Buffer.from(sourceText + "\nA new exception needs review."), "workshop-rules.txt", sources.snapshots.length + 1);
          sources.snapshots.push(next); sources.active = next.version;
          await savePolicySources(root, sources);
        }
        selected = agendaControl === "no" ? "no" : "yes";
        if (agendaControl === "escape") return undefined;
      }
      else if (choice.message === "Save this exact disabled Action edit?") {
        expect(choice.initialValue).toBe("no"); expect(choice.options.find((o: any) => o.value === "yes")).toBeDefined();
        expect(transcript.replace(/\s+/gu, " ")).toContain(editRequest);
        selected = editSaveDeclined ? "yes" : "no"; editSaveDeclined = true;
      }
      else if (choice.message === "Run a new bounded model review?") {
        expect(choice.initialValue).toBe("no"); expect(transcript).toContain("openai[owned-offline]");
        expect(transcript).toContain("Maximum: three model response submissions"); expect(transcript).toContain("Review subject:"); selected = stage.startsWith("reopen_input") ? "no" : "yes";
      }
      else if (choice.title === "CLIENT INTEGRATION RESPONSIBILITIES" && values.includes("assign")) {
        expect(choice.initialValue).toBe("back"); expect(choice.message).toContain("remain unverified");
        decisions.push({ kind: "planned_client_owner", ...derivedClientPlan }); selected = "assign";
      }
      else if (choice.message === "REVIEW CHANGED-RECORD PROTECTION" && values.includes("confirm")) {
        expect(choice.initialValue).toBe("pending"); expect(transcript).toContain("workshop.cards.version"); selected = "confirm";
      }
      else if (choice.message === "Record this planned counter maintenance for the current setup?") {
        expect(choice.initialValue).toBe("no");
        const shown = transcript.replace(/\s+/gu, " ");
        expect(shown).toContain("Counter: workshop.cards.version."); expect(shown).toContain(sourceLines[5]);
        expect(shown).toContain("Implementation remains unverified.");
        expect(shown).toContain("It grants no Read or execution permission and changes no business rule.");
        selected = "yes";
      }
      else if (values.includes("activate") && /(?:READ|ACCESS|BOUNDARY)/.test(choice.title)) { expect(choice.initialValue).toBe("finish"); selected = "activate"; }
      else if (values.includes("yes") && /Send this Boundary-authoring conversation|Allow the assistant to send|reviewed structural context|Allow the assistant to read|Allow the reviewed change requests|Activate verified Action Boundary|Activate.*local read-only/.test(choice.message)) {
        expect(choice.initialValue).toBe("no");
        if (choice.title === "REVIEW CHANGE REQUESTS" && !publicationDeclined) { publicationDeclined = true; selected = "no"; }
        else selected = "yes";
      }
      if (!selected || !values.includes(selected)) { decisions.push({ kind: "unrecognized_menu_refused", ...choice }); interrupt?.(); return undefined; }
      decisions.push({ kind: "choice", stage, ...choice, selected }); return selected;
    },
  };
  const deriveReply = async (request: any) => {
    const body = request.body;
    if (Array.isArray(body.tools) && body.tools.length) expect(body.parallel_tool_calls).toBe(false);
    else { expect(body).not.toHaveProperty("tools"); expect(body).not.toHaveProperty("tool_choice"); expect(body).not.toHaveProperty("parallel_tool_calls"); }
    const text = strings(body).join("\n");
    const names = (body.tools ?? []).map((tool: any) => tool.name ?? tool.function?.name);
    if (++requests > 600) fail("Finite DERIVED request bound exceeded.");
    bodies.push({ index: requests, stage, bytes: Buffer.byteLength(JSON.stringify(body)), body });
    let name: string | undefined, args: any, responseText: string | undefined;
    if (names.includes("runner__plan_boundary_job")) {
      name = "runner__plan_boundary_job";
      args = stage.startsWith("edit") ? { status: "planned", read_mode: "reuse", action_mode: "revise", action_strategy: "rule_derived",
        action_outcome: `workshop.adjust_card_${editIndex}`, action_intent: editRequest, summary: "Revise only Action 37 request lifetime, retaining the complete program." }
        : stage === "remove_request" ? { status: "planned", read_mode: "reuse", action_mode: "remove", action_outcome: "workshop.adjust_card_50", summary: "Withdraw only the explicitly removed Action 50; retain all outside responsibilities." }
        : { status: "planned", read_mode: "create", read_intent: "Read card labels and unit counts from workshop.cards.",
        action_mode: "create", action_strategy: "rule_derived", action_intent: intents[0], action_intents: intents, action_outcomes: Array.from({ length: count }, (_, i) => `workshop.adjust_card_${i + 1}`), summary: `Prepare the complete selected ${count}-Action program.` };
    } else if (names.includes("runner__propose_operator_decision")) {
      const question = lineJson(text, "Current question: ");
      name = "runner__propose_operator_decision";
      expect(question.target.outcomes).toEqual(Array.from({ length: count }, (_, i) => `workshop.adjust_card_${i + 1}`));
      if (question.kind === "input_bounds") {
        expect(question.source_binding).toBeDefined();
        expect(question.source_reference).toBe(canonicalJsonDigest(question.source_binding));
        for (const line of sourceLines) expect(text).toContain(line);
        args = { question_id: question.question_id, revision: question.revision, source_reference: question.source_reference,
          status: "proposal", disposition: "proposed", value: { kind: "input_bounds", requirements: inputBounds
            ? [{ outcomes: question.target.outcomes, input: "operator_note", start: 5, end: 5, min_length: 1, max_length: 64 }] : [] } };
      } else {
        expect(question.kind).toBe("writer_maintenance");
        expect(question.target).toMatchObject({ phase: "changed_record_protection", resource: "workshop.cards", field: "version" });
        expect(question.evidence).toEqual([{ id: "version-structure", digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }]);
        if (question.answer_id === undefined) {
          expect(question.raw_answer).toBeUndefined();
          versionAnswerPending = { question_id: question.question_id, revision: question.revision };
          args = { question_id: question.question_id, revision: question.revision, status: "needs_information", question: versionQuestion };
        } else {
          expect(question.raw_answer).toBe(sourceLines[5]); expect(question.answer_id).toEqual(expect.any(String));
          args = { question_id: question.question_id, revision: question.revision, answer_id: question.answer_id,
            status: "proposal", disposition: "proposed", value: { kind: "writer_maintenance", maintenance: "all_writers_increment" } };
        }
      }
    } else if (names.includes("runner__submit_read_workloads")) {
      name = "runner__submit_read_workloads";
      args = { allowed: [{ id: "card_labels_units", description: "Read card labels and requested unit counts.", plan: { kind: "rows", resource: "workshop.cards", select: ["label", "units"] } }], forbidden: [],
        operator_meanings: [{ resource: "workshop.cards", operator_quote: "workshop.cards is the card register" },
          { resource: "workshop.cards", field: "label", operator_quote: "workshop.cards.label is the public card name" },
          { resource: "workshop.cards", field: "units", operator_quote: "workshop.cards.units is the requested unit count" }] };
    } else if (names.includes("runner__submit_action_rule_draft")) {
      const intent = lineJson(text, "Current action intent: ");
      const index = Number(String(intent).match(/Action (\d+):/)?.[1] ?? String(intent).match(/workshop\.adjust_card_(\d+)/)?.[1]);
      if (!index) fail("Current action intent missing from actual encoder.");
      for (const line of sourceLines) expect(text).toContain(line);
      expect(text).toContain(boundedJob);
      if (count === 50 && index === 25 && !midpointPaused) {
        midpointPaused = true;
        if (interruption === "midpoint_cancel") { interrupt?.(); throw new AskError("ASK_CANCELLED", "DERIVED operator interrupted at the ordinary saved program midpoint.", 499); }
        return { status: 401, body: { error: { message: "DERIVED complete refusal at the saved midpoint, not cancellation." } } };
      }
      const current = draftFor(index);
      if (stage.startsWith("edit") && index === editIndex) {
        current.ttl_seconds = 240;
        const program = lineJson(text, "Host saved complete program and current work unit (progress only; attributed owner decisions remain scoped to their recorded applicability): ");
        expect(program.selected_intents).toHaveLength(count); expect(program.current_intent_index).toBe(editIndex - 1);
        expect(program.counter_owner_reviews.length).toBeGreaterThan(0);
      }
      const { schema_version, verification, effect, approval, ...rule } = current;
      const phases = [
        ["runner__submit_verification_boundary_draft", { status: "draft", ...verification, changed_fields: [] }],
        ["runner__submit_effect_envelope_draft", { status: "draft", ...effect, changed_fields: [] }],
        ["runner__submit_action_rule_draft", { status: "draft", ...rule, changed_fields: stage.startsWith("edit") ? ["ttl_seconds"] : [] }],
        ["runner__submit_approval_policy_draft", { status: "draft", ...approval, changed_fields: [] }],
        ["runner__validate_action_draft", {}],
      ];
      if(inputBounds && index===1 && stage==='create') {
        const initial=structuredClone(rule); delete (initial.inputs![1]!.type as any).min_length;
        phases[2]=["runner__submit_action_rule_draft",{status:"draft",...initial,changed_fields:[]}];
        phases.push(["runner__submit_action_rule_draft",{status:"draft",...rule,changed_fields:[]}],["runner__validate_action_draft",{}]);
      }
      const key = `${stage}:${index}`; const phase = actionReplyIndex.get(key) ?? 0; actionReplyIndex.set(key, phase + 1);
      if (stage === "edit_prepare" && phase === 1 && !editInterrupted) {
        editInterrupted = true;
        if (interruption === "edit_cancel") { interrupt?.(); throw new AskError("ASK_CANCELLED", "DERIVED interruption after the exact pending edit checkpoint.", 499); }
        return { status: 401, body: { error: { message: "DERIVED complete refusal after the exact pending edit checkpoint, not cancellation." } } };
      }
      if(inputBounds && index===1 && stage==='create' && phase===5) expect(text).toContain('SOURCE_INPUT_CONSTRAINT_WEAKER');
      if (phase < phases.length) [name, args] = phases[phase] as any;
      else responseText = "The complete structured draft is prepared; separate attached-source review and operator publication are required.";
    } else if (names.includes("runner__review_policy_coverage")) {
      coverageRequests++;
      for (const line of sourceLines) expect(text).toContain(line);
      const current = lineJson(text, "Current draft (JSON pointer root): ");
      const paths = lineJson(text, "Exact coverage references (select, do not invent paths): ");
      const ownerMessages = lineJson(text, "Indexed operator messages for supporting clarifications or explicit overrides (not source text or model narration): ");
      const actionPaths = (part: string) => current.actions.map((_: any, i: number) => `/actions/${i}/${part}`);
      const passages = sourceLines.flatMap((line, i) => {
        if (i >= 6 && !current.actions.some((action: any) => action.outcome === draftFor(i - 5).outcome)) {
          const owner = ownerMessages.find((message: any) => message.message === removeRequest);
          if (!owner) fail("Removed source clause has no authentic explicit withdrawal message.");
          return [{ start: i + 1, end: i + 1, disposition: "overridden", interpretation: "The operator expressly withdrew only this Action 50 clause; all other duties remain current.", draft_paths: [], operator_message_id: owner.operator_message_id }];
        }
        const passage = { start: i + 1, end: i + 1,
        disposition: i === 0 ? "background" : "implemented", interpretation: i === 0 ? "Program heading." : line,
        draft_paths: i === 0 ? [] : i === 1 ? actionPaths("require") : i === 2 ? [...actionPaths("approval"), ...actionPaths("effect")]
          : i === 3 ? ["/read"] : i === 4 ? [...actionPaths("inputs"), ...actionPaths("effect")]
          : i === 5 ? current.actions.map((action: any) => `/runner_evidence/actions/${action.outcome}/effect/source_counter_maintenance`)
          : [`/actions/${current.actions.findIndex((action: any) => action.outcome === draftFor(i - 5).outcome)}`] };
        // The existing passage has at most 32 exact references. Overlapping
        // fragments retain the complete conjunction while covering each selected
        // Action; the product's source/passages/output bounds are unchanged.
        return passage.draft_paths.length > 32 ? Array.from({ length: Math.ceil(passage.draft_paths.length / 32) }, (_, chunk) => ({ ...passage, draft_paths: passage.draft_paths.slice(chunk * 32, (chunk + 1) * 32) })) : [passage];
      });
      for (const passage of passages) for (const pointer of passage.draft_paths) expect(paths).toContain(pointer);
      name = "runner__review_policy_coverage"; args = { passages };
    } else if (names.length === 0) {
      const question = lineJson(text, "Exact next question: ");
      responseText = typeof question === "string" ? question : "Runner's current record is ready for the next exact operator review. No source operation is claimed.";
    } else fail(`Unexpected actual tool surface: ${JSON.stringify(names)}`);
    if (name && !names.includes(name)) fail(`Tool ${name} absent from actual emitted surface.`);
    return { status: 200, body: { output: name ? [{ type: "function_call", call_id: `owned-local-${requests}`, name, arguments: JSON.stringify(args) }]
      : [{ type: "message", content: [{ type: "output_text", text: responseText }] }] } };
  };
  const wireRecords: any[] = [];
  const profiles: any[] = [];
  const meter = createTaskContextMeter();
  let queuedReply: any;
  const server = http.createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const encoded = Buffer.concat(chunks); const body = JSON.parse(encoded.toString("utf8"));
    const response = JSON.stringify(queuedReply.body);
    wireRecords.push({ origin: "ACTUAL_OWNED_LOOPBACK_TRANSPORT_DERIVED_REPLY", stage, index: wireRecords.length + 1,
      utf8_body_bytes: encoded.length, encoded_utf8: encoded.toString("utf8"), time: new Date().toISOString(), body,
      completed_response_utf8_bytes: Buffer.byteLength(response), completed_response_encoded_utf8: response });
    outgoing.writeHead(queuedReply.status, { "content-type": "application/json" }); outgoing.end(response);
  });
  if (count === 50) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = count === 50 ? new URL(`http://127.0.0.1:${(server.address() as any).port}/responses`) : undefined;
  const requestJson = async (request: any) => {
    const reply = await deriveReply(request);
    if (!endpoint) return reply.status === 200 ? reply : nativeAuthoringRefusal(request, reply.status);
    queuedReply = reply;
    return secureAskJsonRequest({ ...request, endpoint, scope: "custom_loopback", headers: {} });
  };
  const outer: any = { chooseResource: async () => fail("Manual resource route entered"), editFieldTiers: async () => fail("Manual field route entered"),
    chooseOption: async (title: string, choices: Array<{ value: string }>, options: { context?: string[]; initialValue?: string }) => {
      if (title !== "SETUP NEEDS ATTENTION" || !(editInterrupted || midpointPaused || agendaControl === "source_drift")) fail(`Unexpected outer choice: ${title}`);
      expect(choices.some(choice => choice.value === "pause")).toBe(true);
      expect(options.initialValue).toBe("pause");
      const expectedFailure = agendaControl === "source_drift" ? "changed" : interruption ? "unfinished generation" : "rejected the configured API key";
      expect(options.context?.join("\n")).toContain(expectedFailure);
      write(options.context!.join("\n"));
      decisions.push({ kind: "explicit_outer_safe_pause", title, stage, interruption: interruption ?? "complete_native_refusal" });
      return "pause";
    },
    promptText: async () => agendaControl === "source_drift" || interruption ? undefined : fail("Outer operator text bypass"), confirm: async () => fail("Outer confirmation bypass") };
  const options: any = { startWithAgentJob: true, exitAfterAgentJob: true,
    modelAuthoringSession: { provider: "openai", model: "owned-offline", apiKey: "offline-placeholder", dependencies: { requestJson,
      contextMeasurement: { meter, onProfile: (profile: any) => profiles.push({ stage, ...profile }) } } },
    actionProjectInspector: inspection, boundaryAuthoringChatFactory: (selection: any) => createBoundaryAuthoringChat({ ...selection, io, color: false, streamLineDelayMs: 0 }),
    onAuthoringResult: (notice: any) => notices.push(notice) };
  const previousUrl = process.env.OWNED_CONVERSATIONAL_READ_URL;
  process.env.OWNED_CONVERSATIONAL_READ_URL = "postgresql://fixture.invalid/not-used";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { write(String(chunk)); return true; });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => fail("Network transport forbidden"));
  let result: any;
  try {
    result = existingProject ? await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options)
      : await start(["--project-root", root, "--from-env", "OWNED_CONVERSATIONAL_READ_URL", "--schema", "workshop", "--cli"],
      { interactive: true, schemaInspector: inspection,
        runBoundaryReview: (args, inspect) => boundaryReviewCommand(args, inspect, outer, undefined, options) });
    let context = await loadBoundaryReviewContext(root);
    if (agendaControl) {
      expect(await listActionRuleAuthorityDrafts(root)).toHaveLength(0);
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      expect(bodies.some(record => record.body.tools?.some((tool: any) => tool.name === "runner__submit_action_rule_draft"))).toBe(false);
      expect(transcript).toContain(agendaControl === "source_drift" ? "changed" : "not confirmed");
      return;
    }
    if (count === 50 && !existingProject) {
      const [partial] = await listActionRuleAuthorityDrafts(root);
      expect(partial?.authority.rules).toHaveLength(24);
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      const saved = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
      expect(saved.action.intents).toHaveLength(50); expect(saved.action.intended_outcomes).toEqual(Array.from({ length: 50 }, (_, i) => `workshop.adjust_card_${i + 1}`)); expect(saved.action.completed_outcomes).toHaveLength(24);
      await fs.writeFile(path.join(evidence, "midpoint-resume.json"), JSON.stringify(saved, null, 2));
      const savedRequestsAtMidpoint = requests;
      stage = "resume_create";
      result = await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options);
      context = await loadBoundaryReviewContext(root);
      if (interruption === "midpoint_cancel") {
        const retained = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
        expect(requests).toBe(savedRequestsAtMidpoint);
        expect(retained.action).toEqual(saved.action);
        expect(retained.generation_recovery).toEqual(saved.generation_recovery);
        expect(retained.generation_recovery.operations.some((op: any) => op.state === "partial")).toBe(true);
        expect((await listActionRuleAuthorityDrafts(root))[0]).toEqual(partial);
        expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
        return;
      }
    }
    const [declinedDraft] = await listActionRuleAuthorityDrafts(root);
    expect(declinedDraft?.authority.rules).toHaveLength(count);
    if(inputBounds)for(const entry of declinedDraft!.authority.rules) expect(entry.rule.inputs!.find(i=>i.name==='operator_note')!.type).toMatchObject({min_length:1,max_length:64});
    expect(publicationDeclined).toBe(true); expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    await fs.writeFile(path.join(evidence, "declined-publication.json"), JSON.stringify({ digest: declinedDraft?.digest, count, active: false }, null, 2));
    if (reopenInput) {
      const beforeResume = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
      const beforeSources = await loadPolicySources(root, beforeResume.policy_source_session);
      const replacement = path.join(root, "reopened-input-rules.txt");
      // A new authentic attachment version with unchanged, explicit input facts.
      // It must be freshly attributed against this Source; no old record rewrite.
      await fs.writeFile(replacement, sourceText + "\nUpdated policy heading; the declared caller-note rules remain unchanged.");
      const beforeRequests = requests, beforeCoverage = coverageRequests, beforeDecisions = decisions.length;
      if (ordinaryTopReview) {
        // Labelled fixture preparation through the real Source storage API.
        // The actual public START Review must obtain fresh transfer consent and
        // adopt input meaning through its own assisted default-No route.
        const changed = structuredClone(beforeSources);
        const next = policyTextSnapshot(Buffer.from(await fs.readFile(replacement)), "reopened-input-rules.txt", changed.snapshots.length + 1);
        changed.snapshots.push(next); changed.active = next.version;
        await savePolicySources(root, changed, { expectedDigest: canonicalJsonDigest(beforeSources) });
        stage = "reopen_input_review"; answers = [];
      } else { stage = "reopen_input"; answers = [`/attach ${replacement}`]; }
      await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options);
      const afterResume = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
      const afterSources = await loadPolicySources(root, afterResume.policy_source_session);
      const current = afterSources.snapshots.find(source => source.version === afterSources.active)!;
      expect(current.digest).not.toBe(beforeSources.snapshots.find(source => source.version === beforeSources.active)!.digest);
      expect(decisions.slice(beforeDecisions).some(decision => decision.title === "REVIEW DECLARED TEXT INPUT BOUNDS"), transcript.slice(-12000)).toBe(false);
      const added = afterSources.input_policy_reviews!.slice(beforeSources.input_policy_reviews!.length);
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ source_digest: current.digest, decision: "confirmed", requirements: [{
        input: "operator_note", min_length: 1, max_length: 64, start: 5, end: 5,
      }], question_reference: expect.any(Object) });
      expect(afterSources.snapshots.slice(0, beforeSources.snapshots.length)).toEqual(beforeSources.snapshots);
      expect(afterSources.input_policy_reviews!.slice(0, beforeSources.input_policy_reviews!.length)).toEqual(beforeSources.input_policy_reviews);
      expect(afterResume.generation_recovery.operations.slice(0, beforeResume.generation_recovery.operations.length)).toEqual(beforeResume.generation_recovery.operations);
      expect(await listActionRuleAuthorityDrafts(root)).toEqual([declinedDraft]);
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      expect(requests).toBe(beforeRequests + 1); expect(coverageRequests).toBe(beforeCoverage);
      return;
    }
    stage = "publish_resume";
    result = await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options);
    const active = await loadActiveActionRuleAuthority(root);
    const activation = await readActionRuleAuthorityActivation(root);
    await fs.writeFile(path.join(evidence, "result.json"), JSON.stringify({ origin: "DERIVED_PUBLIC_CONVERSATIONAL_SOURCE", result, count, requests, coverageRequests,
      activeOutcomes: active.authority.rules.map(entry => entry.rule.outcome), activationDigest: activation?.digest, providerCalls: 0, notices }, null, 2));
    expect(result, transcript.slice(-12000)).toBe(0);
    expect(active.authority.rules).toHaveLength(count);
    expect(new Set(active.authority.rules.map(entry => entry.rule.approval_class))).toEqual(new Set(["workshop.shared_review"]));
    expect(active.authority.approval_classes).toHaveLength(1);
    expect(active.authority.approval_classes[0]).toMatchObject({ name: "workshop.shared_review", mode: "human", required_role: "card_reviewer", required_approvals: 1, shared_limits: [] });
    expect(active.authority.approval_classes[0]!.rules.map(rule => rule.outcome).sort()).toEqual(intents.map((_, i) => draftFor(i + 1).outcome).sort());
    for (const entry of active.authority.rules) {
      const expected = draftFor(Number(entry.rule.outcome.split("_").at(-1)));
      expect(entry.rule.require).toEqual(expected.require);
      expect(entry.rule.inputs).toEqual([...expected.inputs!].sort((a,b)=>a.name.localeCompare(b.name)));
      expect(entry.rule.effect.set).toEqual(expected.effect.set);
      expect(entry.effect_envelope.allowed_fields).toMatchObject([{ name: "units", minimum: 1, maximum: 10 }]);
      expect(entry.effect_envelope.writeback.mode).toBe("none");
    }
    expect(coverageRequests).toBeGreaterThan(0);
    expect(activation?.digest).toBe(active.activation.digest);
    {
      stage = "edit_prepare"; publicationDeclined = false; answers = [editRequest];
      expect(await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options)).toBe(0);
      const pendingEdit = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
      expect(editInterrupted).toBe(true);
      expect(pendingEdit.action.intents).toEqual(intents); expect(pendingEdit.action.completed_outcomes).toHaveLength(count);
      expect(pendingEdit.pending_action_revision).toMatchObject({ outcome: `workshop.adjust_card_${editIndex}`, instruction: editRequest });
      expect(pendingEdit.pending_action_revision.checkpoint).toBeDefined(); expect(pendingEdit.action.checkpoint).toBeUndefined();
      expect((await loadActiveActionRuleAuthority(root)).activation.digest).toBe(active.activation.digest);
      await fs.writeFile(path.join(evidence, "pending-edit-checkpoint.json"), JSON.stringify(pendingEdit, null, 2));
      const savedRequestsAtEdit = requests;
      stage = "edit_resume";
      expect(await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options)).toBe(0);
      if (interruption === "edit_cancel") {
        const retained = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
        expect(requests).toBe(savedRequestsAtEdit);
        expect(retained.pending_action_revision).toEqual(pendingEdit.pending_action_revision);
        expect(retained.action).toEqual(pendingEdit.action);
        expect(retained.generation_recovery).toEqual(pendingEdit.generation_recovery);
        expect(retained.generation_recovery.operations.some((op: any) => op.state === "partial")).toBe(true);
        expect(await loadActiveActionRuleAuthority(root)).toEqual(active);
        expect(editSaveDeclined).toBe(false);
        return;
      }
      expect(editSaveDeclined).toBe(true);
      expect(await listActionRuleAuthorityDrafts(root)).toEqual([]);
      expect((await loadActiveActionRuleAuthority(root)).activation.digest).toBe(active.activation.digest);
      const declinedEdit = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
      expect(declinedEdit.action.intents).toEqual(intents); expect(declinedEdit.pending_action_revision.instruction).toBe(editRequest);
      expect(declinedEdit.pending_action_revision.checkpoint).toBeDefined();
      await fs.writeFile(path.join(evidence, "declined-edit-save.json"), JSON.stringify(declinedEdit, null, 2));
      stage = "edit_after_decline";
      expect(await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options)).toBe(0);
      const [edited] = await listActionRuleAuthorityDrafts(root);
      expect(edited!.authority.rules).toHaveLength(count);
      expect(edited!.authority.rules.find(entry => entry.rule.outcome === `workshop.adjust_card_${editIndex}`)!.rule.ttl_seconds).toBe(240);
      expect((await loadActiveActionRuleAuthority(root)).authority.rules.find(entry => entry.rule.outcome === `workshop.adjust_card_${editIndex}`)!.rule.ttl_seconds).toBe(300);
      await fs.writeFile(path.join(evidence, "late37-disabled.json"), JSON.stringify(edited, null, 2));
      stage = "edit_publish_resume";
      expect(await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options)).toBe(0);
      const changed = await loadActiveActionRuleAuthority(root);
      expect(changed.authority.rules).toHaveLength(count);
      expect(changed.authority.rules.find(entry => entry.rule.outcome === `workshop.adjust_card_${editIndex}`)!.rule.ttl_seconds).toBe(240);
      for (const entry of changed.authority.rules.filter(entry => entry.rule.outcome !== `workshop.adjust_card_${editIndex}`))
        expect(entry.rule).toEqual(active.authority.rules.find(before => before.rule.outcome === entry.rule.outcome)!.rule);
      if (count === 50) {
      stage = "remove_request"; answers = [removeRequest];
      expect(await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options)).toBe(0);
      const [removed] = await listActionRuleAuthorityDrafts(root);
      expect(removed!.authority.rules).toHaveLength(49); expect((await loadActiveActionRuleAuthority(root)).authority.rules).toHaveLength(50);
      stage = "remove_review";
      expect(await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options)).toBe(0);
      stage = "remove_resume";
      expect(await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options)).toBe(0);
      const retained = await loadActiveActionRuleAuthority(root);
      expect(retained.authority.rules).toHaveLength(49); expect(retained.authority.rules.some(entry => entry.rule.outcome === "workshop.adjust_card_50")).toBe(false);
      for (const entry of retained.authority.rules) expect(entry.rule).toEqual(changed.authority.rules.find(before => before.rule.outcome === entry.rule.outcome)!.rule);
      await fs.writeFile(path.join(evidence, "maintenance-result.json"), JSON.stringify({ edited: changed.activation.digest, removed: retained.activation.digest, activeOutcomes: retained.authority.rules.map(entry => entry.rule.outcome), providerCalls: 0 }, null, 2));
      }
    }
  } finally {
    stdout.mockRestore(); fetch.mockRestore();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousUrl === undefined) delete process.env.OWNED_CONVERSATIONAL_READ_URL; else process.env.OWNED_CONVERSATIONAL_READ_URL = previousUrl;
    await fs.writeFile(path.join(evidence, "transcript.txt"), transcript);
    await fs.writeFile(path.join(evidence, "decisions.json"), JSON.stringify(decisions, null, 2));
    await fs.writeFile(path.join(evidence, "encoded-requests.jsonl"), bodies.map(record => JSON.stringify(record)).join("\n"));
    await fs.writeFile(path.join(evidence, "actual-loopback-requests.jsonl"), wireRecords.map(record => JSON.stringify(record)).join("\n"));
    await fs.writeFile(path.join(evidence, "actual-encoder-profiles.json"), JSON.stringify(profiles, null, 2));
  }
 }

it(`runs the public DERIVED ${count}-Action route with complete native refusal and reprepare`, () => runPublicConversational(), 120000);
if (!process.env.OWNED_CONVERSATIONAL_AGENDA_CONTROL && !existingProject) {
  if(count===13)it("delivers a declared input-bound correction through public save, whole review and restart",()=>runPublicConversational(undefined,true),120000);
  if(count===13)it("reopened saved Source review interprets known input facts without technical registration",()=>runPublicConversational(undefined,true,undefined,true),120000);
  if(count===13)it("ordinary top-level saved Review interprets a changed Source without technical registration",()=>runPublicConversational(undefined,true,undefined,true,true),120000);
  it.each(["no", "escape", "source_drift"] as const)("keeps the real program entry unmutated on %s", control => runPublicConversational(control), 30000);
}

if (!existingProject && !process.env.OWNED_CONVERSATIONAL_AGENDA_CONTROL) {
  it("retains the original in-generation edit cancellation and refuses blind restarted generation", () => runPublicConversational(undefined, false, "edit_cancel"), 120000);
  if (count === 50) it("retains the original midpoint cancellation and refuses blind restarted generation", () => runPublicConversational(undefined, false, "midpoint_cancel"), 120000);
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { onboard, start } from "./guided-start.js";
import { boundaryAssistCommand, boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import { READ_WORKLOAD_SET_VERSION } from "./read-workload-assist.js";
import { saveInstantBoundaryReviewBaseline } from "./boundary-review-persistence.js";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation } from "./action-rule-authority.js";
import { actionRuleModelDraftFromAuthority } from "./action-rule-draft.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { activePolicySource, loadPolicySources, policyTextSnapshot, savePolicySources } from "./authoring-policy-source.js";
import * as mutation from "./project-authority-mutation.js";
import { nativeAuthoringRefusal } from "./test-fixtures/native-authoring-refusal.js";
import { ownedProgramDraft, ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";

/** Implementer DERIVED two-Action public integration fixture. Source meaning is
 * this explicit synthetic operator text, never inferred by a substitute assessor.
 * Only terminal IO and local responses are simulated. The original complete
 * report/episode, nomination, decoder, checkpoint, compiler and CAS run normally.
 * This is not full50 fidelity, provider evidence, activation or source execution. */
type Control = "repair" | "pause_restart" | "source_drift" | "competing_resume" | "outside_scope" | "outside_scope_same_source";
const strings = (value: any): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
function jsonLine(text: string, prefix: string): any {
  const line = text.split("\n").find(line => line.startsWith(prefix));
  return line ? JSON.parse(line.slice(prefix.length)) : undefined;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function publicSourceRepair(control: Control) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `owned-public-source-repair-${control}-`));
  const resumeFile = path.join(root, ".synapsor/boundary-authoring/resume.json");
  const intents = [1, 2].map(index => `Action ${index}: studio.pack_parcel_${index} records caller-supplied units from 1 to 10 for an available parcel; unavailable parcels are refused. It proposes only and requires one human parcel_reviewer.`);
  const lines = [
    "Derived two-Action parcel program.",
    "Action 1 eligibility: available must be true. Unavailable parcels are refused; do not also require available to be false.",
    "Action 2 remains a separately requested unfinished change: " + intents[1],
    "The assistant may read parcel labels and units. studio.parcels is the parcel register; studio.parcels.label is the public parcel name; studio.parcels.units is the unit count.",
    "Every retained Action accepts units from 1 to 10, changes only units and Runner's maintained counter, proposes only, and requires one human parcel_reviewer.",
    "Synthetic source-owner operating fact: every studio.parcels writer increments integer version on each update. This is an operator assertion, not observed enforcement.",
    "The available eligibility fact stays private to Runner verification; it is not returned to the assistant.",
  ];
  const sourceFile = path.join(root, "derived-parcel-rules.txt");
  await fs.writeFile(sourceFile, lines.join("\n"));
  const job = "Prepare both selected studio.pack_parcel_1 and studio.pack_parcel_2 Actions in the attached rules. Preserve the full requested agenda. Read parcel labels and units. studio.parcels is the parcel register; studio.parcels.label is the public parcel name; studio.parcels.units is the unit count.";
  const repairInstruction = "Revise only the current disabled studio.pack_parcel_1 eligibility rule to follow attached Source line 2: retain available=true and remove the contradictory available=false condition. Preserve Read unchanged, every other Action declaration, and the separate unfinished studio.pack_parcel_2 request in the complete agenda. Do not activate or execute anything.";
  const outsideScopeAnswer = "Keep the original TTL unchanged and correct only the exact nominated eligibility condition.";
  let stage: "initial" | "review" | "repair" | "restart" = "initial", transcript = "", requests = 0, repairRequests = 0;
  let initialActionPhase = 0, repairActionPhase = 0, resolved = false, injected = false;
  let versionAnswerPending: { question_id: string; revision: number } | undefined, counterDetailsRequested = false, businessDetailsRequested = false, businessConfirmations = 0;
  const versionQuestion = "Do all your applications advance the parcel change counter every time they change a parcel?";
  let sourceId: string | undefined, competingSaved: any;
  const responses: any[] = [], menus: any[] = [], reports: any[] = [];
  let interrupt: (() => void) | undefined;
  const answers: Array<string | undefined> = [`/attach ${sourceFile}`, job];
  const fail = (message: string): never => { throw new Error(`${message}\n${transcript.slice(-10000)}`); };
  const write = (text: string) => { transcript += text; };
  const inspection = async () => ownedProgramInspection();
  const parentDraft = () => {
    const draft = ownedProgramDraft(1);
    draft.require = { kind: "all", expressions: [draft.require, { kind: "compare", operator: "eq",
      left: { kind: "field", binding: "parcel", field: "available" },
      right: { kind: "literal", value: false, value_type: { kind: "boolean" } } }] };
    return draft;
  };
  const correctedDraft = () => {
    const draft = ownedProgramDraft(1);
    draft.require = { kind: "all", expressions: [draft.require] };
    return draft;
  };
  const io: any = {
    write, writeChunk: write, columns: () => 110, isTerminal: () => false, setStatus: () => {}, clearStatus: () => {}, close: () => {},
    onInterrupt: (handler: () => void) => { interrupt = handler; return () => { interrupt = undefined; }; },
    review: async (title: string, content: string[]) => { write(`\n${title}\n${content.join("\n")}\n`); },
    read: async () => {
      if (versionAnswerPending) {
        const saved = JSON.parse(await fs.readFile(resumeFile, "utf8"));
        const question = saved.operator_questions.find((q: any) => q.id === versionAnswerPending!.question_id);
        expect(question).toMatchObject({ revision: versionAnswerPending.revision, kind: "writer_maintenance",
          presentation: { text: versionQuestion }, target: { resource: "studio.parcels", field: "version" } });
        expect(question.raw_answer).toBeUndefined();
        expect(saved.owner_handoffs.find((h: any) => h.id === question.handoff_id)?.state).toBe("waiting");
        versionAnswerPending = undefined;
        return lines[5];
      }
      const answer = answers.shift(); if (answer === undefined) interrupt?.(); return answer;
    },
    readConversation: async () => io.read(),
    choose: async (choice: any) => {
      const values = choice.options.map((entry: any) => entry.value);
      let selected: string | undefined;
      if (choice.title === "START BOUNDARY DRAFTING") selected = stage === "initial" ? "program"
        : stage === "review" ? "review_rules" : stage === "repair" ? "model" : "resume";
      else if (choice.title === "SAVED BUSINESS STATEMENT" && control === "outside_scope") {
        expect(stage).toBe("restart"); expect(choice.initialValue).toBe("keep");
        const saved = JSON.parse(await fs.readFile(resumeFile, "utf8")), question = saved.operator_questions.at(-1);
        expect(question.kind).toBe("attributed_meaning"); expect(question.raw_answer).toBeUndefined();
        expect(saved.owner_handoffs.find((h: any) => h.id === question.handoff_id)).toMatchObject({ state: "waiting", question: question.presentation.text });
        selected = "review";
      }
      else if (choice.title === "CLIENT FOR THIS JOB") selected = "later";
      else if (choice.title === "SEND ATTACHED RULES") { expect(choice.initialValue).toBe("cancel"); selected = "send"; }
      else if (choice.title === "USE THE SAVED ATTACHMENT") selected = "continue";
      else if (choice.message === "Use this complete intended Action inventory?") {
        expect(choice.initialValue).toBe("no"); selected = "yes";
        expect(transcript).toContain("studio.pack_parcel_1"); expect(transcript).toContain("studio.pack_parcel_2");
      } else if (choice.message === "REVIEW CHANGED-RECORD PROTECTION") {
        expect(choice.initialValue).toBe("pending"); expect(transcript).toContain("studio.parcels.version"); selected = "confirm";
      } else if (choice.message === "Record this planned counter maintenance for the current setup?") {
        expect(choice.initialValue).toBe("no");
        const shown = transcript.replace(/\s+/gu, " ");
        expect(shown).toContain(lines[5]);
        expect(shown).toContain("Implementation remains unverified.");
        expect(shown).toContain("It grants no Read or execution permission and changes no business rule.");
        expect(values).toContain("__view_runner_details__");
        if (!counterDetailsRequested) { expect(shown).not.toContain("Counter: studio.parcels.version."); counterDetailsRequested = true; selected = "__view_runner_details__"; }
        else { expect(shown).toContain("Counter: studio.parcels.version."); selected = "yes"; }
      } else if (choice.message === "Record this exact statement for the current question?") {
        expect(control).toBe("outside_scope"); expect(stage).toBe("restart"); expect(choice.initialValue).toBe("no");
        const saved = JSON.parse(await fs.readFile(resumeFile, "utf8")), question = saved.operator_questions.at(-1);
        expect(question).toMatchObject({ kind: "attributed_meaning", raw_answer: { text: outsideScopeAnswer }, proposal: { value: { kind: "attributed_meaning" } } });
        expect(question.confirmation).toBeUndefined();
        expect(saved.owner_handoffs.find((h: any) => h.id === question.handoff_id)).toMatchObject({ state: "waiting", question: question.presentation.text });
        expect(values).toContain("__view_runner_details__");
        expect(transcript.replace(/\s+/gu, " ")).toContain(outsideScopeAnswer);
        if (!businessDetailsRequested) { businessDetailsRequested = true; selected = "__view_runner_details__"; }
        else { expect(transcript).toContain("EXACT BUSINESS STATEMENT"); businessConfirmations++; selected = "yes"; }
      } else if (choice.title === "REVIEW DECLARED TEXT INPUT BOUNDS") selected = "none";
      else if (choice.message === "Save this exact attributed input-policy interpretation?") { expect(choice.initialValue).toBe("no"); selected = "yes"; }
      else if (choice.message === "Run a new bounded model review?") { expect(choice.initialValue).toBe("no"); selected = "yes"; }
      else if (choice.title === "CLIENT INTEGRATION RESPONSIBILITIES") {
        expect(choice.initialValue).toBe("back"); expect(choice.message).toContain("remain unverified"); selected = "assign";
      }
      else if (choice.title === "FINISH ATTACHED RULES REVIEW") { selected = !resolved && stage !== "restart" ? "resolve" : "pause"; resolved = true; }
      else if (choice.title === "RECHECK SAVED REPAIR") selected = "continue_edit";
      else if (choice.title === "SETUP NEEDS ATTENTION" || values.includes("pause") && !values.includes("yes")) selected = "pause";
      else if (values.includes("yes") && /Send this Boundary-authoring conversation|Allow the assistant to send|reviewed structural context|Allow the assistant to read|Allow the reviewed change requests/.test(choice.message)) {
        expect(choice.initialValue).toBe("no"); selected = "yes";
      } else if (values.includes("activate")) selected = values.includes("finish") ? "finish" : values.includes("back") ? "back" : undefined;
      else if (choice.message === "Save this exact disabled Action edit?") selected = "yes";
      menus.push({ stage, ...choice, values, selected });
      if (!selected || !values.includes(selected)) { interrupt?.(); return undefined; }
      return selected;
    },
  };
  const requestJson = async (request: any) => {
    if (++requests > 80) fail("Finite derived response bound exceeded.");
    const body = request.body, text = strings(body).join("\n");
    const names = (body.tools ?? []).map((tool: any) => tool.name ?? tool.function?.name);
    const scopeRefusals = (body.input ?? []).filter((item: any) => item.type === "function_call_output"
      && typeof item.output === "string" && item.output.includes("ACTION_WORK_UNIT_CORRECTION_OUTSIDE_SCOPE"));
    responses.push({ stage, names, bytes: Buffer.byteLength(JSON.stringify(body)),
      outside_scope_feedback: scopeRefusals.length > 0, scope_refusals: scopeRefusals });
    let name: string | undefined, args: any, answer: string | undefined;
    if (names.includes("runner__plan_boundary_job")) {
      expect(["initial", "repair"]).toContain(stage); name = "runner__plan_boundary_job";
      args = stage === "initial" ? { status: "planned", read_mode: "reuse",
        action_mode: "create", action_strategy: "rule_derived", action_intent: intents[0], action_intents: intents,
        action_outcomes: ["studio.pack_parcel_1", "studio.pack_parcel_2"], summary: "Prepare the exact two-Action derived program." }
        : { status: "planned", read_mode: "reuse", action_mode: "revise", action_strategy: "rule_derived",
          action_outcome: "studio.pack_parcel_1", action_intent: repairInstruction,
          summary: "Prepare one disabled eligibility edit; preserve Read and the full unfinished agenda." };
    } else if (names.includes("runner__propose_operator_decision")) {
      const question = jsonLine(text, "Current question: ");
      expect(question.target.outcomes).toEqual(["studio.pack_parcel_1", "studio.pack_parcel_2"]);
      name = "runner__propose_operator_decision";
      if (question.kind === "input_bounds") {
        // Same numeric units policy: there is no string-length duty.
        expect(question.source_binding).toBeDefined();
        expect(question.source_reference).toBe(canonicalJsonDigest(question.source_binding));
        for (const line of lines) expect(text).toContain(line);
        args = { question_id: question.question_id, revision: question.revision,
          source_reference: question.source_reference, status: "proposal", disposition: "proposed",
          value: { kind: "input_bounds", requirements: [] } };
      } else {
        expect(question.kind).toBe("writer_maintenance");
        expect(question.target).toMatchObject({ phase: "changed_record_protection", resource: "studio.parcels", field: "version" });
        expect(question.evidence).toEqual([{ id: "version-structure", digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }]);
        if (question.answer_id === undefined) {
          expect(question.raw_answer).toBeUndefined();
          versionAnswerPending = { question_id: question.question_id, revision: question.revision };
          args = { question_id: question.question_id, revision: question.revision, status: "needs_information", question: versionQuestion };
        } else {
          expect(question.raw_answer).toBe(lines[5]); expect(question.answer_id).toEqual(expect.any(String));
          args = { question_id: question.question_id, revision: question.revision, answer_id: question.answer_id,
            status: "proposal", disposition: "proposed", value: { kind: "writer_maintenance", maintenance: "all_writers_increment" } };
        }
      }
    } else if (names.includes("runner__submit_read_workloads")) {
      name = "runner__submit_read_workloads";
      args = { allowed: [{ id: "parcel_labels_units", description: "Read parcel labels and units.", plan: { kind: "rows", resource: "studio.parcels", select: ["label", "units"] } }], forbidden: [],
        operator_meanings: [{ resource: "studio.parcels", operator_quote: "studio.parcels is the parcel register" },
          { resource: "studio.parcels", field: "label", operator_quote: "studio.parcels.label is the public parcel name" },
          { resource: "studio.parcels", field: "units", operator_quote: "studio.parcels.units is the unit count" }] };
    } else if (names.includes("runner__submit_action_rule_draft")) {
      for (const line of lines) expect(text).toContain(line);
      const intent = jsonLine(text, "Current action intent: ");
      if (stage === "initial" && String(intent).includes("Action 2:")) return nativeAuthoringRefusal(request);
      if (stage !== "initial") {
        repairRequests++;
        expect(text).toContain("correction_nomination");
        if (control === "outside_scope_same_source" && scopeRefusals.length) return nativeAuthoringRefusal(request);
        if (control === "pause_restart" || control === "outside_scope" && scopeRefusals.length) answer = "Should I repair only the exact nominated eligibility condition?";
      }
      if (!answer) {
        const draft = stage === "initial" ? parentDraft() : correctedDraft();
        const outside = control === "outside_scope" || control === "outside_scope_same_source";
        if (stage !== "initial" && outside) draft.ttl_seconds = 301;
        const { schema_version: _version, verification, effect, approval, ...rule } = draft;
        const phases: Array<[string, any]> = stage === "initial" ? [
          ["runner__review_version_field", { resource: "studio.parcels", field: "version" }],
          ["runner__submit_verification_boundary_draft", { status: "draft", ...verification, changed_fields: [] }],
          ["runner__submit_effect_envelope_draft", { status: "draft", ...effect, changed_fields: [] }],
          ["runner__submit_action_rule_draft", { status: "draft", ...rule, changed_fields: [] }],
          ["runner__submit_approval_policy_draft", { status: "draft", ...approval, changed_fields: [] }], ["runner__validate_action_draft", {}],
        ] : [["runner__submit_action_rule_draft", { status: "draft", ...rule,
          changed_fields: outside ? ["require", "ttl_seconds"] : ["require"] }], ["runner__validate_action_draft", {}]];
        const next = stage === "initial" ? initialActionPhase++ : repairActionPhase++;
        const index = stage !== "initial" && outside
          ? names.includes("runner__validate_action_draft") ? next % 2 : 0 : next;
        if (index < phases.length) [name, args] = phases[index]!;
        else answer = "The structured disabled proposal is prepared; complete current Source review remains required.";
      }
    } else if (names.includes("runner__review_policy_coverage")) {
      name = "runner__review_policy_coverage";
      const draft = jsonLine(text, "Current draft (JSON pointer root): ");
      const references = jsonLine(text, "Exact coverage references (select, do not invent paths): ");
      const captured = { stage, draft_digest: canonicalJsonDigest(draft), draft, references, conflict: false, passages: [] as any[] };
      reports.push(captured);
      expect(draft.actions).toHaveLength(1); expect(draft.actions[0].outcome).toBe("studio.pack_parcel_1");
      const evidence = draft.runner_evidence.actions["studio.pack_parcel_1"];
      expect(evidence.scoped_bindings.parcel.fields.available).toMatchObject({ model_visible: false,
        actual_values_returned: false, private_action_verification: true, model_analysis: [] });
      expect(evidence.effect.source_counter_maintenance).not.toBeNull();
      const conflict = draft.actions[0].require.kind === "all" && draft.actions[0].require.expressions.length === 2;
      captured.conflict = conflict;
      const falseIndex = conflict ? draft.actions[0].require.expressions.findIndex((expression: any) => expression.kind === "compare"
        && expression.left.kind === "field" && expression.left.field === "available" && expression.right.kind === "literal" && expression.right.value === false) : -1;
      if (conflict) expect(falseIndex).toBeGreaterThanOrEqual(0);
      const nomination = conflict ? `/actions/0/require/expressions/${falseIndex}` : "/actions/0/require";
      // The exact current child must be published through BOTH the encoded
      // finite tool schema and ordinary reference inventory. No root fallback.
      const definition = body.tools.find((tool: any) => (tool.name ?? tool.function?.name) === name);
      const schema = definition.parameters ?? definition.function?.parameters;
      expect(schema.properties.passages.items.properties.draft_paths.items.enum).toContain(nomination);
      expect(references).toContain(nomination);
      const passages = [
        { start: 1, end: 1, disposition: "background", interpretation: "Derived program heading.", draft_paths: [] },
        { start: 2, end: 2, disposition: conflict ? "conflict" : "implemented", interpretation: conflict
          ? "The interpreted eligibility clause conflicts with the additional available=false condition."
          : "The exact interpreted current eligibility condition is represented.", responsibility: "runner", issue_kind: conflict ? "contradiction" : "coverage_link",
          draft_paths: [nomination] },
        { start: 3, end: 3, disposition: "needs_decision", interpretation: "The distinct requested Action 2 remains unfinished; this report does not implement it.", draft_paths: [] },
        { start: 4, end: 4, disposition: "implemented", interpretation: "The reviewed Read exposes labels and units only.", draft_paths: ["/read"] },
        { start: 5, end: 5, disposition: "implemented", interpretation: "The current prepared Action preserves bounded units, proposal-only effect and one human reviewer.", draft_paths: ["/actions/0/inputs", "/actions/0/effect", "/actions/0/approval"] },
        { start: 6, end: 6, disposition: "implemented", interpretation: "The exact synthetic owner counter commitment is recorded; no live enforcement is attested.", draft_paths: ["/runner_evidence/actions/studio.pack_parcel_1/effect/source_counter_maintenance"] },
        { start: 7, end: 7, disposition: "implemented", interpretation: "The current eligibility fact remains private across Read and Action use.", draft_paths: ["/runner_evidence/actions/studio.pack_parcel_1/scoped_bindings/parcel/fields/available"],
          field_checks: [{ resource: "studio.parcels", field: "available", expectation: "private" }] },
      ];
      for (const passage of passages) for (const pointer of passage.draft_paths) expect(references).toContain(pointer);
      captured.passages = passages; args = { passages };
    } else if (!names.length) answer = jsonLine(text, "Exact next question: ") ?? "The exact saved derived record remains pending independent operator review.";
    else fail(`Unexpected actual emitted tool surface: ${names.join(", ")}`);
    if (name) expect(names).toContain(name);
    return { status: 200, body: { output: name ? [{ type: "function_call", call_id: `derived-source-repair-${requests}`, name, arguments: JSON.stringify(args) }]
      : [{ type: "message", content: [{ type: "output_text", text: answer }] }] } };
  };
  const outer: any = { chooseResource: async () => fail("No manual resource bypass"), editFieldTiers: async () => fail("No manual field bypass"),
    chooseOption: async (title: string, choices: any[], context: any) => {
      menus.push({ stage, title, options: choices, ...context, selected: "pause", surface: "outer" });
      expect(title).toBe("SETUP NEEDS ATTENTION"); expect(choices.some(c => c.value === "pause")).toBe(true); return "pause";
    },
    promptText: async () => undefined, confirm: async () => fail("No outer confirmation bypass") };
  const options: any = { startWithAgentJob: true, exitAfterAgentJob: true,
    onAuthoringResult: (notice: any) => write(`\n${notice.title}\n${(notice.lines ?? []).join("\n")}\n`),
    modelAuthoringSession: { provider: "openai", model: "derived-source-repair-offline", apiKey: "owned-offline-fixture", dependencies: { requestJson } },
    actionProjectInspector: inspection, boundaryAuthoringChatFactory: (selection: any) => createBoundaryAuthoringChat({ ...selection, io, color: false, streamLineDelayMs: 0 }) };
  vi.stubEnv("OWNED_SOURCE_REPAIR_READ_URL", "postgresql://fixture.invalid/never-opened");
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => fail("External network forbidden"));
  const readResume = async () => JSON.parse(await fs.readFile(resumeFile, "utf8"));
  const originalMutation = mutation.withProjectAuthorityMutation;
  try {
    await onboard(["db", "--project-root", root, "--from-env", "OWNED_SOURCE_REPAIR_READ_URL", "--schema", "studio", "--json"],
      { interactive: false, schemaInspector: inspection });
    const workload = path.join(root, "derived-exact-read.json");
    await fs.writeFile(workload, JSON.stringify({ schema_version: READ_WORKLOAD_SET_VERSION, name: "derived_private_availability",
      allowed: [{ id: "parcel_labels_units", description: "Read parcel labels and unit counts.",
        plan: { kind: "rows", resource: "studio.parcels", select: ["label", "units"] } }],
      forbidden: [{ id: "private_available", description: "Never return the private availability fact to the assistant.",
        plan: { kind: "rows", resource: "studio.parcels", select: ["available"] } }], source: { kind: "operator_exact_plan" } }));
    stdout.mockClear();
    await expect(boundaryAssistCommand(["--project-root", root, "--workload", workload, "--actor", "derived-local-operator",
      "--reason", "Keep availability private while reading labels and units.", "--json"], inspection)).resolves.toBe(0);
    const preview = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""));
    expect(preview.preview.authority_activated).toBe(false);
    await expect(boundaryAssistCommand(["--project-root", root, "--analysis", preview.workload.analysis_id, "--actor", "derived-local-operator",
      "--reason", "Keep availability private while reading labels and units.", "--apply", "--confirm", `APPLY WORKLOAD ${preview.preview.decision_digest}`, "--json"], inspection)).resolves.toBe(0);
    const reviewed = await loadBoundaryReviewContext(root);
    await saveInstantBoundaryReviewBaseline({ projectRoot: root, draft: reviewed.draft, candidate: reviewed.candidate,
      actor: "derived-local-operator", expectedAuthoring: reviewed.bundle.mutation_bindings.authoring });
    await start(["--project-root", root, "--from-env", "OWNED_SOURCE_REPAIR_READ_URL", "--schema", "studio", "--cli"], {
      interactive: true, schemaInspector: inspection, runBoundaryReview: (args, inspect) => boundaryReviewCommand(args, inspect, outer, undefined, options) });
    const before = await readResume(); sourceId = before.policy_source_session;
    const [authorityBefore] = await listActionRuleAuthorityDrafts(root);
    expect(authorityBefore, transcript).toBeDefined();
    expect(authorityBefore!.authority.rules.map(rule => rule.rule.outcome)).toEqual(["studio.pack_parcel_1"]);
    expect(before.action.intended_outcomes).toEqual(["studio.pack_parcel_1", "studio.pack_parcel_2"]);
    expect(before.action.completed_outcomes).toEqual(["studio.pack_parcel_1"]);
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    const agendaBefore = { intents: before.action.intents, intended_outcomes: before.action.intended_outcomes, completed_outcomes: before.action.completed_outcomes };
    const readBefore = (await loadBoundaryReviewContext(root)).bundle.candidate_digest;
    const activeBefore = await fs.readFile(path.join(root, ".synapsor/exploration-boundary.active.json")).catch(() => undefined);
    // Inject a legitimate competing writer only AFTER the complete fresh report
    // is on disk, and BEFORE the next coordinated writer acquires its scope.
    // The original mutex, Source/resume APIs and guards still run unchanged.
    if (control === "source_drift" || control === "competing_resume") vi.spyOn(mutation, "withProjectAuthorityMutation").mockImplementation(async (projectRoot: string, operation: any, config?: any) => {
      if (!config?.permit && !injected && stage !== "initial" && sourceId) {
        const saved = await loadPolicySources(root, sourceId);
        if (saved.coverage?.passages.some(p => p.start === 2 && p.disposition === "implemented") && reports.some(report => !report.conflict)) {
          injected = true;
          await originalMutation(root, async permit => {
            if (control === "source_drift") {
              const changed = structuredClone(saved), source = activePolicySource(saved)!;
              const next = policyTextSnapshot(Buffer.from(source.text + "\nA competing new restriction needs review."), source.name, source.version + 1);
              changed.snapshots.push(next); changed.active = next.version;
              await savePolicySources(root, changed, { expectedDigest: canonicalJsonDigest(saved), permit }); competingSaved = changed;
            } else {
              const current = await readResume();
              const changed = buildBoundaryAuthoringResumeState({ previous: current, binding: current.binding, stage: current.stage,
                jobIntent: current.job_intent, provider: current.model.provider, model: current.model.name, policySourceSession: current.policy_source_session,
                read: current.read, action: current.action, pendingActionRevision: current.pending_action_revision,
                pendingReadRevision: "A separate current operator requested another exact Read review." });
              await writeBoundaryAuthoringResumeState(root, changed, { expectedRevisionDigest: current.revision_digest, permit }); competingSaved = changed;
            }
          });
        }
      }
      return originalMutation(projectRoot, operation, config);
    });
    // This public command performs Source review only. It cannot authorize or
    // silently trigger an Action edit. The next call uses the advertised change
    // route and exact operator request, then the normal planner/producer.
    stage = "review";
    await boundaryReviewCommand(["--project-root", root, "--access", "--job-first", "--review-rules"], inspection, outer, undefined, options);
    const reviewedSources = await loadPolicySources(root, sourceId!);
    const reviewedResume = await readResume();
    const oldOperations = new Set(before.generation_recovery.operations.map((operation: any) => operation.id));
    const consumedReview = reviewedResume.generation_recovery.operations.filter((operation: any) => !oldOperations.has(operation.id));
    // A real complete report is consumed even while current/future business
    // requirements remain pending. This is normal save acknowledgement only,
    // and must not fabricate business completion or acknowledge unknown output.
    expect(consumedReview, transcript).toHaveLength(1);
    expect(consumedReview[0]).toMatchObject({ state: "checkpointed", checkpoint_seen: true });
    expect(reviewedResume.pending_policy_review).toBeDefined();
    expect(reviewedSources.coverage!.passages.find(p => p.start === 2)!.disposition).toBe("conflict");
    expect(reviewedSources.coverage!.passages.find(p => p.start === 3)!.disposition).toBe("needs_decision");
    const originalEpisode = reviewedSources.coverage_episodes?.find(episode => episode.submissions.some(submission => {
      const raw = submission.tentative?.raw_response;
      return submission.validated && submission.completed_at && raw && typeof raw === "object" && "passages" in raw
        && Array.isArray(raw.passages) && raw.passages.some(passage => passage.start === 2 && passage.disposition === "conflict");
    }));
    expect(originalEpisode, transcript).toBeDefined();
    expect(originalEpisode!.context).toMatch(/^sha256:/); expect(originalEpisode!.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(repairRequests).toBe(0);
    expect((await listActionRuleAuthorityDrafts(root))[0]).toEqual(authorityBefore);
    stage = "repair"; answers.push(repairInstruction);
    await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options);
    let after = await readResume();
    const sources = await loadPolicySources(root, sourceId!);
    expect(repairRequests, transcript).toBeGreaterThan(0);
    const [authorityAfter] = await listActionRuleAuthorityDrafts(root);
    const assertOriginalNomination = (checkpoint: any, currentSources: typeof sources) => {
      const repair = checkpoint.source_repair, provenance = repair.coverage_provenance;
      const matches = currentSources.coverage_episodes!.filter(episode => episode.id === provenance.episode_id);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.context).toBe(provenance.context_key);
      const submission = matches[0]!.submissions.find(entry => entry.number === provenance.submission_number)!;
      expect(submission).toMatchObject({ validated: true, completed_at: expect.any(String) });
      const raw = submission.tentative!.raw_response as any;
      expect(raw.passages.find((passage: any) => passage.start === 2)).toMatchObject({ disposition: "conflict",
        draft_paths: repair.correction.editable_paths.map((pointer: string) => `/actions/0${pointer}`) });
      expect(reports.some(report => report.stage === "repair" && report.conflict
        && report.draft_digest === repair.prepared_draft_digest)).toBe(true);
      expect(canonicalJsonDigest(repair.original_parent)).toBe(repair.correction.parent_digest);
    };
    if (control === "repair") {
      expect(authorityAfter!.digest).not.toBe(authorityBefore!.digest);
      const review = authorityAfter!.reviews[0]!;
      const draft = actionRuleModelDraftFromAuthority({ authority: authorityAfter!.authority, outcome: review.outcome, review, preserveVerificationFields: true });
      expect(draft.require).toEqual(correctedDraft().require);
      expect(draft.effect).toEqual(parentDraft().effect); expect(draft.ttl_seconds).toBe(300);
      expect(sources.coverage!.passages.find(p => p.start === 2)!.disposition).toBe("implemented");
      expect(sources.coverage!.passages.find(p => p.start === 3)!.disposition).toBe("needs_decision");
      expect(reports.some(report => !report.conflict)).toBe(true);
    } else {
      expect(authorityAfter).toEqual(authorityBefore);
      if (control === "pause_restart") {
        const checkpoint = after.pending_action_revision.checkpoint;
        expect(checkpoint.source_repair.corrections_used).toBe(1);
        assertOriginalNomination(checkpoint, sources);
        expect(checkpoint.pending_question.completion).toBeDefined();
        const sent = repairRequests; stage = "restart"; resolved = false;
        await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options);
        after = await readResume();
        expect(repairRequests).toBe(sent);
        expect(after.pending_action_revision.checkpoint.source_repair).toEqual(checkpoint.source_repair);
      } else if (control === "outside_scope_same_source") {
        const first = after.pending_action_revision.checkpoint;
        expect(first.source_repair.corrections_used).toBe(1);
        assertOriginalNomination(first, sources);
        expect(first.pending_question).toBeUndefined();
        expect(responses.some(response => response.outside_scope_feedback)).toBe(true);
        expect(after.generation_recovery.operations.at(-1).state).toBe("refused");
        stage = "restart";
        const priorRequests = repairRequests;
        await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options);
        after = await readResume();
        expect(repairRequests).toBeGreaterThan(priorRequests);
        expect(after.pending_action_revision.checkpoint.source_repair.corrections_used).toBe(2);
        expect(after.pending_action_revision.checkpoint.source_repair.original_parent).toEqual(first.source_repair.original_parent);
        expect(after.generation_recovery.operations.at(-1).state).toBe("refused");
        expect((await listActionRuleAuthorityDrafts(root))[0]).toEqual(authorityBefore);
        expect(await loadPolicySources(root, sourceId!)).toEqual(sources);
        const sent = requests;
        await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options);
        after = await readResume();
        expect(requests).toBe(sent);
        expect(after.pending_action_revision.checkpoint.source_repair.corrections_used).toBe(2);
        expect(transcript).toContain("ACTION_SOURCE_REPAIR_EXHAUSTED");
      } else if (control === "outside_scope") {
        const first = after.pending_action_revision.checkpoint;
        expect(first.source_repair.corrections_used).toBe(1);
        assertOriginalNomination(first, sources);
        expect(responses.some(response => response.outside_scope_feedback)).toBe(true);
        // Tool attempts within one conversational invocation share its one
        // allowance. A real attributed answer reserves another invocation but
        // changes the Source answer history: the old nomination must then stop
        // on currentness, without resetting its existing reserved allowance.
        const answer = outsideScopeAnswer;
        stage = "restart"; answers.push(answer);
        await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options);
        after = await readResume();
        expect(businessConfirmations).toBe(1);
        expect(after.pending_action_revision.checkpoint.source_repair.corrections_used).toBe(2);
        expect(after.pending_action_revision.checkpoint.source_repair.original_parent).toEqual(first.source_repair.original_parent);
        expect((await listActionRuleAuthorityDrafts(root))[0]).toEqual(authorityBefore);
        const answeredSources = await loadPolicySources(root, sourceId!);
        expect(answeredSources.operator_messages).toContain(answer);
        expect(canonicalJsonDigest(answeredSources.operator_messages)).not.toBe(first.source_repair.correction.source_answer_history_digest);
        const consumed = repairRequests, sent = requests; answers.push(answer);
        await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], inspection, outer, undefined, options);
        after = await readResume();
        expect(repairRequests).toBe(consumed);
        expect(requests).toBe(sent);
        expect(after.pending_action_revision.checkpoint.source_repair.corrections_used).toBe(2);
        expect(transcript).toContain("ACTION_WORK_UNIT_SOURCE_CONTEXT_CHANGED");
      } else {
        expect(injected).toBe(true);
        if (control === "source_drift") expect(await loadPolicySources(root, sourceId!)).toEqual(competingSaved);
        else expect(after).toEqual(competingSaved);
      }
    }
    expect({ intents: after.action.intents, intended_outcomes: after.action.intended_outcomes, completed_outcomes: after.action.completed_outcomes }).toEqual(agendaBefore);
    expect((await loadBoundaryReviewContext(root)).bundle.candidate_digest).toBe(readBefore);
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    expect(await fs.readFile(path.join(root, ".synapsor/exploration-boundary.active.json")).catch(() => undefined)).toEqual(activeBefore);
    expect(authorityAfter!.authority.rules).toHaveLength(1);
    return { origin: "IMPLEMENTER_DERIVED_TWO_ACTION_PUBLIC_SOURCE_REPAIR", control, requests, repairRequests, reports,
      original_episode_id: originalEpisode!.id, original_episode_context: originalEpisode!.context, agenda: agendaBefore,
      authority_before: authorityBefore!.digest, authority_after: authorityAfter!.digest, activation: false, provider_calls: 0 };
  } finally {
    const evidenceRoot = process.env.OWNED_PUBLIC_SOURCE_REPAIR_EVIDENCE;
    if (evidenceRoot) {
      const persisted = await Promise.allSettled([
        readResume(), listActionRuleAuthorityDrafts(root),
        sourceId ? loadPolicySources(root, sourceId) : Promise.resolve(undefined),
      ]);
      await fs.mkdir(evidenceRoot, { recursive: true });
      await fs.writeFile(path.join(evidenceRoot, `${control}-${randomUUID()}.json`), JSON.stringify({
        origin: "IMPLEMENTER_DERIVED_TWO_ACTION_PUBLIC_SOURCE_REPAIR", control, transcript, menus, responses, reports, injected,
        // This is the owned synthetic fixture only, retained even on failure.
        // No production client ledger or protected credential is read.
        persisted: persisted.map((result, index) => ({ kind: ["resume", "disabled_actions", "sources"][index],
          ...(result.status === "fulfilled" ? { value: result.value } : { error: String(result.reason) }) })),
      }, null, 2));
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

it.each(["repair", "pause_restart", "source_drift", "competing_resume", "outside_scope", "outside_scope_same_source"] as const)(
  "public Source repair keeps the unfinished derived two-Action agenda and exact current provenance: %s", async control => {
    const result = await publicSourceRepair(control);
    expect(result.provider_calls).toBe(0);
  }, 30_000);

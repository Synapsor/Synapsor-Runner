import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { onboard, start } from "./guided-start.js";
import { boundaryAssistCommand, boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { saveInstantBoundaryReviewBaseline } from "./boundary-review-persistence.js";
import { listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation, loadActiveActionRuleAuthority } from "./action-rule-authority.js";
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { readSemanticSupervisedExecutionState } from "./semantic-action-deployment.js";
import { loadPolicySources, activePolicySource } from "./authoring-policy-source.js";
import { READ_WORKLOAD_SET_VERSION } from "./read-workload-assist.js";
import { secureAskJsonRequest } from "./model-ask.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { loadActionRuleFacts, evaluateActionRule } from "@synapsor-runner/action-rules";
import { bindPostgresActionRuleScope, createPostgresActionRuleFactLoader } from "@synapsor-runner/postgres";
import { Pool } from "pg";
import { readRuntimeConfig } from "./cli-project.js";
import { createProjectRuntimeStore } from "./control-policy-store.js";
import { createOptionalReadActionRuleRuntimeServices } from "./semantic-action-runtime.js";
import { createScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";
import { createDerivedFourShapePhysicalFixture } from "./test-fixtures/derived-four-shape-physical.js";

// IMPLEMENTER DERIVED component/public-route evidence. Real inspected compound FK,
// RLS and fresh synthetic data are explicit differences from the original025 Source.
// Local responses pass the actual encoder, loopback transport, decoder, compiler,
// persistence and Source review. No accepted report/authority/provenance is seeded.
const strings = (v: any): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings)
  : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
const jsonLine = (text: string, prefix: string): any => {
  const value = text.split("\n").find(line => line.startsWith(prefix));
  return value ? JSON.parse(value.slice(prefix.length)) : undefined;
};

it.skipIf(process.env.SYNAPSOR_TEST_DERIVED_FOUR_REAL_PG !== "1")("authors four DERIVED shapes through actual current compound-FK private admission and canonical Source review", async () => {
  const evidence = process.env.OWNED_DERIVED_FOUR_EVIDENCE ?? path.join(os.tmpdir(), `derived-four-${randomUUID()}`);
  const physical = await createDerivedFourShapePhysicalFixture({ evidenceRoot: evidence, schema: "derived_small", categories: 1 });
  const root = path.join(evidence, "project"); await fs.mkdir(root, { mode: 0o700 });
  const sourceLines = [
    "DERIVED supported-relationship four-shape program; never original-schema or paid-full50 qualification.",
    "EARLY: No Action may alter a blocked unit. Missing applicable private eligibility information remains unresolved for every later Action.",
    "The sole allocation has ONE tenant/principal automatic count ceiling3 and capability count ceiling2, rolling86400seconds; workunits never reset accounting. Otherwise-valid over-ceiling allocations require one distinct authorized large.manual human reviewer; hard constraints, blocked or missing private facts are never waived.",
    "All four selected outcomes must remain inventoried. Unfinished, failed or unassessed Source duties stay pending; partial work is not a complete program. No worker, Source write, reviewer-key enrollment, approval or business request.",
    "derived_small.units is the selected unit register. Only unit id/category/status/reason/allocated_count may be returned by Read. The selected unit is the only caller subject and effect target; eligibility is private supporting evidence, never another caller reference.",
    "derived_small.units.id is the selected unit identifier; derived_small.units.category is the unit category; derived_small.units.status is its state; derived_small.units.reason is the recorded reason; derived_small.units.allocated_count is its allocated count.",
    "1. derived_small.mark_ready_00: Set status ready and exact caller reason string1..64 only for an open nonblocked category0 unit; human classlarge.manual. The private allowed flag and capacity are irrelevant; applicable private eligibility must exist.",
    "2. derived_small.defer_item_00: Set status held and exact caller reason string1..64 only for an open nonblocked category0 unit; human classlarge.manual. The private allowed flag and capacity are irrelevant; applicable private eligibility must exist.",
    "3. derived_small.allocate_units_00: Caller units integer1..25; add exactunits to allocated_count only for nonblocked category0 with private allowed=true and resultingcount<=privatecapacity; policy classlarge.shared_allocation with the unchanged shared ceilings and human fallback.",
    "4. derived_small.release_units_00: Caller units integer1..25; subtractexactunits from allocated_count only for nonblocked category0 with count>=units and private allowed=true; human classlarge.manual.",
    "DERIVED technical facts: actual non-null immediate compound tenant/principal/id eligibility FK to units; eligibility is an inverse bounded collection. Positive version counters and physical increment triggers exist on both tables. The fixture backend owns derived.tenant/principal RLS settings. Every applicable private row is unique by its actual id primary key; absent or overflow facts remain unresolved. No summary effect or additional caller subject is requested.",
  ];
  const source = sourceLines.join("\n"), sourceFile = path.join(root, "derived-rules.txt"); await fs.writeFile(sourceFile, source);
  const outcomes = ["mark_ready_00", "defer_item_00", "allocate_units_00", "release_units_00"].map(name => `derived_small.${name}`);
  const intents = sourceLines.slice(6, 10);
  const job = "Prepare all four selected Actions in the attached DERIVED rules in order; retain every unfinished duty. Reuse the exact disabled unit Read. Only selected units are caller subjects/effect targets; eligibility stays private supporting evidence. The backend Source version trigger maintains every units.version and eligibility.version update; this is an owner assertion, not imported readiness. Do not activate, execute, approve, enroll reviewers or start a worker.";
  let transcript = "", stdout = "", requests = 0, stage = "setup", interruption: (() => void) | undefined;
  const menus: any[] = [], exchanges: any[] = [], reports: any[] = [], wire: any[] = [], notices: any[] = [], dependencyFailures: any[] = [];
  const phases = new Map<string, number>(); let privateReviewed = false, versionReviewed = false;
  let answers: Array<string | undefined> = [`/attach ${sourceFile}`, job, "1,2", "reason", "1..64", "7-8"];
  const write = (s: string) => { transcript += s; };
  const fail = (message: string): never => { throw new Error(`${message}\n${transcript.slice(-8000)}`); };
  const io: any = { write, writeChunk: write, columns: () => 110, isTerminal: () => false,
    onInterrupt: (f: () => void) => { interruption = f; return () => { interruption = undefined; }; },
    close: () => {}, setStatus: () => {}, clearStatus: () => {},
    review: async (title: string, lines: string[]) => write(`\n${title}\n${lines.join("\n")}\n`),
    read: async (prompt: string) => { const answer = answers.shift(); menus.push({ stage, prompt, answer, unresolved: answer === undefined });
      if (answer === undefined) interruption?.(); return answer; },
    readConversation: async (prompt: string) => io.read(prompt),
    choose: async (choice: any) => {
      const values = choice.options.map((o: any) => o.value); let selected: string | undefined;
      if (choice.title === "START BOUNDARY DRAFTING") selected = stage === "four-shape-create" ? "program" : "resume";
      else if (choice.title === "CLIENT FOR THIS JOB") selected = "later";
      else if (choice.title === "SEND ATTACHED RULES") selected = "send";
      else if (choice.title === "USE THE SAVED ATTACHMENT") selected = "continue";
      else if (choice.title === "PERMISSION REQUIRED" && choice.message === "REVIEW SUPPORTING SOURCE") selected = "allow";
      else if (choice.message === "Use this complete intended Action inventory?") selected = "yes";
      else if (choice.title === "REVIEW DECLARED TEXT INPUT BOUNDS") selected = "register";
      else if (choice.message === "Register another distinct input requirement?") selected = "no";
      else if (choice.message === "Save this exact attributed input-policy interpretation?") selected = "yes";
      else if (choice.message === "Record this counting interpretation for these exact rules?") selected = "yes";
      else if (choice.message === "REVIEW CHANGED-RECORD PROTECTION") selected = "confirm";
      else if (choice.title === "REVIEW COUNTED AUTOMATIC APPROVALS") {
        if (stage === "four-shape-create") { menus.push({ stage, ...choice, selected: undefined, declared_owner_review_pause: true }); interruption?.(); return undefined; }
        expect(choice.initialValue).toBe("unresolved");
        if (choice.message.includes("Configured allowance: 2; scope capability")) {
          selected = choice.options.find((o: any) => o.label === "Only automatic derived_small.allocate_units_00 approvals")?.value;
        } else { expect(choice.message).toContain("Configured allowance: 3; scope tenant_principal"); selected = "boundary"; }
      }
      else if (choice.title === "CLIENT INTEGRATION RESPONSIBILITIES") selected = "assign";
      else if (choice.message === "Run a new bounded model review?") selected = "yes";
      else if (choice.title === "FINISH ATTACHED RULES REVIEW" || choice.title === "SETUP NEEDS ATTENTION") selected = "pause";
      else if (values.includes("activate")) selected = stage.includes("publication") ? "activate" : values.includes("finish") ? "finish" : "back";
      else if (choice.title === "REVIEW CHANGE REQUESTS" || choice.message.startsWith("Activate verified Action Boundary")) selected = stage === "action-publication" ? "yes" : "no";
      else if (/Enable.*execution|Allow.*approved.*change|Allow.*source.*write|Enable.*worker/iu.test(choice.message)) selected = "no";
      else if (values.includes("yes") && /Send this Boundary-authoring conversation|Allow the assistant to send|reviewed structural context|Allow the assistant to read|Allow the reviewed change requests/.test(choice.message)) selected = "yes";
      menus.push({ stage, ...choice, selected });
      if (!selected || !values.includes(selected)) { interruption?.(); return undefined; } return selected;
    } };
  const deriveReply = async (request: any) => {
    const body = request.body, text = strings(body).join("\n"), names = (body.tools ?? []).map((t: any) => t.name ?? t.function?.name);
    if (++requests > 120) fail("Predeclared M1 120-response bound exceeded.");
    exchanges.push({ request: requests, stage, body }); let name: string | undefined, args: any, answer: string | undefined;
    if (names.includes("runner__plan_boundary_job")) {
      name = "runner__plan_boundary_job"; args = { status: "planned", read_mode: "reuse", action_mode: "create", action_strategy: "rule_derived",
        action_intent: intents[0], action_intents: intents, action_outcomes: outcomes, summary: "Four complete inventoried intents; each unfinished Source duty stays pending." };
    } else if (names.includes("runner__submit_action_rule_draft")) {
      const intent = jsonLine(text, "Current action intent: "); const index = intents.indexOf(intent); expect(index).toBeGreaterThanOrEqual(0);
      for (const line of sourceLines) expect(text).toContain(line);
      if (!privateReviewed) { privateReviewed = true; name = "runner__review_private_action_source"; args = { resource: "derived_small.eligibility", parent_resource: "derived_small.units" }; }
      else if (!versionReviewed) { versionReviewed = true; name = "runner__review_version_field"; args = { resource: "derived_small.units", field: "version" }; }
      else {
        // Normal preparation tools return the updated current catalog in their
        // actual function output; the conversation's initial catalog stays inert.
        const outputs = (body.input ?? []).filter((value: any) => value.type === "function_call_output")
          .map((value: any) => JSON.parse(value.output));
        const catalog = outputs.filter((value: any) => value.catalog).at(-1)?.catalog
          ?? jsonLine(text, "Current normalized structural catalog: ");
        const unit = catalog.resources.find((r: any) => r.name === "derived_small.units");
        const privateResource = catalog.resources.find((r: any) => r.name === "derived_small.eligibility"); expect(privateResource.verification_only).toBe(true);
        const relationship = catalog.relationships.find((r: any) => r.name === "eligibility_unit_scope_fk"); expect(relationship.field_pairs).toHaveLength(3);
        const type = (field: string) => { const value = unit.fields.find((f: any) => f.name === field)?.type; if (!value) fail(`Actual catalog lacks ${field}`); return value; };
        const field = (f: string, binding = "unit") => ({ kind: "field", binding, field: f });
        const literal = (value: any, f: string) => ({ kind: "literal", value, value_type: type(f) });
        const compare = (operator: string, left: any, right: any) => ({ kind: "compare", operator, left, right });
        const minimum = (f: string) => ({ kind: "aggregate", operation: "min", binding: "eligibility", field: f });
        const allowed = compare("gte", { kind: "aggregate", operation: "sum", binding: "eligibility", field: "version",
          where: compare("eq", field("allowed", "eligibility"), { kind: "literal", value: true, value_type: { kind: "boolean" } }) }, minimum("version"));
        const units = { kind: "input", name: "units" }, reason = { kind: "input", name: "reason" };
        const count = { kind: "math", operation: index === 2 ? "add" : "subtract", inputs: [field("allocated_count"), units] };
        const checks = [compare("eq", field("blocked"), literal(false, "blocked")), compare("eq", field("category"), literal(0, "category")),
          compare("gte", minimum("version"), { kind: "literal", value: 1, value_type: { kind: "integer" } })];
        if (index < 2) checks.push(compare("eq", field("status"), literal("open", "status")));
        else { checks.push(allowed); checks.push(index === 2 ? compare("lte", count, minimum("capacity")) : compare("gte", field("allocated_count"), units)); }
        const require = { kind: "all", expressions: checks };
        const draft: any = { name: outcomes[index], outcome: outcomes[index], inputs: [index < 2 ? { name: "reason", description: "Exact caller reason.", type: { kind: "string", min_length: 1, max_length: 64, comparison: "exact" } }
          : { name: "units", description: "Exact caller allocation/release count.", type: { kind: "integer" }, minimum: 1, maximum: 25 }],
          verification: { name: `${outcomes[index]}_verification`, resources: [
            { binding: "unit", resource: unit.name, source: { kind: "subject_ref" }, fields: ["status", "blocked", "category", "allocated_count"] },
            { binding: "eligibility", resource: privateResource.name, source: { kind: "relationship", from_binding: "unit", relationship: relationship.name, direction: "inverse" },
              fields: ["allowed", "capacity", "version"], max_rows: 1, overflow: "unsupported", collection_consistency: "complete_locked", deterministic_order: [{ field: "id", direction: "asc" }] } ] },
          effect: { name: `${outcomes[index]}_effect`, operation: "update", target_resource: unit.name, target_binding: "unit",
            allowed_fields: index < 2 ? [{ name: "status", values: [index === 0 ? "ready" : "held"] }, { name: "reason" }] : [{ name: "allocated_count", minimum: 0 }],
            set: index < 2 ? { status: literal(index === 0 ? "ready" : "held", "status"), reason } : { allocated_count: count }, writeback: "proposal_only" },
          require, derive: {}, ttl_seconds: 300,
          approval: { class_name: index === 2 ? "large.shared_allocation" : "large.manual", mode: index === 2 ? "policy" : "human",
            ...(index === 2 ? { auto_approve_when: require } : {}), required_role: "large.manual", required_approvals: 1,
            shared_limits: index === 2 ? [{ id: "allocation_joint", kind: "count", scope: "tenant_principal", maximum: 3, window_seconds: 86400 },
              { id: "allocation_capability", kind: "count", scope: "capability", capability: outcomes[index], maximum: 2, window_seconds: 86400 }] : [] },
          review: { when: intents[index], then: "Propose only the exact requested effect on the selected unit.", refused: ["Blocked or wrong category; missing/ambiguous private facts remain unknown; required hard guard false."],
            human_review: "One distinct authorized large.manual reviewer; otherwise-valid over-ceiling allocation uses normal human review. No override of hard limits.",
            examples: [{ kind: "eligible", scenario: "Complete same-scope permitted facts and bounded input.", result: "Exact proposal only." }, { kind: "ineligible", scenario: "Blocked unit.", result: "Refuse." }] } };
        const { verification, effect, approval, ...rule } = draft;
        const sequence: Array<[string, any]> = [ ["runner__submit_verification_boundary_draft", { status: "draft", ...verification, changed_fields: [] }],
          ["runner__submit_effect_envelope_draft", { status: "draft", ...effect, changed_fields: [] }], ["runner__submit_action_rule_draft", { status: "draft", ...rule, changed_fields: [] }],
          ["runner__submit_approval_policy_draft", { status: "draft", ...approval, changed_fields: [] }], ["runner__validate_action_draft", {}] ];
        // Finite wrong-but-decodable input representation then actual ordinary
        // compiler feedback correction. Business bounds/effects never change.
        if (index === 2) {
          const invalid = structuredClone(rule);
          invalid.inputs[0].type = { kind: "integer", minimum: 1, maximum: 25 };
          delete invalid.inputs[0].minimum; delete invalid.inputs[0].maximum;
          sequence[2] = ["runner__submit_action_rule_draft", { status: "draft", ...invalid, changed_fields: [] }];
          sequence.push(["runner__submit_action_rule_draft", { status: "draft", ...rule, changed_fields: ["inputs"] }], ["runner__validate_action_draft", {}]);
        }
        const n = phases.get(outcomes[index]!) ?? 0; phases.set(outcomes[index]!, n + 1);
        if (index === 2 && n === 5) {
          expect(outputs.at(-1)?.status).toBe("needs_repair");
          expect(outputs.at(-1)?.diagnostics).toContainEqual(expect.objectContaining({ code: "ACTION_RULE_INVALID", path: "rule.inputs" }));
        }
        if (n >= sequence.length) {
          const validated = outputs.at(-1);
          expect(validated?.status).toBe("ready_for_review"); expect(validated?.outcome).toBe(outcomes[index]);
          answer = "The exact structured disabled proposal is prepared; normal current Source review and separate operator publication remain required.";
        } else [name, args] = sequence[n]!;
      }
    } else if (names.includes("runner__review_policy_coverage")) {
      name = "runner__review_policy_coverage";
      const draft = jsonLine(text, "Current draft (JSON pointer root): "), references = jsonLine(text, "Exact coverage references (select, do not invent paths): ");
      reports.push({ draft, references });
      const paths = (part: string) => draft.actions.map((_: any, i: number) => `/actions/${i}/${part}`);
      args = { passages: sourceLines.map((line, i) => ({ start: i + 1, end: i + 1, disposition: i === 0 ? "background" : "implemented", interpretation: line,
        draft_paths: i === 0 ? [] : i === 1 ? paths("require") : i === 2 ? paths("approval") : i === 3 ? paths("effect")
          : i === 4 || i === 5 ? ["/read"] : i < 10 ? [`/actions/${draft.actions.findIndex((a: any) => a.outcome === outcomes[i - 6])}`]
          : draft.actions.map((a: any) => `/runner_evidence/actions/${a.outcome}/effect/source_counter_maintenance`) })) };
      expect(draft.actions.map((a: any) => a.outcome).sort()).toEqual([...outcomes].sort());
      const counters = Object.entries(draft.runner_evidence.actions).flatMap(([outcome, value]: [string, any]) =>
        (value.automatic_limits ?? []).map((limit: any, index: number) => ({
          path: `/runner_evidence/actions/${outcome}/automatic_limits/${index}/history_selector/capability`,
          current_capability: limit.history_selector.capability, required_capability: limit.scope === "capability" ? outcomes[2] : null,
        })));
      expect(counters).toHaveLength(2);
      args.passages.push({ start: 3, end: 3, disposition: "implemented", responsibility: "runner", interpretation: "Exact Source-bound operator counting review retains the automatic allocation domain and separate per-capability domain; human approvals remain excluded.",
        draft_paths: [...new Set(counters.map((counter: any) => counter.path.replace(/\/\d+\/history_selector\/capability$/u, "")))], counter_requirements: counters });
      for (const passage of args.passages) for (const pointer of passage.draft_paths) expect(references).toContain(pointer);
    } else if (!names.length) answer = jsonLine(text, "Exact next question: ") ?? "The exact current record needs its normal operator review; no execution is claimed.";
    else fail(`Unexpected actual tool surface: ${names.join(",")}`);
    if (name) expect(names).toContain(name);
    return { status: 200, body: { output: name ? [{ type: "function_call", call_id: `derived-four-${requests}`, name, arguments: JSON.stringify(args) }]
      : [{ type: "message", content: [{ type: "output_text", text: answer }] }] } };
  };
  let queued: any;
  const server = http.createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const encoded = Buffer.concat(chunks); const response = JSON.stringify(queued.body);
    wire.push({ stage, request: wire.length + 1, encoded_utf8: encoded.toString("utf8"), bytes: encoded.length, status: queued.status, response });
    outgoing.writeHead(queued.status, { "content-type": "application/json" }); outgoing.end(response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = new URL(`http://127.0.0.1:${(server.address() as any).port}/responses`);
  const requestJson = async (request: any) => {
    try { queued = await deriveReply(request); }
    catch (error: any) { dependencyFailures.push({ request: requests, stage, name: error.name, message: error.message, stack: error.stack }); throw error; }
    return secureAskJsonRequest({ ...request, endpoint, scope: "custom_loopback", headers: {} });
  };
  const outer: any = { chooseResource: async () => fail("No manual resource bypass"), editFieldTiers: async () => fail("No manual tier bypass"),
    chooseOption: async (title: string, choices: any[], options: any) => { menus.push({ stage, title, choices, options, surface: "outer" });
      if (title === "REVIEW SUPPORTING SOURCE") { expect(options.initialValue).toBe("pending"); return "allow"; }
      expect(title).toBe("SETUP NEEDS ATTENTION"); expect(choices.some(c => c.value === "pause")).toBe(true); return "pause"; },
    promptText: async () => undefined, confirm: async () => false };
  const options: any = { startWithAgentJob: true, exitAfterAgentJob: true, onAuthoringResult: (notice: any) => notices.push(notice),
    modelAuthoringSession: { provider: "openai", model: "derived-four-offline", apiKey: "owned-local-only", dependencies: { requestJson } },
    actionProjectInspector: physical.inspect, boundaryAuthoringChatFactory: (selection: any) => createBoundaryAuthoringChat({ ...selection, io, color: false, streamLineDelayMs: 0 }) };
  vi.stubEnv("OWNED_DERIVED_READ_URL", physical.env.OWNED_DERIVED_READ_URL);
  const capture = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { stdout += String(chunk); return true; });
  const noFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => fail("External network prohibited"));
  let failure: any;
  try {
    expect(await onboard(["db", "--project-root", root, "--from-env", "OWNED_DERIVED_READ_URL", "--schema", "derived_small", "--json"], { interactive: false, schemaInspector: physical.inspect })).toBe(0);
    const workload = path.join(root, "exact-read.json");
    await fs.writeFile(workload, JSON.stringify({ schema_version: READ_WORKLOAD_SET_VERSION, name: "derived_unit_read", source: { kind: "operator_exact_plan" },
      allowed: [{ id: "unit_public_fields", description: "Only selected-unit public fields.", plan: { kind: "rows", resource: "derived_small.units", select: ["id", "category", "status", "reason", "allocated_count"] } }],
      forbidden: [{ id: "private_blocked", description: "Blocked is private.", plan: { kind: "rows", resource: "derived_small.units", select: ["blocked"] } }] }));
    const before = stdout.length;
    expect(await boundaryAssistCommand(["--project-root", root, "--workload", workload, "--actor", "derived-owner", "--reason", "Public unit values only; supporting eligibility private.", "--json"], physical.inspect)).toBe(0);
    const preview = JSON.parse(stdout.slice(before));
    expect(await boundaryAssistCommand(["--project-root", root, "--analysis", preview.workload.analysis_id, "--actor", "derived-owner", "--reason", "Public unit values only; supporting eligibility private.", "--apply", "--confirm", `APPLY WORKLOAD ${preview.preview.decision_digest}`, "--json"], physical.inspect)).toBe(0);
    const current = await loadBoundaryReviewContext(root);
    await saveInstantBoundaryReviewBaseline({ projectRoot: root, draft: current.draft, candidate: current.candidate, actor: "derived-owner", expectedAuthoring: current.bundle.mutation_bindings.authoring });
    stage = "four-shape-create";
    await start(["--project-root", root, "--from-env", "OWNED_DERIVED_READ_URL", "--schema", "derived_small", "--cli"], { interactive: true, schemaInspector: physical.inspect,
      runBoundaryReview: (args, inspect) => boundaryReviewCommand(args, inspect, outer, undefined, options) });
    const authorities = await listActionRuleAuthorityDrafts(root);
    expect(authorities).toHaveLength(1); expect(authorities[0]!.authority.rules.map(a => a.rule.outcome).sort()).toEqual([...outcomes].sort());
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    const beforeResume = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
    expect(beforeResume.action.intents).toEqual(intents); expect(beforeResume.action.intended_outcomes).toEqual(outcomes);
    expect(beforeResume.generation_recovery.operations.every((op: any) => op.state === "checkpointed")).toBe(true);
    await fs.writeFile(path.join(evidence, "actual-count-owner-pause-resume.json"), JSON.stringify(beforeResume, null, 2));
    stage = "count-owner-review-resume"; answers = [];
    await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], physical.inspect, outer, undefined, options);
    expect(exchanges.filter(e => e.stage === stage && (e.body.tools ?? []).some((t: any) => (t.name ?? t.function?.name) === "runner__submit_action_rule_draft"))).toHaveLength(0);
    expect(reports.length).toBeGreaterThan(0);
    const resume = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
    expect(resume.action.intents).toEqual(intents); expect(resume.action.intended_outcomes).toEqual(outcomes);
    const sources = await loadPolicySources(root, resume.policy_source_session); expect(activePolicySource(sources)?.text).toBe(source);
    expect(dependencyFailures).toHaveLength(0);
    expect(sources.coverage).toBeDefined(); expect(sources.coverage?.source_digest).toBe(activePolicySource(sources)?.digest);
    expect(sources.coverage?.draft_digest).toBe(canonicalJsonDigest(reports.at(-1).draft));
    expect(sources.coverage?.passages.every(p => p.disposition === "implemented" || p.disposition === "background")).toBe(true);
    expect(sources.coverage_episodes?.some(e => e.submissions.some(s => s.validated === true && s.completed_at))).toBe(true);
    expect(resume.generation_recovery.operations.every((op: any) => op.state === "checkpointed")).toBe(true);
    await fs.writeFile(path.join(evidence, "actual-disabled-authority.json"), JSON.stringify(authorities[0], null, 2));
    await fs.writeFile(path.join(evidence, "actual-final-resume.json"), JSON.stringify(resume, null, 2));
    await fs.writeFile(path.join(evidence, "actual-final-source.json"), JSON.stringify(sources, null, 2));
    await expect(loadActivatedExplorationBoundaries(root)).rejects.toThrow("No exploration boundary is active.");
    stage = "read-publication";
    await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], physical.inspect, outer, undefined, options);
    expect(await loadActivatedExplorationBoundaries(root)).toHaveLength(1);
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    await fs.writeFile(path.join(evidence, "actual-read-only-publication.json"), JSON.stringify(await loadBoundaryReviewContext(root), null, 2));
    stage = "action-publication";
    await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], physical.inspect, outer, undefined, options);
    const active = await loadActiveActionRuleAuthority(root);
    expect(active.authority.rules.map(a => a.rule.outcome).sort()).toEqual([...outcomes].sort());
    expect((await readSemanticSupervisedExecutionState({ projectRoot: root })).enabled).toBe(false);
    expect(dependencyFailures).toHaveLength(0);
    await fs.writeFile(path.join(evidence, "actual-published-authority.json"), JSON.stringify(active, null, 2));
    await fs.writeFile(path.join(evidence, "actual-after-publication-resume.json"), await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json")));
    stage = "observed-read-and-pure-fact-evaluation";
    const configPath = path.join(root, "synapsor.actions.runner.json"), config = await readRuntimeConfig(configPath);
    const store = await createProjectRuntimeStore({ projectRoot: root, config, env: physical.env, storePath: path.join(root, ".synapsor/local.db") });
    const reader = new Pool({ connectionString: physical.env.OWNED_DERIVED_READ_URL });
    let explore: Awaited<ReturnType<typeof createScopedExploreBoundarySetRuntime>> | undefined;
    try {
      const semantic = await createOptionalReadActionRuleRuntimeServices({ projectRoot: root, config, configPath, env: physical.env, store });
      expect(semantic).toBeDefined();
      explore = await createScopedExploreBoundarySetRuntime({ projectRoot: root, transport: "stdio", mode: "local_authoring", env: physical.env, store,
        subjectReferences: { service: semantic!.subjectReferences, workflow_session_id: semantic!.workflow_session_id } });
      const observation: any = await explore.explore({ kind: "rows", resource: "derived_small.units", select: ["id", "category", "status", "reason", "allocated_count"] });
      expect(observation.ok).toBe(true); expect(observation.data).toHaveLength(6); expect(observation.subjects).toHaveLength(6);
      expect(observation.data.every((row: any) => !row.id.includes("foreign") && !Object.hasOwn(row, "blocked") && !Object.hasOwn(row, "allowed") && !Object.hasOwn(row, "capacity"))).toBe(true);
      await fs.writeFile(path.join(evidence, "actual-public-read-observation.json"), JSON.stringify(observation, null, 2));
      const dbScope: any = config.sources!.local_postgres!.database_scope;
      expect(dbScope.mode).toBe("postgres_rls");
      const scope = { tenantId: "fixture_tenant", principal: "fixture_principal", tenantSetting: dbScope.tenant_setting, principalSetting: dbScope.principal_setting };
      const evaluations: any[] = [];
      for (const [rowIndex, row] of observation.data.entries()) {
        const reference = observation.subjects.find((ref: any) => ref.row_index === rowIndex);
        const observed = await store.getObservedSubjectReference!(reference.ref);
        expect(observed?.state).toBe("active"); expect(observed?.resource).toBe("derived_small.units");
        for (const [index, outcome] of outcomes.entries()) {
          const compiled = active.registry.rules.find(rule => rule.compiled.outcome === outcome)!.compiled;
          const client = await reader.connect(); let loaded: Awaited<ReturnType<typeof loadActionRuleFacts>>;
          try {
            await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
            await bindPostgresActionRuleScope(client, scope);
            loaded = await loadActionRuleFacts({ compiled, mode: "proposal_snapshot", adapter: createPostgresActionRuleFactLoader(client, scope),
              subjects: [{ binding: "unit", resource: "derived_small.units", primary_key: { column: "id", value: row.id }, subject_ref_digest: observed!.subject_ref_digest }],
              trusted: { tenant: scope.tenantId, principal: scope.principal, transaction_time: new Date().toISOString() } });
          } finally { await client.query("ROLLBACK"); client.release(); }
          const inputs = index < 2 ? { reason: "r" } : { units: 1 };
          const result = evaluateActionRule({ compiled, facts: loaded!.facts, inputs, proposal_id: "derived_component_only_no_proposal_created" });
          const variant = row.id.slice("fixture_0_".length);
          const expected = variant === "missing" ? "unknown" : variant === "blocked" ? "ineligible" : variant === "denied" && index >= 2 ? "ineligible"
            : variant === "low_capacity" && index === 2 || variant === "low_count" && index === 3 ? "ineligible" : "eligible";
          expect(result.result, `${outcome}/${variant}`).toBe(expected);
          if (result.result === "eligible") {
            expect(result.effect.resource).toBe("derived_small.units"); expect(result.effect.primary_key.value).toBe(row.id);
            expect(result.effect.set).toEqual(index < 2 ? { status: index === 0 ? "ready" : "held", reason: "r" }
              : { allocated_count: row.allocated_count + (index === 2 ? 1 : -1) });
            expect(result.effect.version_advance).toMatchObject({ column: "version", strategy: "integer_increment" });
          }
          evaluations.push({ outcome, variant, provenance: "actual normal Read observation and issued metadata digest; actual current PG loader; component only, no subject claim/request/proposal", result });
          if (variant === "healthy") {
            for (const value of index < 2 ? ["", "x".repeat(64), "x".repeat(65)] : [0, 25, 26]) {
              const bounded = evaluateActionRule({ compiled, facts: loaded!.facts, inputs: index < 2 ? { reason: value } : { units: value }, proposal_id: "derived_component_only_no_proposal_created" });
              const valid = index < 2 ? (value as string).length === 64 : value === 25;
              expect(bounded.result).toBe(valid ? "eligible" : "unknown");
              if (!valid) expect(bounded).toMatchObject({ safe_code: "ACTION_RULE_INVALID" });
              evaluations.push({ outcome, variant, input_boundary: value, result: bounded });
            }
          }
          expect((await store.getObservedSubjectReference!(reference.ref))?.state).toBe("active");
        }
      }
      await fs.writeFile(path.join(evidence, "actual-pure-component-evaluations.json"), JSON.stringify(evaluations, null, 2));
      expect(await store.listProposals!()).toHaveLength(0);
    } finally { await explore?.close(); await reader.end(); await Promise.resolve(store.close()); }
  } catch (error: any) { failure = { name: error.name, code: error.code ?? null, message: error.message, stack: error.stack }; throw error; }
  finally {
    capture.mockRestore(); noFetch.mockRestore(); vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.writeFile(path.join(evidence, "transcript.txt"), transcript); await fs.writeFile(path.join(evidence, "stdout.txt"), stdout);
    await fs.writeFile(path.join(evidence, "menus.json"), JSON.stringify(menus, null, 2));
    await fs.writeFile(path.join(evidence, "actual-encoded-exchanges.json"), JSON.stringify(exchanges, null, 2));
    await fs.writeFile(path.join(evidence, "actual-loopback-exchanges.json"), JSON.stringify(wire, null, 2));
    await fs.writeFile(path.join(evidence, "actual-source-reviews.json"), JSON.stringify(reports, null, 2));
    await fs.writeFile(path.join(evidence, "result.json"), JSON.stringify({ source_head: "fe5101cf19e315e21746b4ac891595e30837b331", scope: "DERIVED implementer small-four public authoring component stage only", failure: failure ?? null,
      requests, actual_loopback_responses: wire.length, dependencyFailures, provider_calls: 0, business_requests: 0, source_effects_requested: 0, notices, container: physical.container, socket: physical.socket,
      cleanup: "Retained until actual full Source/control cold coverage is established." }, null, 2));
    await physical.snapshot();
    const normalize = (value: string) => value.split("\n").filter(line => !line.startsWith("\\restrict ") && !line.startsWith("\\unrestrict ")).join("\n");
    const preservation = await Promise.all(["schema", "data"].map(async kind => ({ kind, unchanged: normalize(await fs.readFile(path.join(evidence, `initial-${kind}.sql`), "utf8"))
      === normalize(await fs.readFile(path.join(evidence, `final-${kind}.sql`), "utf8")) })));
    await fs.writeFile(path.join(evidence, "actual-source-preservation.json"), JSON.stringify(preservation, null, 2));
    expect(preservation.every(value => value.unchanged)).toBe(true);
  }
}, 120000);

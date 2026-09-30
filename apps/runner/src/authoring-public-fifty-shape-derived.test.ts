import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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
import { readBoundaryDraftExchange } from "./boundary-draft-bundle.js";
import { createDerivedFourShapePhysicalFixture } from "./test-fixtures/derived-four-shape-physical.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";

// IMPLEMENTER DERIVED component/public-route evidence. Real inspected compound FK,
// RLS and fresh synthetic data are explicit differences from the original025 Source.
// Prepared source only until Main supplies a settled revision. On opt-in execution
// local responses use the actual encoder/decoder/compiler/persistence/Source review.
// No accepted report/authority/provenance is seeded. No result is established here.
const strings = (v: any): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings)
  : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
const jsonLine = (text: string, prefix: string): any => {
  const value = text.split("\n").find(line => line.startsWith(prefix));
  return value ? JSON.parse(value.slice(prefix.length)) : undefined;
};
const publishedDraft = (value: any): any => {
  const object = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!object(value)) throw new Error("Unsupported published draft representation.");
  if (!Object.hasOwn(value, "encoding")) {
    if (Object.hasOwn(value, "draft") || Object.hasOwn(value, "scoped_binding_groups")) throw new Error("Incomplete published draft envelope.");
    return value;
  }
  if (value.encoding !== "scoped_binding_groups_v1"
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["draft", "encoding", "scoped_binding_groups"])
    || !object(value.draft) || !object(value.draft.runner_evidence?.actions)
    || !Array.isArray(value.scoped_binding_groups) || !value.scoped_binding_groups.length
    || value.scoped_binding_groups.length > 32) throw new Error("Unsupported published draft envelope.");
  const draft = structuredClone(value.draft), actions = draft.runner_evidence.actions;
  const configured = Object.keys(actions);
  if (configured.length > 64) throw new Error("Published binding groups exceed the configured outcome bound.");
  const seen = new Set<string>(); let priorGroup = -1;
  for (const group of value.scoped_binding_groups) {
    if (!object(group) || JSON.stringify(Object.keys(group).sort()) !== JSON.stringify(["outcomes", "value"])
      || !object(group.value) || !Array.isArray(group.outcomes) || group.outcomes.length < 2
      || group.outcomes.length > 64) throw new Error("Malformed published binding group.");
    let prior = -1;
    for (const outcome of group.outcomes) {
      const index = typeof outcome === "string" ? configured.indexOf(outcome) : -1;
      if (index < 0 || index <= prior || seen.has(outcome) || !object(actions[outcome])
        || Object.hasOwn(actions[outcome], "scoped_bindings")) throw new Error("Published binding group collision or foreign outcome.");
      if (prior === -1) {
        if (index <= priorGroup) throw new Error("Unordered published binding groups.");
        priorGroup = index;
      }
      prior = index; seen.add(outcome);
      // This is opaque untrusted publication data. Expanding it records no
      // observation, scope proof, accepted Source report or readiness.
      actions[outcome].scoped_bindings = structuredClone(group.value);
    }
  }
  return draft;
};
const boundedSourcePassages = (passages: any[]): any[] => passages.flatMap(passage => {
  expect(Array.isArray(passage.draft_paths)).toBe(true);
  if (passage.draft_paths.length <= 32) return [passage];
  // The seven original040 long associations contain only this base shape.
  // Never duplicate or detach a counter, field or other typed claim here.
  expect(Object.keys(passage).sort()).toEqual(["disposition", "draft_paths", "end", "interpretation", "start"]);
  const parts = [];
  for (let offset = 0; offset < passage.draft_paths.length; offset += 32) {
    parts.push({ ...passage, draft_paths: passage.draft_paths.slice(offset, offset + 32) });
  }
  expect(parts.flatMap(part => part.draft_paths)).toEqual(passage.draft_paths);
  return parts;
});
const publishedReferencePaths = (inventory: any): string[] => {
  if (Array.isArray(inventory)) {
    expect(inventory.every(value => typeof value === "string")).toBe(true);
    return inventory;
  }
  expect(Object.keys(inventory).sort()).toEqual(["encoding", "groups"]);
  expect(inventory.encoding).toBe("pointer_prefix_groups_v1");
  expect(Array.isArray(inventory.groups)).toBe(true);
  // Decode only the actual published group. Concatenation preserves the exact
  // pointer, its escaped tokens and original order; no cross-group expansion.
  return inventory.groups.flatMap((group: any) => {
    expect(Object.keys(group).sort()).toEqual(["prefix", "suffixes"]);
    expect(typeof group.prefix).toBe("string"); expect(Array.isArray(group.suffixes)).toBe(true);
    expect(group.suffixes.every((value: any) => typeof value === "string")).toBe(true);
    return group.suffixes.map((suffix: string) => group.prefix + suffix);
  });
};

it("expands only exact published binding groups as untrusted encoding data", () => {
  const first = { unit: { region: "opaque-first", fields: ["id", "status"] } };
  const second = { unit: { region: "opaque-second", fields: ["id", "status"] } };
  const root = { read: { literal: true }, actions: ["a", "b", "c", "d"], runner_evidence: { actions: {
    a: { retained: 1 }, b: { retained: 2 }, c: { retained: 3 }, d: { retained: 4 },
    singleton: { scoped_bindings: { exact: "literal" } }, absent: {}, nullable: { scoped_bindings: null },
  } } };
  const envelope = { encoding: "scoped_binding_groups_v1", draft: root,
    scoped_binding_groups: [{ outcomes: ["a", "c"], value: first }, { outcomes: ["b", "d"], value: second }] };
  const before = JSON.stringify(envelope), expanded = publishedDraft(envelope);
  expect(expanded).toEqual({ ...root, runner_evidence: { actions: {
    a: { retained: 1, scoped_bindings: first }, b: { retained: 2, scoped_bindings: second },
    c: { retained: 3, scoped_bindings: first }, d: { retained: 4, scoped_bindings: second },
    singleton: { scoped_bindings: { exact: "literal" } }, absent: {}, nullable: { scoped_bindings: null },
  } } });
  expect(JSON.stringify(envelope)).toBe(before); expect(publishedDraft(root)).toBe(root);
  expect(expanded.runner_evidence.actions.a.scoped_bindings).not.toBe(expanded.runner_evidence.actions.c.scoped_bindings);
});
it("refuses unsupported, malformed, foreign or colliding publication groups", () => {
  const base = () => ({ encoding: "scoped_binding_groups_v1", draft: { runner_evidence: { actions: { a: {}, b: {}, c: {} } } },
    scoped_binding_groups: [{ outcomes: ["a", "b"], value: { opaque: true } }] });
  const malformed: any[] = [null, [], { encoding: "unknown" }, { draft: {} }, { scoped_binding_groups: [] }];
  for (const edit of [
    (x: any) => { x.extra = true; }, (x: any) => { x.scoped_binding_groups = []; },
    (x: any) => { x.scoped_binding_groups[0].value = null; }, (x: any) => { x.scoped_binding_groups[0].value = []; },
    (x: any) => { x.scoped_binding_groups[0].outcomes = ["a"]; },
    (x: any) => { x.scoped_binding_groups[0].outcomes = ["a", "foreign"]; },
    (x: any) => { x.scoped_binding_groups[0].outcomes = ["a", "a"]; },
    (x: any) => { x.scoped_binding_groups[0].outcomes = ["b", "a"]; },
    (x: any) => { x.scoped_binding_groups.push({ outcomes: ["b", "c"], value: { other: true } }); },
    (x: any) => { x.draft.runner_evidence.actions.a.scoped_bindings = null; },
    (x: any) => { x.draft.runner_evidence.actions.b = null; },
    (x: any) => { x.draft.runner_evidence.actions = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), {}])); },
  ]) { const value = base(); edit(value); malformed.push(value); }
  for (const value of malformed) expect(() => publishedDraft(value)).toThrow();
});
it("expands the finite64-outcome publication bound without adding outcomes or authority", () => {
  const outcomes = Array.from({ length: 64 }, (_, i) => `opaque_${i}`);
  const actions = Object.fromEntries(outcomes.map(outcome => [outcome, { retained: outcome }]));
  const value = { opaque_binding: { observed: false, permitted: false } };
  const expanded = publishedDraft({ encoding: "scoped_binding_groups_v1", draft: { runner_evidence: { actions } },
    scoped_binding_groups: [{ outcomes, value }] });
  expect(Object.keys(expanded.runner_evidence.actions)).toEqual(outcomes);
  for (const outcome of outcomes) expect(expanded.runner_evidence.actions[outcome]).toEqual({ retained: outcome, scoped_bindings: value });
  expect(Object.values(actions).every(action => !Object.hasOwn(action, "scoped_bindings"))).toBe(true);
});
it("bounds overlapping Source associations without changing their exact claims or ordered path union", () => {
  const paths = Array.from({ length: 50 }, (_, i) => `/actions/${i}/require`);
  const original = [
    { start: 2, end: 2, disposition: "implemented", interpretation: "Opaque original exact Source claim.", draft_paths: paths },
    { start: 56, end: 56, disposition: "implemented", interpretation: "Opaque original conjunction is retained.", draft_paths: ["/read", ...paths] },
  ];
  const before = JSON.stringify(original), parts = boundedSourcePassages(original);
  expect(parts.map(part => part.draft_paths.length)).toEqual([32, 18, 32, 19]);
  for (const parent of original) {
    const children = parts.filter(part => part.start === parent.start);
    expect(children.flatMap(part => part.draft_paths)).toEqual(parent.draft_paths);
    for (const child of children) expect({ ...child, draft_paths: parent.draft_paths }).toEqual(parent);
  }
  expect(JSON.stringify(original)).toBe(before);
  expect(() => boundedSourcePassages([{ ...original[0], counter_requirements: [{ opaque: true }] }])).toThrow();
});

it.skipIf(process.env.SYNAPSOR_TEST_DERIVED_FIFTY_REAL_PG !== "1")("authors the DERIVED ordered fifty agenda through actual public pause, export, restart and complete Source review", async () => {
  const evidence = process.env.OWNED_DERIVED_FIFTY_EVIDENCE ?? path.join(os.tmpdir(), `derived-fifty-${randomUUID()}`);
  const root = path.join(evidence, "project");
  const originalFile = process.env.OWNED_DERIVED_ORIGINAL_SOURCE;
  const ownerFile = process.env.OWNED_DERIVED_OWNER_PACKET;
  if (!originalFile || !ownerFile) throw new Error("The opt-in test requires the exact non-heldout original Source and declarative owner packet paths.");
  const original = await fs.readFile(originalFile), ownerBytes = await fs.readFile(ownerFile);
  expect(createHash("sha256").update(original).digest("hex")).toBe("4a9bd0b207f94575b3c45151b656d35f7258f14b2824a52ca392cb9ad0234807");
  expect(createHash("sha256").update(ownerBytes).digest("hex")).toBe("034b456d5b707add6fd5f45589be3759fe54fb0af94ce0d2e3d1939299c42244");
  const owner: any = JSON.parse(ownerBytes.toString("utf8"));
  // Read-only accounting across preserved controlled attempts. This is evidence
  // measurement, never a product checkpoint or authorization record.
  const priorResultPaths: unknown = JSON.parse(process.env.OWNED_DERIVED_M2_M3_PRIOR_RESULTS ?? "[]");
  expect(Array.isArray(priorResultPaths)).toBe(true);
  const priorPaths = priorResultPaths as string[];
  expect(priorPaths.length).toBeLessThanOrEqual(32); expect(new Set(priorPaths).size).toBe(priorPaths.length);
  let priorRequests = 0;
  for (const priorPath of priorPaths) {
    expect(typeof priorPath).toBe("string"); expect(path.basename(priorPath)).toBe("result.json");
    const stat = await fs.lstat(priorPath); expect(stat.isSymbolicLink()).toBe(false); expect(stat.isFile()).toBe(true); expect(stat.size).toBeLessThan(65536);
    const prior = JSON.parse(await fs.readFile(priorPath, "utf8"));
    expect(prior.scope).toContain("DERIVED implementer full50"); expect(Number.isSafeInteger(prior.requests)).toBe(true); expect(prior.requests).toBeGreaterThanOrEqual(0);
    priorRequests += prior.requests;
  }
  expect(priorRequests).toBeLessThan(1400);
  const sourceLines = [
    "DERIVED supported-relationship ordered-fifty program; never original-schema or paid-full50 qualification.",
    ...original.toString("utf8").trim().split("\n").map(line => line.replaceAll("operations.", "derived_ops.")),
    "DERIVED operator field contract: derived_ops.units is the selected register and only caller subject/effect target. Public Read returns only id/category/status/reason/allocated_count. Private blocked/allowed/capacity never appear as public fields. Eligibility is supporting evidence, never another caller subject. Mark/defer record the exact nonempty caller reason; allocation/release alter only allocated_count by exact caller units. Backend version maintenance is Source-owned, never a caller write.",
    "DERIVED technical facts: immediate non-null compound tenant/principal/id eligibility FK to units, unique eligibility id and physical positive version increment triggers. Inverse eligibility is a complete_locked bounded collection; absent or overflow facts remain unresolved. The actual fixture backend owns derived.tenant/principal RLS. Private allowed/capacity are irrelevant for mark/defer, but applicable private eligibility must exist for all four shapes. No summary companion is requested.",
    "Otherwise-valid allocations above either automatic ceiling require one distinct authorized large.manual human reviewer. Human fallback never waives blocked, missing private facts, input bounds or hard guards; no approval or business request is performed here.",
  ];
  const source = sourceLines.join("\n"), sourceFile = path.join(root, "derived-rules.txt");
  const descriptors = sourceLines.flatMap((line, lineIndex) => {
    const match = /^(\d+)\. (derived_ops\.(mark_ready|defer_item|allocate_units|release_units)_(\d+)):.*; category (\d+)\.$/u.exec(line);
    return match ? [{ position: Number(match[1]), outcome: match[2]!, shape: match[3]!, category: Number(match[5]), intent: line, sourceLine: lineIndex + 1 }] : [];
  });
  expect(descriptors).toHaveLength(50);
  expect(descriptors.map(d => d.position)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
  expect(descriptors.map(d => d.outcome)).toEqual(owner.actions.map((a: any) => a.outcome.replace("operations.", "derived_ops.")));
  expect(descriptors.map(d => d.category)).toEqual(owner.actions.map((a: any) => a.category_selector));
  const outcomes = descriptors.map(d => d.outcome), intents = descriptors.map(d => d.intent);
  const job = "Prepare the selected complete ordered50-Action program in the attached DERIVED Source. Retain all unfinished duties and the ONE12-outcome automatic allocation domain; work units never reset caps/history. Reuse the exact disabled public-unit Read. Only selected units are caller subjects/effect targets; eligibility stays private supporting evidence. The backend Source trigger maintains units.version and eligibility.version; this is an owner assertion, not imported readiness. Do not activate, execute, approve, enroll reviewers or start a worker.";
  const sourceHead = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })).stdout.trim();
  const testSourceDigest = createHash("sha256").update(await fs.readFile(fileURLToPath(import.meta.url))).digest("hex");
  const physical = await createDerivedFourShapePhysicalFixture({ evidenceRoot: evidence, schema: "derived_ops", categories: 13 });
  await fs.mkdir(root, { mode: 0o700 }); await fs.writeFile(sourceFile, source);
  let transcript = "", stdout = "", requests = 0, stage = "setup", interruption: (() => void) | undefined;
  const menus: any[] = [], exchanges: any[] = [], reports: any[] = [], wire: any[] = [], notices: any[] = [], dependencyFailures: any[] = [];
  const phases = new Map<string, number>(); let privateReviewed = false, versionReviewed = false;
  const textDescriptors = descriptors.filter(d => ["mark_ready", "defer_item"].includes(d.shape));
  const textSourceRange = `${textDescriptors[0]!.sourceLine}-${textDescriptors.at(-1)!.sourceLine}`;
  let answers: Array<string | undefined> = [`/attach ${sourceFile}`, job, textDescriptors.map(d => d.position).join(","), "reason", "1..64", textSourceRange];
  const observations = new Map<number, Buffer>(); let pausedAtTwenty = false;
  const write = (s: string) => {
    transcript += s;
    const progress = [...transcript.matchAll(/Selected program:\s*(\d+)\/50 Action drafts prepared/gu)].at(-1);
    if (!progress || stage !== "fifty-create") return;
    const count = Number(progress[1]);
    if ([1, 4, 10, 20].includes(count) && !observations.has(count)) {
      // A read-only snapshot at the actual displayed persisted progress; no
      // mutation/save callback is substituted. Interrupt at the real20 display.
      const bytes = readFileSync(path.join(root, ".synapsor/boundary-authoring/resume.json"));
      const state = JSON.parse(bytes.toString("utf8"));
      expect(state.action.completed_outcomes).toHaveLength(count); observations.set(count, bytes);
      if (count === 20) { pausedAtTwenty = true; interruption?.(); }
    }
  };
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
      if (choice.title === "START BOUNDARY DRAFTING") selected = stage === "fifty-create" ? "program" : "resume";
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
        expect(choice.initialValue).toBe("unresolved");
        if (choice.message.includes("Configured allowance: 2; scope capability")) {
          const exact = [...choice.message.matchAll(/\/runner_evidence\/actions\/(derived_ops\.allocate_units_\d+)\/automatic_limits\/\d+\/history_selector\/capability/gu)];
          const named = [...new Set(exact.map((match: RegExpMatchArray) => match[1]))];
          if (named.length !== 1) {
            menus.push({ stage, ...choice, selected: undefined, stop: "Exact current counter attribution unavailable; never guess iteration." }); interruption?.(); return undefined;
          }
          selected = choice.options.find((o: any) => o.label === `Only automatic ${named[0]} approvals`)?.value;
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
    if (++requests + priorRequests > 1400) fail("Predeclared cumulative M2/M3 1400-response bound exceeded.");
    exchanges.push({ request: requests, stage, body }); let name: string | undefined, args: any, answer: string | undefined;
    if (names.includes("runner__plan_boundary_job")) {
      name = "runner__plan_boundary_job"; args = { status: "planned", read_mode: "reuse", action_mode: "create", action_strategy: "rule_derived",
        action_intent: intents[0], action_intents: intents, action_outcomes: outcomes, summary: "Fifty complete ordered inventoried intents; each unfinished Source duty stays pending." };
    } else if (names.includes("runner__submit_action_rule_draft")) {
      const intent = jsonLine(text, "Current action intent: "); const index = intents.indexOf(intent); expect(index).toBeGreaterThanOrEqual(0);
      const descriptor = descriptors[index]!, textShape = ["mark_ready", "defer_item"].includes(descriptor.shape);
      const allocation = descriptor.shape === "allocate_units", markReady = descriptor.shape === "mark_ready";
      for (const line of sourceLines) expect(text).toContain(line);
      if (!privateReviewed) { privateReviewed = true; name = "runner__review_private_action_source"; args = { resource: "derived_ops.eligibility", parent_resource: "derived_ops.units" }; }
      else if (!versionReviewed) { versionReviewed = true; name = "runner__review_version_field"; args = { resource: "derived_ops.units", field: "version" }; }
      else {
        // Normal preparation tools return the updated current catalog in their
        // actual function output; the conversation's initial catalog stays inert.
        const outputs = (body.input ?? []).filter((value: any) => value.type === "function_call_output")
          .map((value: any) => JSON.parse(value.output));
        const catalog = outputs.filter((value: any) => value.catalog).at(-1)?.catalog
          ?? jsonLine(text, "Current normalized structural catalog: ");
        const unit = catalog.resources.find((r: any) => r.name === "derived_ops.units");
        const privateResource = catalog.resources.find((r: any) => r.name === "derived_ops.eligibility"); expect(privateResource.verification_only).toBe(true);
        const relationship = catalog.relationships.find((r: any) => r.name === "eligibility_unit_scope_fk"); expect(relationship.field_pairs).toHaveLength(3);
        const type = (field: string) => { const value = unit.fields.find((f: any) => f.name === field)?.type; if (!value) fail(`Actual catalog lacks ${field}`); return value; };
        const field = (f: string, binding = "unit") => ({ kind: "field", binding, field: f });
        const literal = (value: any, f: string) => ({ kind: "literal", value, value_type: type(f) });
        const compare = (operator: string, left: any, right: any) => ({ kind: "compare", operator, left, right });
        const minimum = (f: string) => ({ kind: "aggregate", operation: "min", binding: "eligibility", field: f });
        const allowed = compare("gte", { kind: "aggregate", operation: "sum", binding: "eligibility", field: "version",
          where: compare("eq", field("allowed", "eligibility"), { kind: "literal", value: true, value_type: { kind: "boolean" } }) }, minimum("version"));
        const units = { kind: "input", name: "units" }, reason = { kind: "input", name: "reason" };
        const count = { kind: "math", operation: allocation ? "add" : "subtract", inputs: [field("allocated_count"), units] };
        const checks = [compare("eq", field("blocked"), literal(false, "blocked")), compare("eq", field("category"), literal(descriptor.category, "category")),
          compare("gte", minimum("version"), { kind: "literal", value: 1, value_type: { kind: "integer" } })];
        if (textShape) checks.push(compare("eq", field("status"), literal("open", "status")));
        else { checks.push(allowed); checks.push(allocation ? compare("lte", count, minimum("capacity")) : compare("gte", field("allocated_count"), units)); }
        const require = { kind: "all", expressions: checks };
        const draft: any = { name: outcomes[index], outcome: outcomes[index], inputs: [textShape ? { name: "reason", description: "Exact caller reason.", type: { kind: "string", min_length: 1, max_length: 64, comparison: "exact" } }
          : { name: "units", description: "Exact caller allocation/release count.", type: { kind: "integer" }, minimum: 1, maximum: 25 }],
          verification: { name: `${outcomes[index]}_verification`, resources: [
            { binding: "unit", resource: unit.name, source: { kind: "subject_ref" }, fields: ["status", "blocked", "category", "allocated_count"] },
            { binding: "eligibility", resource: privateResource.name, source: { kind: "relationship", from_binding: "unit", relationship: relationship.name, direction: "inverse" },
              fields: ["allowed", "capacity", "version"], max_rows: 1, overflow: "unsupported", collection_consistency: "complete_locked", deterministic_order: [{ field: "id", direction: "asc" }] } ] },
          effect: { name: `${outcomes[index]}_effect`, operation: "update", target_resource: unit.name, target_binding: "unit",
            allowed_fields: textShape ? [{ name: "status", values: [markReady ? "ready" : "held"] }, { name: "reason" }] : [{ name: "allocated_count", minimum: 0 }],
            set: textShape ? { status: literal(markReady ? "ready" : "held", "status"), reason } : { allocated_count: count }, writeback: "proposal_only" },
          require, derive: {}, ttl_seconds: 300,
          approval: { class_name: allocation ? "large.shared_allocation" : "large.manual", mode: allocation ? "policy" : "human",
            ...(allocation ? { auto_approve_when: require } : {}), required_role: "large.manual", required_approvals: 1,
            shared_limits: allocation ? [{ id: "allocation_joint", kind: "count", scope: "tenant_principal", maximum: 3, window_seconds: 86400 },
              { id: "allocation_capability", kind: "count", scope: "capability", maximum: 2, window_seconds: 86400 }] : [] },
          review: { when: intents[index], then: "Propose only the exact requested effect on the selected unit.", refused: ["Blocked or wrong category; missing/ambiguous private facts remain unknown; required hard guard false."],
            human_review: "One distinct authorized large.manual reviewer; otherwise-valid over-ceiling allocation uses normal human review. No override of hard limits.",
            examples: [{ kind: "eligible", scenario: "Complete same-scope permitted facts and bounded input.", result: "Exact proposal only." }, { kind: "ineligible", scenario: "Blocked unit.", result: "Refuse." }] } };
        const { verification, effect, approval, ...rule } = draft;
        const sequence: Array<[string, any]> = [ ["runner__submit_verification_boundary_draft", { status: "draft", ...verification, changed_fields: [] }],
          ["runner__submit_effect_envelope_draft", { status: "draft", ...effect, changed_fields: [] }], ["runner__submit_action_rule_draft", { status: "draft", ...rule, changed_fields: [] }],
          ["runner__submit_approval_policy_draft", { status: "draft", ...approval, changed_fields: [] }], ["runner__validate_action_draft", {}] ];
        // Finite wrong-but-decodable input representation then actual ordinary
        // compiler feedback correction. Business bounds/effects never change.
        if (descriptor.position === 21) {
          const invalid = structuredClone(rule);
          invalid.inputs[0].type = { kind: "integer", minimum: 1, maximum: 25 };
          delete invalid.inputs[0].minimum; delete invalid.inputs[0].maximum;
          sequence[2] = ["runner__submit_action_rule_draft", { status: "draft", ...invalid, changed_fields: [] }];
          sequence.push(["runner__submit_action_rule_draft", { status: "draft", ...rule, changed_fields: ["inputs"] }], ["runner__validate_action_draft", {}]);
        }
        const n = phases.get(outcomes[index]!) ?? 0; phases.set(outcomes[index]!, n + 1);
        if (descriptor.position === 21 && n === 5) {
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
      const publication = jsonLine(text, "Current draft (JSON pointer root): "), draft = publishedDraft(publication);
      const referenceInventory = jsonLine(text, "Exact coverage references (select, do not invent paths): ");
      const references = publishedReferencePaths(referenceInventory);
      reports.push({ draft, draft_publication: publication, reference_inventory: referenceInventory, references });
      const paths = (part: string) => draft.actions.map((_: any, i: number) => `/actions/${i}/${part}`);
      const actionAtLine = new Map(descriptors.map(d => [d.sourceLine, d]));
      args = { passages: boundedSourcePassages(sourceLines.map((line, i) => {
        const action = actionAtLine.get(i + 1);
        const actionIndex = action ? draft.actions.findIndex((a: any) => a.outcome === action.outcome) : undefined;
        return { start: i + 1, end: i + 1, disposition: i === 0 ? "background" : "implemented", interpretation: line,
          draft_paths: i === 0 ? [] : action ? [`/actions/${actionIndex}`] : i === 1 ? paths("require") : i === 2 ? paths("approval")
            : i === sourceLines.length - 2 ? paths("verification")
            : i === sourceLines.length - 3 ? ["/read", ...paths("effect")] : i === sourceLines.length - 1 ? paths("approval") : paths("effect") };
      })) };
      expect(draft.actions.map((a: any) => a.outcome).sort()).toEqual([...outcomes].sort());
      const counters = Object.entries(draft.runner_evidence.actions).flatMap(([outcome, value]: [string, any]) =>
        (value.automatic_limits ?? []).map((limit: any, index: number) => ({
          path: `/runner_evidence/actions/${outcome}/automatic_limits/${index}/history_selector/capability`,
          current_capability: limit.history_selector.capability, required_capability: limit.scope === "capability" ? outcome : null,
        })));
      expect(counters).toHaveLength(24);
      const counterPassages = [];
      for (let offset = 0; offset < counters.length; offset += 12) {
        const checks = counters.slice(offset, offset + 12);
        counterPassages.push({ start: 3, end: 3, disposition: "implemented", responsibility: "runner", interpretation: "The exact Source-bound operator counting review retains ONE automatic12-allocation domain and each separate per-capability domain, with human approvals excluded and no workunit reset.",
          draft_paths: [...new Set(checks.map((counter: any) => counter.path.replace(/\/\d+\/history_selector\/capability$/u, "")))], counter_requirements: checks });
      }
      // Existing grammar allows overlapping Source ranges and at most16 checks
      // per passage. The two bounded passages retain all24 original selectors.
      expect(counterPassages.flatMap(passage => passage.counter_requirements)).toEqual(counters);
      expect(counterPassages.every(passage => passage.counter_requirements.length <= 16)).toBe(true);
      args.passages.push(...counterPassages);
      // Separate source-owner operating responsibility from effect/condition
      // and privacy claims. The reply supplies no confirmation or resolution:
      // the actual parser must find the normal current owner record itself.
      args.passages.push(...draft.actions.map((action: any) => {
        const pointer = `/runner_evidence/actions/${action.outcome}/effect/source_counter_maintenance`;
        return { start: sourceLines.length - 2, end: sourceLines.length - 1,
          disposition: "needs_decision", responsibility: "deployment", issue_kind: "missing_configuration",
          topic: `Source-owned version maintenance: ${action.outcome}`,
          interpretation: "Backend version maintenance is Source-owned. Its all-writers operating contract requires current exact owner confirmation; independent external-writer and production assurance remain unverified.",
          draft_paths: [pointer], source_counter_obligation: { path: pointer, requirement: "owner_maintenance" } };
      }));
      args.passages.push({ start: sourceLines.length - 2, end: sourceLines.length - 2,
        disposition: "implemented", responsibility: "runner",
        interpretation: "Only id/category/status/reason/allocated_count are public unit values. Blocked and supporting eligibility allowed/capacity remain private across every current Read and Action use.",
        draft_paths: ["/read", "/runner_evidence/actions"], field_checks: [
          { resource: "derived_ops.units", field: "blocked", expectation: "private" },
          ...["allowed", "capacity"].map(field => ({ resource: "derived_ops.eligibility", field, expectation: "private" })),
          ...["id", "category", "status", "reason", "allocated_count"].map(field => ({ resource: "derived_ops.units", field, expectation: "business_visible" })),
        ] });
      expect(args.passages.length).toBeLessThanOrEqual(120);
      expect(args.passages.every((passage: any) => passage.draft_paths.length <= 32)).toBe(true);
      for (const passage of args.passages) for (const pointer of passage.draft_paths) expect(references).toContain(pointer);
    } else if (!names.length) answer = jsonLine(text, "Exact next question: ") ?? "The exact current record needs its normal operator review; no execution is claimed.";
    else fail(`Unexpected actual tool surface: ${names.join(",")}`);
    if (name) expect(names).toContain(name);
    return { status: 200, body: { output: name ? [{ type: "function_call", call_id: `derived-fifty-${requests}`, name, arguments: JSON.stringify(args) }]
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
    expect(await onboard(["db", "--project-root", root, "--from-env", "OWNED_DERIVED_READ_URL", "--schema", "derived_ops", "--json"], { interactive: false, schemaInspector: physical.inspect })).toBe(0);
    const workload = path.join(root, "exact-read.json");
    await fs.writeFile(workload, JSON.stringify({ schema_version: READ_WORKLOAD_SET_VERSION, name: "derived_unit_read", source: { kind: "operator_exact_plan" },
      allowed: [{ id: "unit_public_fields", description: "Only selected-unit public fields.", plan: { kind: "rows", resource: "derived_ops.units", select: ["id", "category", "status", "reason", "allocated_count"] } }],
      forbidden: [{ id: "private_blocked", description: "Blocked is private.", plan: { kind: "rows", resource: "derived_ops.units", select: ["blocked"] } }] }));
    const before = stdout.length;
    expect(await boundaryAssistCommand(["--project-root", root, "--workload", workload, "--actor", "derived-owner", "--reason", "Public unit values only; supporting eligibility private.", "--json"], physical.inspect)).toBe(0);
    const preview = JSON.parse(stdout.slice(before));
    expect(await boundaryAssistCommand(["--project-root", root, "--analysis", preview.workload.analysis_id, "--actor", "derived-owner", "--reason", "Public unit values only; supporting eligibility private.", "--apply", "--confirm", `APPLY WORKLOAD ${preview.preview.decision_digest}`, "--json"], physical.inspect)).toBe(0);
    const current = await loadBoundaryReviewContext(root);
    await saveInstantBoundaryReviewBaseline({ projectRoot: root, draft: current.draft, candidate: current.candidate, actor: "derived-owner", expectedAuthoring: current.bundle.mutation_bindings.authoring });
    stage = "fifty-create";
    await start(["--project-root", root, "--from-env", "OWNED_DERIVED_READ_URL", "--schema", "derived_ops", "--cli"], { interactive: true, schemaInspector: physical.inspect,
      runBoundaryReview: (args, inspect) => boundaryReviewCommand(args, inspect, outer, undefined, options) });
    expect(pausedAtTwenty).toBe(true);
    const partial = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
    expect(partial.action.intents).toEqual(intents); expect(partial.action.intended_outcomes).toEqual(outcomes);
    expect(partial.action.completed_outcomes).toEqual(outcomes.slice(0, 20));
    expect(partial.generation_recovery.operations.every((op: any) => op.state === "checkpointed")).toBe(true);
    const partialAuthority = await listActionRuleAuthorityDrafts(root);
    expect(partialAuthority[0]!.authority.rules).toHaveLength(20);
    const beforeExportResume = await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"));
    const partialFile = path.join(root, "partial20.draft.json");
    expect(await start(["--project-root", root, "--export-draft", partialFile, "--json"], { interactive: false, schemaInspector: physical.inspect })).toBe(0);
    const partialExchange: any = await readBoundaryDraftExchange(root, partialFile);
    expect(partialExchange.actions).toHaveLength(20); expect(partialExchange.action_skeletons).toHaveLength(50);
    expect(partialExchange.notes.source_material_state).toBe("untrusted_not_attached");
    expect(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"))).toEqual(beforeExportResume);
    await fs.writeFile(path.join(evidence, "actual-partial20-declarative-exchange.json"), JSON.stringify(partialExchange, null, 2));
    expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    stage = "fifty-resume"; answers = [];
    await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], physical.inspect, outer, undefined, options);
    expect(exchanges.filter(e => e.stage === stage && (e.body.tools ?? []).some((t: any) => (t.name ?? t.function?.name) === "runner__submit_action_rule_draft") &&
      outcomes.slice(0, 20).some(outcome => strings(e.body).some(text => text.includes(`Current action intent: ${intents[outcomes.indexOf(outcome)]}`))))).toHaveLength(0);
    const authorities = await listActionRuleAuthorityDrafts(root);
    expect(authorities).toHaveLength(1); expect(authorities[0]!.authority.rules.map(a => a.rule.outcome).sort()).toEqual([...outcomes].sort());
    expect(reports.length).toBeGreaterThan(0);
    const resume = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
    expect(resume.action.intents).toEqual(intents); expect(resume.action.intended_outcomes).toEqual(outcomes);
    const sources = await loadPolicySources(root, resume.policy_source_session); expect(activePolicySource(sources)?.text).toBe(source);
    expect(dependencyFailures).toHaveLength(0);
    expect(sources.coverage).toBeDefined(); expect(sources.coverage?.source_digest).toBe(activePolicySource(sources)?.digest);
    expect(sources.coverage?.draft_digest).toBe(canonicalJsonDigest(reports.at(-1).draft));
    expect(policyReviewReadiness(activePolicySource(sources)!, sources.coverage, sources).ready).toBe(true);
    const maintenance = sources.coverage!.passages.filter(p => p.source_counter_obligation);
    expect(maintenance).toHaveLength(50);
    expect(new Set(maintenance.map(p => p.source_counter_obligation!.path)).size).toBe(50);
    for (const passage of maintenance) {
      expect(passage).toMatchObject({ disposition: "needs_decision", responsibility: "deployment", issue_kind: "missing_configuration",
        source_counter_obligation: { requirement: "owner_maintenance" }, source_counter_resolution: {
          source_digest: activePolicySource(sources)!.digest, path: passage.source_counter_obligation!.path, external_assurance: "unverified",
        } });
    }
    expect(sources.coverage!.passages.filter(p => !p.source_counter_obligation)
      .every(p => p.disposition === "implemented" || p.disposition === "background")).toBe(true);
    expect(sources.coverage_episodes?.some(e => e.submissions.some(s => s.validated === true && s.completed_at))).toBe(true);
    expect(resume.generation_recovery.operations.every((op: any) => op.state === "checkpointed")).toBe(true);
    await fs.writeFile(path.join(evidence, "actual-disabled-authority.json"), JSON.stringify(authorities[0], null, 2));
    await fs.writeFile(path.join(evidence, "actual-final-resume.json"), JSON.stringify(resume, null, 2));
    await fs.writeFile(path.join(evidence, "actual-final-source.json"), JSON.stringify(sources, null, 2));
    expect(resume.action.completed_outcomes).toEqual(outcomes);
    await fs.writeFile(path.join(evidence, "actual-progress-50.json"), JSON.stringify(resume, null, 2));
    stage = "full50-declarative-export";
    const completeFile = path.join(root, "full50.draft.json");
    expect(await start(["--project-root", root, "--export-draft", completeFile, "--json"], { interactive: false, schemaInspector: physical.inspect })).toBe(0);
    const completeExchange: any = await readBoundaryDraftExchange(root, completeFile);
    expect(completeExchange.actions).toHaveLength(50); expect(completeExchange.action_skeletons).toHaveLength(50);
    expect(completeExchange.notes.source_material_state).toBe("untrusted_not_attached");
    await fs.writeFile(path.join(evidence, "actual-full50-declarative-exchange.json"), JSON.stringify(completeExchange, null, 2));
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
  } catch (error: any) { failure = { name: error.name, code: error.code ?? null, message: error.message, stack: error.stack }; throw error; }
  finally {
    capture.mockRestore(); noFetch.mockRestore(); vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.writeFile(path.join(evidence, "transcript.txt"), transcript); await fs.writeFile(path.join(evidence, "stdout.txt"), stdout);
    await fs.writeFile(path.join(evidence, "menus.json"), JSON.stringify(menus, null, 2));
    await fs.writeFile(path.join(evidence, "actual-encoded-exchanges.json"), JSON.stringify(exchanges, null, 2));
    await fs.writeFile(path.join(evidence, "actual-loopback-exchanges.json"), JSON.stringify(wire, null, 2));
    await fs.writeFile(path.join(evidence, "actual-source-reviews.json"), JSON.stringify(reports, null, 2));
    for (const [count, bytes] of observations) await fs.writeFile(path.join(evidence, `actual-progress-${count}.json`), bytes);
    await fs.writeFile(path.join(evidence, "result.json"), JSON.stringify({ source_head: sourceHead, test_source_sha256: testSourceDigest, scope: "DERIVED implementer full50 primary public preparation; not original-schema or paid qualification", failure: failure ?? null,
      measured_budget: { maximum: 1400, prior_results: priorPaths, prior_requests: priorRequests, total_requests: priorRequests + requests },
      requests, actual_loopback_responses: wire.length, dependencyFailures, provider_calls: 0, business_requests: 0, source_effects_requested: 0, notices, container: physical.container, socket: physical.socket,
      cleanup: "Retained until actual full Source/control cold coverage is established." }, null, 2));
    await physical.snapshot();
    const normalize = (value: string) => value.split("\n").filter(line => !line.startsWith("\\restrict ") && !line.startsWith("\\unrestrict ")).join("\n");
    const preservation = await Promise.all(["schema", "data"].map(async kind => ({ kind, unchanged: normalize(await fs.readFile(path.join(evidence, `initial-${kind}.sql`), "utf8"))
      === normalize(await fs.readFile(path.join(evidence, `final-${kind}.sql`), "utf8")) })));
    await fs.writeFile(path.join(evidence, "actual-source-preservation.json"), JSON.stringify(preservation, null, 2));
    expect(preservation.every(value => value.unchanged)).toBe(true);
  }
}, 600000);

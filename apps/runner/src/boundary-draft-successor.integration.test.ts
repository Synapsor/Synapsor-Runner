import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onboard } from "./guided-start.js";
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { readBoundaryDraftExchange, writeBoundaryDraftExchange } from "./boundary-draft-bundle.js";
import { readStructuredDraftSuccessorInventory, structuredDraftSuccessorSourceMatches } from "./boundary-draft-successor.js";
import { readActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { loadBoundaryReviewContext } from "./boundary-commands.js";
import { OperatorAuthorityRepository } from "./control-policy-operator-repository.js";
import { newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import { ownedProgramDraft, ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import * as actionDraft from "./action-rule-draft.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-draft-successor-")); roots.push(root);
  vi.stubEnv("SUCCESSOR_OWNED_READ_URL", "postgresql://fixture.invalid/not-used");
  const inspect = vi.fn(async () => ownedProgramInspection());
  let output = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
  expect(await onboard(["db", "--project-root", root, "--from-env", "SUCCESSOR_OWNED_READ_URL", "--schema", "studio", "--json"],
    { interactive: false, schemaInspector: inspect })).toBe(0);
  const run = async (args: string[], review?: BoundaryReviewInteractiveSession) => { output = ""; const exit = await structuredBoundaryAuthoringCommand(["--project-root", root, ...args, "--json"], inspect, review); return { exit, output: JSON.parse(output) }; };
  return { root, inspect, run, write };
}
async function fixture(count = 50) {
  const original = await project();
  expect(await original.run(["--export-draft", "template.json"])).toMatchObject({ exit: 0 });
  const input: any = await readBoundaryDraftExchange(original.root, "template.json");
  input.schema_version = "synapsor.boundary-draft-input.v2";
  input.read.resources = [{ resource_id: "studio.parcels", include: true, tenant_key: "tenant_id", principal_key: "principal_id", row_identity: "parcel_id",
    selectable_fields: ["label", "units", "available", "version"], keep_out_fields: ["internal_note"], withhold_from_model_fields: ["available", "version"], private_model_fields: ["available", "version"] }];
  input.actions = Array.from({ length: count }, (_, index) => {
    const action = ownedProgramDraft(index + 1);
    action.review.when = "The parcel is available. ".repeat(40);
    action.review.then = "Record requested units. ".repeat(40);
    action.review.human_review = "One parcel reviewer decides. ".repeat(30);
    action.review.refused = Array.from({ length: 16 }, () => "Unavailable parcels are refused. ".repeat(15));
    return action;
  });
  input.action_skeleton_candidates = { resources: [], relationships: [], subject_ref_resource_candidates: [] };
  input.action_skeletons = Array.from({ length: 64 }, (_, index) => ({ state: "incomplete", intent_index: index,
    intent: `Pack parcel type ${index + 1} with bounded supplied units and human review.`, candidates_ref: "/action_skeleton_candidates",
    resume: { revision_digest: `sha256:${"d".repeat(64)}`, old_operation_id: "historical-operation-never-imported" },
    continuation: index < count ? { state: "exact_current_draft", outcome: input.actions[index].outcome,
      digest: canonicalJsonDigest(input.actions[index]), draft_ref: `/actions/${index}` } : { state: "unprepared" } }));
  const source = policyTextSnapshot(Buffer.from("Available parcels may receive bounded requested units. One human reviewer must decide every proposal."), "rules.txt");
  input.attached_sources = [{ name: source.name, text: source.text, digest: source.digest, version: source.version }];
  await writeBoundaryDraftExchange({ projectRoot: original.root, supplied: "agenda.json", payload: input });
  original.write.mockRestore();
  const destination = await project();
  await fs.copyFile(path.join(original.root, "agenda.json"), path.join(destination.root, "agenda.json"));
  try { await fs.cp(path.join(original.root, "agenda.json.parts"), path.join(destination.root, "agenda.json.parts"), { recursive: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const page = (number: number, extra: string[] = []) => destination.run(["--draft", "agenda.json", "--successor", "--action-page", String(number), "--yes", ...extra]);
  return { ...destination, originalRoot: original.root, input, source, page };
}

describe("explicit disabled successor pages", () => {
  it.each([50, 64])("keeps the complete %i-Action/64-intent agenda across pages, restart inspection and duplicate page", async count => {
    const f = await fixture(count);
    expect(await f.page(1)).toMatchObject({ exit: 0, output: { state: "saved_disabled", successor: { selected_page: 1, total_actions: count, total_intents: 64, readiness: false } } });
    let inspected = await readStructuredDraftSuccessorInventory(f.root);
    expect(inspected).toMatchObject({ status: "present", current_binding_matches: true, readiness: false });
    if (inspected.status !== "present") throw new Error("Missing complete successor inventory");
    expect(inspected.inventory.actions).toHaveLength(count); expect(inspected.inventory.intents).toHaveLength(64);
    expect(inspected.pages[0]!.matching_current_disabled_outcomes).toHaveLength(12);
    expect(inspected.pending_pages).toEqual(Array.from({ length: Math.ceil(count / 12) - 1 }, (_, index) => index + 2));
    expect(JSON.stringify(inspected.inventory)).not.toContain("historical-operation-never-imported");
    expect(JSON.stringify(inspected.inventory)).not.toContain("continuation");
    expect(JSON.stringify(inspected.inventory)).not.toContain("provider");
    const inventoryFile = path.join(f.root, ".synapsor/boundary-authoring/structured-successor/inventory.json");
    const immutableBefore = await fs.readFile(inventoryFile), firstContext = await loadBoundaryReviewContext(f.root);
    expect(await f.page(1)).toMatchObject({ exit: 0, output: { policy_epoch: firstContext.bundle.mutation_bindings.authoring!.epoch } });
    expect((await loadBoundaryReviewContext(f.root)).bundle.mutation_bindings.authoring).toEqual(firstContext.bundle.mutation_bindings.authoring);
    for (let number = 2; number <= Math.ceil(count / 12); number++) expect(await f.page(number)).toMatchObject({ exit: 0 });
    expect(await fs.readFile(inventoryFile)).toEqual(immutableBefore);
    inspected = await readStructuredDraftSuccessorInventory(f.root);
    expect(inspected).toMatchObject({ status: "present", pending_pages: [], pending_intent_indexes: Array.from({ length: 64 - count }, (_, index) => count + index), source_material_state: "untrusted_not_attached", readiness: false });
    const context = await loadBoundaryReviewContext(f.root), authority = await readActionRuleAuthorityDraft(f.root, `${context.candidate.pack.name}_rules`);
    expect(authority!.authority.rules).toHaveLength(count); expect(authority!.state).toBe("disabled");
    expect(inspected.status === "present" && structuredDraftSuccessorSourceMatches(inspected.inventory, undefined)).toEqual([{ name: f.source.name, digest: f.source.digest, attached_current: false }]);
    const fresh = newPolicySourceSession(); fresh.snapshots = [policyTextSnapshot(Buffer.from(f.source.text), f.source.name, 3)];
    expect(inspected.status === "present" && structuredDraftSuccessorSourceMatches(inspected.inventory, fresh)).toEqual([{ name: f.source.name, digest: f.source.digest, attached_current: true }]);
    await expect(fs.lstat(path.join(f.root, ".synapsor/boundary-authoring/resume.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("requires explicit page/confirmation and keeps dry-run completely draft-only", async () => {
    const f = await fixture(20);
    expect(await f.run(["--draft", "agenda.json", "--successor", "--yes"])).toMatchObject({ exit: 2 });
    expect(await f.run(["--draft", "agenda.json", "--successor", "--action-page", "1"])).toMatchObject({ exit: 2, output: { code: "STRUCTURED_DRAFT_SUCCESSOR_CONFIRMATION_REQUIRED" } });
    expect(await f.run(["--draft", "agenda.json", "--successor", "--action-page", "0", "--dry-run"])).toMatchObject({ exit: 2 });
    expect(await f.run(["--draft", "agenda.json", "--successor", "--action-page", "1", "--dry-run"])).toMatchObject({ exit: 0, output: { state: "validated_disabled_preview", successor: { selected_page: 1 } } });
    expect(await readStructuredDraftSuccessorInventory(f.root)).toEqual({ status: "none" });
    expect(await f.run(["--draft", "agenda.json", "--yes"])).toMatchObject({ exit: 2, output: { code: "STRUCTURED_DRAFT_STALE" } });
  });

  it("refuses the original control-store identity and an unresolved destination job", async () => {
    const f = await fixture(20);
    let output = ""; f.write.mockImplementation(chunk => { output += String(chunk); return true; });
    expect(await structuredBoundaryAuthoringCommand(["--project-root", f.originalRoot, "--draft", "agenda.json", "--successor", "--action-page", "1", "--yes", "--json"], f.inspect)).toBe(2);
    expect(JSON.parse(output).code).toBe("STRUCTURED_DRAFT_SUCCESSOR_INVALID");
    await fs.mkdir(path.join(f.root, ".synapsor/boundary-authoring"), { recursive: true });
    await fs.writeFile(path.join(f.root, ".synapsor/boundary-authoring/resume.json"), "{}");
    f.write.mockRestore();
    // Restore this fixture's normal capture after the direct original-project call.
    const capture = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await structuredBoundaryAuthoringCommand(["--project-root", f.root, "--draft", "agenda.json", "--successor", "--action-page", "1", "--yes", "--json"], f.inspect)).toBe(2);
    capture.mockRestore();
    expect(await readStructuredDraftSuccessorInventory(f.root)).toEqual({ status: "none" });
  });

  it("rolls back only newly staged files on definite refusal and preserves page-one agenda when page two fails", async () => {
    const f = await fixture(20);
    vi.spyOn(OperatorAuthorityRepository.prototype, "commitReadAuthoring").mockRejectedValueOnce(Object.assign(new Error("exact conflict"), { code: "POLICY_REVISION_CONFLICT" }));
    expect(await f.page(1)).toMatchObject({ exit: 2, output: { code: "POLICY_REVISION_CONFLICT", disabled_authority_changed: false } });
    expect(await readStructuredDraftSuccessorInventory(f.root)).toEqual({ status: "none" });
    expect(await f.page(1)).toMatchObject({ exit: 0 });
    const file = path.join(f.root, ".synapsor/boundary-authoring/structured-successor/inventory.json"), before = await fs.readFile(file);
    vi.spyOn(OperatorAuthorityRepository.prototype, "commit").mockRejectedValueOnce(Object.assign(new Error("exact conflict"), { code: "POLICY_REVISION_CONFLICT" }));
    expect(await f.page(2)).toMatchObject({ exit: 2, output: { disabled_authority_changed: false } });
    expect(await fs.readFile(file)).toEqual(before);
    expect(await readStructuredDraftSuccessorInventory(f.root)).toMatchObject({ status: "present", pending_pages: [2] });
    await expect(fs.lstat(path.join(f.root, ".synapsor/boundary-authoring/structured-successor/page-002.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the full agenda after a lost disabled commit acknowledgement and reports unknown publication", async () => {
    const f = await fixture(20), commit = OperatorAuthorityRepository.prototype.commitReadAuthoring;
    vi.spyOn(OperatorAuthorityRepository.prototype, "commitReadAuthoring").mockImplementationOnce(async function(this: OperatorAuthorityRepository, input) {
      await commit.call(this, input); throw new Error("lost commit acknowledgement");
    });
    expect(await f.page(1)).toMatchObject({ exit: 2, output: { disabled_authority_changed: "unknown" } });
    expect(await readStructuredDraftSuccessorInventory(f.root)).toMatchObject({ status: "present", current_binding_matches: true, pending_pages: [2], readiness: false });
  });

  it("rejects changed agenda membership after first page without replacing retained work", async () => {
    const f = await fixture(20); expect(await f.page(1)).toMatchObject({ exit: 0 });
    const changed = structuredClone(f.input); changed.actions[19].review.when = "A changed operator explanation.";
    await writeBoundaryDraftExchange({ projectRoot: f.root, supplied: "changed.json", payload: changed });
    expect(await f.run(["--draft", "changed.json", "--successor", "--action-page", "2", "--yes"])).toMatchObject({ exit: 2, output: { code: "STRUCTURED_DRAFT_SUCCESSOR_INVALID", disabled_authority_changed: false } });
    expect(await readStructuredDraftSuccessorInventory(f.root)).toMatchObject({ status: "present", pending_pages: [2] });
  });

  it("cancels ordinary counter review before creating a successor inventory or disabled Action", async () => {
    const f = await fixture(20), session = { chooseOption: vi.fn(async () => "cancel") } as unknown as BoundaryReviewInteractiveSession;
    expect(await f.run(["--draft", "agenda.json", "--successor", "--action-page", "1", "--yes", "--review-counters"], session)).toMatchObject({ exit: 2, output: { code: "ACTION_VERSION_REVIEW_CANCELLED", disabled_authority_changed: false } });
    expect(session.chooseOption).toHaveBeenCalled();
    expect(await readStructuredDraftSuccessorInventory(f.root)).toEqual({ status: "none" });
    const context = await loadBoundaryReviewContext(f.root);
    expect(await readActionRuleAuthorityDraft(f.root, `${context.candidate.pack.name}_rules`)).toBeUndefined();
  });

  it("refuses final Source role drift before staging any successor page", async () => {
    const f = await fixture(20), compile = actionDraft.compileActionRuleModelDraft;
    let changed = false;
    vi.spyOn(actionDraft, "compileActionRuleModelDraft").mockImplementation((...args) => { const result = compile(...args); changed = true; return result; });
    f.inspect.mockImplementation(async () => { const inspection = ownedProgramInspection(); if (changed) inspection.role_posture!.read_only = false; return inspection; });
    expect(await f.page(1)).toMatchObject({ exit: 2, output: { code: "STRUCTURED_DRAFT_STALE", disabled_authority_changed: false } });
    expect(await readStructuredDraftSuccessorInventory(f.root)).toEqual({ status: "none" });
  });
});

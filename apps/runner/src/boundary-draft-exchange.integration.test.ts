import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onboard } from "./guided-start.js";
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { readBoundaryDraftExchange, writeBoundaryDraftExchange } from "./boundary-draft-bundle.js";
import { loadBoundaryReviewContext } from "./boundary-commands.js";
import { readActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { newPolicySourceSession, policyTextSnapshot, savePolicySources, loadPolicySources } from "./authoring-policy-source.js";
import { ownedProgramDraft, ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";
import * as actionDraft from "./action-rule-draft.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const readRequests = [{ resource_id: "studio.parcels", include: true, tenant_key: "tenant_id", principal_key: "principal_id", row_identity: "parcel_id",
  selectable_fields: ["label", "units", "available", "version"], keep_out_fields: ["internal_note"], withhold_from_model_fields: ["available", "version"], private_model_fields: ["available", "version"] }];
function detailedDraft(index: number) {
  const draft = ownedProgramDraft(index);
  // Bounded, repeated operator explanations exercise real existing schema
  // limits. Their text is not a Source-fidelity oracle or model response.
  draft.review.when = "The parcel is available. ".repeat(40);
  draft.review.then = "Record requested units. ".repeat(40);
  draft.review.human_review = "One parcel reviewer decides. ".repeat(30);
  draft.review.refused = Array.from({ length: 16 }, () => "Unavailable parcels are refused. ".repeat(15));
  return draft;
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-exchange-handler-")); roots.push(root);
  vi.stubEnv("EXCHANGE_OWNED_READ_URL", "postgresql://fixture.invalid/not-used");
  const inspector = vi.fn(async () => ownedProgramInspection());
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
  expect(await onboard(["db", "--project-root", root, "--from-env", "EXCHANGE_OWNED_READ_URL", "--schema", "studio", "--json"],
    { interactive: false, schemaInspector: inspector })).toBe(0);
  const run = async (args: string[]) => { output = ""; const exit = await structuredBoundaryAuthoringCommand(["--project-root", root, ...args, "--json"], inspector); return { exit, output: JSON.parse(output) }; };
  return { root, inspector, run };
}

describe("coherent bounded draft handler", () => {
  it.each([20, 50, 64])("preserves all %i disabled Actions, complete pending agenda and inert Source across export/reimport", async count => {
    const f = await fixture();
    let context = await loadBoundaryReviewContext(f.root);
    const binding = () => ({ boundary_name: context.candidate.pack.name, generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
      schema_fingerprint: context.lock.schema_fingerprint, role_posture_fingerprint: context.lock.role_posture_fingerprint });
    const intents = Array.from({ length: 64 }, (_, index) => `Pack parcel type ${index + 1} with bounded supplied units and human review.`);
    const sources = newPolicySourceSession(), source = policyTextSnapshot(Buffer.from("Available parcels may receive bounded requested units. All proposals require one human parcel reviewer."), "owned-rules.txt");
    sources.snapshots = [source]; sources.active = source.version;
    await savePolicySources(f.root, sources);
    let resume = buildBoundaryAuthoringResumeState({ binding: binding(), stage: "action_drafting", jobIntent: "Prepare every selected parcel program proposal.",
      provider: "openai", model: "owned-offline-no-provider", policySourceSession: sources.id, action: { intent: intents[0]!, intents, strategy: "rule_derived" } });
    await writeBoundaryAuthoringResumeState(f.root, resume, { expectedRevisionDigest: null });
    for (let start = 0; start < count; start += 12) {
      expect(await f.run(["--export-draft", `before-${start}.json`])).toMatchObject({ exit: 0 });
      const input: any = await readBoundaryDraftExchange(f.root, `before-${start}.json`);
      input.read.resources = readRequests;
      input.actions.push(...Array.from({ length: Math.min(12, count - start) }, (_, index) => detailedDraft(start + index + 1)));
      await writeBoundaryDraftExchange({ projectRoot: f.root, supplied: `submit-${start}.json`, payload: input });
      expect(await f.run(["--draft", `submit-${start}.json`])).toMatchObject({ exit: 0, output: { state: "saved_disabled" } });
      context = await loadBoundaryReviewContext(f.root);
      const previous = resume.revision_digest;
      resume = buildBoundaryAuthoringResumeState({ binding: binding(), previous: resume, stage: count === 64 && start + 12 >= count ? "authority_review" : "action_drafting",
        jobIntent: resume.job_intent, provider: "openai", model: "owned-offline-no-provider", policySourceSession: sources.id,
        action: { intent: intents[0]!, intents, completed_outcomes: Array.from({ length: Math.min(count, start + 12) }, (_, index) => ownedProgramDraft(index + 1).outcome), strategy: "rule_derived" } });
      await writeBoundaryAuthoringResumeState(f.root, resume, { expectedRevisionDigest: previous });
    }
    const exported = await f.run(["--export-draft", "complete.json"]);
    expect(exported).toMatchObject({ exit: 0, output: { format: count === 20 ? "json" : "bundle", source_database_changed: false, active_authority_changed: false, disabled_authority_changed: false } });
    const input: any = await readBoundaryDraftExchange(f.root, "complete.json");
    expect(input.actions.map((draft: any) => draft.outcome)).toEqual(Array.from({ length: count }, (_, index) => ownedProgramDraft(index + 1).outcome).sort());
    expect(input.action_skeletons).toHaveLength(64);
    expect(input.attached_sources).toEqual([{ name: source.name, text: source.text, version: source.version, digest: source.digest }]);
    expect(JSON.stringify(input)).not.toContain(sources.id);
    expect(input.notes).toMatchObject({ source_material_state: "untrusted_not_attached", activation: "not_available_from_this_input" });
    const before = await readActionRuleAuthorityDraft(f.root, `${context.candidate.pack.name}_rules`);
    expect(await f.run(["--draft", "complete.json", "--dry-run"])).toMatchObject({ exit: 0, output: { state: "validated_disabled_preview" } });
    expect((await readActionRuleAuthorityDraft(f.root, before!.authority.name))!.digest).toBe(before!.digest);
    expect(f.inspector).toHaveBeenCalled(); // supplied metadata inspection, not a real Source call
    if (process.env.AUTHORING_EXCHANGE_METRICS) {
      const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
      const records = [
        ...input.actions.map((value: any, index: number) => ({ identity: value.outcome, kind: "action", index, value })),
        ...input.action_skeletons.map((value: any, index: number) => ({ identity: `intent-${value.intent_index}`, kind: "skeleton", index, value })),
        ...input.attached_sources.map((value: any, index: number) => ({ identity: value.name, kind: "source", index, value })),
        ...["action_authoring_catalog", "read_authoring_catalog", "action_skeleton_candidates"].map(key => ({ identity: key, kind: "property", value: input[key] })),
      ].map(({ identity, ...record }) => ({ identity, kind: record.kind, compact_bytes: bytes(record.value), typed_record_bytes: bytes(record) }));
      await fs.writeFile(path.join(process.env.AUTHORING_EXCHANGE_METRICS, `handler-${count}-records.json`), JSON.stringify({
        actions: count, intents: 64, format: exported.output.format, exchange_bytes: exported.output.bytes,
        payload_compact_bytes: bytes(input), payload_pretty_bytes: Buffer.byteLength(JSON.stringify(input, null, 2) + "\n"),
        records, max_typed_record_bytes: Math.max(...records.map(record => record.typed_record_bytes)),
        authority_digest: before!.digest, provider_calls: 0, source_calls: 0,
        scope: "owned expanded bounded declarations through current handler; supplied metadata inspector; not installed CLI or Source fidelity proof",
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
  }, 120_000);

  it("captures Source before a competing coordinated Source replacement", async () => {
    const f = await fixture(), context = await loadBoundaryReviewContext(f.root), sources = newPolicySourceSession();
    const original = policyTextSnapshot(Buffer.from("Original complete operator Source."), "rules.txt");
    sources.snapshots = [original]; sources.active = original.version; await savePolicySources(f.root, sources);
    const binding = { boundary_name: context.candidate.pack.name, generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
      schema_fingerprint: context.lock.schema_fingerprint, role_posture_fingerprint: context.lock.role_posture_fingerprint };
    const resume = buildBoundaryAuthoringResumeState({ binding, stage: "planning", jobIntent: "Inspect untrusted proposals.", provider: "openai", model: "owned-offline", policySourceSession: sources.id });
    await writeBoundaryAuthoringResumeState(f.root, resume, { expectedRevisionDigest: null });
    let entered!: () => void, release!: () => void;
    const captureEntered = new Promise<void>(resolve => { entered = resolve; }), captureRelease = new Promise<void>(resolve => { release = resolve; });
    f.inspector.mockImplementationOnce(async () => { entered(); await captureRelease; return ownedProgramInspection(); });
    const exporting = f.run(["--export-draft", "coherent.json"]); await captureEntered;
    const next = { ...sources, snapshots: [policyTextSnapshot(Buffer.from("Replaced current operator Source."), "rules.txt")] };
    let replacementDone = false;
    const replacement = savePolicySources(f.root, next).then(() => { replacementDone = true; });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(replacementDone).toBe(false);
    release(); expect(await exporting).toMatchObject({ exit: 0 }); await replacement;
    expect((await readBoundaryDraftExchange(f.root, "coherent.json") as any).attached_sources[0].text).toBe(original.text);
    expect((await loadPolicySources(f.root, sources.id)).snapshots[0]!.text).toBe(next.snapshots[0]!.text);
  });

  it("rechecks Source role posture after compilation and refuses a drifted disabled save", async () => {
    const f = await fixture(); expect(await f.run(["--export-draft", "initial.json"])).toMatchObject({ exit: 0 });
    const input: any = await readBoundaryDraftExchange(f.root, "initial.json"); input.read.resources = readRequests; input.actions = [ownedProgramDraft(1)];
    await fs.writeFile(path.join(f.root, "submit.json"), JSON.stringify(input));
    let changed = false;
    const original = actionDraft.compileActionRuleModelDraft;
    vi.spyOn(actionDraft, "compileActionRuleModelDraft").mockImplementation((...args) => { const result = original(...args); changed = true; return result; });
    f.inspector.mockImplementation(async () => { const inspection = ownedProgramInspection(); if (changed) inspection.role_posture!.read_only = false; return inspection; });
    expect(await f.run(["--draft", "submit.json"])).toMatchObject({ exit: 2, output: { code: "STRUCTURED_DRAFT_STALE", disabled_authority_changed: false } });
    const context = await loadBoundaryReviewContext(f.root);
    expect(await readActionRuleAuthorityDraft(f.root, `${context.candidate.pack.name}_rules`)).toBeUndefined();
  });
});

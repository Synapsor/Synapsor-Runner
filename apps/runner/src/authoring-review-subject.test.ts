// Verification fixture reuses the existing billing preference rule. No business source is connected.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterEach, describe, it, expect, vi} from "vitest";
import {canonicalJsonDigest} from "@synapsor-runner/protocol";
import {ControlPolicyRepository} from "@synapsor-runner/proposal-store";
import {type RuntimeConfig} from "@synapsor-runner/mcp-server";
import type {ActionRuleCatalogV1} from "@synapsor-runner/action-rules";
import type {ActionRuleScalarTypeSpecV1, ActionRuleSpecV1, DerivedEffectEnvelopeSpecV1, RuleVerificationBoundarySpecV1} from "@synapsor/spec";
import type {SchemaInspection} from "@synapsor-runner/schema-inspector";
import {buildAutoBoundary, activateExplorationBoundary, writeAutoBoundaryArtifacts, explorationBoundaryCandidateDigest,
  AUTO_BOUNDARY_OVERRIDES_VERSION, type ActivatedExplorationBoundary} from "./auto-boundary.js";
import {recommendedBoundaryReviewCandidate} from "./boundary-candidate.js";
import {buildActionRuleAuthorityDraft, writeActionRuleAuthorityDraft, activateActionRuleAuthority, readActionRuleReviewSubjects, readActionRuleAuthorityDraft, deactivateActionRuleAuthority,
  readActionRuleCoverageLineage, removeOutcomeActionRuleAuthorityDraft} from "./action-rule-authority.js";
import {encodeOperatorAuthority, validateOperatorPolicySnapshot} from "./control-policy-authority-codec.js";
import {migrateProjectControlPolicies} from "./control-policy-store.js";
let generationLock = `sha256:${"a".repeat(64)}` as const;
const stateType: ActionRuleScalarTypeSpecV1 = {kind: "string", max_length: 16, comparison: "exact", enum: ["active", "paused"]};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(backend: "sqlite" | "postgres" | "legacy" = "sqlite") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-review-subject-"));
  cleanup.push(() => fs.rm(root, {recursive: true, force: true}));
  const {read, build, candidate} = await reviewedRead(root), source = authoritySource();
  const schema = `review_subject_${randomUUID().replaceAll("-", "")}`;
  const storePath = path.join(root, ".synapsor/control.db");
  const config: RuntimeConfig = {version: 1, mode: "review", storage: backend !== "postgres" ? {sqlite_path: storePath} : {
    shared_postgres: {mode: "runtime_store", url_env: "SYNAPSOR_TEST_POSTGRES_URL", schema}}, capabilities: [],
    sources: {local_postgres: {engine: "postgres", read_url_env: "DATABASE_URL"}},
    trusted_context: {provider: "static_dev", values: {tenant_id: "fixture", principal: "fixture"}}, action_rules: {project_root: root}};
  const records = [encodeOperatorAuthority({type: "read", boundary: read, generation_lock: build.lock}),
    encodeOperatorAuthority({type: "read_selection", selected_name: read.pack.name})];
  const binding = backend === "legacy" ? undefined : (await migrateProjectControlPolicies({projectRoot: root, config, storePath, actor: "fixture reviewer",
    readLegacySnapshot: async () => ({revisions: records, active: records.map(r => ({scope: r.scope, kind: r.kind, name: r.name, revision_id: r.revision_id})), drafts: [], provenance: []}),
    validateSnapshot: async snapshot => validateOperatorPolicySnapshot(snapshot, {runtimeConfig: config})})).binding;
  cleanup.push(async () => { await binding?.close(); if(backend === "postgres") { const pool = new Pool({connectionString: process.env.SYNAPSOR_TEST_POSTGRES_URL});
    try { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await pool.end(); } } });
  await fs.writeFile(path.join(root, "synapsor.runner.json"), JSON.stringify(config));
  const make = (ttl = 300) => buildActionRuleAuthorityDraft({ name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
    rules: [{read_boundary_name: read.pack.name, read_boundary_digest: read.activation.digest, verification_boundary: source.verification,
      effect_envelope: source.envelope, rule: {...source.rule, ttl_seconds: ttl}}], reviews: [{outcome: source.rule.outcome,
      when: "The preference is active.", then: "Propose pausing notifications.", refused: ["Already paused."], human_review: "A reviewer approves.",
      examples: [{kind: "eligible", scenario: "Active preference", result: "One proposal"}]}] });
  const draft = make(); await writeActionRuleAuthorityDraft(root, draft);
  const subject = (await readActionRuleReviewSubjects(root))[0]!;
  const context = {source_session: randomUUID(), source_digest: canonicalJsonDigest("complete attached source"),
    read_name: read.pack.name, read_digest: read.activation.digest};
  const request = {operation: "review_rules" as const, request: "Review existing rules", source_session: context.source_session,
    source_digest: context.source_digest, read_digest: context.read_digest, action_name: draft.authority.name,
    action_digest: draft.digest, action_subject: subject.identity};
  const resumeBinding = {boundary_name: read.pack.name, generation_lock_fingerprint: read.generation_lock_fingerprint,
    schema_fingerprint: build.lock.schema_fingerprint, role_posture_fingerprint: read.role_posture_fingerprint};
  const resume = buildBoundaryAuthoringResumeState({binding: resumeBinding, stage: "authority_review", jobIntent: "Maintain preferences",
    provider: "openai", model: "fixture", policySourceSession: context.source_session,
    action: {intent: "Maintain preferences", outcome: source.rule.outcome, strategy: "rule_derived", completed_outcomes: [source.rule.outcome]},
    completedPolicyReviews: [{request, report_digest: canonicalJsonDigest("review"), context_digest: canonicalJsonDigest("context"),
      activity: "validated_reuse", completed_at: new Date().toISOString()}]});
  const publish = (value = draft) => activateActionRuleAuthority({projectRoot: root, name: value.authority.name, expected_digest: value.digest,
    confirmation: `ACTIVATE ${value.digest}`, actor: "fixture reviewer"});
  const chooseOption = vi.fn(async () => "0");
  const resolve = (state = resume, selectedContext = context, explicit = true) => resolveAuthoringReviewSubject({projectRoot: root,
    resume: state, context: selectedContext, session: {chooseOption}, selectCurrentContext: explicit});
  return {root, binding, read, build, candidate, draft, make, publish, resolve, resume, resumeBinding, context, request, chooseOption};
}

for (const backend of ["sqlite", "postgres"] as const) describe.skipIf(backend === "postgres" && !process.env.SYNAPSOR_TEST_POSTGRES_URL)(`published authoring review (${backend})`, () => {
  it('reads exact reviewed removal from real repository activation records without creating authority', async () => {
    const f = await fixture(backend), original = authoritySource();
    const extra = 'billing.pause_reminders';
    const both = buildActionRuleAuthorityDraft({ name: f.draft.authority.name,
      action_boundary_name: f.draft.authority.action_boundary.name, catalog: original.catalog,
      rules: [original.rule, { ...original.rule, name: extra, outcome: extra }].map(rule => ({
        read_boundary_name: f.read.pack.name, read_boundary_digest: f.read.activation.digest,
        verification_boundary: original.verification, effect_envelope: original.envelope, rule })),
      reviews: [f.draft.reviews[0]!, { ...f.draft.reviews[0]!, outcome: extra }] });
    await writeActionRuleAuthorityDraft(f.root, both); await f.publish(both);
    const removed = removeOutcomeActionRuleAuthorityDraft({ existing: both, outcome: extra });
    // A disabled removal is not a completed publication.
    await writeActionRuleAuthorityDraft(f.root, removed);
    const readDigest = explorationBoundaryCandidateDigest(f.candidate);
    expect(await readActionRuleCoverageLineage(f.root, removed, readDigest)).toBeUndefined();
    const active = await f.publish(removed);
    const before = await readActionRuleReviewSubjects(f.root);
    const result = await readActionRuleCoverageLineage(f.root, active, readDigest);
    const prior = result!.origins.find(v => v.coverage_authority_digest === canonicalJsonDigest({read:readDigest,action:both.digest}));
    expect(prior?.authority.digest).toBe(both.digest);
    expect(prior?.transitions).toMatchObject([{before_digest:both.digest,after_digest:removed.digest,removed_outcomes:[extra],introduced_outcomes:[]}]);
    expect(await readActionRuleReviewSubjects(f.root)).toEqual(before);
    // Legacy copies have no repository activation chain; absence is unknown.
    const legacy = await fixture('legacy');
    expect(await readActionRuleCoverageLineage(legacy.root, legacy.draft, explorationBoundaryCandidateDigest(legacy.candidate))).toBeUndefined();
  });
  it("resolves the real publication after clearing its draft, persisting the reviewed subject and restarting", async () => {
    const f = await fixture(backend), before = await f.resolve();
    expect(before.subject?.identity.location).toBe("disabled");
    await writeBoundaryAuthoringResumeState(f.root, f.resume, {expectedRevisionDigest: null});
    const active = await f.publish();
    expect(await readActionRuleAuthorityDraft(f.root, f.draft.authority.name)).toBeUndefined();
    const reopened = await readBoundaryAuthoringResumeState(f.root, f.resumeBinding);
    expect(reopened.status).toBe("ready");
    const result = await f.resolve(reopened.status === "ready" ? reopened.value : f.resume);
    expect(result.subject).toMatchObject({authority: active, identity: {location: "active"}, published_from: before.subject!.identity.record});
    expect(result.subject!.identity.record).not.toBe(before.subject!.identity.record);
    await result.assertCurrent();
    expect(f.chooseOption).not.toHaveBeenCalled();
    expect(await readActionRuleAuthorityDraft(f.root, f.draft.authority.name)).toBeUndefined();
  });
  it('offers exact disabled and published subjects on explicit Review while Resume retains the pending target', async () => {
    const f = await fixture(backend), active = await f.publish();
    // Composed lifecycle: normal repository save retains the exact original
    // candidate after real publication, as in the authentic stopped project.
    await writeActionRuleAuthorityDraft(f.root, f.draft);
    const before = await readActionRuleReviewSubjects(f.root);
    const disabled = before.find(item => item.identity.location === 'disabled')!;
    const pending = {...f.resume, pending_policy_review: {...f.request, action_subject: disabled.identity}};
    const original = structuredClone(pending);
    expect((await f.resolve(pending, f.context, false)).subject?.identity).toEqual(disabled.identity);
    expect(f.chooseOption).not.toHaveBeenCalled();
    f.chooseOption.mockResolvedValueOnce('1');
    const selected = await f.resolve(pending);
    expect(selected.subject).toMatchObject({authority: active, identity: {location: 'active'}});
    expect(f.chooseOption).toHaveBeenCalledOnce();
    expect((f.chooseOption.mock.calls as unknown as [string, {label: string}[]][])[0]?.[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({label: expect.stringContaining('Disabled candidate')}),
      expect.objectContaining({label: expect.stringContaining('Active published')}),
    ]));
    expect(pending).toEqual(original);
    expect(await readActionRuleReviewSubjects(f.root)).toEqual(before);
  });
  it('cancels explicit subject choice without changing history or completing pending work', async () => {
    const f = await fixture(backend); await f.publish(); await writeActionRuleAuthorityDraft(f.root, f.draft);
    const before = await readActionRuleReviewSubjects(f.root);
    const pending = {...f.resume, pending_policy_review: {...f.request,
      action_subject: before.find(item => item.identity.location === 'disabled')!.identity}};
    const original = structuredClone(pending); f.chooseOption.mockResolvedValueOnce(undefined as never);
    expect(await f.resolve(pending)).toMatchObject({cancelled: true});
    expect(pending).toEqual(original); expect(await readActionRuleReviewSubjects(f.root)).toEqual(before);
  });
  it('retains the recorded exact active subject after restart despite an equal-value draft, while respecting a real pending edit', async () => {
    const f = await fixture(backend); await f.publish(); await writeActionRuleAuthorityDraft(f.root, f.draft);
    const active = (await readActionRuleReviewSubjects(f.root)).find(item => item.identity.location === 'active')!;
    // Normal resume factory record; this component control measures target
    // selection, not a claimed canonical BUSINESS report or public review.
    const completed = {...f.resume, completed_policy_reviews: [{...f.resume.completed_policy_reviews![0]!,
      request: {...f.request, action_subject: active.identity}}]};
    expect((await f.resolve(completed)).subject?.identity).toEqual(active.identity);
    expect(f.chooseOption).not.toHaveBeenCalled();
    const next = f.make(600); await writeActionRuleAuthorityDraft(f.root, next);
    const edit = {...completed, pending_action_revision: {outcome: next.authority.rules[0]!.rule.outcome,
      instruction: 'Change duration', baseline_digest: f.draft.digest,
      preparation: {read_digest: f.context.read_digest, authority_digest: f.draft.digest, prepared_digest: next.digest}}};
    const originalEdit = structuredClone(edit);
    expect((await f.resolve(edit)).subject?.authority.digest).toBe(next.digest);
    expect(edit).toEqual(originalEdit);
  });
  it('refuses publication drift during explicit subject choice and does not offer unproven active authority', async () => {
    const f = await fixture(backend); await f.publish(); await writeActionRuleAuthorityDraft(f.root, f.draft);
    const pending = {...f.resume, pending_policy_review: f.request};
    f.chooseOption.mockImplementationOnce(async () => { await writeActionRuleAuthorityDraft(f.root, f.make(600)); return '1'; });
    await expect(f.resolve(pending)).rejects.toThrow('POLICY_REVIEW_SUBJECT_CHANGED');
    expect(pending.pending_policy_review).toEqual(f.request);
    const unknown = await fixture(backend); await unknown.publish(); await writeActionRuleAuthorityDraft(unknown.root, unknown.draft);
    vi.spyOn(ControlPolicyRepository.prototype, 'history').mockResolvedValue([]);
    const selected = await unknown.resolve({...unknown.resume, pending_policy_review: unknown.request});
    expect(selected.subject?.identity.location).toBe('disabled');
    expect(unknown.chooseOption).not.toHaveBeenCalled();
  });
  it('reviews the current publication on first entry from an untouched completed historical-active job', async () => {
    const f = await fixture(backend); await f.publish();
    const old = (await readActionRuleReviewSubjects(f.root)).find(item => item.identity.location === 'active')!;
    const untouched = {...f.resume, completed_policy_reviews: [{...f.resume.completed_policy_reviews![0]!,
      request: {...f.request, action_subject: old.identity}}]};
    expect(untouched.pending_policy_review).toBeUndefined();
    expect(untouched.pending_action_revision).toBeUndefined();
    const next = f.make(600); await writeActionRuleAuthorityDraft(f.root, next); await f.publish(next);
    // Retain the real published candidate through the normal save API, as in
    // the authentic untouched start. Do not open Review to create a new anchor.
    await writeActionRuleAuthorityDraft(f.root, next);
    const subjects = await readActionRuleReviewSubjects(f.root);
    const active = subjects.find(item => item.identity.location === 'active')!;
    const disabled = subjects.find(item => item.identity.location === 'disabled')!;
    expect(active.prior_subjects).toContainEqual({record: old.identity.record, digest: old.authority.digest});
    expect(active.published_from).toBe(disabled.identity.record);
    const before = structuredClone(untouched);
    expect((await f.resolve(untouched)).subject?.identity).toEqual(active.identity);
    expect(f.chooseOption).not.toHaveBeenCalled();
    expect(untouched).toEqual(before);
    expect(await readActionRuleReviewSubjects(f.root)).toEqual(subjects);
    // This is an explicit current review, not an automatic retarget of Resume.
    expect((await f.resolve(untouched, f.context, false)).subject?.identity).toEqual(disabled.identity);
    const edit = {...untouched, pending_action_revision: {outcome: next.authority.rules[0]!.rule.outcome,
      instruction: 'Review this exact saved edit', baseline_digest: f.draft.digest,
      preparation: {read_digest: f.context.read_digest, authority_digest: f.draft.digest, prepared_digest: next.digest}}};
    expect((await f.resolve(edit)).subject?.identity).toEqual(disabled.identity);
    expect(edit.pending_action_revision.preparation.prepared_digest).toBe(next.digest);
    const selected = await f.resolve(untouched);
    await writeActionRuleAuthorityDraft(f.root, f.make(900));
    await expect(selected.assertCurrent()).rejects.toThrow('POLICY_REVIEW_SUBJECT_CHANGED');
    expect(untouched).toEqual(before);
  });
  it('does not infer that an unrelated disabled save is the historical candidate of the current publication', async () => {
    const f = await fixture(backend); await f.publish();
    const old = (await readActionRuleReviewSubjects(f.root)).find(item => item.identity.location === 'active')!;
    const untouched = {...f.resume, completed_policy_reviews: [{...f.resume.completed_policy_reviews![0]!,
      request: {...f.request, action_subject: old.identity}}]};
    const next = f.make(600); await writeActionRuleAuthorityDraft(f.root, next); await f.publish(next);
    const other = {...next, created_at: '2026-09-26T00:00:00.000Z'};
    await writeActionRuleAuthorityDraft(f.root, other);
    const subjects = await readActionRuleReviewSubjects(f.root);
    const active = subjects.find(item => item.identity.location === 'active')!;
    const disabled = subjects.find(item => item.identity.location === 'disabled')!;
    expect(active.published_from).not.toBe(disabled.identity.record);
    expect(active.authority.digest).toBe(disabled.authority.digest);
    expect((await f.resolve(untouched)).subject?.identity).toEqual(disabled.identity);
    expect(f.chooseOption).not.toHaveBeenCalled();
  });
  it("preserves exact pending edits and explicitly distinguishes another current publication", async () => {
    const f = await fixture(backend); await f.publish();
    const next = f.make(600); await writeActionRuleAuthorityDraft(f.root, next);
    const activeSubject = (await readActionRuleReviewSubjects(f.root)).find(item => item.identity.location === "active")!;
    const pending = {...f.resume, pending_action_revision: {outcome: next.authority.rules[0]!.rule.outcome, instruction: "Change duration",
      baseline_digest: f.draft.digest, preparation: {read_digest: f.context.read_digest, authority_digest: f.draft.digest, prepared_digest: next.digest}}};
    expect((await f.resolve(pending)).subject?.authority.digest).toBe(next.digest);
    const explicitActive = {...pending, pending_policy_review: {...f.request, action_subject: activeSubject.identity}};
    expect((await f.resolve(explicitActive)).subject?.identity).toEqual(activeSubject.identity);
    expect(explicitActive.pending_action_revision).toEqual(pending.pending_action_revision);
    const choices = await f.resolve(); expect(f.chooseOption).toHaveBeenCalled();
    expect(choices.subject?.identity.location).toBe("disabled");
    await f.publish(next);
    await expect(f.resolve(pending)).rejects.toThrow("POLICY_REVIEW_CANDIDATE_CHANGED");
    const reviewPending = {...f.resume, pending_policy_review: f.request};
    await expect(f.resolve(reviewPending, f.context, false)).rejects.toThrow("POLICY_REVIEW_CANDIDATE_CHANGED");
    f.chooseOption.mockClear();
    expect((await f.resolve()).subject?.authority.digest).toBe(next.digest);
    expect(f.chooseOption).toHaveBeenCalledOnce(); // deliberate current review, never inferred completion
  });
  it.each(["source", "read", "record", "store", "unrelated", "revoked"])("refuses a mismatched or unavailable active subject: %s", async mode => {
    const f = await fixture(backend); await f.publish();
    const resume = structuredClone(f.resume), context = {...f.context};
    if(mode === "source") context.source_digest = canonicalJsonDigest("other source");
    if(mode === "read") context.read_digest = canonicalJsonDigest("other Read");
    if(mode === "record") resume.completed_policy_reviews![0]!.request.action_subject!.record = "policy:unrelated";
    if(mode === "store") resume.completed_policy_reviews![0]!.request.action_subject!.store = canonicalJsonDigest("other store");
    if(mode === "unrelated") resume.completed_policy_reviews![0]!.request.action_name = "unrelated_rules";
    if(mode === "revoked") await deactivateActionRuleAuthority(f.root);
    await expect(f.resolve(resume, context, false)).rejects.toThrow("POLICY_REVIEW_CANDIDATE_UNAVAILABLE");
    await expect(f.resolve(resume, context, true)).rejects.toThrow("POLICY_REVIEW_CANDIDATE_UNAVAILABLE");
  });
  it("rejects drift before persistence and leaves cancellation, pending work and Read-only jobs intact", async () => {
    const f = await fixture(backend); await f.publish();
    const prepared = await f.resolve(); const next = f.make(600); await writeActionRuleAuthorityDraft(f.root, next);
    await expect(prepared.assertCurrent()).rejects.toThrow("POLICY_REVIEW_SUBJECT_CHANGED");
    f.chooseOption.mockResolvedValueOnce(undefined as never);
    expect(await f.resolve()).toMatchObject({cancelled: true});
    expect(await readActionRuleAuthorityDraft(f.root, next.authority.name)).toEqual(next);
    expect((await f.resolve({...f.resume, action: undefined})).subject).toBeUndefined();
    await expect(f.resolve({...f.resume, pending_action_revision: {outcome: next.authority.rules[0]!.rule.outcome,
      instruction: "Unfinished change", baseline_digest: f.draft.digest}})).rejects.toThrow("POLICY_REVIEW_CANDIDATE_CHANGED");
  });
  it("does not equate a separately saved same-value record with the job's exact publication", async () => {
    const f = await fixture(backend);
    const other = {...f.draft, created_at: "2026-09-21T00:00:00.000Z"};
    await writeActionRuleAuthorityDraft(f.root, other); await f.publish(other);
    await expect(f.resolve(f.resume, f.context, false)).rejects.toThrow("POLICY_REVIEW_CANDIDATE_UNAVAILABLE");
    expect((await f.resolve()).subject?.identity.location).toBe("active");
    expect(f.chooseOption).toHaveBeenCalledOnce(); // explicit separate current-authority operation
  });
  it("refuses incomplete bounded publication history rather than treating active metadata as proof", async () => {
    const f = await fixture(backend); await f.publish();
    // Derived history-read control; the actual publication and stores are not rewritten.
    vi.spyOn(ControlPolicyRepository.prototype, "history").mockResolvedValue([]);
    await expect(f.resolve()).rejects.toThrow("POLICY_REVIEW_CANDIDATE_UNAVAILABLE");
  });
});

it("does not infer publication lineage from an active legacy file or a same-value unrelated review record", async () => {
  const f = await fixture("legacy"); await f.publish();
  expect((await readActionRuleReviewSubjects(f.root))[0]!.identity.location).toBe("active");
  await expect(f.resolve()).rejects.toThrow("POLICY_REVIEW_CANDIDATE_UNAVAILABLE");
});
import { resolveAuthoringReviewSubject } from "./authoring-review-subject.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
async function reviewedRead(root: string) {
  const columns = ["preference_id", "account_id", "principal_id", "status", "version"];
  const inspection: SchemaInspection = {
    engine: "postgres", server_version: "PostgreSQL 17", current_user: "reader", inspected_at: new Date().toISOString(),
    schemas: ["billing"], warnings: [], role_posture: {verified: true, superuser: false, bypass_rls: false, read_only: true,
      writable_relations: [], owned_relations: [], reasons: []},
    tables: [{schema: "billing", name: "preferences", type: "table", writable: false,
      columns: columns.map((name, ordinal_position) => ({name, ordinal_position, data_type: name === "version" ? "integer" : "text",
        nullable: false, generated: false, suggestions: {tenant: name === "account_id", conflict: name === "version", sensitive: false,
          immutable: name.endsWith("id"), large_or_binary: false}})),
      primary_key: ["preference_id"], unique_constraints: [{name: "preferences_pkey", columns: ["preference_id"]}],
      check_constraints: [], foreign_keys: [], row_level_security: false, indexes: [],
      role_posture: {owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: {select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false},
        row_security_forced: false, row_security_effective_for_current_role: false},
      suggestions: {tenant_columns: ["account_id"], conflict_columns: ["version"], sensitive_columns: [], default_visible_columns: ["status"]}}],
  };
  const reviewed = (value: string) => ({value, actor: "fixture_operator", reason: "Reviewed existing preference scope", decided_at: new Date().toISOString()});
  const build = buildAutoBoundary({inspection, inspectedSchema: "billing", sourceEnv: "DATABASE_URL", deploymentProfile: "staging",
    overrides: {schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION, resources: {"billing.preferences": {
      tenant_key: reviewed("account_id"), principal_key: reviewed("principal_id")}}},
    project: {root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"]}});
  const candidate = recommendedBoundaryReviewCandidate(build.exploration_boundary);
  await writeAutoBoundaryArtifacts({projectRoot: root, build});
  const read = await activateExplorationBoundary({projectRoot: root, candidate,
    expectedDigest: explorationBoundaryCandidateDigest(candidate), actor: "fixture_operator",
    confirmation: `ACTIVATE ${explorationBoundaryCandidateDigest(candidate)}`, confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection});
  generationLock = read.generation_lock_fingerprint;
  return {read, build, candidate};
}

function authoritySource(): {
  catalog: ActionRuleCatalogV1;
  verification: RuleVerificationBoundarySpecV1;
  envelope: DerivedEffectEnvelopeSpecV1;
  rule: ActionRuleSpecV1;
} {
  const exactString = { kind: "string", max_length: 64, comparison: "exact" } as const;
  const fields = [
    { name: "preference_id", type: exactString, nullable: false },
    { name: "account_id", type: exactString, nullable: false },
    { name: "principal_id", type: exactString, nullable: false },
    { name: "status", type: stateType, nullable: false },
    { name: "version", type: { kind: "integer" as const }, nullable: false },
  ];
  const catalog: ActionRuleCatalogV1 = { schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: generationLock,
    resources: [{ name: "billing.preferences", source: "local_postgres", engine: "postgres", schema: "billing", table: "preferences",
      primary_key: "preference_id", tenant_key: "account_id", principal_scope_key: "principal_id", version_field: "version", fields }], relationships: [] };
  const verification: RuleVerificationBoundarySpecV1 = { schema_version: "synapsor.verification-boundary.v1", name: "billing.pause_verification",
    source: "local_postgres", context: "trusted_context", generation_lock_fingerprint: generationLock, resources: [{ binding: "preference",
      resource: "billing.preferences", source: { kind: "subject_ref" }, primary_key: "preference_id", version_field: "version", fields,
      scope: { mode: "columns", tenant_field: "account_id", principal_field: "principal_id" }, cardinality: "one", max_rows: 1,
      overflow: "unsupported", lock: "for_update" }], lock_order: ["preference"], transaction: { isolation: "repeatable_read", timezone: "UTC" } };
  const envelope: DerivedEffectEnvelopeSpecV1 = { schema_version: "synapsor.derived-effect-envelope.v1", name: "billing.pause_effect",
    source: "local_postgres", operation: "update", target_resource: "billing.preferences", target_binding: "preference", primary_key: "preference_id",
    tenant_key: "account_id", principal_scope_key: "principal_id", conflict_key: "version", max_rows: 1,
    allowed_fields: [{ name: "status", type: stateType, values: ["paused"] }], version_advance: { column: "version", strategy: "integer_increment" },
    approval_classes: ["billing.standard_change"], writeback: { mode: "direct_sql", supervised_worker: "allowed" } };
  const rule: ActionRuleSpecV1 = { schema_version: "synapsor.action-rule.v1", name: "billing.pause_notifications", outcome: "billing.pause_notifications",
    context: "trusted_context", source: "local_postgres", verification_boundary_ref: verification.name, effect_envelope_ref: envelope.name,
    subjects: [{ binding: "preference", resource: "billing.preferences", input: "opaque_subject_ref" }], require: { kind: "compare", operator: "eq",
      left: { kind: "field", binding: "preference", field: "status" }, right: { kind: "literal", value: "active", value_type: stateType } }, derive: {},
    effect: { operation: "update", target_resource: "billing.preferences", target_binding: "preference",
      set: { status: { kind: "literal", value: "paused", value_type: stateType } } }, approval_class: "billing.standard_change", ttl_seconds: 300 };
  return { catalog, verification, envelope, rule };
}

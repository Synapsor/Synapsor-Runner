import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { ScopedCatalogSession, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import type {
  ActionRuleSpecV1,
  ActionRuleScalarTypeSpecV1,
  DerivedEffectEnvelopeSpecV1,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deactivateExplorationBoundary, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { reviewVerifiedActionAuthority } from "./boundary-commands.js";
import { reviewSemanticSupervisedExecution, verifiedActionAuthorityDetails } from "./verified-action-review.js";
import * as semanticDeployment from "./semantic-action-deployment.js";
import { readPausedExecutionSetup } from "./semantic-execution-setup.js";
import { runActionControlPlane, type ActionControlPrompter } from "./action-tui.js";
import {
  activateActionRuleAuthority,
  buildActionRuleAuthorityDraft,
  createActiveActionRuleAuthorityLoader,
  deactivateActionRuleAuthority,
  deactivateActionRuleAuthorityIfCurrent,
  listActionRuleAuthorityDrafts,
  loadActiveActionRuleAuthority,
  mergeActionRuleAuthorityDraft,
  readActionRuleAuthorityActivation,
  readActionRuleAuthorityDraft,
  readActionRuleAuthorityRevisionBaseline,
  removeOutcomeActionRuleAuthorityDraft,
  writeActionRuleAuthorityDraft,
  writeActionRuleAuthorityDraftIfCurrent,
} from "./action-rule-authority.js";
import { migrateProjectControlPolicies } from "./control-policy-store.js";
import {
  activateSemanticActionRuntime,
  enableSemanticSupervisedExecution,
  previewSemanticSupervisedExecution,
  semanticExecutionConfirmation,
  semanticActionRuntimeConfig,
  restoreReviewedSemanticReadScope,
} from "./semantic-action-deployment.js";
import { inspectMcpToolBoundary, toolsPreview } from "./mcp-runtime.js";
import { mcp } from "./mcp-project.js";
import { runPostActivationAskHandoff } from "./post-activation-ask.js";
import * as clientHandoff from "./post-activation-ask.js";
import { createOptionalActionRuleRuntimeServices } from "./semantic-action-runtime.js";
import { decodeOperatorAuthority, encodeOperatorAuthority, validateOperatorPolicySnapshot } from "./control-policy-authority-codec.js";

const roots: string[] = [];
const lock = `sha256:${"a".repeat(64)}` as const;
const stringId = { kind: "string", max_length: 64, comparison: "exact" } as const;
const stateType: ActionRuleScalarTypeSpecV1 = {
  kind: "string",
  max_length: 16,
  comparison: "exact",
  enum: ["active", "paused"],
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("semantic Action Rule authority persistence", () => {
  it.each([false, true])("checks the selected four-tool contract before publication (relationship-only=%s)", async relatedOnly => {
    const root = await temporaryRoot(), read = activeReadBoundary();
    if (relatedOnly) read.pack.resources[0]!.relationship_only = true;
    const { activation, ...material } = read;
    read.activation.digest = canonicalJsonDigest({ ...material, activation: "reviewed" });
    await writeActiveReadSet(root, read);
    const source = authoritySource(read.activation.digest);
    const draft = buildActionRuleAuthorityDraft({ name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [{ read_boundary_name: read.pack.name, read_boundary_digest: read.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: source.rule }], reviews: [authorityReview()] });
    await writeActionRuleAuthorityDraft(root, draft);
    const publish = () => activateActionRuleAuthority({ projectRoot: root, name: draft.authority.name, expected_digest: draft.digest,
      confirmation: `ACTIVATE ${draft.digest}`, actor: "fixture reviewer", clientContract: "four_tool" });
    if (relatedOnly) {
      await expect(publish()).rejects.toThrow("ACTION_SUBJECT_UNOBTAINABLE");
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      expect(await readActionRuleAuthorityDraft(root, draft.authority.name)).toEqual(draft);
    } else {
      expect((await publish()).digest).toBe(draft.digest);
      expect((await readActionRuleAuthorityActivation(root))?.digest).toBe(draft.digest);
    }
  });

  it.each(["legacy", "sqlite"] as const)("retires only the exact reviewed active bundle under the writer permit (%s)", async backend => {
    const root = await temporaryRoot(), read = activeReadBoundary();
    await writeActiveReadSet(root, read);
    const source = authoritySource(read.activation.digest);
    const draft = buildActionRuleAuthorityDraft({ name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [{ read_boundary_name: read.pack.name, read_boundary_digest: read.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: source.rule }], reviews: [authorityReview()] });
    await writeActionRuleAuthorityDraft(root, draft);
    const active = await activateActionRuleAuthority({ projectRoot: root, name: draft.authority.name, expected_digest: draft.digest,
      confirmation: `ACTIVATE ${draft.digest}`, actor: "fixture reviewer" });
    const binding = backend === "sqlite" ? await migrateActionBaselineFixture(root) : undefined;
    try {
      const baseline = await readActionRuleAuthorityRevisionBaseline(root);
      let pending!: Promise<unknown>, finished = false;
      await withProjectAuthorityMutation(root, async permit => {
        pending = deactivateActionRuleAuthorityIfCurrent(root, baseline).catch(error => error).finally(() => { finished = true; });
        await delay(30);
        expect(finished).toBe(false);
        await writeActionRuleAuthorityDraft(root, draft, permit);
        Object.assign(baseline, await readActionRuleAuthorityRevisionBaseline(root, permit));
      });
      expect(await pending).toMatchObject({ code: "ACTION_BOUNDARY_REVISION_CHANGED" });
      expect(await readActionRuleAuthorityActivation(root)).toEqual(active);
      const current = await readActionRuleAuthorityRevisionBaseline(root);
      expect(await deactivateActionRuleAuthorityIfCurrent(root, current)).toBe(true);
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
      expect(await readActionRuleAuthorityDraft(root, draft.authority.name)).toEqual(draft);
    } finally { await binding?.close(); }
  });
  it.each(["return", "failure", "nonzero"] as const)("continues directly from active Action review to client setup without another activation (%s)", async mode => {
    const root = await temporaryRoot(), read = activeReadBoundary();
    await writeActiveReadSet(root, read);
    const source = authoritySource(read.activation.digest);
    const draft = buildActionRuleAuthorityDraft({ name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [{ read_boundary_name: read.pack.name, read_boundary_digest: read.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: source.rule }], reviews: [authorityReview()] });
    await writeActionRuleAuthorityDraft(root, draft);
    const active = (await activateSemanticActionRuntime({ projectRoot: root, draft, actor: "fixture reviewer" })).activation;
    const before = await readActionRuleAuthorityActivation(root);
    const execution = await semanticDeployment.readSemanticSupervisedExecutionState({ projectRoot: root });
    const pending = await listActionRuleAuthorityDrafts(root);
    const handoff = vi.spyOn(clientHandoff, "runPostActivationAskHandoff").mockImplementation(async () => {
      if (mode === "failure") throw new Error("Fixture client launch unavailable");
      return mode === "nonzero" ? 1 : 0;
    });
    const confirm = vi.fn(async () => { throw new Error("No repeated authority confirmation"); });
    const showReviewDetails = vi.fn(async () => {});
    let visits = 0;
    const session = { chooseResource: async () => undefined, editFieldTiers: async () => "back",
      promptText: async () => { throw new Error("No repeated job or model question"); }, confirm, confirmActivation: confirm,
      showReviewDetails,
      chooseOption: async (title, choices) => {
        expect(title).toBe("VERIFIED ACTION BOUNDARY");
        expect(choices).toContainEqual(expect.objectContaining({ value: "client_setup", label: "Continue client setup" }));
        return visits++ === 0 ? "client_setup" : "back";
      },
    } as BoundaryReviewInteractiveSession;
    await reviewVerifiedActionAuthority({ projectRoot: root, boundaryName: read.pack.name, session, active, env: {},
      clientSetup: () => clientHandoff.runPostActivationAskHandoff({ projectRoot: root, includeActions: true,
        autoStartConfiguredProvider: false, initialRoute: "mcp-client" }, { env: {} }) });
    expect(visits).toBe(2);
    expect(handoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectRoot: root, includeActions: true,
      autoStartConfiguredProvider: false, initialRoute: "mcp-client" }), expect.objectContaining({ env: {} }));
    expect(confirm).not.toHaveBeenCalled();
    expect(showReviewDetails).toHaveBeenCalledTimes(mode === "return" ? 0 : 1);
    if (mode === "failure") expect(showReviewDetails).toHaveBeenCalledWith("Client setup needs attention",
      expect.arrayContaining([expect.stringContaining("Fixture client launch unavailable")]));
    expect(await readActionRuleAuthorityActivation(root)).toEqual(before);
    expect(await listActionRuleAuthorityDrafts(root)).toEqual(pending);
    expect(await semanticDeployment.readSemanticSupervisedExecutionState({ projectRoot: root })).toEqual(execution);
  });

  it.each(["disabled", "missing_read"] as const)("does not enter client setup before current authority is usable (%s)", async mode => {
    const root = await temporaryRoot(), read = activeReadBoundary();
    await writeActiveReadSet(root, read);
    const source = authoritySource(read.activation.digest);
    const draft = buildActionRuleAuthorityDraft({ name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [{ read_boundary_name: read.pack.name, read_boundary_digest: read.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: source.rule }], reviews: [authorityReview()] });
    await writeActionRuleAuthorityDraft(root, draft);
    const active = mode === "disabled" ? undefined : (await activateSemanticActionRuntime({ projectRoot: root, draft, actor: "fixture reviewer" })).activation;
    if (mode === "missing_read") await deactivateExplorationBoundary(root, read.pack.name);
    const handoff = vi.spyOn(clientHandoff, "runPostActivationAskHandoff").mockResolvedValue(0);
    let visits = 0;
    const session = { chooseResource: async () => undefined, editFieldTiers: async () => "back",
      promptText: async () => undefined, confirm: async () => false,
      chooseOption: async (title, choices) => {
        expect(title).toBe("VERIFIED ACTION BOUNDARY");
        expect(choices.some(choice => choice.value === "client_setup")).toBe(false);
        return visits++ === 0 ? "client_setup" : "back";
      },
    } as BoundaryReviewInteractiveSession;
    const before = await readActionRuleAuthorityActivation(root);
    await reviewVerifiedActionAuthority({ projectRoot: root, boundaryName: read.pack.name, session, env: {},
      clientSetup: () => clientHandoff.runPostActivationAskHandoff({ projectRoot: root }),
      ...(active ? { active } : { draft }) });
    expect(handoff).not.toHaveBeenCalled();
    expect(await readActionRuleAuthorityActivation(root)).toEqual(before);
  });

  it.each((["legacy", "sqlite"] as const).flatMap((backend) =>
    (["create", "review", "rules", "active"] as const).map((change) => ({ backend, change })),
  ))("checks the exact Action baseline under the publication permit ($backend, $change)", async ({ backend, change }) => {
    const root = await temporaryRoot(), boundary = activeReadBoundary();
    await writeActiveReadSet(root, boundary);
    const source = authoritySource(boundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({ name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [{ read_boundary_name: boundary.pack.name, read_boundary_digest: boundary.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: source.rule }],
      reviews: [authorityReview()], now: "2026-09-09T00:00:00.000Z" });
    if (change !== "create") await writeActionRuleAuthorityDraft(root, draft);
    if (change === "active") await activateActionRuleAuthority({ projectRoot: root, name: draft.authority.name,
      expected_digest: draft.digest, confirmation: `ACTIVATE ${draft.digest}`, actor: "fixture reviewer" });
    const binding = backend === "sqlite" ? await migrateActionBaselineFixture(root) : undefined;
    try {
      const previousDraft = await readActionRuleAuthorityDraft(root, draft.authority.name);
      const expected = await readActionRuleAuthorityRevisionBaseline(root);
      const replacement = structuredClone(draft);
      const competing = change === "rules" ? buildActionRuleAuthorityDraft({ name: draft.authority.name,
        action_boundary_name: draft.authority.action_boundary.name, catalog: source.catalog,
        rules: draft.authority.rules.map((entry) => ({ ...entry, rule: { ...entry.rule, ttl_seconds: 120 } })),
        reviews: draft.reviews, now: draft.created_at,
      }) : { ...draft, reviews: draft.reviews.map((review) => ({ ...review, when: "A concurrent operator revised this review." })) };
      if (change === "review") expect(competing.digest).toBe(draft.digest);
      if (change === "rules") expect(competing.digest).not.toBe(draft.digest);
      let pending!: Promise<unknown>, finished = false;
      await withProjectAuthorityMutation(root, async (permit) => {
        pending = writeActionRuleAuthorityDraftIfCurrent(root, replacement, expected)
          .then(() => { finished = true; return "unexpected publication"; }, (error: unknown) => { finished = true; return error; });
        await delay(50);
        expect(finished).toBe(false);
        if (change === "active") await deactivateActionRuleAuthority(root, permit);
        else await writeActionRuleAuthorityDraft(root, competing, permit);
        // Neither the caller's baseline nor replacement may change while queued.
        Object.assign(expected, await readActionRuleAuthorityRevisionBaseline(root, permit));
        replacement.reviews[0]!.when = "Mutated after the publication request.";
      });
      expect(await pending).toMatchObject({ code: "ACTION_BOUNDARY_REVISION_CHANGED" });
      expect(await readActionRuleAuthorityDraft(root, draft.authority.name)).toEqual(change === "active" ? previousDraft : competing);
      expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    } finally { await binding?.close(); }
  });

  it.each(["legacy", "sqlite"] as const)("advances only its own Action baseline and preserves other active outcomes (%s)", async (backend) => {
    const root = await temporaryRoot(), boundary = activeReadBoundary();
    await writeActiveReadSet(root, boundary);
    const source = authoritySource(boundary.activation.digest);
    const draftFor = (outcome: string) => buildActionRuleAuthorityDraft({ name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [{ read_boundary_name: boundary.pack.name, read_boundary_digest: boundary.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: { ...source.rule, name: outcome, outcome } }],
      reviews: [{ ...authorityReview(), outcome }], now: "2026-09-09T00:00:00.000Z" });
    const original = draftFor("billing.unrelated_outcome");
    await writeActionRuleAuthorityDraft(root, original);
    const active = await activateActionRuleAuthority({ projectRoot: root, name: original.authority.name,
      expected_digest: original.digest, confirmation: `ACTIVATE ${original.digest}`, actor: "fixture reviewer" });
    const binding = backend === "sqlite" ? await migrateActionBaselineFixture(root) : undefined;
    try {
      let expected = await readActionRuleAuthorityRevisionBaseline(root);
      for (const outcome of ["billing.first_job_outcome", "billing.second_job_outcome"]) {
        if (binding) {
          // A Read-selection commit advances the shared epoch, not Action identity.
          const selection = encodeOperatorAuthority({ type: "read_selection", selected_name: null });
          const current = await binding.repository.deployment(binding.deployment_id);
          await binding.repository.commit({ deployment_id: binding.deployment_id, expected_epoch: current!.epoch,
            revisions: [], active: [{ scope: selection.scope, kind: selection.kind, name: selection.name, revision_id: selection.revision_id }],
            event: { event_id: outcome, actor: "fixture reviewer", occurred_at: new Date().toISOString(), receipt: { operation: "read_selection" } } });
          expect(await readActionRuleAuthorityRevisionBaseline(root)).toEqual(expected);
        }
        const saved = mergeActionRuleAuthorityDraft({ existing: await readActionRuleAuthorityDraft(root, original.authority.name) ?? active,
          incoming: draftFor(outcome) });
        expected = await writeActionRuleAuthorityDraftIfCurrent(root, saved, expected);
        expect(await readActionRuleAuthorityRevisionBaseline(root)).toEqual(expected);
      }
      const saved = (await readActionRuleAuthorityDraft(root, original.authority.name))!;
      expect(saved.authority.rules.map((entry) => entry.rule.outcome).sort()).toEqual([
        "billing.first_job_outcome", "billing.second_job_outcome", "billing.unrelated_outcome",
      ]);
      expect(saved.authority.rules.find((entry) => entry.rule.outcome === "billing.unrelated_outcome")).toEqual(original.authority.rules[0]);
      expect(await readActionRuleAuthorityActivation(root)).toEqual(active);
    } finally { await binding?.close(); }
  });

  it("adds a third mixed-punctuation outcome without mistaking review ordering for an invalid authority", async () => {
    const root = await temporaryRoot();
    const boundary = activeReadBoundary();
    await writeActiveReadSet(root, boundary);
    const source = authoritySource(boundary.activation.digest);
    const names = ["warehouse.notification_preference.change", "warehouse.stock_item_reorder_threshold.change", "warehouse.stock_item.available_stock_units.change"];
    const draftFor = (outcomes: string[]) => buildActionRuleAuthorityDraft({
      name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: outcomes.map((outcome) => ({ read_boundary_name: boundary.pack.name, read_boundary_digest: boundary.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: { ...source.rule, name: outcome, outcome } })),
      reviews: outcomes.map((outcome) => ({ ...authorityReview(), outcome })),
    });
    const first = draftFor(names.slice(0, 2));
    await writeActionRuleAuthorityDraft(root, first);
    const active = await activateActionRuleAuthority({ projectRoot: root, name: first.authority.name,
      expected_digest: first.digest, confirmation: `ACTIVATE ${first.digest}`, actor: "reviewer" });
    const replacement = mergeActionRuleAuthorityDraft({ existing: active, incoming: draftFor(names.slice(2)) });
    const beforeDetails = structuredClone(replacement);
    const exactDetails = verifiedActionAuthorityDetails(replacement, 80);
    for (const outcome of names) expect(exactDetails).toContain(`OUTCOME  ${outcome}`);
    const codeStart = exactDetails.indexOf("```json");
    expect(codeStart).toBeGreaterThan(0);
    expect(JSON.parse(exactDetails.slice(codeStart + 1, exactDetails.lastIndexOf("```")).join("\n"))).toEqual(replacement.authority);
    expect(exactDetails).toContain(`Authority digest: ${replacement.digest}`);
    expect(replacement).toEqual(beforeDetails);
    await writeActionRuleAuthorityDraft(root, replacement);
    expect((await readActionRuleAuthorityActivation(root))?.digest).toBe(active.digest);
    expect((await readActionRuleAuthorityDraft(root, replacement.authority.name))?.reviews.map((review) => review.outcome).sort()).toEqual([...names].sort());
    await activateActionRuleAuthority({ projectRoot: root, name: replacement.authority.name,
      expected_digest: replacement.digest, confirmation: `ACTIVATE ${replacement.digest}`, actor: "reviewer" });
    expect((await loadActiveActionRuleAuthority(root)).registry.rules.map((entry) => entry.compiled.outcome).sort()).toEqual([...names].sort());
    for (const reviews of [replacement.reviews.slice(1), [...replacement.reviews, replacement.reviews[0]!],
      replacement.reviews.map((review, index) => index === 0 ? { ...review, outcome: "warehouse.unreviewed_action" } : review)]) {
      await expect(writeActionRuleAuthorityDraft(root, { ...replacement, reviews })).rejects.toThrow("ACTION_RULE_DRAFT_INVALID");
    }
    expect((await readActionRuleAuthorityActivation(root))?.digest).toBe(replacement.digest);
  });

  it("transfers exact stored Action authority without changing rule identity, state or provenance", async () => {
    const root = await temporaryRoot(); const boundary = activeReadBoundary();
    await writeActiveReadSet(root, boundary);
    const source = authoritySource(boundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({ name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [{ read_boundary_name: boundary.pack.name, read_boundary_digest: boundary.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: source.rule }], reviews: [authorityReview()] });
    await writeActionRuleAuthorityDraft(root, draft);
    const active = await activateActionRuleAuthority({ projectRoot: root, name: draft.authority.name,
      expected_digest: draft.digest, confirmation: `ACTIVATE ${draft.digest}`, actor: "original_reviewer" });
    const records = [draft, active].map((authority) => encodeOperatorAuthority({ type: "action", authority }));
    expect(records.map((record) => decodeOperatorAuthority(record))).toEqual([{ type: "action", authority: draft }, { type: "action", authority: active }]);
    expect(records[0]!.authority_digest).toBe(records[1]!.authority_digest);
    expect(records[0]!.revision_id).not.toBe(records[1]!.revision_id);
    const selection = encodeOperatorAuthority({ type: "read_selection", selected_name: null });
    // The Read dependency is revoked here. Migration preserves that unavailable
    // state rather than inventing a replacement Read digest or removing the rule.
    expect(() => validateOperatorPolicySnapshot({ revisions: [...records, selection], drafts: [records[0]!],
      active: [records[1]!, selection], provenance: [] })).not.toThrow();
    const tampered = structuredClone(active); tampered.authority.rules[0]!.rule.ttl_seconds++;
    expect(() => encodeOperatorAuthority({ type: "action", authority: tampered })).toThrow();
  });

  it("reuses verified compiled snapshots but observes changed files and Read revocation", async () => {
    const root = await temporaryRoot();
    const boundary = activeReadBoundary();
    await writeActiveReadSet(root, boundary);
    const source = authoritySource(boundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({
      name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [{ read_boundary_name: boundary.pack.name, read_boundary_digest: boundary.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: source.rule }],
      reviews: [authorityReview()], now: "2026-09-02T20:00:00.000Z",
    });
    await writeActionRuleAuthorityDraft(root, draft);
    const activation = await activateActionRuleAuthority({ projectRoot: root, name: draft.authority.name,
      expected_digest: draft.digest, confirmation: `ACTIVATE ${draft.digest}`, actor: "reviewer" });
    const load = createActiveActionRuleAuthorityLoader(root);
    const first = await load();
    expect((await load()).registry).toBe(first.registry);
    expect(Object.isFrozen(first.activation.authority.rules[0]!.rule)).toBe(true);
    expect(() => { first.activation.authority.rules[0]!.rule.outcome = "billing.invented"; }).toThrow();
    const revoked = await load({ read_boundaries: [], dependency_check: "report" });
    expect(revoked.registry).toBe(first.registry);
    expect(revoked.unavailable_outcomes).toEqual(["billing.pause_notifications"]);
    await expect(load({ read_boundaries: [] })).rejects.toMatchObject({ code: "ACTION_RULE_READ_AUTHORITY_STALE" });
    expect((await load()).unavailable_outcomes).toBeUndefined();

    const activeFile = path.join(root, ".synapsor/action-rules/active.json");
    const revisionFile = path.join(root, ".synapsor/action-rules/revisions", draft.digest.slice(7), "authority.json");
    const originalActive = await fs.readFile(activeFile, "utf8");
    const originalRevision = await fs.readFile(revisionFile, "utf8");
    const tampered = structuredClone(activation);
    tampered.authority.rules[0]!.rule.outcome = "billing.invented";
    await fs.writeFile(activeFile, JSON.stringify(tampered));
    await expect(load()).rejects.toThrow();
    await fs.writeFile(activeFile, originalActive);
    await fs.writeFile(revisionFile, JSON.stringify(tampered));
    await expect(load()).rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
    await fs.writeFile(revisionFile, originalRevision);
    expect((await load()).registry.rules[0]!.compiled.outcome).toBe("billing.pause_notifications");
    await deactivateActionRuleAuthority(root);
    await expect(load()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads and searches a real 2000-outcome authority without recompiling warm requests", async () => {
    const root = await temporaryRoot();
    const boundary = activeReadBoundary();
    await writeActiveReadSet(root, boundary);
    const source = authoritySource(boundary.activation.digest);
    const count = 2_000;
    const rules = Array.from({ length: count }, (_, index) => {
      const outcome = `billing.option_${String(index).padStart(4, "0")}`;
      const approval = `${outcome}_approval`;
      return { read_boundary_name: boundary.pack.name, read_boundary_digest: boundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: { ...source.envelope, approval_classes: [approval] },
        rule: { ...source.rule, name: outcome, outcome, approval_class: approval } };
    });
    const started = performance.now();
    const draft = buildActionRuleAuthorityDraft({
      name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules, reviews: rules.map(({ rule }) => ({ ...authorityReview(), outcome: rule.outcome })),
      now: "2026-09-02T20:00:00.000Z",
    });
    await writeActionRuleAuthorityDraft(root, draft);
    await activateActionRuleAuthority({ projectRoot: root, name: draft.authority.name,
      expected_digest: draft.digest, confirmation: `ACTIVATE ${draft.digest}`, actor: "reviewer" });
    const load = createActiveActionRuleAuthorityLoader(root);
    const coldStart = performance.now();
    const first = await load();
    const coldMs = performance.now() - coldStart;
    const warmStart = performance.now();
    expect((await load()).registry).toBe(first.registry);
    const warmMs = performance.now() - warmStart;
    expect(first.registry.rules).toHaveLength(count);
    expect(first.registry.approval_classes).toHaveLength(count);
    const store = new ProposalStore(":memory:");
    const session = new ScopedCatalogSession();
    const visible = rules.slice(0, 1_000).map(({ rule }) => rule.outcome);
    let scope = "tenant-a";
    const facts = vi.fn(async () => { throw new Error("Discovery must not read source rows"); });
    try {
      const services = await createOptionalActionRuleRuntimeServices({
        projectRoot: root, config: { version: 1, mode: "review", sources: {} }, store, key: Buffer.alloc(32, 7),
        catalogSession: session, factSessionFactory: facts,
        resolveCatalogAuthorization: async () => ({ scope_key: scope, revision: "1", allowed_outcomes: visible }),
      });
      const runtime = services!.semanticActions;
      const queryStart = performance.now();
      const response = await runtime.callTool("app.describe_actions", { query: "option 0100" });
      const queryMs = performance.now() - queryStart;
      expect(response.actions).toEqual([expect.objectContaining({ outcome: "billing.option_0100", eligibility: "not_checked" })]);
      expect(session.lastWork.visited).toBe(1);
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(16_384);
      const detail = await runtime.callTool("app.describe_actions", { outcome: "billing.option_0100" });
      expect(detail.actions).toEqual([expect.objectContaining({ outcome: "billing.option_0100", request_shape: expect.any(Object) })]);
      const firstPage = await runtime.callTool("app.describe_actions", { limit: 20 });
      const secondPage = await runtime.callTool("app.describe_actions", { limit: 20, cursor: firstPage.next_cursor });
      const outcomes = [firstPage, secondPage].flatMap((page) => (page.actions as Array<{ outcome: string }>).map((action) => action.outcome));
      expect(new Set(outcomes).size).toBe(40);
      expect(outcomes.every((outcome) => visible.includes(outcome))).toBe(true);
      for (const outcome of ["billing.option_1999", "billing.missing"]) {
        await expect(runtime.callTool("app.describe_actions", { outcome })).rejects.toMatchObject({
          code: "CATALOG_ENTRY_UNAVAILABLE", message: "That entry is not available in the current authorized catalog.",
        });
      }
      const deniedSearch = await runtime.callTool("app.describe_actions", { query: "option 1999" });
      expect(deniedSearch.actions).toEqual([]);
      scope = "tenant-b";
      await expect(runtime.callTool("app.describe_actions", { limit: 20, cursor: secondPage.next_cursor }))
        .rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
      await expect(runtime.callTool("app.request_change", { outcome: "billing.option_1999",
        subject_refs: { preference: `obj_${"x".repeat(40)}` } }))
        .rejects.toMatchObject({ code: "SEMANTIC_ACTION_UNAVAILABLE" });
      expect(facts).not.toHaveBeenCalled();
      console.info(JSON.stringify({ benchmark: "production_action_discovery", outcomes: count,
        authorized: visible.length, query_ms: Math.round(queryMs), response_bytes: Buffer.byteLength(JSON.stringify(response)) }));
    } finally { store.close(); }
    console.info(JSON.stringify({ benchmark: "real_action_authority", outcomes: count,
      total_ms: Math.round(performance.now() - started), cold_ms: Math.round(coldMs), warm_ms: Math.round(warmMs) }));
  }, 60_000);

  it("previews a managed authoring MCP install without concrete runtime identity", async () => {
    const root = await temporaryRoot();
    await writeActiveReadSet(root, activeReadBoundary());
    const priorTenant = process.env.SYNAPSOR_TENANT_ID;
    const priorPrincipal = process.env.SYNAPSOR_PRINCIPAL;
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      output.push(String(value));
      return true;
    });
    delete process.env.SYNAPSOR_TENANT_ID;
    delete process.env.SYNAPSOR_PRINCIPAL;
    try {
      await expect(mcp([
        "install", "claude-code",
        "--project", "--authoring", "--dry-run",
        "--project-root", root,
      ])).resolves.toBe(0);
    } finally {
      write.mockRestore();
      if (priorTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID;
      else process.env.SYNAPSOR_TENANT_ID = priorTenant;
      if (priorPrincipal === undefined) delete process.env.SYNAPSOR_PRINCIPAL;
      else process.env.SYNAPSOR_PRINCIPAL = priorPrincipal;
    }
    expect(output.join("")).toContain("Model-facing tools: app.describe_data, app.explore_data");
  });

  it("does not create Action writer state during a read-only handoff with no runtime config", async () => {
    const root = await temporaryRoot();
    const before = await fs.readdir(root);
    expect(await restoreReviewedSemanticReadScope(path.join(root, "absent-project"))).toBe(false);
    expect(await restoreReviewedSemanticReadScope(root)).toBe(false);
    expect(await fs.readdir(root)).toEqual(before);
  });

  it.each(["draft", "activate", "deactivate", "runtime", "scope_repair"])("coordinates native Action %s with the project authority writer", async (mode) => {
    const root = await temporaryRoot();
    const readBoundary = activeReadBoundary();
    if (mode === "scope_repair") {
      readBoundary.pack.resources[0]!.rls_session = { tenant_setting: "synapsor.tenant_id" };
      readBoundary.activation.digest = canonicalJsonDigest({ ...readBoundary, activation: "reviewed" });
    }
    await writeActiveReadSet(root, readBoundary);
    const source = authoritySource(readBoundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({ name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [{ read_boundary_name: readBoundary.pack.name, read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: source.rule }],
      reviews: [authorityReview()], now: "2026-09-02T20:00:00.000Z" });
    if (mode !== "draft") await writeActionRuleAuthorityDraft(root, draft);
    const activate = { projectRoot: root, name: draft.authority.name, expected_digest: draft.digest,
      confirmation: `ACTIVATE ${draft.digest}`, actor: "billing reviewer" };
    if (mode === "deactivate") await activateActionRuleAuthority(activate);
    const actionConfigPath = path.join(root, "synapsor.actions.runner.json");
    if (mode === "scope_repair") {
      await activateSemanticActionRuntime({ projectRoot: root, draft, actor: "billing reviewer" });
      const config = JSON.parse(await fs.readFile(actionConfigPath, "utf8"));
      delete config.sources.local_postgres.database_scope;
      await fs.writeFile(actionConfigPath, JSON.stringify(config));
    }
    const run = () => mode === "draft" ? writeActionRuleAuthorityDraft(root, draft)
      : mode === "activate" ? activateActionRuleAuthority(activate)
      : mode === "deactivate" ? deactivateActionRuleAuthority(root)
      : mode === "runtime" ? activateSemanticActionRuntime({ projectRoot: root, draft, actor: "billing reviewer" })
      : restoreReviewedSemanticReadScope(root);
    let finished = false;
    let pending!: Promise<unknown>;
    await withProjectAuthorityMutation(root, async () => {
      pending = run().then((value) => { finished = true; return value; });
      await delay(150);
      expect(finished).toBe(false);
    });
    await pending;
    expect(finished).toBe(true);
    if (mode === "draft") expect((await readActionRuleAuthorityDraft(root, draft.authority.name))?.digest).toBe(draft.digest);
    if (mode === "activate" || mode === "runtime") expect((await readActionRuleAuthorityActivation(root))?.digest).toBe(draft.digest);
    if (mode === "deactivate") expect(await readActionRuleAuthorityActivation(root)).toBeUndefined();
    if (mode === "scope_repair") expect(JSON.parse(await fs.readFile(actionConfigPath, "utf8")).sources.local_postgres.database_scope)
      .toEqual({ mode: "postgres_rls", tenant_setting: "synapsor.tenant_id" });
  });

  it.each(["draft", "runtime_explicit"])("writes %s to the locked canonical project even if its input alias is retargeted", async (mode) => {
    const root = await temporaryRoot(), other = await temporaryRoot(), linkRoot = await temporaryRoot();
    const alias = path.join(linkRoot, "current");
    await fs.symlink(root, alias, "dir");
    const readBoundary = activeReadBoundary(), source = authoritySource(readBoundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({ name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [{ read_boundary_name: readBoundary.pack.name, read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: source.rule }], reviews: [authorityReview()] });
    if (mode === "runtime_explicit") {
      await writeActiveReadSet(root, readBoundary);
      await writeActionRuleAuthorityDraft(root, draft);
    }
    const lstat = fs.lstat.bind(fs);
    let retargeted = false;
    const spy = vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      if (!retargeted && args[0] === path.join(root, ".synapsor/exploration-boundaries.active.lock")) {
        retargeted = true; await fs.unlink(alias); await fs.symlink(other, alias, "dir");
      }
      return lstat(...args);
    }) as typeof fs.lstat);
    try {
      if (mode === "draft") await writeActionRuleAuthorityDraft(alias, draft);
      else await activateSemanticActionRuntime({ projectRoot: alias, draft, actor: "billing reviewer",
        baseConfigPath: path.join(alias, "synapsor.runner.json"), outputConfigPath: path.join(alias, "synapsor.actions.runner.json") });
    } finally { spy.mockRestore(); }
    expect(retargeted).toBe(true);
    if (mode === "draft") expect((await readActionRuleAuthorityDraft(root, draft.authority.name))?.digest).toBe(draft.digest);
    else {
      expect((await readActionRuleAuthorityActivation(root))?.digest).toBe(draft.digest);
      expect(await fs.stat(path.join(root, "synapsor.actions.runner.json"))).toBeDefined();
      await expect(fs.stat(path.join(other, "synapsor.actions.runner.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readActionRuleAuthorityDraft(other, draft.authority.name)).toBeUndefined();
  });

  it.each(["config", "revocation"])("rechecks legacy execution %s after inspection and before publication", async (mode) => {
    const root = await temporaryRoot(), read = activeReadBoundary();
    await writeActiveReadSet(root, read);
    const source = authoritySource(read.activation.digest);
    const draft = buildActionRuleAuthorityDraft({ name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [{ read_boundary_name: read.pack.name, read_boundary_digest: read.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: source.rule }], reviews: [authorityReview()] });
    await writeActionRuleAuthorityDraft(root, draft);
    await activateSemanticActionRuntime({ projectRoot: root, draft, actor: "billing reviewer" });
    const file = path.join(root, "synapsor.actions.runner.json");
    let preserved = await fs.readFile(file, "utf8");
    const input = { projectRoot: root, outcome: source.rule.outcome, profile: "staging" as const,
      writeUrlEnv: "BILLING_WRITER_URL", env: { BILLING_WRITER_URL: "postgresql://fixture.invalid/not-used" },
      inspect: async () => writerInspection() };
    const preview = await previewSemanticSupervisedExecution(input);
    await expect(enableSemanticSupervisedExecution({ ...input, expectedActionBoundaryDigest: preview.action_boundary_digest,
      expectedConfigDigest: preview.current_config_digest, expectedWriterPostureFingerprint: preview.writer_posture_fingerprint,
      confirmation: semanticExecutionConfirmation(preview), inspect: async () => {
        await withProjectAuthorityMutation(root, async (permit) => {
          if (mode === "config") {
            const changed = JSON.parse(preserved); changed.sources.local_postgres.write_url_env = "OTHER_WRITER";
            preserved = JSON.stringify(changed); await fs.writeFile(file, preserved);
          } else await deactivateActionRuleAuthority(root, permit);
        });
        return writerInspection();
      },
    })).rejects.toThrow(mode === "config" ? /SEMANTIC_ACTION_CONFIG_CHANGED/ : /No active semantic Action Rule authority/);
    expect(await fs.readFile(file, "utf8")).toBe(preserved);
  });

  it("publishes a separate fixed-tool Action runtime without copying Read capabilities", async () => {
    const root = await temporaryRoot();
    const readBoundary = activeReadBoundary();
    await writeActiveReadSet(root, readBoundary);
    const source = authoritySource(readBoundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      reviews: [authorityReview()],
      now: "2026-09-02T20:00:00.000Z",
    });
    await writeActionRuleAuthorityDraft(root, draft);

    const published = await activateSemanticActionRuntime({
      projectRoot: root,
      draft,
      actor: "billing reviewer",
      now: "2026-09-02T20:05:00.000Z",
    });
    expect(published).toMatchObject({
      config_path: "./synapsor.actions.runner.json",
      config_changed: true,
      activation: { state: "active", digest: draft.digest },
    });
    const base = JSON.parse(await fs.readFile(path.join(root, "synapsor.runner.json"), "utf8"));
    expect(base.capabilities).toHaveLength(1);
    expect(base.action_rules).toBeUndefined();
    const actionConfigPath = path.join(root, "synapsor.actions.runner.json");
    const action = JSON.parse(await fs.readFile(actionConfigPath, "utf8"));
    expect(action).toMatchObject({
      version: 1,
      mode: "review",
      action_rules: { project_root: "./" },
      sources: { local_postgres: { read_only: true } },
    });
    expect(action.capabilities).toBeUndefined();
    expect(action.production_explore).toBeUndefined();
    expect((await fs.stat(actionConfigPath)).mode & 0o777).toBe(0o600);

    await expect(inspectMcpToolBoundary([
      "--config", path.join(root, "synapsor.runner.json"),
      "--store", ":memory:",
    ])).resolves.toMatchObject({
      surface: "capabilities",
      names: ["billing.inspect_preference"],
      companionActionSurface: {
        ok: true,
        active: true,
        configPath: actionConfigPath,
        names: ["app.describe_actions", "app.request_change"],
        capabilityDetails: [{ name: "billing.pause_notifications" }],
      },
    });

    await expect(inspectMcpToolBoundary([
      "--config", actionConfigPath,
      "--store", ":memory:",
    ])).resolves.toMatchObject({
      ok: true,
      surface: "semantic_actions",
      names: ["app.describe_actions", "app.request_change"],
      capabilityDetails: [{
        name: "billing.pause_notifications",
        kind: "proposal",
        operation: "update",
        target: "billing.preferences",
        tenant_source: expect.stringContaining("Runner trusted context"),
        approval: expect.stringContaining("human"),
        max_rows: 1,
      }],
    });

    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(toolsPreview([
        "--config", path.join(root, "synapsor.runner.json"),
        "--store", ":memory:",
      ])).resolves.toBe(0);
      expect(output.join("")).toContain("Companion Action surface: ACTIVE");
      expect(output.join("")).toContain("app.describe_actions");
      expect(output.join("")).toContain("app.request_change");
      expect(output.join("")).toContain("--include-actions");

      output.length = 0;
      await expect(toolsPreview([
        "--config", path.join(root, "synapsor.runner.json"),
        "--store", ":memory:",
        "--json",
      ])).resolves.toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({
        exposed_to_mcp: ["billing.inspect_preference"],
        companion_action_surface: {
          ok: true,
          active: true,
          exposed_to_mcp: ["app.describe_actions", "app.request_change"],
          action_details: [{ name: "billing.pause_notifications" }],
        },
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const install = vi.fn(async () => 0);
    await expect(runPostActivationAskHandoff({
      projectRoot: root,
      selection: { route: "mcp-client", client: "claude-code" },
    }, {
      runMcpInstall: install,
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    })).resolves.toBe(0);
    expect(install).toHaveBeenCalledWith([
      "install", "claude-code",
      "--project", "--authoring",
      "--project-root", root,
      "--include-actions",
    ]);
  });

  it("shows active semantic authority in the /actions control plane instead of reporting Action OFF", async () => {
    const root = await temporaryRoot();
    const readBoundary = activeReadBoundary();
    await writeActiveReadSet(root, readBoundary);
    const source = authoritySource(readBoundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      reviews: [authorityReview()],
      now: "2026-09-02T20:00:00.000Z",
    });
    await writeActionRuleAuthorityDraft(root, draft);
    await activateSemanticActionRuntime({ projectRoot: root, draft, actor: "billing reviewer" });
    const screens: Array<{ title: string; labels: string[]; context: string[]; initialValue?: string }> = [];
    const choices = ["verified_model_revision", "quit"];
    const modelRevision = vi.fn(async () => ({
      tone: "success" as const,
      title: "Model-guided replacement prepared.",
      lines: ["Active authority remains live."],
    }));
    const prompter: ActionControlPrompter = {
      async choose(title, available, context = [], initialValue) {
        screens.push({
          title,
          labels: available.map((choice) => choice.label),
          context,
          ...(initialValue ? { initialValue } : {}),
        });
        return choices.shift();
      },
      async text() { return undefined; },
      async confirm() { return false; },
      async message() {},
    };

    await expect(runActionControlPlane({
      projectRoot: root,
      configPath: path.join(root, "synapsor.runner.json"),
      storePath: path.join(root, ".synapsor/local.db"),
      inspection: writerInspection(),
      prompter,
      env: {},
      modelSuggestionSession: {
        provider: "openai",
        model: "gpt-5.6-terra",
      },
      modelGuidedVerifiedActionRevision: modelRevision,
    })).resolves.toMatchObject({ state: "closed", source_database_changed: false });

    expect(screens[0]).toMatchObject({
      title: "ACTION BOUNDARY",
      labels: expect.arrayContaining([
        "Change a verified outcome with openai[gpt-5.6-terra] [recommended]",
        "Verified Action Boundary [ACTIVE]",
      ]),
      context: expect.arrayContaining([
        expect.stringContaining("fixed app.describe_actions + app.request_change"),
        expect.stringContaining("Caller-supplied Action Boundary OFF"),
      ]),
      initialValue: "verified_model_revision",
    });
    expect(screens[1]?.title).toBe("ACTION BOUNDARY");
    expect(screens[1]?.context).toContain("Model-guided replacement prepared.");
    expect(modelRevision).toHaveBeenCalledWith({
      projectRoot: root,
      boundaryName: readBoundary.pack.name,
      modelSuggestionSession: {
        provider: "openai",
        model: "gpt-5.6-terra",
      },
    });
  });

  it("preserves existing caller-supplied actions while removing stale semantic execution authority", async () => {
    const readBoundary = activeReadBoundary();
    const source = authoritySource(readBoundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      reviews: [authorityReview()],
      now: "2026-09-02T20:00:00.000Z",
    });
    const oldDigest = `sha256:${"e".repeat(64)}`;
    const config = semanticActionRuntimeConfig({
      projectRoot: "/srv/billing",
      sourceConfigPath: "/srv/billing/synapsor.actions.runner.json",
      outputConfigPath: "/srv/billing/synapsor.actions.runner.json",
      preserveActionRuntime: true,
      draft,
      sourceConfig: {
        version: 1,
        mode: "review",
        action_rules: { project_root: "./" },
        contracts: ["./.synapsor/actions/legacy.json"],
        capabilities: [{ name: "billing.propose_note", kind: "proposal" }],
        supervised_worker: {
          enabled: true,
          profile: "staging",
          capabilities: [{ capability: "billing.propose_note", contract_digest: oldDigest }],
          outcomes: [{ outcome: source.rule.outcome, action_boundary_digest: oldDigest }],
        },
      },
    });
    expect(config.contracts).toEqual(["./.synapsor/actions/legacy.json"]);
    expect(config.capabilities).toEqual([{ name: "billing.propose_note", kind: "proposal" }]);
    expect(config.supervised_worker).toMatchObject({
      enabled: true,
      capabilities: [{ capability: "billing.propose_note", contract_digest: oldDigest }],
    });
    expect((config.supervised_worker as { outcomes?: unknown[] }).outcomes).toBeUndefined();
  });

  it("enables one exact semantic worker only after live least-privilege review", async () => {
    const root = await temporaryRoot();
    const readBoundary = activeReadBoundary();
    await writeActiveReadSet(root, readBoundary);
    const source = authoritySource(readBoundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      reviews: [authorityReview()],
      now: "2026-09-02T20:00:00.000Z",
    });
    await writeActionRuleAuthorityDraft(root, draft);
    await activateSemanticActionRuntime({ projectRoot: root, draft, actor: "billing reviewer" });
    const actionConfigPath = path.join(root, "synapsor.actions.runner.json");
    const before = await fs.readFile(actionConfigPath, "utf8");
    const inspection = writerInspection();
    const preview = await previewSemanticSupervisedExecution({
      projectRoot: root,
      outcome: source.rule.outcome,
      profile: "staging",
      writeUrlEnv: "BILLING_WRITER_URL",
      workerIdentity: "billing_worker",
      env: { BILLING_WRITER_URL: "postgresql://secret-writer-url" },
      inspect: async () => inspection,
    });
    expect(preview).toMatchObject({
      outcome: "billing.pause_notifications",
      source: "local_postgres",
      target: "billing.preferences",
      operation: "update",
      write_url_env: "BILLING_WRITER_URL",
      writer_role: "billing_writer",
      allowed_relations: ["billing.preferences"],
      policy: {
        worker_identity: "billing_worker",
        require_least_privilege_writer: true,
        action_boundary_digest: draft.authority.action_boundary.digest,
      },
    });
    expect(JSON.stringify(preview.config)).not.toContain("secret-writer-url");

    await expect(enableSemanticSupervisedExecution({
      projectRoot: root,
      outcome: source.rule.outcome,
      profile: "staging",
      writeUrlEnv: "BILLING_WRITER_URL",
      workerIdentity: "billing_worker",
      expectedActionBoundaryDigest: preview.action_boundary_digest,
      expectedConfigDigest: preview.current_config_digest,
      expectedWriterPostureFingerprint: preview.writer_posture_fingerprint,
      confirmation: "not the reviewed confirmation",
      env: { BILLING_WRITER_URL: "postgresql://secret-writer-url" },
      inspect: async () => inspection,
    })).rejects.toThrow(/EXECUTION_CONFIRMATION_REQUIRED/);
    await expect(fs.readFile(actionConfigPath, "utf8")).resolves.toBe(before);

    const enabled = await enableSemanticSupervisedExecution({
      projectRoot: root,
      outcome: source.rule.outcome,
      profile: "staging",
      writeUrlEnv: "BILLING_WRITER_URL",
      workerIdentity: "billing_worker",
      expectedActionBoundaryDigest: preview.action_boundary_digest,
      expectedConfigDigest: preview.current_config_digest,
      expectedWriterPostureFingerprint: preview.writer_posture_fingerprint,
      confirmation: semanticExecutionConfirmation(preview),
      env: { BILLING_WRITER_URL: "postgresql://secret-writer-url" },
      inspect: async () => inspection,
    });
    expect(enabled.writer_posture_fingerprint).toBe(preview.writer_posture_fingerprint);
    const config = JSON.parse(await fs.readFile(actionConfigPath, "utf8"));
    expect(config).toMatchObject({
      mode: "review",
      sources: {
        local_postgres: {
          read_only: false,
          write_url_env: "BILLING_WRITER_URL",
          receipts: { authority: "runner_ledger" },
        },
      },
      supervised_worker: {
        enabled: true,
        profile: "staging",
        capabilities: [],
        outcomes: [{
          outcome: "billing.pause_notifications",
          action_boundary_digest: draft.authority.action_boundary.digest,
          mode: "supervised_worker",
        }],
      },
    });
  });

  it("refuses semantic execution before config mutation when the writer can reach an unrelated relation", async () => {
    const root = await temporaryRoot();
    const readBoundary = activeReadBoundary();
    await writeActiveReadSet(root, readBoundary);
    const source = authoritySource(readBoundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      reviews: [authorityReview()],
    });
    await writeActionRuleAuthorityDraft(root, draft);
    await activateSemanticActionRuntime({ projectRoot: root, draft, actor: "billing reviewer" });
    const actionConfigPath = path.join(root, "synapsor.actions.runner.json");
    const before = await fs.readFile(actionConfigPath, "utf8");
    const inspection = writerInspection();
    inspection.tables.push({
      schema: "billing",
      name: "unrelated_secrets",
      role_posture: { privileges: writerPrivileges({ select: true }) },
    } as never);
    await expect(previewSemanticSupervisedExecution({
      projectRoot: root,
      outcome: source.rule.outcome,
      profile: "staging",
      env: { SYNAPSOR_DATABASE_WRITE_URL: "postgresql://secret-writer-url" },
      inspect: async () => inspection,
    })).rejects.toMatchObject({ code: "SEMANTIC_ACTION_WRITER_POSTURE_INVALID", problem: {
      details: expect.arrayContaining([expect.stringContaining("writer_unreviewed_relation_privilege"),
        expect.stringContaining("billing.unrelated_secrets")]),
    } });
    await expect(fs.readFile(actionConfigPath, "utf8")).resolves.toBe(before);
  });

  it.each([false, true])("keeps proposal activation and supervised execution as two separate TUI confirmations (enable=%s)", async enable => {
    vi.spyOn(semanticDeployment, "verifySemanticExecutionReadPosture").mockResolvedValue(undefined);
    const root = await temporaryRoot();
    const readBoundary = activeReadBoundary();
    await writeActiveReadSet(root, readBoundary);
    const source = authoritySource(readBoundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      reviews: [authorityReview()],
    });
    await writeActionRuleAuthorityDraft(root, draft);
    const active = (await activateSemanticActionRuntime({
      projectRoot: root,
      draft,
      actor: "billing reviewer",
    })).activation;
    const beforeExecution = await fs.readFile(path.join(root, "synapsor.actions.runner.json"), "utf8");
    let visits = 0;
    const confirmations: string[] = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => "back",
      promptText: async () => "BILLING_WRITER_URL",
      confirm: async () => false,
      confirmActivation: async (prompt, options) => {
        expect(options?.context?.join("\n")).toContain("Writer verification: PASSED");
        expect(options?.context?.join("\n")).toContain("Receipt probe: NOT RUN (Runner-ledger mode)");
        expect(options?.context?.join("\n")).not.toContain("secret-writer-url");
        confirmations.push(prompt);
        return enable;
      },
      chooseOption: async (title) => {
        if (title === "Set up database changes") return "choose";
        expect(title).toBe("VERIFIED ACTION BOUNDARY");
        return visits++ === 0 ? "enable_execution:billing.pause_notifications" : "back";
      },
    };
    const notice = await reviewVerifiedActionAuthority({
      projectRoot: root,
      boundaryName: readBoundary.pack.name,
      session,
      active,
      env: { BILLING_WRITER_URL: "postgresql://secret-writer-url" },
      inspectDatabaseFn: async () => writerInspection(),
    });
    expect(confirmations).toEqual([
      "Enable supervised source execution for billing.pause_notifications?",
    ]);
    if (!enable) {
      expect(await fs.readFile(path.join(root, "synapsor.actions.runner.json"), "utf8")).toBe(beforeExecution);
      expect((await readActionRuleAuthorityActivation(root))!.digest).toBe(active.digest);
      return;
    }
    expect(notice).toMatchObject({
      tone: "success",
      title: "Supervised execution enabled for this outcome.",
      lines: expect.arrayContaining([
        expect.stringContaining("Check only: synapsor-runner worker check --supervised --config"),
        expect.stringMatching(/Start work separately: synapsor-runner worker run --supervised --config .* --capability 'billing.pause_notifications' --yes/),
        "No proposal was executed and source data is unchanged.",
      ]),
    });
    const config = JSON.parse(await fs.readFile(path.join(root, "synapsor.actions.runner.json"), "utf8"));
    expect(config.supervised_worker.outcomes).toHaveLength(1);
    const reviewMenu = vi.fn().mockResolvedValue("back");
    await reviewVerifiedActionAuthority({
      projectRoot: root,
      boundaryName: readBoundary.pack.name,
      session: { ...session, chooseOption: reviewMenu },
      active,
      env: { BILLING_WRITER_URL: "postgresql://secret-writer-url" },
    });
    expect(JSON.stringify(reviewMenu.mock.calls)).toContain("Execution enabled");
    expect(JSON.stringify(reviewMenu.mock.calls)).not.toContain("Worker on");
    expect(confirmations).toHaveLength(1);
  });

  it.each(["unconfirmed", "committed", "cancelled"] as const)("keeps the execution review truthful after a %s save and pause", async (state) => {
    vi.spyOn(semanticDeployment, "verifySemanticExecutionReadPosture").mockResolvedValue(undefined);
    const root = await temporaryRoot(), read = activeReadBoundary();
    await writeActiveReadSet(root, read);
    const source = authoritySource(read.activation.digest);
    const draft = buildActionRuleAuthorityDraft({ name: "billing_active_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [{ read_boundary_name: read.pack.name, read_boundary_digest: read.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope, rule: source.rule }], reviews: [authorityReview()] });
    await writeActionRuleAuthorityDraft(root, draft);
    const active = (await activateSemanticActionRuntime({ projectRoot: root, draft, actor: "reviewer" })).activation;
    const code = state === "unconfirmed" ? "POLICY_EXECUTION_COMMIT_UNCONFIRMED" : "POLICY_CONFIG_RECOVERY_CLEANUP_PENDING";
    const fault = vi.spyOn(semanticDeployment, "enableSemanticSupervisedExecution").mockRejectedValue(
      Object.assign(new Error(`${code}: simulated publication outcome`), { code, publication_state: state }));
    const chooseOption = vi.fn().mockResolvedValueOnce("choose").mockResolvedValueOnce("details").mockResolvedValueOnce("pause");
    const showReviewDetails = vi.fn(async () => {}), confirmActivation = vi.fn(async () => true);
    try {
      const notice = await reviewSemanticSupervisedExecution({ projectRoot: root, outcome: source.rule.outcome,
        active, activeReads: [read], env: { BILLING_WRITER_URL: "postgresql://fixture.invalid" }, inspectDatabaseFn: async () => writerInspection(),
        session: { promptText: async () => "BILLING_WRITER_URL", confirmActivation, chooseOption, showReviewDetails } as unknown as BoundaryReviewInteractiveSession });
      expect(notice).toMatchObject({ tone: "warning", title: "Execution review paused." });
      expect(JSON.stringify(notice)).not.toMatch(/remain off|updates are off|not enabled/);
      expect(chooseOption.mock.calls[0]![0]).toBe("Set up database changes");
      expect(chooseOption.mock.calls[1]![0]).toBe("Execution save needs recovery");
      expect(JSON.stringify(chooseOption.mock.calls)).not.toMatch(/grants externally|completion stays off/);
      expect(showReviewDetails).toHaveBeenCalledWith("Execution save recovery", expect.any(Array));
      expect((await readPausedExecutionSetup(root, active.authority.action_boundary.digest))?.problem.publication_state).toBe(state);
      expect(confirmActivation).toHaveBeenCalledTimes(1);
    } finally { fault.mockRestore(); }
  });

  it("publishes one immutable authority only while its exact Read revision is active", async () => {
    const root = await temporaryRoot();
    const readBoundary = activeReadBoundary();
    await writeActiveReadSet(root, readBoundary);
    const source = authoritySource(readBoundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      reviews: [authorityReview()],
      now: "2026-09-02T20:00:00.000Z",
    });

    expect(await writeActionRuleAuthorityDraft(root, draft))
      .toBe("./.synapsor/action-rules/drafts/billing_active_rules/authority.json");
    await expect(listActionRuleAuthorityDrafts(root)).resolves.toEqual([draft]);
    await expect(readActionRuleAuthorityActivation(root)).resolves.toBeUndefined();
    const activation = await activateActionRuleAuthority({
      projectRoot: root,
      name: draft.authority.name,
      expected_digest: draft.digest,
      confirmation: `ACTIVATE ${draft.digest}`,
      actor: "billing reviewer",
      now: "2026-09-02T20:05:00.000Z",
    });
    expect(activation).toMatchObject({ state: "active", digest: draft.digest, actor: "billing reviewer" });
    expect(await readActionRuleAuthorityDraft(root, draft.authority.name)).toBeUndefined();
    await expect(listActionRuleAuthorityDrafts(root)).resolves.toEqual([]);
    await expect(readActionRuleAuthorityActivation(root)).resolves.toEqual(activation);

    const loaded = await loadActiveActionRuleAuthority(root);
    expect(loaded.registry.rules.map((entry) => entry.compiled.outcome))
      .toEqual(["billing.pause_notifications"]);
    expect(loaded.authority.action_boundary.digest)
      .toBe(loaded.registry.rules[0]!.action_boundary_digest);

    const changedReadBoundary = structuredClone(readBoundary);
    changedReadBoundary.activation.digest = `sha256:${"f".repeat(64)}`;
    await expect(loadActiveActionRuleAuthority(root, { read_boundaries: [changedReadBoundary] }))
      .rejects.toMatchObject({ code: "ACTION_RULE_READ_AUTHORITY_STALE" });
    const report = await loadActiveActionRuleAuthority(root, {
      read_boundaries: [changedReadBoundary], dependency_check: "report",
    });
    expect(report.unavailable_outcomes).toEqual(["billing.pause_notifications"]);
    expect(report.registry).toEqual(loaded.registry);
    expect(report.authority.digest).toBe(loaded.authority.digest);
    await expect(loadActiveActionRuleAuthority(root, {
      read_boundaries: [changedReadBoundary], outcome: "billing.pause_notifications",
    })).rejects.toMatchObject({ code: "ACTION_RULE_READ_AUTHORITY_STALE" });
    await expect(loadActiveActionRuleAuthority(root, { outcome: "invented.outcome" }))
      .rejects.toMatchObject({ code: "ACTION_RULE_OUTCOME_UNAVAILABLE" });
  });

  it("isolates stale outcomes without rewriting the signed registry or shared approval classes", async () => {
    const root = await temporaryRoot();
    const first = activeReadBoundary();
    const second = activeReadBoundary();
    second.pack.name = "reviewed_notifications";
    second.activation.digest = canonicalJsonDigest({ ...second, activation: "reviewed" });
    await writeActiveReadSet(root, first);
    const activePath = path.join(root, ".synapsor/exploration-boundaries.active.json");
    const activeSet = JSON.parse(await fs.readFile(activePath, "utf8"));
    activeSet.boundaries.push(second);
    await fs.writeFile(activePath, JSON.stringify(activeSet));
    const source = authoritySource(first.activation.digest);
    const draft = buildActionRuleAuthorityDraft({
      name: "independent_rules", action_boundary_name: "billing_actions", catalog: source.catalog,
      rules: [first, second].map((read, index) => ({
        read_boundary_name: read.pack.name, read_boundary_digest: read.activation.digest,
        verification_boundary: source.verification, effect_envelope: source.envelope,
        rule: { ...source.rule, name: `billing.pause_${index}`, outcome: `billing.pause_${index}` },
      })),
      reviews: [0, 1].map((index) => ({ ...authorityReview(), outcome: `billing.pause_${index}` })),
    });
    await writeActionRuleAuthorityDraft(root, draft);
    await activateActionRuleAuthority({ projectRoot: root, name: draft.authority.name,
      expected_digest: draft.digest, confirmation: `ACTIVATE ${draft.digest}`, actor: "reviewer" });
    const before = await loadActiveActionRuleAuthority(root);
    const changed = structuredClone(first);
    changed.activation.digest = `sha256:${"f".repeat(64)}`;
    const report = await loadActiveActionRuleAuthority(root, { read_boundaries: [changed, second], dependency_check: "report" });
    expect(report.unavailable_outcomes).toEqual(["billing.pause_0"]);
    expect(report.registry).toEqual(before.registry);
    expect(report.authority.digest).toBe(before.authority.digest);
    await expect(loadActiveActionRuleAuthority(root, { read_boundaries: [changed, second], outcome: "billing.pause_1" })).resolves.toMatchObject({ authority: { digest: before.authority.digest } });
    await expect(loadActiveActionRuleAuthority(root, { read_boundaries: [changed, second], outcome: "billing.pause_0" })).rejects.toMatchObject({ code: "ACTION_RULE_READ_AUTHORITY_STALE" });
  });

  it("refuses a changed active pointer even when its embedded authority still parses", async () => {
    const root = await temporaryRoot();
    const readBoundary = activeReadBoundary();
    await writeActiveReadSet(root, readBoundary);
    const source = authoritySource(readBoundary.activation.digest);
    const draft = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      reviews: [authorityReview()],
      now: "2026-09-02T20:00:00.000Z",
    });
    await writeActionRuleAuthorityDraft(root, draft);
    await activateActionRuleAuthority({
      projectRoot: root,
      name: draft.authority.name,
      expected_digest: draft.digest,
      confirmation: `ACTIVATE ${draft.digest}`,
      actor: "billing reviewer",
      now: "2026-09-02T20:05:00.000Z",
    });
    const activePath = path.join(root, ".synapsor/action-rules/active.json");
    const active = JSON.parse(await fs.readFile(activePath, "utf8")) as Record<string, unknown>;
    active.actor = "different reviewer";
    await fs.writeFile(activePath, `${JSON.stringify(active, null, 2)}\n`, "utf8");

    await expect(loadActiveActionRuleAuthority(root))
      .rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
    await expect(readActionRuleAuthorityActivation(root))
      .rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
  });

  it("keeps the active authority live until an exact replacement is separately activated", async () => {
    const root = await temporaryRoot();
    const readBoundary = activeReadBoundary();
    await writeActiveReadSet(root, readBoundary);
    const source = authoritySource(readBoundary.activation.digest);
    const original = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      reviews: [authorityReview()],
      now: "2026-09-02T20:00:00.000Z",
    });
    await writeActionRuleAuthorityDraft(root, original);
    const originalActivation = await activateActionRuleAuthority({
      projectRoot: root,
      name: original.authority.name,
      expected_digest: original.digest,
      confirmation: `ACTIVATE ${original.digest}`,
      actor: "billing reviewer",
      now: "2026-09-02T20:05:00.000Z",
    });

    const replacementRule = structuredClone(source.rule);
    replacementRule.ttl_seconds = 180;
    const replacement = buildActionRuleAuthorityDraft({
      name: original.authority.name,
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: replacementRule,
      }],
      reviews: [{
        ...authorityReview(),
        when: "The preference is active and the decision is current for three minutes.",
      }],
      now: "2026-09-02T20:10:00.000Z",
    });
    expect(replacement.digest).not.toBe(original.digest);
    await writeActionRuleAuthorityDraft(root, replacement);

    await expect(readActionRuleAuthorityActivation(root)).resolves.toEqual(originalActivation);
    await expect(listActionRuleAuthorityDrafts(root)).resolves.toEqual([replacement]);

    const replacementActivation = await activateActionRuleAuthority({
      projectRoot: root,
      name: replacement.authority.name,
      expected_digest: replacement.digest,
      confirmation: `ACTIVATE ${replacement.digest}`,
      actor: "billing reviewer",
      now: "2026-09-02T20:15:00.000Z",
    });
    expect(replacementActivation.digest).toBe(replacement.digest);
    await expect(readActionRuleAuthorityActivation(root)).resolves.toEqual(replacementActivation);
    await expect(listActionRuleAuthorityDrafts(root)).resolves.toEqual([]);

    await expect(fs.access(path.join(
      root,
      ".synapsor/action-rules/revisions",
      original.digest.slice("sha256:".length),
      "authority.json",
    ))).resolves.toBeUndefined();
  });

  it("renders active authority and its disabled replacement as separate operator choices", async () => {
    const root = await temporaryRoot();
    const readBoundary = activeReadBoundary();
    await writeActiveReadSet(root, readBoundary);
    const source = authoritySource(readBoundary.activation.digest);
    const original = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      reviews: [{
        ...authorityReview(),
        refused: [
          "The preference is already paused.",
          "Verification does not resolve exactly one preference",
        ],
      }],
      now: "2026-09-02T20:00:00.000Z",
    });
    await writeActionRuleAuthorityDraft(root, original);
    const active = await activateActionRuleAuthority({
      projectRoot: root,
      name: original.authority.name,
      expected_digest: original.digest,
      confirmation: `ACTIVATE ${original.digest}`,
      actor: "billing reviewer",
      now: "2026-09-02T20:05:00.000Z",
    });
    const replacementRule = structuredClone(source.rule);
    replacementRule.ttl_seconds = 180;
    const replacement = buildActionRuleAuthorityDraft({
      name: original.authority.name,
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: replacementRule,
      }],
      reviews: [authorityReview()],
      now: "2026-09-02T20:10:00.000Z",
    });
    await writeActionRuleAuthorityDraft(root, replacement);

    let menuContext: string[] = [];
    let activeDetailsContext: string[] = [];
    let menuValues: string[] = [];
    let openedActiveDetails = false;
    const session: BoundaryReviewInteractiveSession = {
      terminalColumns: 80,
      chooseResource: async () => undefined,
      editFieldTiers: async () => "back",
      promptText: async () => undefined,
      confirm: async () => false,
      chooseOption: async (title, choices, options) => {
        if (title === "EXACT ACTIVE ACTION DETAILS") {
          activeDetailsContext = options?.context ?? [];
          return "back";
        }
        if (title !== "VERIFIED ACTION BOUNDARY") throw new Error(`Unexpected choice: ${title}`);
        menuContext = options?.context ?? [];
        menuValues = choices.map((choice) => choice.value);
        if (!openedActiveDetails) {
          openedActiveDetails = true;
          return "details_active";
        }
        return "back";
      },
    };
    const notice = await reviewVerifiedActionAuthority({
      projectRoot: root,
      boundaryName: readBoundary.pack.name,
      session,
      draft: replacement,
      active,
    });

    expect(menuContext).toEqual(expect.arrayContaining([
      expect.stringContaining("ACTIVE AUTHORITY"),
      expect.stringContaining("REPLACEMENT DRAFT - NOT ACTIVE"),
      expect.stringContaining("active authority remains live"),
    ]));
    expect(menuValues).toEqual([
      "activate",
      "details_draft",
      "details_active",
      "enable_execution:billing.pause_notifications",
      "deactivate",
      "back",
    ]);
    expect(menuContext.filter((line) => line.startsWith("+") || line.startsWith("|")))
      .toEqual(expect.arrayContaining([expect.stringContaining("+")]));
    expect([...menuContext, ...activeDetailsContext]
      .filter((line) => line.startsWith("+") || line.startsWith("|"))
      .every((line) => line.length <= 76)).toBe(true);
    expect(activeDetailsContext).toEqual(expect.arrayContaining([
      "EXAMPLES",
      "REVIEW   1 distinct action_reviewer approval",
      "REFUSE   The preference is already paused. Verification does not resolve exactly one preference.",
      expect.stringContaining("| Case"),
    ]));
    expect(notice).toMatchObject({
      tone: "warning",
      title: "Active verified authority is unchanged; replacement remains disabled.",
    });
  });

  it("adds a second reviewed outcome without replacing the active outcome behind the fixed tool", async () => {
    const root = await temporaryRoot();
    const readBoundary = activeReadBoundary();
    await writeActiveReadSet(root, readBoundary);
    const source = authoritySource(readBoundary.activation.digest);
    const original = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      reviews: [authorityReview()],
      now: "2026-09-02T20:00:00.000Z",
    });
    await writeActionRuleAuthorityDraft(root, original);
    const active = await activateActionRuleAuthority({
      projectRoot: root,
      name: original.authority.name,
      expected_digest: original.digest,
      confirmation: `ACTIVATE ${original.digest}`,
      actor: "billing reviewer",
      now: "2026-09-02T20:05:00.000Z",
    });

    const resumeEnvelope = structuredClone(source.envelope);
    resumeEnvelope.name = "billing.resume_effect";
    resumeEnvelope.allowed_fields = [{ name: "status", type: stateType, values: ["active"] }];
    const resumeRule = structuredClone(source.rule);
    resumeRule.name = "billing.resume_notifications";
    resumeRule.outcome = "billing.resume_notifications";
    resumeRule.require = {
      kind: "compare",
      operator: "eq",
      left: { kind: "field", binding: "preference", field: "status" },
      right: { kind: "literal", value: "paused", value_type: stateType },
    };
    resumeRule.effect.set = {
      status: { kind: "literal", value: "active", value_type: stateType },
    };
    const resumeVerification = structuredClone(source.verification);
    resumeVerification.name = "billing.resume_verification";
    resumeRule.verification_boundary_ref = resumeVerification.name;
    resumeRule.effect_envelope_ref = resumeEnvelope.name;
    const incoming = buildActionRuleAuthorityDraft({
      name: original.authority.name,
      action_boundary_name: original.authority.action_boundary.name,
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: resumeVerification,
        effect_envelope: resumeEnvelope,
        rule: resumeRule,
      }],
      reviews: [{
        outcome: "billing.resume_notifications",
        when: "The preference is paused.",
        then: "Propose resuming notifications.",
        refused: ["The preference is already active."],
        human_review: "One billing reviewer must approve.",
        examples: [{ kind: "eligible", scenario: "Paused preference", result: "Create a proposal" }],
      }],
      now: "2026-09-02T20:10:00.000Z",
    });
    const replacement = mergeActionRuleAuthorityDraft({
      existing: active,
      incoming,
    });
    expect(replacement.authority.rules.map((rule) => rule.rule.outcome)).toEqual([
      "billing.pause_notifications",
      "billing.resume_notifications",
    ]);
    expect(replacement.authority.approval_classes).toHaveLength(1);
    expect(replacement.authority.approval_classes[0]!.rules.map((rule) => rule.outcome)).toEqual([
      "billing.pause_notifications",
      "billing.resume_notifications",
    ]);

    const revisedPause = buildActionRuleAuthorityDraft({
      name: original.authority.name,
      action_boundary_name: original.authority.action_boundary.name,
      catalog: source.catalog,
      rules: [{
        read_boundary_name: readBoundary.pack.name,
        read_boundary_digest: readBoundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      approval_classes: [{
        name: "billing.standard_change",
        mode: "human",
        rules: [{ outcome: "billing.pause_notifications" }],
        required_role: "billing_reviewer",
        required_approvals: 2,
        shared_limits: [],
      }],
      reviews: [{
        ...authorityReview(),
        human_review: "Two billing reviewers must approve.",
      }],
      now: "2026-09-02T20:12:00.000Z",
    });
    const policyReplacement = mergeActionRuleAuthorityDraft({
      existing: replacement,
      incoming: revisedPause,
    });
    const pauseRule = policyReplacement.authority.rules.find((rule) =>
      rule.rule.outcome === "billing.pause_notifications")!;
    const resumeRuleSource = policyReplacement.authority.rules.find((rule) =>
      rule.rule.outcome === "billing.resume_notifications")!;
    expect(pauseRule.rule.approval_class).toMatch(/^billing\.revision_[a-f0-9]{12}$/u);
    expect(resumeRuleSource.rule.approval_class).toBe("billing.standard_change");
    expect(policyReplacement.authority.approval_classes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: pauseRule.rule.approval_class,
        required_role: "billing_reviewer",
        required_approvals: 2,
        rules: [{ outcome: "billing.pause_notifications" }],
      }),
      expect.objectContaining({
        name: "billing.standard_change",
        required_approvals: 1,
        rules: [{ outcome: "billing.resume_notifications" }],
      }),
    ]));
    await writeActionRuleAuthorityDraft(root, replacement);
    expect((await readActionRuleAuthorityActivation(root))!.authority.rules).toHaveLength(1);

    await activateActionRuleAuthority({
      projectRoot: root,
      name: replacement.authority.name,
      expected_digest: replacement.digest,
      confirmation: `ACTIVATE ${replacement.digest}`,
      actor: "billing reviewer",
      now: "2026-09-02T20:15:00.000Z",
    });
    const loaded = await loadActiveActionRuleAuthority(root);
    expect(loaded.registry.rules.map((rule) => rule.compiled.outcome)).toEqual([
      "billing.pause_notifications",
      "billing.resume_notifications",
    ]);
  });
  it("builds a disabled replacement that removes one exact outcome and preserves retained authority", () => {
    const boundary = activeReadBoundary();
    const source = authoritySource(boundary.activation.digest);
    const entry = (outcome: string, approvalClass: string) => {
      const effect = { ...source.envelope, name: `${outcome}.effect`, approval_classes: [approvalClass] };
      return {
        read_boundary_name: boundary.pack.name,
        read_boundary_digest: boundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: effect,
        rule: { ...source.rule, name: outcome, outcome, effect_envelope_ref: effect.name, approval_class: approvalClass },
      };
    };
    const pause = entry("billing.pause_notifications", "billing.standard_change");
    const resume = entry("billing.resume_notifications", "billing.standard_change");
    const archive = entry("billing.archive_notifications", "billing.exception_change");
    const original = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [pause, resume, archive],
      reviews: [pause, resume, archive].map(({ rule }) => ({ ...authorityReview(), outcome: rule.outcome })),
      now: "2026-09-02T20:00:00.000Z",
    });

    const replacement = removeOutcomeActionRuleAuthorityDraft({
      existing: original,
      outcome: archive.rule.outcome,
      now: original.created_at,
    });

    expect(replacement.state).toBe("disabled");
    expect(replacement.authority.name).toBe(original.authority.name);
    expect(replacement.authority.action_boundary.name).toBe(original.authority.action_boundary.name);
    expect(replacement.authority.catalog).toEqual(original.authority.catalog);
    expect(replacement.authority.rules).toEqual(original.authority.rules.filter((rule) => rule.rule.outcome !== archive.rule.outcome));
    expect(replacement.reviews).toEqual(original.reviews.filter((review) => review.outcome !== archive.rule.outcome));
    expect(replacement.authority.approval_classes).toEqual([
      expect.objectContaining({
        name: "billing.standard_change",
        rules: [{ outcome: pause.rule.outcome }, { outcome: resume.rule.outcome }],
      }),
    ]);
    expect(replacement.digest).not.toBe(original.digest);
  });

  it("refuses an unknown outcome and removal of the final outcome", () => {
    const boundary = activeReadBoundary();
    const source = authoritySource(boundary.activation.digest);
    const single = buildActionRuleAuthorityDraft({
      name: "billing_active_rules",
      action_boundary_name: "billing_actions",
      catalog: source.catalog,
      rules: [{
        read_boundary_name: boundary.pack.name,
        read_boundary_digest: boundary.activation.digest,
        verification_boundary: source.verification,
        effect_envelope: source.envelope,
        rule: source.rule,
      }],
      reviews: [authorityReview()],
      now: "2026-09-02T20:00:00.000Z",
    });

    expect(() => removeOutcomeActionRuleAuthorityDraft({ existing: single, outcome: "billing.unknown" }))
      .toThrow("ACTION_RULE_OUTCOME_NOT_FOUND");
    expect(() => removeOutcomeActionRuleAuthorityDraft({ existing: single, outcome: source.rule.outcome }))
      .toThrow("ACTION_RULE_LAST_OUTCOME_REMOVAL_UNSUPPORTED");
    expect(() => removeOutcomeActionRuleAuthorityDraft({ existing: single, outcome: source.rule.outcome }))
      .toThrow("Deactivate the verified Action Boundary instead");
  });
});

function authorityReview() {
  return {
    outcome: "billing.pause_notifications",
    when: "The preference is active.",
    then: "Propose pausing notifications.",
    refused: ["The preference is already paused."],
    human_review: "One billing reviewer must approve.",
    examples: [
      { kind: "eligible" as const, scenario: "Active preference", result: "Create a proposal" },
      { kind: "ineligible" as const, scenario: "Paused preference", result: "Refuse" },
    ],
  };
}

function authoritySource(readBoundaryDigest: `sha256:${string}`): {
  catalog: ActionRuleCatalogV1;
  verification: RuleVerificationBoundarySpecV1;
  envelope: DerivedEffectEnvelopeSpecV1;
  rule: ActionRuleSpecV1;
} {
  void readBoundaryDigest;
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [{
      name: "billing.preferences",
      source: "local_postgres",
      engine: "postgres",
      schema: "billing",
      table: "preferences",
      primary_key: "preference_id",
      tenant_key: "account_id",
      principal_scope_key: "principal_id",
      version_field: "version",
      fields: [
        { name: "preference_id", type: stringId, nullable: false },
        { name: "account_id", type: stringId, nullable: false },
        { name: "principal_id", type: stringId, nullable: false },
        { name: "status", type: stateType, nullable: false },
        { name: "version", type: { kind: "integer" }, nullable: false },
      ],
    }],
    relationships: [],
  };
  const verification: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1",
    name: "billing.pause_verification",
    source: "local_postgres",
    context: "trusted_context",
    generation_lock_fingerprint: lock,
    resources: [{
      binding: "preference",
      resource: "billing.preferences",
      source: { kind: "subject_ref" },
      primary_key: "preference_id",
      version_field: "version",
      fields: catalog.resources[0]!.fields,
      scope: { mode: "columns", tenant_field: "account_id", principal_field: "principal_id" },
      cardinality: "one",
      max_rows: 1,
      overflow: "unsupported",
      lock: "for_update",
    }],
    lock_order: ["preference"],
    transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const envelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1",
    name: "billing.pause_effect",
    source: "local_postgres",
    operation: "update",
    target_resource: "billing.preferences",
    target_binding: "preference",
    primary_key: "preference_id",
    tenant_key: "account_id",
    principal_scope_key: "principal_id",
    conflict_key: "version",
    max_rows: 1,
    allowed_fields: [{ name: "status", type: stateType, values: ["paused"] }],
    version_advance: { column: "version", strategy: "integer_increment" },
    approval_classes: ["billing.standard_change"],
    writeback: { mode: "direct_sql", supervised_worker: "allowed" },
  };
  const rule: ActionRuleSpecV1 = {
    schema_version: "synapsor.action-rule.v1",
    name: "billing.pause_notifications",
    outcome: "billing.pause_notifications",
    context: "trusted_context",
    source: "local_postgres",
    verification_boundary_ref: verification.name,
    effect_envelope_ref: envelope.name,
    subjects: [{ binding: "preference", resource: "billing.preferences", input: "opaque_subject_ref" }],
    require: {
      kind: "compare",
      operator: "eq",
      left: { kind: "field", binding: "preference", field: "status" },
      right: { kind: "literal", value: "active", value_type: stateType },
    },
    derive: {},
    effect: {
      operation: "update",
      target_resource: "billing.preferences",
      target_binding: "preference",
      set: { status: { kind: "literal", value: "paused", value_type: stateType } },
    },
    approval_class: "billing.standard_change",
    ttl_seconds: 300,
  };
  return { catalog, verification, envelope, rule };
}

function activeReadBoundary(): ActivatedExplorationBoundary {
  const authority = {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "reviewed" as const,
    deployment_profile: "staging" as const,
    source: "local_postgres",
    compiler_version: "test",
    spec_version: "test",
    trusted_context: {
      provider: "environment" as const,
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
    },
    generation_lock_fingerprint: lock,
    role_posture_fingerprint: `sha256:${"b".repeat(64)}` as const,
    pack: { name: "reviewed_billing", resources: [{
      id: "billing.preferences", schema: "billing", table: "preferences", primary_key: "preference_id", tenant_key: "account_id", principal_key: "principal_id",
      field_types: { status: "text", version: "integer" }, field_enums: {}, selectable_fields: ["status"], filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["preference_id", "account_id", "principal_id", "version"], relationships: [],
    }] },
    budgets: { max_rows: 50, max_response_cells: 500 },
  };
  return {
    ...authority,
    activation: {
      state: "active",
      digest: canonicalJsonDigest(authority),
      actor: "test",
      activated_at: "2026-09-02T19:00:00.000Z",
      generation_lock_fingerprint: lock,
      reviewed_decisions: [],
    },
  } as unknown as ActivatedExplorationBoundary;
}

async function migrateActionBaselineFixture(projectRoot: string) {
  const drafts = (await listActionRuleAuthorityDrafts(projectRoot)).map((authority) => encodeOperatorAuthority({ type: "action", authority }));
  const active = await readActionRuleAuthorityActivation(projectRoot);
  const activeRecords = [encodeOperatorAuthority({ type: "read_selection", selected_name: null }),
    ...(active ? [encodeOperatorAuthority({ type: "action", authority: active })] : [])];
  const pointer = (entry: typeof drafts[number]) => ({ scope: entry.scope, kind: entry.kind, name: entry.name, revision_id: entry.revision_id });
  return (await migrateProjectControlPolicies({ projectRoot, config: {} as RuntimeConfig, storePath: path.join(projectRoot, "control.db"),
    actor: "fixture reviewer", readLegacySnapshot: async () => ({ revisions: [...drafts, ...activeRecords],
      active: activeRecords.map(pointer), drafts: drafts.map(pointer), provenance: [] }),
    validateSnapshot: async (snapshot) => validateOperatorPolicySnapshot(snapshot),
  })).binding;
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-action-rules-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "synapsor.runner.json"), `${JSON.stringify({
    version: 1,
    mode: "read_only",
    storage: { sqlite_path: "./.synapsor/local.db" },
    sources: {
      local_postgres: {
        engine: "postgres",
        read_url_env: "DATABASE_URL",
        read_only: true,
      },
    },
    trusted_context: { provider: "environment" },
    capabilities: [{
      name: "billing.inspect_preference",
      kind: "read",
      source: "local_postgres",
      target: {
        schema: "billing",
        table: "preferences",
        primary_key: "preference_id",
        tenant_key: "account_id",
        principal_scope_key: "principal_id",
      },
      args: { preference_id: { type: "string", required: true } },
      lookup: { id_from_arg: "preference_id" },
      visible_columns: ["status"],
      max_rows: 1,
    }],
  }, null, 2)}\n`, "utf8");
  return root;
}

async function writeActiveReadSet(root: string, boundary: ActivatedExplorationBoundary): Promise<void> {
  const state = path.join(root, ".synapsor");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "exploration-boundaries.active.json"), `${JSON.stringify({
    schema_version: "synapsor.active-exploration-boundaries.v1",
    selected_name: boundary.pack.name,
    boundaries: [boundary],
    updated_at: "2026-09-02T19:00:00.000Z",
  }, null, 2)}\n`, "utf8");
}

function writerInspection(): SchemaInspection {
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16.4",
    current_user: "billing_writer",
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: false,
      writable_relations: ["billing.preferences"],
      owned_relations: [],
      reasons: [],
    },
    inspected_at: "2026-09-03T00:00:00.000Z",
    schemas: ["billing"],
    tables: [{
      schema: "billing",
      name: "preferences",
      row_level_security: false,
      role_posture: { privileges: writerPrivileges({ select: true, update: true }) },
    } as never],
    warnings: [],
  };
}

function writerPrivileges(overrides: Partial<Record<"select" | "insert" | "update" | "delete" | "truncate" | "references" | "trigger", boolean>>) {
  return {
    select: false,
    insert: false,
    update: false,
    delete: false,
    truncate: false,
    references: false,
    trigger: false,
    ...overrides,
  };
}

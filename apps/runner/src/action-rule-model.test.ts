import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildActionRuleAuthorityDraft, writeActionRuleAuthorityDraft, readActionRuleAuthorityDraft, readActionRuleAuthorityRevisionBaseline, writeActionRuleAuthorityDraftIfCurrent } from "./action-rule-authority.js";
import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import type {
  ActionRuleBooleanExpressionV1,
  ActionRuleScalarTypeSpecV1,
} from "@synapsor/spec";
import { describe, expect, it, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";
import { compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { actionRuleModelDraftJsonSchema, generateFocusedModelActionRuleDraft as generateModelActionRuleDraft, generateModelActionRuleDraft as converseActionRuleDraft } from "./action-rule-model.js";
import type { AskProviderDependencies } from "./model-ask.js";
import type { ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { inspectActionRelationships } from "./action-rule-relationship-review.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { evaluateActionRule, evaluateActionRuleApprovalPredicate } from "@synapsor-runner/action-rules";
import { ActionAuthoringReadOnlyRequest } from "./action-rule-model.js";

const lock = `sha256:${"a".repeat(64)}` as const;
const readDigest = `sha256:${"b".repeat(64)}` as const;
const stringId = { kind: "string", max_length: 64, comparison: "exact" } as const;
const statusType: ActionRuleScalarTypeSpecV1 = {
  kind: "string",
  max_length: 8,
  comparison: "exact",
  enum: ["active", "paused"],
};

describe("structured Action draft schema", () => {
  it.each(["update", "insert"] as const)("accepts the compiler-valid nested %s fixture without merging component names", (operation) => {
    const draft = modelDraft(), catalog = builtCatalog();
    draft.effect.operation = operation;
    if (operation === "insert") {
      delete draft.effect.target_binding;
      catalog.authoring.resources[0]!.operations.insert = true;
    }
    const before = structuredClone(draft);
    const compiled = compileActionRuleModelDraft({ draft, builtCatalog: catalog,
      readBoundary: boundary(), readBoundaryDigest: readDigest });
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(actionRuleModelDraftJsonSchema());
    expect(validate(compiled.draft), JSON.stringify(validate.errors)).toBe(true);
    expect(compiled.rule.name).toBe(draft.name);
    expect(compiled.verification_boundary.name).toBe(draft.verification.name);
    expect(compiled.effect_envelope.name).toBe(draft.effect.name);
    expect(compiled.approval_class.name).toBe(draft.approval.class_name);
    expect(new Set([draft.name, draft.verification.name, draft.effect.name, draft.approval.class_name]).size).toBe(4);
    expect(draft).toEqual(before);
  });

  it("retains nested policy predicates, shared limits and expression definitions", () => {
    const draft = policyModelDraft();
    const compiled = compileActionRuleModelDraft({ draft, builtCatalog: builtCatalog(),
      readBoundary: boundary(), readBoundaryDigest: readDigest });
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(actionRuleModelDraftJsonSchema());
    expect(validate(compiled.draft), JSON.stringify(validate.errors)).toBe(true);
    expect(compiled.approval_class.shared_limits).toEqual(draft.approval.shared_limits);
    expect(validate({ ...draft, approval: { ...draft.approval,
      auto_approve_when: { kind: "compare", operator: "execute", left: statusLiteral("active"), right: statusLiteral("active") },
    } })).toBe(false);
  });

  it("rejects flattened phases, provider envelopes, unknown fields and invalid effect variants", () => {
    const draft = modelDraft();
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(actionRuleModelDraftJsonSchema());
    expect(validate(draft), JSON.stringify(validate.errors)).toBe(true);
    const { verification, effect, approval, ...rule } = draft;
    const { target_binding: _target, ...withoutTarget } = effect;
    const invalid = [
      { ...rule, ...verification, ...approval, ...effect },
      { ...draft, status: "draft" },
      { ...draft, verification: { ...verification, status: "draft" } },
      { ...draft, effect: { ...effect, status: "draft" } },
      { ...draft, approval: { ...approval, actor: "external_actor" } },
      { ...draft, effect: withoutTarget },
      { ...draft, effect: { ...effect, operation: "insert" } },
      { ...draft, effect: { ...effect, set: { status: {
        kind: "literal", value: "paused", value_type: { kind: "unsupported_type" },
      } } } },
    ];
    for (const candidate of invalid) expect(validate(candidate), JSON.stringify(candidate)).toBe(false);
  });
});

describe("conversational Action authoring tools", () => {
  it("reviews an existing counter through a bounded host operation and restores it before resuming draft components", async () => {
    const initial = builtCatalog();
    delete initial.catalog.resources[0]!.version_field;
    delete initial.authoring.resources[0]!.selected_version_field;
    initial.authoring.resources[0]!.version_candidates = [];
    initial.authoring.resources[0]!.version_field_options = ["version"];
    initial.authoring.resources[0]!.operations.update = false;
    const review = { resource: "billing.accounts", field: "version", maintenance: "all_writers_increment" as const,
      proof_digest: canonicalJsonDigest("reviewed owner-maintained counter") };
    const reviewVersionField = vi.fn(async ({ context }: Parameters<NonNullable<Parameters<typeof converseActionRuleDraft>[0]["reviewVersionField"]>>[0]) =>
      ({ ...context, builtCatalog: builtCatalog(), review }));
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    const first = [call("runner.review_version_field", { resource: review.resource, field: review.field }),
      call("runner.submit_verification_boundary_draft"), say("Who reviews valid exceptions?")];
    await expect(converseActionRuleDraft({ ...requestInput(async () => first.shift()!), builtCatalog: initial, reviewVersionField,
      onCheckpoint: async saved => { checkpoint = saved; }, askClarification: async () => undefined })).rejects.toThrow("CANCELLED");
    expect(checkpoint?.reviewed_version_fields).toEqual([review]);
    expect(checkpoint?.components.verification).toBeDefined();
    expect(initial.catalog.resources[0]!.version_field).toBeUndefined();
    const resumed = [call("runner.submit_effect_envelope_draft"), call("runner.submit_action_rule_draft"),
      call("runner.submit_approval_policy_draft"), call("runner.validate_action_draft", {}), say("Ready for review.")];
    const actual = await converseActionRuleDraft({ ...requestInput(async () => resumed.shift()!), builtCatalog: initial,
      reviewVersionField, checkpoint });
    expect(reviewVersionField.mock.calls[1]?.[0]).toMatchObject({ previousReview: review });
    expect(actual).toMatchObject({ authority_granted: false, source_database_changed: false });
    expect(actual.compiled.loaded.authority.catalog.resources[0]!.version_field).toBe("version");
    expect(resumed).toEqual([]);
    const noRequest = vi.fn();
    await expect(converseActionRuleDraft({ ...requestInput(noRequest), checkpoint, builtCatalog: initial })).rejects.toThrow("CHECKPOINT_STALE");
    expect(noRequest).not.toHaveBeenCalled();
    await expect(converseActionRuleDraft({ ...requestInput(noRequest), checkpoint, builtCatalog: initial,
      reviewVersionField: async () => undefined })).rejects.toThrow("CHECKPOINT_STALE");
    expect(noRequest).not.toHaveBeenCalled();
  });

  it("does not repeat declined counter review or treat it as mapped", async () => {
    const requests: string[] = [];
    const steps = [call("runner.review_version_field", { resource: "billing.accounts", field: "version" }),
      call("runner.review_version_field", { resource: "billing.accounts", field: "version" }), say("Keep this mapping pending.")];
    const reviewVersionField = vi.fn(async () => undefined), onCheckpoint = vi.fn();
    await expect(converseActionRuleDraft({ ...requestInput(async request => { requests.push(JSON.stringify(request.body)); return steps.shift()!; }),
      reviewVersionField, onCheckpoint, askClarification: async () => undefined })).rejects.toThrow("CANCELLED");
    expect(reviewVersionField).toHaveBeenCalledOnce();
    expect(requests.at(-1)).toContain("do not repeat the same confirmation");
    expect(onCheckpoint.mock.calls.every(([saved]) => !saved.reviewed_version_fields?.length)).toBe(true);
  });

  it.each(["extra", "invalid_name", "changed_read", "wrong_field"])("refuses an unbounded or inconsistent counter mapping (%s)", async kind => {
    const requests: string[] = [];
    const args = { resource: "billing.accounts", field: "version", ...(kind === "extra" ? { execute: true } : {}) };
    if (kind === "invalid_name") args.field = "version; DROP TABLE accounts";
    const steps = [call("runner.review_version_field", args), say("Mapping remains pending.")];
    const reviewVersionField = vi.fn(async ({ context }: Parameters<NonNullable<Parameters<typeof converseActionRuleDraft>[0]["reviewVersionField"]>>[0]) => ({
      ...context, ...(kind === "changed_read" ? { readBoundaryDigest: canonicalJsonDigest("unapproved reads") } : {}),
      review: { resource: "billing.accounts", field: kind === "wrong_field" ? "other_counter" : "version",
        maintenance: "all_writers_increment" as const, proof_digest: canonicalJsonDigest("proof") },
    }));
    await expect(converseActionRuleDraft({ ...requestInput(async request => { requests.push(JSON.stringify(request.body)); return steps.shift()!; }),
      reviewVersionField, askClarification: async () => undefined })).rejects.toThrow("CANCELLED");
    if (["extra", "invalid_name"].includes(kind)) expect(reviewVersionField).not.toHaveBeenCalled();
    else expect(requests.at(-1)).toContain("ACTION_VERSION_REVIEW_CHANGED");
    expect(requests.at(-1)).not.toContain('"status":"counter_mapping_prepared"');
  });

  it("revalidates retained partial components after a host-mediated Read edit without asking answered questions", async () => {
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    const first = [call("runner.submit_verification_boundary_draft"), call("runner.submit_effect_envelope_draft"),
      call("runner.submit_action_rule_draft"), say("Who reviews this request?")];
    await expect(converseActionRuleDraft({ ...requestInput(async () => first.shift()!),
      onCheckpoint: async value => { checkpoint = value; }, askClarification: async () => undefined })).rejects.toThrow("CANCELLED");
    const before = structuredClone(checkpoint);
    const resumed = [call("runner.inspect_action_draft", {}), call("runner.submit_approval_policy_draft"),
      call("runner.validate_action_draft", {}), say("The updated access and saved action validate.")];
    const requests: string[] = [];
    const result = await converseActionRuleDraft({ ...requestInput(async request => {
      requests.push(JSON.stringify(request.body)); return resumed.shift()!;
    }), checkpoint, revalidateSavedComponents: true, readBoundaryDigest: `sha256:${"f".repeat(64)}` });
    expect(result.state).toBe("ready");
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(requests[0]).toContain("needs_revalidation");
    expect(requests[0]).toContain("untrusted drafting input");
    expect(checkpoint).toEqual(before);
    expect(resumed).toEqual([]);
    const noRequest = vi.fn();
    await expect(converseActionRuleDraft({ ...requestInput(noRequest), checkpoint, revalidateSavedComponents: true,
      intent: "An unrelated new action" })).rejects.toThrow("CHECKPOINT_STALE");
    expect(noRequest).not.toHaveBeenCalled();
  });

  it("restores a reviewed private source before checkpoint validation and carries it through later components", async () => {
    const expanded = structuredClone(builtCatalog());
    expanded.catalog.resources.push({ ...structuredClone(expanded.catalog.resources[0]!), name: "billing.admission", table: "admission" });
    expanded.authoring.resources.push({ ...structuredClone(expanded.authoring.resources[0]!), name: "billing.admission", operations: { insert: false, update: false } });
    const review = { resource: "billing.admission", parent_resource: "billing.accounts", relationship: "admission_account",
      proof_digest: `sha256:${"c".repeat(64)}` as const };
    const reviewPrivateSource = vi.fn(async (_request: Parameters<NonNullable<Parameters<typeof converseActionRuleDraft>[0]["reviewPrivateSource"]>>[0]) => ({ builtCatalog: expanded, readBoundary: boundary(), readBoundaryDigest: readDigest, review }));
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    const steps = [call("runner.review_private_action_source", { resource: review.resource, parent_resource: review.parent_resource }),
      call("runner.submit_verification_boundary_draft"), say("What admission rule applies?")];
    await expect(converseActionRuleDraft({ ...requestInput(async () => steps.shift()!), reviewPrivateSource,
      onCheckpoint: async value => { checkpoint = value; }, askClarification: async () => undefined })).rejects.toThrow("CANCELLED");
    expect(checkpoint?.reviewed_private_sources).toEqual([review]);
    expect(checkpoint?.components.verification).toBeDefined();
    const resumedSteps = [call("runner.submit_effect_envelope_draft"), call("runner.submit_action_rule_draft"),
      call("runner.submit_approval_policy_draft"), call("runner.validate_action_draft", {}), say("Draft ready.")];
    const prepareResources = vi.fn(async ({ context }: Parameters<NonNullable<Parameters<typeof converseActionRuleDraft>[0]["prepareResources"]>>[0]) => context);
    const result = await converseActionRuleDraft({ ...requestInput(async () => resumedSteps.shift()!), reviewPrivateSource, checkpoint, prepareResources });
    expect(reviewPrivateSource.mock.calls[1]?.[0]).toMatchObject({ previousReview: review });
    expect(prepareResources.mock.calls[0]?.[0].context.builtCatalog).toEqual(expanded);
    expect(result.compiled.loaded.authority.catalog.resources.map(resource => resource.name)).toContain("billing.admission");
    const expected = modelDraft();
    expected.verification.resources[0]!.fields = ["account_id", "risk_hold", "status", "version"];
    expect(result.compiled.draft).toEqual(expected);
    await expect(converseActionRuleDraft({ ...requestInput(vi.fn()), checkpoint,
      reviewPrivateSource: async () => ({ builtCatalog: expanded, readBoundary: boundary(), readBoundaryDigest: readDigest,
        review: { ...review, proof_digest: `sha256:${"e".repeat(64)}` } }),
    })).rejects.toThrow("CHECKPOINT_STALE");
    await expect(converseActionRuleDraft({ ...requestInput(vi.fn()), checkpoint })).rejects.toThrow("CHECKPOINT_STALE");
  });

  it("cannot turn a retained checkpoint into authority when the current catalog no longer supports its fields", async () => {
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    const first = [call("runner.submit_verification_boundary_draft"), call("runner.submit_effect_envelope_draft"),
      call("runner.submit_action_rule_draft"), call("runner.submit_approval_policy_draft"), say("Pause this draft?")];
    await expect(converseActionRuleDraft({ ...requestInput(async () => first.shift()!),
      onCheckpoint: async value => { checkpoint = value; }, askClarification: async () => undefined })).rejects.toThrow("CANCELLED");
    const changed = structuredClone(builtCatalog());
    changed.catalog.resources[0]!.fields = changed.catalog.resources[0]!.fields.filter(field => field.name !== "status");
    changed.authoring.resources[0]!.fields = changed.authoring.resources[0]!.fields.filter(field => field.name !== "status");
    const requests: string[] = [];
    const steps = [call("runner.validate_action_draft", {}), say("The saved status field is no longer available. Keep setup pending?")];
    await expect(converseActionRuleDraft({ ...requestInput(async request => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), builtCatalog: changed, checkpoint, revalidateSavedComponents: true,
      askClarification: async () => undefined })).rejects.toThrow("CANCELLED");
    expect(requests[1]).toContain("needs_repair");
    expect(requests.join("\n")).not.toContain('"status":"ready_for_review"');
    expect(steps).toEqual([]);
  });

  it.each(["reviewed", "declined", "public_read_changed", "unrelated_intent"])("retains partial business work but requires the current private proof after rescan (%s)", async scenario => {
    const review = { resource: "billing.private_facts", parent_resource: "billing.accounts", relationship: "facts_account",
      proof_digest: canonicalJsonDigest("previous reviewed proof") };
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    const first = [call("runner.review_private_action_source", { resource: review.resource, parent_resource: review.parent_resource }),
      call("runner.submit_verification_boundary_draft"), say("Who reviews exceptions?")];
    await expect(converseActionRuleDraft({ ...requestInput(async () => first.shift()!),
      reviewPrivateSource: async ({ context }) => ({ ...context, review }),
      onCheckpoint: async value => { checkpoint = value; }, askClarification: async () => undefined })).rejects.toThrow("CANCELLED");
    const before = structuredClone(checkpoint);
    const currentReview = { ...review, proof_digest: canonicalJsonDigest("fresh explicitly reviewed proof") };
    const sourceReview = vi.fn(async ({ context, revalidatePreviousReview }: Parameters<NonNullable<Parameters<typeof converseActionRuleDraft>[0]["reviewPrivateSource"]>>[0]) => {
      expect(revalidatePreviousReview).toBe(true);
      if (scenario === "declined") return undefined;
      return { ...context, review: currentReview,
        ...(scenario === "public_read_changed" ? { readBoundaryDigest: canonicalJsonDigest("unauthorized new public access") } : {}) };
    });
    const steps = [call("runner.submit_effect_envelope_draft"), call("runner.submit_action_rule_draft"),
      call("runner.submit_approval_policy_draft"), call("runner.validate_action_draft", {}), say("Ready for review.")];
    const request = vi.fn(async () => steps.shift()!);
    let saved: ActionRuleAuthoringCheckpoint | undefined;
    const result = converseActionRuleDraft({ ...requestInput(request), checkpoint, revalidateSavedComponents: true,
      readBoundaryDigest: canonicalJsonDigest("current read"), reviewPrivateSource: sourceReview,
      ...(scenario === "unrelated_intent" ? { intent: "Create a different business operation" } : {}),
      onCheckpoint: async value => { saved = value; } });
    if (scenario === "reviewed") {
      expect(await result).toMatchObject({ state: "ready", authority_granted: false, source_database_changed: false });
      expect(saved?.reviewed_private_sources).toEqual([currentReview]);
      expect(saved?.components.verification).toEqual(before?.components.verification);
      expect(steps).toEqual([]);
    } else {
      await expect(result).rejects.toThrow(scenario === "public_read_changed" ? "PRIVATE_SOURCE_READ_CHANGED" : "CHECKPOINT_STALE");
      expect(request).not.toHaveBeenCalled();
      expect(saved).toBeUndefined();
    }
    expect(sourceReview).toHaveBeenCalledTimes(scenario === "unrelated_intent" ? 0 : 1);
    expect(checkpoint).toEqual(before);
  });

  it("does not repeat a declined source transfer or send its metadata into later model turns", async () => {
    const requests: string[] = [];
    const steps = [call("runner.review_private_action_source", { resource: "billing.admission", parent_resource: "billing.accounts" }),
      call("runner.review_private_action_source", { resource: "billing.admission", parent_resource: "billing.accounts" }), say("Setup remains pending this source.")];
    const reviewPrivateSource = vi.fn(async () => undefined);
    await expect(converseActionRuleDraft({ ...requestInput(async request => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), reviewPrivateSource, askClarification: async () => undefined })).rejects.toThrow("CANCELLED");
    expect(reviewPrivateSource).toHaveBeenCalledOnce();
    expect(requests.at(-1)).toContain("do not ask for the same permission repeatedly");
    expect(requests.at(-1)).not.toContain("private_source_prepared");
  });

  it("rejects an alleged private mapping that changes public reads", async () => {
    const changed = structuredClone(boundary()); changed.pack.name = "broadened";
    const requests: string[] = [];
    const steps = [call("runner.review_private_action_source", { resource: "billing.admission", parent_resource: "billing.accounts" }), say("Mapping remains pending.")];
    await expect(converseActionRuleDraft({ ...requestInput(async request => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), reviewPrivateSource: async () => ({ builtCatalog: builtCatalog(), readBoundary: changed, readBoundaryDigest: readDigest,
      review: { resource: "billing.admission", parent_resource: "billing.accounts", relationship: "admission_account", proof_digest: `sha256:${"c".repeat(64)}` } }),
    askClarification: async () => undefined })).rejects.toThrow("CANCELLED");
    expect(requests.at(-1)).toContain("PRIVATE_SOURCE_READ_CHANGED");
  });
  it.skipIf(!process.env.SYNAPSOR_LIVE_AUTHORING_PROVIDER)("qualifies live creation and a day-two edit through the same tools", async () => {
    const provider = process.env.SYNAPSOR_LIVE_AUTHORING_PROVIDER as "openai" | "openai_compatible" | "anthropic";
    const progress: string[] = [];
    const session = {
      provider,
      model: process.env.SYNAPSOR_LIVE_AUTHORING_MODEL ?? "gpt-5.6-terra",
      ...(process.env.SYNAPSOR_LIVE_AUTHORING_BASE_URL ? { baseUrl: process.env.SYNAPSOR_LIVE_AUTHORING_BASE_URL } : {}),
      dependencies: { onProgress: (event: { phase: "provider" | "tool"; tool?: string }) => { progress.push(event.tool ?? event.phase); } },
    };
    const common = { session, builtCatalog: builtCatalog(), readBoundary: boundary(), readBoundaryDigest: readDigest, egressAcknowledged: true };
    const created = await converseActionRuleDraft({
      ...common,
      intent: "Let a signed-in customer request pausing their own billing account. Only active accounts without a risk hold qualify. Set status to paused. Require one billing_reviewer for every proposal. Keep it proposal-only, never apply or write anything.",
      askClarification: async (question) => { throw new Error(`Unnecessary operator question: ${question}`); },
    }).catch((error) => { throw new Error(`${String(error)}; authoring steps: ${progress.join(", ")}`, { cause: error }); });
    expect(created.compiled.effect_envelope.writeback.mode).toBe("none");
    expect(created.compiled.approval_class.required_approvals).toBe(1);
    const edited = await converseActionRuleDraft({ ...common, existingDraft: created.compiled.draft, intent: "Require two distinct billing reviewers instead of one. Keep every other business rule and setting unchanged." });
    expect(edited.revision?.changed_phases).toEqual(["approval"]);
    expect(edited.compiled.approval_class.required_approvals).toBe(2);
    expect(edited.compiled.draft.effect).toEqual(created.compiled.draft.effect);
    const executable = await converseActionRuleDraft({ ...common, existingDraft: edited.compiled.draft,
      intent: "Automatically execute each approved pause after the two billing reviewers approve it. Keep all eligibility rules, fields and review requirements unchanged. Prepare only the disabled configuration now; do not activate anything during setup." });
    expect(executable.compiled.draft.effect.writeback).toBe("supervised");
    expect(executable.compiled.draft.require).toEqual(edited.compiled.draft.require);
    expect(executable.compiled.draft.approval).toEqual(edited.compiled.draft.approval);
    expect(executable.authority_granted).toBe(false);
  }, 300_000);

  const requestInput = (requestJson: NonNullable<AskProviderDependencies["requestJson"]>) => ({
    session: { provider: "openai" as const, model: "gpt-5.6-terra", dependencies: { requestJson } },
    intent: "Let an eligible account request a temporary pause, with human review.",
    builtCatalog: builtCatalog(), readBoundary: boundary(), readBoundaryDigest: readDigest,
    egressAcknowledged: true, env: { OPENAI_API_KEY: "provider-test-key" },
  });
  const call = (name: string, args = payloadFor(name)) => ({
    status: 200,
    body: { output: [{ type: "function_call", call_id: `call_${name}`, name: name.replaceAll(".", "__"), arguments: JSON.stringify(args) }] },
  });
  const say = (text: string) => ({ status: 200, body: { output: [{ type: "message", content: [{ type: "output_text", text }] }] } });

  it("keeps generated repair diagnostics separate from original counter intent", async () => {
    const diagnostic = "Recorded requirement at lines 57-62: The private routine-ceiling condition, maxima, rolling 24-hour window, and boundary/trusted-insurer scopes are drafted, but both history selectors have capability=null. They therefore count approved outcomes across the Action Boundary rather than only this reserve-adjustment outcome, contrary to the outcome-specific source requirement.";
    const baseline = policyModelDraft();
    const requests: string[] = [];
    const steps = [call("runner.validate_action_draft", {}), say("The original per-outcome limits are retained.")];
    const result = await converseActionRuleDraft({ ...requestInput(async request => {
      requests.push(JSON.stringify(request.body));
      if (!steps.length) throw new Error("Repair diagnostics incorrectly became business intent");
      return steps.shift()!;
    }), existingDraft: baseline, intent: diagnostic,
    operatorStatements: ["Allow at most 100 automatic approvals for this action and 1 per account and principal in a rolling 24-hour period."] });
    expect(result.compiled.draft.approval).toEqual(baseline.approval);
    expect(requests.join("\n")).toContain("Generated repair context (not operator intent)");
    expect(requests.join("\n")).toContain(diagnostic);
  });

  it("preserves the saved role explanation without demanding an unrequested principal quota during revision", async () => {
    const explanation = "Yes. Each tenant is exactly one league, and each principal is an assigned referee within that league. Referees in the same league share the limit of two automatic ratifications in the rolling 24 hours; all leagues share the overall limit of six.";
    const baseline = policyModelDraft();
    baseline.approval.shared_limits = [
      { id: "overall", kind: "count", scope: "boundary", maximum: 6, window_seconds: 86400, capability: baseline.outcome },
      { id: "organization", kind: "count", scope: "tenant", maximum: 2, window_seconds: 86400, capability: baseline.outcome },
    ];
    const steps = [call("runner.validate_action_draft", {}), say("The original shared limits validate unchanged.")];
    const result = await converseActionRuleDraft({ ...requestInput(async () => {
      if (!steps.length) throw new Error("Role glossary incorrectly requested an extra quota");
      return steps.shift()!;
    }), existingDraft: baseline, intent: "Recheck the saved policy using its original explanation.",
    operatorStatements: [explanation], approvalLimitsOnly: true });
    expect(result.compiled.draft.approval).toEqual(baseline.approval);
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(steps).toEqual([]);
  });

  it("corrects an unaccepted extra quota through disabled revision, with restart and stale-save protection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-role-quota-revision-"));
    try {
      const original = policyModelDraft();
      original.approval.shared_limits = [
        { id: "overall", kind: "count", scope: "boundary", maximum: 6, window_seconds: 86400, capability: original.outcome },
        { id: "tenant", kind: "count", scope: "tenant", maximum: 2, window_seconds: 86400, capability: original.outcome },
        { id: "unrequested", kind: "count", scope: "tenant_principal", maximum: 2, window_seconds: 86400, capability: original.outcome },
      ];
      const toStored = (compiled: ReturnType<typeof compileActionRuleModelDraft>) => buildActionRuleAuthorityDraft({
        name: "saved_rules", action_boundary_name: "saved_actions", catalog: compiled.loaded.authority.catalog,
        rules: [{ read_boundary_name: boundary().pack.name, read_boundary_digest: readDigest,
          verification_boundary: compiled.verification_boundary, effect_envelope: compiled.effect_envelope, rule: compiled.rule }],
        approval_classes: [compiled.approval_class], reviews: [{ ...compiled.review, outcome: compiled.draft.outcome }],
      });
      const initial = toStored(compileActionRuleModelDraft({ draft: original, builtCatalog: builtCatalog(), readBoundary: boundary(), readBoundaryDigest: readDigest }));
      const initialPath = await writeActionRuleAuthorityDraft(root, initial);
      // Legacy disabled files are a current draft, not immutable activation history.
      // Preserve the actual pre-repair bytes in an owned evidence copy.
      await fs.copyFile(path.join(root, initialPath), path.join(root, "initial-disabled.json"));
      const baseline = await readActionRuleAuthorityRevisionBaseline(root);
      const requested = { ...original.approval, shared_limits: original.approval.shared_limits.slice(0, 2) };
      const steps = [call("runner.submit_approval_policy_draft", { status: "draft", ...requested, changed_fields: ["shared_limits"] }),
        call("runner.validate_action_draft", {}), say("The original quotas are ready for review.")];
      const result = await converseActionRuleDraft({ ...requestInput(async () => {
        if (!steps.length) throw new Error("The disabled model-generated cap was incorrectly promoted to operator policy");
        return steps.shift()!;
      }), existingDraft: original, approvalLimitsOnly: true,
        intent: "Remove only the unrequested principal quota from this disabled draft. Keep the original limits and all other rules.",
        operatorStatements: ["At most 6 automatic approvals across the Action Boundary and 2 per tenant in a rolling 24-hour window.",
          "Each tenant is exactly one league, and each principal is an assigned referee within that league."] });
      expect(result.compiled.draft.approval).toEqual(requested);
      expect(result.compiled.draft.require).toEqual(original.require);
      expect(result.compiled.draft.effect).toEqual(original.effect);
      const corrected = toStored(result.compiled);
      await writeActionRuleAuthorityDraftIfCurrent(root, corrected, baseline);
      const restarted = await readActionRuleAuthorityDraft(root, corrected.authority.name);
      expect(restarted!.authority.approval_classes[0]!.shared_limits).toEqual(corrected.authority.approval_classes[0]!.shared_limits);
      expect(restarted!.state).toBe("disabled");
      await expect(writeActionRuleAuthorityDraftIfCurrent(root, initial, baseline)).rejects.toThrow("changed while this job");
      expect(await readActionRuleAuthorityDraft(root, corrected.authority.name)).toEqual(restarted);
      const oldRevision = JSON.parse(await fs.readFile(path.join(root, "initial-disabled.json"), "utf8"));
      expect(oldRevision.authority.approval_classes[0].shared_limits).toHaveLength(3);
      await expect(fs.stat(path.join(root, ".synapsor/action-rules/active.json"))).rejects.toHaveProperty("code", "ENOENT");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("honors an explicit later scope replacement without carrying the old principal quota forward", async () => {
    const baseline = policyModelDraft();
    const approval = { ...baseline.approval, shared_limits: [baseline.approval.shared_limits[0]!,
      { id: "account", kind: "count", scope: "tenant", maximum: 2, window_seconds: 86400, capability: baseline.outcome }] };
    const steps = [call("runner.submit_approval_policy_draft", { status: "draft", ...approval, changed_fields: ["shared_limits"] }),
      call("runner.validate_action_draft", {}), say("The accepted replacement is ready for review.")];
    const result = await converseActionRuleDraft({ ...requestInput(async () => {
      if (!steps.length) throw new Error("Old scope was incorrectly preserved after its explicit replacement");
      return steps.shift()!;
    }), existingDraft: baseline, intent: "Apply the operator's accepted accounting change.", approvalLimitsOnly: true,
    operatorStatements: ["Allow at most 100 automatic approvals for this action and 1 per principal in a rolling 24-hour period.",
      "Change the scoped limit to 2 per tenant rather than per principal in the same rolling 24-hour period. Keep the overall action limit unchanged."] });
    expect(result.compiled.draft.approval.shared_limits).toEqual(approval.shared_limits);
    expect(result.authority_granted).toBe(false);
  });

  it("saves and reloads a fresh clarification without converting its role definition into accounting", async () => {
    const explanation = "Yes. Each tenant is exactly one league, and each principal is an assigned referee within that league. Referees in the same league share the limit of two automatic ratifications in the rolling 24 hours; all leagues share the overall limit of six.";
    const approval = { ...policyModelDraft().approval, shared_limits: [
      { id: "overall", kind: "count", scope: "boundary", maximum: 6, window_seconds: 86400, capability: modelDraft().outcome },
      { id: "organization", kind: "count", scope: "tenant", maximum: 2, window_seconds: 86400, capability: modelDraft().outcome },
    ] };
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    const steps = [call("runner.submit_verification_boundary_draft"), call("runner.submit_effect_envelope_draft"),
      call("runner.submit_action_rule_draft"), call("runner.submit_approval_policy_draft", { status: "draft", ...approval }),
      say("What does the organization and person scope mean?"), say("Continue this saved review?")];
    const input = { ...requestInput(async () => steps.shift()!), intent: "Allow at most six automatic approvals across the Action Boundary and two per tenant in the rolling 24-hour window." };
    await expect(converseActionRuleDraft({ ...input,
      askClarification: vi.fn().mockResolvedValueOnce(explanation).mockResolvedValueOnce(undefined),
      onCheckpoint: async value => { checkpoint = JSON.parse(JSON.stringify(value)); },
    })).rejects.toThrow("CANCELLED");
    expect(checkpoint?.operator_messages).toContain(explanation);
    const saved = structuredClone(checkpoint!);
    const resumed = [call("runner.validate_action_draft", {}), say("The original shared limits are ready for review.")];
    const result = await converseActionRuleDraft({ ...input, checkpoint: saved,
      session: { ...input.session, dependencies: { requestJson: async () => resumed.shift()! } },
    });
    expect(result.compiled.draft.approval.shared_limits).toEqual(approval.shared_limits);
    expect(checkpoint).toEqual(saved);
    expect(result.authority_granted).toBe(false);
  });

  it("still enforces original scope and accepted operator decisions during a generated repair", async () => {
    const baseline = policyModelDraft();
    const corrected = { ...baseline.approval, shared_limits: [...baseline.approval.shared_limits,
      { id: "all_actions", kind: "count", scope: "boundary", maximum: 100, window_seconds: 86400 }] };
    const requests: string[] = [];
    const steps = [call("runner.validate_action_draft", {}),
      call("runner.submit_approval_policy_draft", { status: "draft", ...corrected, changed_fields: ["shared_limits"] }),
      call("runner.validate_action_draft", {}), say("Boundary-wide accounting is retained.")];
    const result = await converseActionRuleDraft({ ...requestInput(async request => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), existingDraft: baseline, intent: "Repair the saved accounting selector.",
    operatorStatements: ["Allow at most 100 automatic approvals across the Action Boundary in a rolling 24-hour period."] });
    expect(requests.some(request => request.includes("explicit boundary accounting"))).toBe(true);
    expect(result.compiled.draft.approval.shared_limits.some(limit => limit.scope === "boundary")).toBe(true);
  });

  it("preserves setup pending an authoritative source without treating the operator answer as a source fact", async () => {
    const question = "I cannot verify current admission from these records. Is there an authoritative admission source to connect, or should I save setup pending that source?";
    const answer = "No existing field proves admission. Keep the requirement; do not infer it from authentication or registrations. Save setup pending that source.";
    const requests: string[] = [];
    const steps = [call("runner.submit_verification_boundary_draft"), say(question),
      call("runner.pause_action_draft", { operator_message: answer })];
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    const askClarification = vi.fn().mockResolvedValueOnce(answer);
    const input = requestInput(async request => { requests.push(JSON.stringify(request.body)); return steps.shift()!; });
    const before = structuredClone(input.builtCatalog);
    await expect(converseActionRuleDraft({ ...input, intent: "Only currently admitted students may make this request.", askClarification,
      onCheckpoint: async value => { checkpoint = value; },
    })).rejects.toMatchObject({ code: "ASK_CANCELLED" });
    expect(askClarification).toHaveBeenCalledOnce();
    expect(requests[0]).toContain("map an existing authoritative source");
    expect(requests[0]).toContain("missing, expired or withdrawn evidence");
    expect(requests.at(-1)).toContain(answer);
    expect(checkpoint!.operator_messages).toContain(answer);
    expect(Object.keys(checkpoint!.components)).toEqual(["verification"]);
    expect(input.builtCatalog).toEqual(before);
    expect(steps).toEqual([]);
  });

  it("does not honor a fabricated pause or claim a failed checkpoint was saved", async () => {
    const answer = "Save pending";
    const steps = [call("runner.pause_action_draft", { operator_message: answer }), say("An authoritative source is still missing."),
      call("runner.pause_action_draft", { operator_message: answer })];
    const requests: string[] = [];
    const onCheckpoint = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("checkpoint storage unavailable"));
    await expect(converseActionRuleDraft({ ...requestInput(async request => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), askClarification: async () => answer, onCheckpoint })).rejects.toThrow("checkpoint storage unavailable");
    expect(requests.join("\n")).toContain("Quote the actual operator message asking to pause");
    expect(onCheckpoint).toHaveBeenCalledTimes(2);
    expect(steps).toEqual([]);
  });

  it.each(["valid", "nonnullable", "unknown_enum", "timestamp_value"])("validates explicit nullable clears through conversational effect submission (%s)", async failure => {
    const built = builtCatalog();
    const effect = { status: "draft", ...modelDraft().effect };
    for (const [name, type] of [["drop_reason", { kind: "string", max_length: 32, comparison: "exact", enum: ["prerequisite_error"] }],
      ["dropped_at", { kind: "timestamp" }]] as const) {
      const field = { name, type: structuredClone(type) as ActionRuleScalarTypeSpecV1, nullable: true };
      built.catalog.resources[0]!.fields.push(field);
      built.authoring.resources[0]!.fields.push({ ...field, role: "runner_verification_only", writable: true });
      effect.allowed_fields.push({ name, values: [null] });
      effect.set[name] = { kind: "literal", value: null, value_type: field.type };
    }
    const invalidEffect = structuredClone(effect);
    const invalidIndex = invalidEffect.allowed_fields.findIndex(field => field.name === "drop_reason");
    if (failure === "nonnullable") invalidEffect.allowed_fields[0]!.values = [null];
    if (failure === "unknown_enum") invalidEffect.allowed_fields[invalidIndex]!.values = ["made_up"];
    if (failure === "timestamp_value") invalidEffect.allowed_fields.find(field => field.name === "dropped_at")!.values = ["2026-09-01T00:00:00Z"];
    const steps = [call("runner.submit_verification_boundary_draft"),
      call("runner.submit_effect_envelope_draft", failure === "valid" ? effect : invalidEffect),
      call("runner.submit_action_rule_draft"), call("runner.submit_approval_policy_draft"),
      ...(failure === "valid" ? [] : [call("runner.validate_action_draft", {}), call("runner.submit_effect_envelope_draft", effect)]),
      call("runner.validate_action_draft", {}), say("The disabled revision is ready for review.")];
    const requests: string[] = [];
    const result = await converseActionRuleDraft({ ...requestInput(async request => {
      requests.push(JSON.stringify(request.body));
      if (!steps.length) throw new Error("Unexpected correction after valid nullable clear");
      return steps.shift()!;
    }), builtCatalog: built });
    expect(result.compiled.draft.effect.set).toEqual(effect.set);
    expect(result.compiled.draft.effect.allowed_fields).toEqual(effect.allowed_fields);
    const diagnostic: Record<string, string | undefined> = { valid: undefined, nonnullable: "ACTION_RULE_EFFECT_NULL_FORBIDDEN",
      unknown_enum: "ACTION_RULE_EFFECT_VALUE_UNREVIEWED", timestamp_value: "ACTION_RULE_EFFECT_VALUE_TYPE_INVALID" };
    if (diagnostic[failure]) expect(requests.some(request => request.includes(diagnostic[failure]!))).toBe(true);
    else expect(requests.some(request => request.includes("ACTION_RULE_EFFECT_VALUE_UNREVIEWED"))).toBe(false);
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(steps).toEqual([]);
  });

  it.each([false, true])("scopes private linked facts separately from subjects and every changed record (atomic=%s)", async (atomic) => {
    const built = builtCatalog();
    const account = built.catalog.resources[0]!;
    account.fields.push({ name: "policy_id", type: stringId, nullable: false });
    built.authoring.resources[0]!.fields.push({ name: "policy_id", type: stringId, nullable: false, role: "guard", writable: false });
    const policy = structuredClone(account);
    policy.name = "billing.policies"; policy.table = "policies"; policy.primary_key = "policy_id";
    delete policy.principal_scope_key;
    policy.fields = policy.fields.filter((field) => !["account_id", "principal_id"].includes(field.name));
    built.catalog.resources.push(policy);
    built.catalog.relationships.push({ name: "accounts_policy_fk", from_resource: account.name, to_resource: policy.name,
      field_pairs: [{ local_field: "tenant_id", target_field: "tenant_id" }, { local_field: "policy_id", target_field: "policy_id" }],
      cardinality: "many_to_one", nullable: false, target_unique: true });
    built.authoring.relationships = structuredClone(built.catalog.relationships);
    const description = structuredClone(built.authoring.resources[0]!);
    description.name = policy.name; description.primary_key = policy.primary_key;
    description.principal_scope = "none"; delete description.principal_key;
    description.fields = description.fields.filter((field) => !["account_id", "principal_id"].includes(field.name));
    built.authoring.resources.push(description);
    const verification = { status: "draft", ...modelDraft().verification };
    verification.resources.push({ binding: "policy", resource: policy.name,
      source: { kind: "relationship", from_binding: "account", relationship: "accounts_policy_fk", direction: "forward" },
      fields: ["status", "risk_hold"] });
    const effect = payloadFor("runner.submit_effect_envelope_draft");
    if (atomic) effect.atomic_updates = [{ operation: "update", target_resource: policy.name, target_binding: "policy",
      allowed_fields: effect.allowed_fields, set: effect.set }];
    const prepareResources = vi.fn(async () => ({ builtCatalog: built, readBoundary: boundary(), readBoundaryDigest: readDigest }));
    const steps = [call("runner.submit_verification_boundary_draft", verification), call("runner.submit_effect_envelope_draft", effect),
      call("runner.submit_action_rule_draft"), call("runner.submit_approval_policy_draft"),
      call("runner.validate_action_draft", {}), say("The requested draft is ready for review.")];
    const result = await converseActionRuleDraft({ ...requestInput(async () => steps.shift()!), builtCatalog: built, prepareResources });
    expect(prepareResources).toHaveBeenNthCalledWith(1, { context: { builtCatalog: built, readBoundary: boundary(), readBoundaryDigest: readDigest }, phase: "verification", resourceIds: [account.name, policy.name], principalScopeResourceIds: [account.name] });
    expect(prepareResources).toHaveBeenNthCalledWith(2, { context: { builtCatalog: built, readBoundary: boundary(), readBoundaryDigest: readDigest }, phase: "effect", resourceIds: atomic ? [account.name, policy.name] : [account.name],
      principalScopeResourceIds: atomic ? [account.name, policy.name] : [account.name] });
    expect(result.compiled.verification_boundary.resources.find((entry) => entry.binding === "account")!.scope)
      .toMatchObject({ mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" });
    expect(result.compiled.verification_boundary.resources.find((entry) => entry.binding === "policy")!.source)
      .toMatchObject({ kind: "relationship", from_binding: "account", relationship: "accounts_policy_fk" });
    expect(result.compiled.draft.effect.atomic_updates?.length ?? 0).toBe(atomic ? 1 : 0);
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
  });

  it("authors public discovery vocabulary through the same bounded rule tool", async () => {
    const discovery = { title: "Pause billing", summary: "Request a temporary billing pause with human review.",
      aliases: ["pause my account", "temporary billing pause"] };
    const steps = [call("runner.submit_verification_boundary_draft"), call("runner.submit_effect_envelope_draft"),
      call("runner.submit_action_rule_draft", { ...payloadFor("runner.submit_action_rule_draft"), discovery }),
      call("runner.submit_approval_policy_draft"), call("runner.validate_action_draft", {}), say("The disabled billing pause is ready for review.")];
    const requests: string[] = [];
    const result = await converseActionRuleDraft(requestInput(async (request) => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }));
    expect(result.compiled.draft.discovery).toEqual(discovery);
    expect(result.compiled.rule["x-runner-discovery"]).toEqual(discovery);
    expect(requests[0]).toContain("Public client catalog wording");
    expect(requests[0]).toContain("ordinary business phrases");
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(steps).toEqual([]);
  });

  it.each([false, true])("changes discovery only with a declared revision scope (%s)", async (editDiscovery) => {
    const baseline = policyModelDraft();
    baseline.discovery = { title: "Pause billing", summary: "A temporary billing pause.", aliases: ["pause billing"] };
    const changed = { ...baseline.discovery, aliases: ["pause my account"] };
    const steps = [call("runner.submit_action_rule_draft", { ...payloadFor("runner.submit_action_rule_draft"),
      discovery: changed, review: { ...baseline.review, then: "Set the account status to paused." },
      changed_fields: editDiscovery ? ["discovery"] : ["review.then"] }),
      call("runner.validate_action_draft", {}), say("The same disabled rule remains ready for review.")];
    const result = await converseActionRuleDraft({ ...requestInput(async () => steps.shift()!), existingDraft: baseline,
      intent: editDiscovery ? "Let clients find this by pause my account. Keep all rules unchanged." : "Update only the effect description to say Set the account status to paused. Keep client wording and all rules unchanged." });
    expect(result.compiled.draft.discovery).toEqual(editDiscovery ? changed : baseline.discovery);
    expect(result.compiled.draft.require).toEqual(baseline.require);
    expect(result.compiled.draft.approval).toEqual(baseline.approval);
    expect(result.compiled.draft.effect).toEqual(baseline.effect);
    expect(result.compiled.draft.outcome).toBe(baseline.outcome);
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(steps).toEqual([]);
  });

  it("repairs per-action counters using the original multi-action job without repeating the business question", async () => {
    const original = "Across both actions allow at most 10 automatic approvals overall and at most 3 per account in a rolling 24-hour period.";
    const policy = { ...payloadFor("runner.submit_approval_policy_draft"), mode: "policy", auto_approve_when: eligiblePredicate(),
      shared_limits: [{ id: "joint_overall", kind: "count", scope: "boundary", maximum: 10, window_seconds: 86400 },
        { id: "joint_account", kind: "count", scope: "tenant", maximum: 3, window_seconds: 86400 }] };
    const wrong = { ...policy, shared_limits: policy.shared_limits.map((limit) => ({ ...limit, capability: "billing.pause_account" })) };
    const steps = [call("runner.submit_verification_boundary_draft"), call("runner.submit_effect_envelope_draft"),
      call("runner.submit_action_rule_draft"), call("runner.submit_approval_policy_draft", wrong), call("runner.validate_action_draft", {}),
      call("runner.submit_approval_policy_draft", policy), call("runner.validate_action_draft", {}), say("Both actions use one shared allowance.")];
    const requests: string[] = [];
    const askClarification = vi.fn(async () => undefined);
    const result = await converseActionRuleDraft({ ...requestInput(async (request) => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), operatorJob: original, askClarification });
    expect(requests.join("\n")).toContain(original);
    expect(requests.join("\n")).toContain("JOINT automatic approval limits");
    expect(result.compiled.approval_class.shared_limits).toEqual(policy.shared_limits);
    expect(askClarification).not.toHaveBeenCalled();
    expect(steps).toEqual([]);
  });

  it("repairs an incomplete tool submission internally instead of asking the operator to submit draft components", async () => {
    const missing = "The draft is missing the `effect`, `rule`, and `approval` components. Please submit these through the corresponding tools to complete the action rule.";
    const steps = [say(missing), call("runner.submit_verification_boundary_draft"), call("runner.submit_effect_envelope_draft"),
      call("runner.submit_action_rule_draft"), call("runner.submit_approval_policy_draft"), call("runner.validate_action_draft", {}), say("The disabled draft is ready for review.")];
    const requests: string[] = [];
    const askClarification = vi.fn(async () => { throw new Error("Mechanical work reached the operator"); });
    const result = await converseActionRuleDraft({ ...requestInput(async (request) => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), askClarification });
    expect(requests.join("\n")).toContain("Runner validation feedback");
    expect(askClarification).not.toHaveBeenCalled();
    expect(result.state).toBe("ready");
    expect(result.correction_used).toBe(true);
    expect(result.clarification_count).toBe(0);
    expect(steps).toEqual([]);
  });

  it("bounds repeated incomplete tool submissions without a human clarification loop", async () => {
    const requestJson = vi.fn(async () => say("The draft components still needed are effect, rule, and approval. Submit the corresponding tools."));
    const askClarification = vi.fn(async () => { throw new Error("Mechanical work reached the operator"); });
    await expect(converseActionRuleDraft({ ...requestInput(requestJson), askClarification }))
      .rejects.toThrow("ACTION_RULE_MODEL_DRAFT_INCOMPLETE");
    expect(requestJson).toHaveBeenCalledTimes(3);
    expect(askClarification).not.toHaveBeenCalled();
  });

  it.each([
    "The reviewed relationship paths are prepared in the disabled draft; no authority is active.",
    "The seat draft is partially prepared. The remaining business rules are not yet prepared.",
    "The restoration draft is partially prepared; the prerequisite, 30-day rule and approval still need preparation.",
  ])("continues saved drafting progress without asking for another operator turn: %s", async (progress) => {
    const steps = [call("runner.submit_verification_boundary_draft"), say(progress),
      call("runner.submit_effect_envelope_draft"), call("runner.submit_action_rule_draft"),
      call("runner.submit_approval_policy_draft"), call("runner.validate_action_draft", {}), say("Ready for review.")];
    const requests: string[] = [];
    const onStream = vi.fn();
    const askClarification = vi.fn(async () => { throw new Error("Progress is not a business question"); });
    const input = requestInput(async (request) => {
      requests.push(JSON.stringify(request.body));
      const next = steps.shift()!;
      if (requests.length === 2) request.stream?.onEvent?.({ phase: "text_delta", text: progress });
      return next;
    });
    const result = await converseActionRuleDraft({ ...input,
      session: { ...input.session, dependencies: { ...input.session.dependencies, onStream } }, askClarification });
    expect(result.state).toBe("ready");
    expect(result.clarification_count).toBe(0);
    expect(askClarification).not.toHaveBeenCalled();
    expect(onStream).toHaveBeenCalledWith(expect.objectContaining({ text: progress, operator_text: false }));
    expect(requests.join("\n")).toContain("not a new operator decision");
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(steps).toEqual([]);
  });

  it.each([false, true])("still asks a genuine business question after saving a component (structured: %s)", async (structured) => {
    const question = structured ? "Please specify how many customer-service reviewers must approve valid exceptions." : "Which team should review valid exceptions?";
    const steps = [call("runner.submit_verification_boundary_draft"),
      ...(structured ? [call("runner.submit_approval_policy_draft", { status: "clarification", question })] : []), say(question)];
    const askClarification = vi.fn(async () => undefined);
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    await expect(converseActionRuleDraft({ ...requestInput(async () => steps.shift()!),
      askClarification, onCheckpoint: async (value) => { checkpoint = value; } })).rejects.toThrow("CANCELLED");
    expect(askClarification).toHaveBeenCalledExactlyOnceWith(question);
    expect(checkpoint!.components.verification).toBeDefined();
    expect(checkpoint!.components.approval).toBeUndefined();
    expect(steps).toEqual([]);
  });

  it("continues relationship-only progress without treating inspection or unchanged saves as new progress", async () => {
    const built = builtCatalog();
    const relationship = { name: "account_parent_fk", from_resource: "billing.accounts", to_resource: "billing.accounts",
      field_pairs: [{ local_field: "tenant_id", target_field: "tenant_id" }, { local_field: "account_id", target_field: "account_id" }],
      cardinality: "many_to_one" as const, nullable: false, target_unique: true };
    built.catalog.relationships = [relationship]; built.authoring.relationships = [relationship];
    const args = { from_resource: "billing.accounts", to_resource: "billing.accounts", relationship: relationship.name };
    const steps = [call("runner.review_action_relationship", args), say("The reviewed path is prepared."),
      call("runner.inspect_action_draft", {}), call("runner.review_action_relationship", args), say("The reviewed path is prepared."),
      call("runner.inspect_action_draft", {}), say("The reviewed path is prepared.")];
    const askClarification = vi.fn(async () => { throw new Error("Progress is not a business question"); });
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    await expect(converseActionRuleDraft({ ...requestInput(async () => steps.shift()!), builtCatalog: built, askClarification,
      onCheckpoint: async (value) => { checkpoint = value; } })).rejects.toThrow("after two internal corrections");
    expect(checkpoint!.reviewed_relationships).toEqual([relationship.name]);
    expect(checkpoint!.components).toEqual({});
    expect(askClarification).not.toHaveBeenCalled();
    expect(steps).toEqual([]);
  });

  it("bounds progress-only continuation and retains the partial draft for resume", async () => {
    const steps = [call("runner.submit_verification_boundary_draft"), say("The first component has been saved."),
      say("Preparation is ongoing."), say("Preparation is ongoing.")];
    const askClarification = vi.fn(async () => { throw new Error("Progress is not a business question"); });
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    await expect(converseActionRuleDraft({ ...requestInput(async () => steps.shift()!), askClarification,
      onCheckpoint: async (value) => { checkpoint = value; } })).rejects.toThrow("after two internal corrections");
    expect(askClarification).not.toHaveBeenCalled();
    expect(checkpoint!.components.verification).toBeDefined();
    expect(checkpoint!.components.approval).toBeUndefined();
    expect(steps).toEqual([]);
  });

  it.each([
    ["http://127.0.0.1:11434/v1", true],
    ["https://provider.example/v1", false],
  ] as const)("offers honest compatible-provider recovery without extending retries (%s)", async (baseUrl, local) => {
    const incomplete = "The draft components still needed are effect, rule, and approval. Submit the corresponding tools.";
    const steps = [call("runner.submit_verification_boundary_draft"), say(incomplete), say(incomplete), say(incomplete)];
    const requestJson = vi.fn(async () => steps.shift()!);
    const askClarification = vi.fn(async () => { throw new Error("Mechanical work reached the operator"); });
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    const input = requestInput(requestJson);
    const error = await converseActionRuleDraft({ ...input,
      session: { provider: "openai_compatible", model: "local-fixture", baseUrl, dependencies: { requestJson } },
      askClarification, onCheckpoint: async (value) => { checkpoint = value; },
    }).then(() => { throw new Error("Incomplete draft must not pass"); }, (error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("ACTION_RULE_MODEL_DRAFT_INCOMPLETE");
    expect(message).toContain("after two internal corrections");
    expect(message).toContain("structured draft/export");
    expect(message).toContain("no authority or source data changed");
    expect(message.includes("configured context window")).toBe(local);
    expect(message.includes("structured tool-call support")).toBe(local);
    expect(message).not.toContain(baseUrl);
    expect(message).not.toContain(input.intent);
    expect(requestJson).toHaveBeenCalledTimes(4);
    expect(steps).toEqual([]);
    expect(askClarification).not.toHaveBeenCalled();
    expect(Object.keys(checkpoint!.components)).toEqual(["verification"]);
    expect(checkpoint!.components.verification).toMatchObject({ name: modelDraft().verification.name });

    const recovery = [call("runner.submit_effect_envelope_draft"), call("runner.submit_action_rule_draft"),
      call("runner.submit_approval_policy_draft"), call("runner.validate_action_draft", {}), say("Prepared for review.")];
    const resumed = await converseActionRuleDraft({ ...input, checkpoint,
      session: { ...input.session, dependencies: { requestJson: async () => recovery.shift()! } },
    });
    expect(recovery).toEqual([]);
    expect(resumed.state).toBe("ready");
    expect(resumed.authority_granted).toBe(false);
    expect(resumed.source_database_changed).toBe(false);
  });

  it("keeps a joint-limit repair from changing the reviewer or other saved components", async () => {
    const baseline = policyModelDraft();
    const limits = [{ id: "joint_overall", kind: "count", scope: "boundary", maximum: 10, window_seconds: 86400 },
      { id: "joint_account", kind: "count", scope: "tenant", maximum: 3, window_seconds: 86400 }];
    const approval = { status: "draft", ...baseline.approval, shared_limits: limits };
    const steps = [call("runner.submit_approval_policy_draft", { ...approval, required_role: "another_reviewer", changed_fields: ["shared_limits", "required_role"] }),
      call("runner.validate_action_draft", {}), call("runner.submit_approval_policy_draft", { ...approval, changed_fields: ["shared_limits", "required_role"] }),
      call("runner.validate_action_draft", {}), say("The joint limits are repaired; the remaining policy is unchanged.")];
    const requests: string[] = [];
    const result = await converseActionRuleDraft({ ...requestInput(async (request) => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), existingDraft: baseline, approvalLimitsOnly: true, intent: "Repair only the shared approval counters.",
    operatorJob: "Across both actions allow at most 10 automatic approvals overall and 3 per account in a rolling 24-hour period." });
    expect(requests.join("\n")).toContain("may change only approval.shared_limits");
    expect(result.compiled.draft).toMatchObject({ effect: baseline.effect, require: baseline.require, verification: baseline.verification,
      approval: { ...baseline.approval, shared_limits: limits } });
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(steps).toEqual([]);
  });

  it.each([false, true])("streams business questions but defers a compiled recap only when policy review owns the turn (%s)", async (deferCompletionMessage) => {
    const question = "Who should review valid requests?";
    const recap = "The disabled pause draft is prepared for review.";
    const steps = [say(question), call("runner.submit_verification_boundary_draft"),
      call("runner.submit_approval_policy_draft"), call("runner.submit_action_rule_draft"),
      call("runner.submit_effect_envelope_draft"), call("runner.validate_action_draft", {}), say(recap)];
    const onStream = vi.fn();
    const input = requestInput(async (request) => {
      const step = steps.shift()!;
      const item = step.body.output[0]!;
      const text = "content" in item ? item.content[0]?.text : undefined;
      if (text) request.stream?.onEvent?.({ phase: "text_delta", text });
      return step;
    });
    const askClarification = vi.fn(async () => "One billing reviewer.");
    const result = await converseActionRuleDraft({ ...input,
      session: { ...input.session, dependencies: { ...input.session.dependencies, onStream } },
      askClarification, deferCompletionMessage });
    expect(onStream).toHaveBeenCalledWith(expect.objectContaining({ text: question, operator_text: true }));
    expect(onStream).toHaveBeenCalledWith(expect.objectContaining({ text: recap, operator_text: !deferCompletionMessage }));
    expect(askClarification).toHaveBeenCalledTimes(1);
    expect(result.message).toBe(recap);
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(steps).toEqual([]);
  });

  it("allows an explicit read-only pivot but rejects an invented cancellation message", async () => {
    const answer = "Drop the pending action; keep the read-only draft.";
    const steps = [call("runner.finish_without_new_actions", { operator_message: answer, reason: "Read-only requested" }),
      say("Would you like to continue with reads only?"),
      call("runner.finish_without_new_actions", { operator_message: answer, reason: "Read-only requested" }),
      say("Continuing with the Read draft; no saved Action was deleted.")];
    const requests: string[] = [];
    await expect(converseActionRuleDraft({ ...requestInput(async (request) => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), askClarification: async () => answer })).rejects.toBeInstanceOf(ActionAuthoringReadOnlyRequest);
    expect(requests.join("\n")).toContain("Quote an actual operator message");
    expect(steps).toEqual([]);
  });

  it.each([false, true])("repairs approval-only execution without another business question (resumed: %s)", async (resume) => {
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    const intent = "Automatically approve and complete eligible account pauses.";
    const componentCalls = [call("runner.submit_verification_boundary_draft"), call("runner.submit_approval_policy_draft"),
      call("runner.submit_action_rule_draft"), call("runner.submit_effect_envelope_draft")];
    if (resume) {
      const paused = [...componentCalls, say("Pause for now?")];
      await expect(converseActionRuleDraft({ ...requestInput(async () => paused.shift()!), intent,
        onCheckpoint: async (value) => { checkpoint = value; }, askClarification: async () => undefined,
      })).rejects.toThrow("CANCELLED");
    }
    const steps = [...(resume ? [] : componentCalls), call("runner.validate_action_draft", {}),
      call("runner.submit_effect_envelope_draft", { ...payloadFor("runner.submit_effect_envelope_draft"), writeback: "supervised" }),
      call("runner.validate_action_draft", {}), say("Execution configuration is drafted; separate operator review is still required.")];
    const requests: string[] = [];
    const askClarification = vi.fn();
    const result = await converseActionRuleDraft({ ...requestInput(async (request) => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), intent, checkpoint, askClarification });
    expect(requests.join("\n")).toContain("ACTION_EXECUTION_INTENT_UNMET");
    expect(result.compiled.effect_envelope.writeback).toMatchObject({ mode: "direct_sql", supervised_worker: "allowed" });
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(askClarification).not.toHaveBeenCalled();
    expect(steps).toEqual([]);
  });

  it("discovers and prepares an exact composite link in chat, retaining it across pause/resume", async () => {
    const built = builtCatalog();
    const link = { name: "account_parent_fk", from_resource: "billing.accounts", to_resource: "billing.accounts",
      field_pairs: [{ local_field: "tenant_id", target_field: "tenant_id" }, { local_field: "account_id", target_field: "account_id" }],
      cardinality: "many_to_one" as const, nullable: false, target_unique: true };
    built.catalog.relationships = [link];
    built.authoring.relationships = [link];
    const args = { from_resource: "billing.accounts", to_resource: "billing.accounts" };
    const steps = [call("runner.inspect_action_relationships", args),
      call("runner.review_action_relationship", { ...args, relationship: link.name }),
      call("runner.submit_verification_boundary_draft"), say("Should every request need human review?")];
    const requests: string[] = [];
    const details: string[][] = [];
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    const input = { ...requestInput(vi.fn(async (request) => { requests.push(JSON.stringify(request.body)); return steps.shift()!; })), builtCatalog: built,
      onCheckpoint: async (value: ActionRuleAuthoringCheckpoint) => { checkpoint = value; },
      onRelationshipReview: (lines: string[]) => details.push(lines), askClarification: async () => undefined };
    const readBefore = structuredClone(input.readBoundary);
    await expect(converseActionRuleDraft(input)).rejects.toThrow("CANCELLED");
    expect(checkpoint?.reviewed_relationships).toEqual([link.name]);
    expect(checkpoint?.components.verification).toBeDefined();
    expect(requests[1]).toContain("available_unreviewed");
    expect(requests[2]).toContain("already_reviewed");
    expect(details.flat().join("\n")).toContain("tenant_id = tenant_id");
    expect(input.readBoundary).toEqual(readBefore);
    const resumed = [call("runner.inspect_action_relationships", args), call("runner.submit_approval_policy_draft"),
      call("runner.submit_action_rule_draft"), call("runner.submit_effect_envelope_draft"), call("runner.validate_action_draft", {}), say("Ready for review.")];
    const requestJson = vi.fn(async (request) => { requests.push(JSON.stringify(request.body)); return resumed.shift()!; });
    const result = await converseActionRuleDraft({ ...input, session: requestInput(requestJson).session, checkpoint });
    expect(result.state).toBe("ready");
    expect(result.authority_granted).toBe(false);
    expect(requests.at(-1)).toContain("already_reviewed");
    const changed = structuredClone(built);
    changed.catalog.relationships[0]!.field_pairs!.reverse();
    await expect(converseActionRuleDraft({ ...input, builtCatalog: changed, checkpoint })).rejects.toThrow("CHECKPOINT_STALE");
  });

  it("reports ambiguous, missing and unsupported relationships without guessing or granting access", () => {
    const built = builtCatalog();
    const link = { name: "billing_parent", from_resource: "billing.accounts", to_resource: "billing.accounts",
      local_field: "account_id", target_field: "account_id", cardinality: "many_to_one" as const, nullable: false, target_unique: true };
    const args = { from_resource: "billing.accounts", to_resource: "billing.accounts" };
    const reviewed = new Set<string>();
    const inspect = () => inspectActionRelationships({ built, args, reviewed, prepare: false });
    expect(inspect().status).toBe("missing");
    built.authoring.diagnostics.push({ code: "ACTION_RULE_RELATIONSHIP_UNBOUNDED", resource: link.from_resource, target_resource: link.to_resource, relationship: link.name, message: "No unconditional unique target key." });
    expect(inspect().status).toBe("unsupported");
    built.catalog.relationships = [link, { ...link, name: "different_business_link" }];
    expect(inspect().status).toBe("ambiguous");
    expect(reviewed.size).toBe(0);
    const missing = inspectActionRelationships({ built, args: { ...args, relationship: "invented" }, reviewed, prepare: true });
    expect(missing.prepared_disabled).toBe(false);
    expect(reviewed.size).toBe(0);
    expect(() => inspectActionRelationships({ built, args: { ...args, sql: "SELECT 1" }, reviewed, prepare: false })).toThrow("SELECTION_INVALID");
  });

  it("lets the model choose component order and repair compiler feedback without a user interruption", async () => {
    const requests: string[] = [];
    const steps = [
      call("runner.submit_approval_policy_draft"),
      call("runner.submit_action_rule_draft", rulePayload(eligiblePredicate("wrong_alias"))),
      call("runner.submit_verification_boundary_draft"),
      call("runner.submit_effect_envelope_draft"),
      call("runner.validate_action_draft", {}),
      call("runner.submit_action_rule_draft"),
      call("runner.validate_action_draft", {}),
      say("The pause draft is ready for your review. Existing authority is unchanged."),
    ];
    const requestJson = vi.fn(async (request) => {
      requests.push(JSON.stringify(request.body));
      return steps.shift()!;
    });
    const askClarification = vi.fn();
    const result = await converseActionRuleDraft({ ...requestInput(requestJson), askClarification });
    expect(result).toMatchObject({ state: "ready", correction_used: true, clarification_count: 0, authority_granted: false });
    expect(askClarification).not.toHaveBeenCalled();
    expect(requests[0]).toContain("runner__inspect_action_draft");
    expect(requests[5]).toContain("needs_repair");
    expect(result.compiled.rule.outcome).toBe("billing.pause_account");
  });

  it("retains draft state across more than two business questions and treats blank input as no decision", async () => {
    const requests: string[] = [];
    const steps = [
      call("runner.submit_verification_boundary_draft"),
      say("Should pauses always need a reviewer?"),
      say("A reviewer checks the request before it can proceed. Which team should review?"),
      say("Is one billing reviewer sufficient?"),
      say("I still need the reviewer count; nothing has been accepted."),
      call("runner.submit_approval_policy_draft"),
      call("runner.submit_action_rule_draft"),
      call("runner.submit_effect_envelope_draft"),
      call("runner.validate_action_draft", {}),
      say("The draft requires one billing reviewer."),
    ];
    const requestJson = vi.fn(async (request) => { requests.push(JSON.stringify(request.body)); return steps.shift()!; });
    const answers = ["Why?", "Billing reviewers", "", "Yes, one billing reviewer"];
    const askClarification = vi.fn(async () => answers.shift());
    const result = await converseActionRuleDraft({ ...requestInput(requestJson), askClarification });
    expect(result.clarification_count).toBe(4);
    expect(askClarification).toHaveBeenCalledTimes(4);
    expect(requests[4]).not.toContain("I have not supplied a decision");
    expect(requests[4]).toContain("The input was empty");
    expect(requests[4]).toContain("changes none of the recorded business answers");
    expect(requests[4]).toContain("billing.pause_account_verification");
  });

  it("finishes clarification of an already-correct baseline without requiring a fake edit or another answer", async () => {
    const baseline = (await generateModelActionRuleDraft(requestInput(phaseResponder([])))).compiled.draft;
    const before = structuredClone(baseline);
    const requests: string[] = [];
    const steps = [call("runner.validate_action_draft", {}), say("The existing draft already uses one billing reviewer; no rule changed.")];
    const askClarification = vi.fn(async () => { throw new Error("The business answer is already supplied."); });
    const result = await converseActionRuleDraft({ ...requestInput(async request => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), existingDraft: baseline, intent: "Yes, retain one billing reviewer. Do not change any other rules.", askClarification });
    expect(result.compiled.draft).toEqual(before);
    expect(baseline).toEqual(before);
    expect(result.revision?.changed_phases).toEqual([]);
    expect(result.clarification_count).toBe(0);
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(requests.at(-1)).toContain('draft_changed');
    expect(requests.at(-1)).toContain("No revision was saved");
    expect(askClarification).not.toHaveBeenCalled();
  });

  it("edits only the selected component of an existing rule, without recreating its effect", async () => {
    const existing = await generateModelActionRuleDraft(requestInput(phaseResponder([])));
    const steps = [
      call("runner.submit_approval_policy_draft", { ...payloadFor("runner.submit_approval_policy_draft"), required_approvals: 2, changed_fields: ["required_approvals"] }),
      call("runner.validate_action_draft", {}),
      say("The revised draft requires two distinct billing reviewers."),
    ];
    const requestJson = vi.fn(async () => steps.shift()!);
    const result = await converseActionRuleDraft({
      ...requestInput(requestJson), existingDraft: existing.compiled.draft,
      intent: "Change only the fallback reviewer count to two. Keep every other rule and value unchanged.",
    });
    expect(result.revision?.changed_phases).toEqual(["approval"]);
    expect(result.compiled.draft.effect).toEqual(existing.compiled.draft.effect);
    expect(result.compiled.approval_class.required_approvals).toBe(2);
    expect(requestJson).toHaveBeenCalledTimes(3);
  });

  it("applies an explicitly revised input bound without losing other rule or approval settings", async () => {
    const baseline = policyModelDraft();
    baseline.inputs = [{ name: "requested_days", description: "Requested pause duration", type: { kind: "integer" }, minimum: 1, maximum: 25 }];
    const before = structuredClone(baseline);
    const inputs = [{ ...baseline.inputs[0]!, maximum: 15 }];
    const steps = [call("runner.submit_action_rule_draft", { ...rulePayload(baseline.require), inputs, changed_fields: ["inputs"] }),
      call("runner.validate_action_draft", {}), say("The proposed duration is now bounded to 1 through 15 days.")];
    const result = await converseActionRuleDraft({ ...requestInput(async () => steps.shift()!), existingDraft: baseline,
      intent: "Lower only the maximum requested days to 15. Keep all other rules and limits." });
    expect(result.compiled.rule.inputs).toEqual(inputs);
    expect(result.compiled.draft).toMatchObject({ inputs, outcome: baseline.outcome, approval: baseline.approval,
      require: baseline.require, effect: baseline.effect, review: baseline.review });
    expect(result.revision?.changed_phases).toEqual(["rule"]);
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(baseline).toEqual(before);
  });

  it("repairs a caller-version mistake internally without asking the customer for a hidden value", async () => {
    const faulty = { ...payloadFor("runner.submit_action_rule_draft"), inputs: [{ name: "expected_version", description: "Version.", type: { kind: "integer" }, minimum: 0, maximum: 100 }],
      require: { kind: "all", expressions: [eligiblePredicate(), { kind: "compare", operator: "eq", left: { kind: "field", binding: "account", field: "version" }, right: { kind: "input", name: "expected_version" } }] } };
    const requests: string[] = [];
    const steps = [call("runner.submit_verification_boundary_draft"), call("runner.submit_effect_envelope_draft"),
      call("runner.submit_action_rule_draft", faulty), call("runner.submit_approval_policy_draft"), call("runner.validate_action_draft", {}),
      call("runner.submit_action_rule_draft", { ...payloadFor("runner.submit_action_rule_draft"), inputs: [] }),
      call("runner.validate_action_draft", {}), say("The pause draft is ready; Runner checks stale records privately.")];
    const askClarification = vi.fn();
    const result = await converseActionRuleDraft({ ...requestInput(async (request) => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), askClarification });
    expect(requests.join("\n")).toContain("Remove the caller guard input and its comparison");
    expect(result.compiled.rule.inputs).toEqual([]);
    expect(result.compiled.rule.require).toEqual(eligiblePredicate());
    expect(askClarification).not.toHaveBeenCalled();
    expect(result.authority_granted).toBe(false);
    expect(steps).toEqual([]);
  });

  it.each([false, true])("reopens a same-job draft after mistaken second-action creation (resume: %s)", async (resume) => {
    const existing = await generateModelActionRuleDraft(requestInput(phaseResponder([])));
    const baseline = existing.compiled.draft;
    const before = structuredClone(baseline);
    const selection = { outcome: baseline.outcome, digest: canonicalJsonDigest(baseline), covered_intent_indexes: [0, 1] };
    const pendingIntents = ["Route valid pauses to billing review.", "Refuse invalid pauses."];
    const requests: string[] = [];
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    const initialSteps = [call("runner.submit_verification_boundary_draft"), call("runner.submit_effect_envelope_draft"),
      call("runner.submit_action_rule_draft"), call("runner.submit_approval_policy_draft"),
      call("runner.validate_action_draft", {}), call("runner.reopen_prepared_action", selection)];
    const common = { preparedDrafts: [baseline], reservedOutcomes: [baseline.outcome], pendingIntents,
      intent: "Use the same pause action and policy. Only change the human fallback to two billing reviewers; retain its eligibility, effect and all other settings.",
      onCheckpoint: async (value: ActionRuleAuthoringCheckpoint) => { checkpoint = value; } };
    if (resume) {
      const paused = [...initialSteps, say("Keep the same action with two reviewers?")];
      await expect(converseActionRuleDraft({ ...requestInput(async (request) => {
        requests.push(JSON.stringify(request.body)); return paused.shift()!;
      }), ...common, askClarification: async () => undefined })).rejects.toThrow("CANCELLED");
      expect(checkpoint?.reopened_draft).toEqual(selection);
    }
    const steps = [...(resume ? [] : initialSteps),
      call("runner.submit_approval_policy_draft", { ...payloadFor("runner.submit_approval_policy_draft"), required_approvals: 2, changed_fields: ["required_approvals"] }),
      call("runner.reopen_prepared_action", selection), // An identical retry must not discard the edit.
      call("runner.validate_action_draft", {}), say("One pause action, with two billing reviewers. Review activation next.")];
    const result = await converseActionRuleDraft({ ...requestInput(async (request) => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), ...common, ...(resume ? { checkpoint } : {}) });
    expect(requests.join("\n")).toContain("ACTION_OUTCOME_COLLISION");
    expect(result.revision).toEqual({ outcome: baseline.outcome, changed_phases: ["approval"], reopened_draft: selection });
    expect(result.compiled.approval_class.required_approvals).toBe(2);
    expect(result.compiled.draft).toEqual({ ...baseline, approval: { ...baseline.approval, required_approvals: 2 } });
    expect(baseline).toEqual(before);
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
    expect(steps).toEqual([]);
    if (resume) {
      const requestJson = vi.fn();
      await expect(converseActionRuleDraft({ ...requestInput(requestJson), ...common, checkpoint,
        preparedDrafts: [{ ...baseline, approval: { ...baseline.approval, required_approvals: 3 } }],
      })).rejects.toThrow("REVISION_STALE");
      expect(requestJson).not.toHaveBeenCalled();
    }
  });

  it("keeps genuine outcome collisions closed and gives a guided revision recovery", async () => {
    const requests: string[] = [];
    const steps = [call("runner.submit_verification_boundary_draft"), call("runner.submit_effect_envelope_draft"),
      call("runner.submit_action_rule_draft"), call("runner.submit_approval_policy_draft"),
      call("runner.validate_action_draft", {}), say("This different action cannot claim the existing pause outcome.")];
    await expect(converseActionRuleDraft({ ...requestInput(async (request) => {
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), reservedOutcomes: ["billing.pause_account"], askClarification: async () => undefined })).rejects.toThrow("CANCELLED");
    expect(requests.at(-1)).toContain("ACTION_OUTCOME_COLLISION");
    expect(requests.at(-1)).not.toContain("Choose a distinct business outcome");
  });

  it("keeps validity separate from automatic eligibility when revising one policy", async () => {
    const existing = await generateModelActionRuleDraft(requestInput(phaseResponder([])));
    const baseline = existing.compiled.draft;
    const predicate = eligiblePredicate();
    if (predicate.kind !== "all") throw new Error("Expected fixture conjunction");
    const policy = { ...payloadFor("runner.submit_approval_policy_draft"), mode: "policy", auto_approve_when: predicate.expressions[1],
      shared_limits: [{ id: "all_pauses", kind: "count", scope: "capability", maximum: 10, window_seconds: 86400 },
        { id: "tenant_pauses", kind: "count", scope: "tenant", maximum: 3, window_seconds: 86400 }],
      changed_fields: ["mode", "auto_approve_when", "shared_limits"] };
    const steps = [call("runner.reopen_prepared_action", { outcome: baseline.outcome, digest: canonicalJsonDigest(baseline), covered_intent_indexes: [0] }),
      call("runner.submit_action_rule_draft", { ...rulePayload(predicate.expressions[0]!), changed_fields: ["require", "review.human_review"] }),
      call("runner.submit_approval_policy_draft", policy), call("runner.validate_action_draft", {}), say("Valid accounts can pause; risk holds need human review.")];
    const result = await converseActionRuleDraft({ ...requestInput(async () => steps.shift()!), preparedDrafts: [baseline],
      reservedOutcomes: [baseline.outcome], intent: "Use the same pause action. Active accounts qualify. Auto-approve only without a risk hold, at most 10 overall and 3 per tenant per rolling 24 hours; otherwise use one billing reviewer. Invalid accounts are refused. Keep the same effect and proposal-only posture." });
    const compiled = result.compiled.loaded.registry.rules[0]!.compiled;
    const facts = (status: string, hold: boolean) => ({ bindings: { account: { rows: [{ account_id: "a", tenant_id: "t", principal_id: "p", status, risk_hold: hold, version: 1 }] } },
      trusted: { tenant: "t", principal: "p", transaction_time: "2026-09-05T12:00:00.000Z" }, subject_provenance_digest: readDigest });
    for (const hold of [false, true]) {
      expect(evaluateActionRule({ compiled, facts: facts("active", hold), proposal_id: "test" }).result).toBe("eligible");
      expect(evaluateActionRuleApprovalPredicate({ compiled, facts: facts("active", hold),
        expression: result.compiled.draft.approval.auto_approve_when! }).result).toBe(hold ? "no_match" : "match");
    }
    expect(evaluateActionRule({ compiled, facts: facts("paused", false), proposal_id: "invalid" }).result).toBe("ineligible");
    expect(result.compiled.draft.effect).toEqual(baseline.effect);
    expect(result.compiled.draft.verification).toEqual(baseline.verification);
    expect(result.compiled.approval_class.required_approvals).toBe(1);
  });

  it("rejects stale or out-of-agenda reopen requests and can reuse an already-correct draft", async () => {
    const existing = await generateModelActionRuleDraft(requestInput(phaseResponder([])));
    const baseline = existing.compiled.draft;
    const selected = { outcome: baseline.outcome, digest: canonicalJsonDigest(baseline), covered_intent_indexes: [0] };
    const checkpoints = vi.fn();
    const requests: string[] = [];
    const steps = [call("runner.reopen_prepared_action", { ...selected, digest: readDigest }),
      call("runner.reopen_prepared_action", { ...selected, covered_intent_indexes: [0, 1] }),
      call("runner.reopen_prepared_action", selected), call("runner.validate_action_draft", {}), say("The same draft already requires one billing reviewer; no second action is needed.")];
    const result = await converseActionRuleDraft({ ...requestInput(async (request) => {
      if (steps.length >= 3) expect(checkpoints).not.toHaveBeenCalled();
      requests.push(JSON.stringify(request.body)); return steps.shift()!;
    }), preparedDrafts: [baseline], reservedOutcomes: [baseline.outcome], onCheckpoint: checkpoints });
    expect(requests.join("\n")).toContain("ACTION_RULE_REVISION_STALE");
    expect(checkpoints).toHaveBeenCalledOnce();
    expect(result.revision?.changed_phases).toEqual([]);
    expect(result.compiled.draft).toEqual(baseline);
  });

  it("resumes disabled components after an interruption and rejects a changed structural binding", async () => {
    let checkpoint: ActionRuleAuthoringCheckpoint | undefined;
    const initialSteps = [call("runner.submit_verification_boundary_draft"), say("Which team reviews this?")];
    await expect(converseActionRuleDraft({
      ...requestInput(vi.fn(async () => initialSteps.shift()!)),
      onCheckpoint: async (value) => { checkpoint = value; },
      askClarification: async () => undefined,
    })).rejects.toThrow("CANCELLED");
    expect(checkpoint?.components.verification).toBeDefined();
    const resumedSteps = [
      call("runner.submit_approval_policy_draft"), call("runner.submit_action_rule_draft"),
      call("runner.submit_effect_envelope_draft"), call("runner.validate_action_draft", {}), say("The paused draft is ready."),
    ];
    const requestJson = vi.fn(async () => resumedSteps.shift()!);
    const resumed = await converseActionRuleDraft({ ...requestInput(requestJson), checkpoint });
    expect(resumed.state).toBe("ready");
    expect(requestJson).toHaveBeenCalledTimes(5);
    const staleRequest = vi.fn();
    await expect(converseActionRuleDraft({
      ...requestInput(staleRequest), checkpoint, readBoundaryDigest: `sha256:${"f".repeat(64)}`,
    })).rejects.toThrow("CHECKPOINT_STALE");
    expect(staleRequest).not.toHaveBeenCalled();
  });
});

describe("model-guided Action Rule authoring", () => {
  it("labels retained operator statements separately in focused repair prompts", async () => {
    const calls: string[] = [], requests: string[] = [];
    const result = await generateModelActionRuleDraft({
      session: { provider: "openai", model: "gpt-5.6-terra", dependencies: { requestJson: phaseResponder(calls, undefined, requests) } },
      intent: "Generated diagnostic: repair the draft while preserving the original policy.",
      operatorStatements: ["Let an eligible account request a temporary pause with human review."],
      builtCatalog: builtCatalog(), readBoundary: boundary(), readBoundaryDigest: readDigest,
      egressAcknowledged: true, env: { OPENAI_API_KEY: "provider-test-key" },
    });
    expect(result.compiled.approval_class.mode).toBe("human");
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request).toContain("Generated repair context (not operator intent)");
      expect(request).toContain("Original policy and accepted operator statements");
      expect(request).not.toContain("Operator intent: \\\"Generated diagnostic");
    }
  });

  it("uses four focused required tools and compiles one disabled semantic authority", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    const requestJson = phaseResponder(calls, undefined, requestBodies);

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(calls).toEqual([
      "runner__submit_verification_boundary_draft",
      "runner__submit_effect_envelope_draft",
      "runner__submit_action_rule_draft",
      "runner__submit_approval_policy_draft",
    ]);
    expect(result).toMatchObject({
      state: "ready",
      provider: "openai",
      model: "gpt-5.6-terra",
      correction_used: false,
      clarification_count: 0,
      authority_granted: false,
      source_database_changed: false,
      compiled: {
        rule: { outcome: "billing.pause_account" },
        approval_class: { mode: "human" },
      },
    });
    expect(requestBodies).toHaveLength(4);
    for (const body of requestBodies) {
      expect(body).toContain("Current normalized structural catalog");
      expect(body).toContain("Already validated phase drafts");
      expect(body).toContain("include one clearly labelled non-authoritative example");
    }
    expect(requestBodies[0]).not.toContain("$defs");
    expect(requestBodies[1]).toContain("$defs");
    expect(requestBodies[0]).toContain("Do not nest the draft under object, boundary");
    expect(requestBodies[1]).toContain("Never put numeric bounds on strings or non-null values on money fields");
    expect(requestBodies[1]).toContain('\\"fields\\":[\\"account_id\\",\\"risk_hold\\",\\"status\\",\\"version\\"]');
    expect(result.compiled.draft.verification.resources[0]!.fields).toEqual([
      "account_id",
      "risk_hold",
      "status",
      "version",
    ]);
    expect(requestBodies[0]!.match(/Draft only the private Verification Boundary/g)).toHaveLength(1);
    expect(requestBodies[1]).toContain("billing.pause_account_verification");
    const effectRequest = JSON.parse(requestBodies[1]!) as {
      tools: Array<{ parameters?: Record<string, unknown>; function?: { parameters?: Record<string, unknown> } }>;
    };
    const effectSchema = effectRequest.tools[0]?.parameters
      ?? effectRequest.tools[0]?.function?.parameters;
    const effectVariants = effectSchema?.oneOf as Array<{
      required?: string[];
      properties?: Record<string, { const?: string }>;
    }>;
    const updateVariant = effectVariants.find((variant) => variant.properties?.operation?.const === "update");
    const insertVariant = effectVariants.find((variant) => variant.properties?.operation?.const === "insert");
    expect(updateVariant?.required).toContain("target_binding");
    expect(insertVariant?.required).not.toContain("target_binding");
    expect(insertVariant?.properties).not.toHaveProperty("target_binding");
    expect(requestBodies[1]).toContain("An UPDATE draft must include target_binding");
    expect(requestBodies[1]).not.toContain("optional target_binding");
    expect(requestBodies[3]).toContain("A tenant_principal limit already satisfies trusted scope");
    expect(requestBodies[3]).toContain("do not ask for or invent a redundant tenant-only limit");
  });

  it("uses the same operation-aware Effect contract for Anthropic authoring", async () => {
    const calls: string[] = [];
    let effectSchema: Record<string, unknown> | undefined;
    const requestJson = vi.fn(async (
      request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0],
    ) => {
      const body = request.body as Record<string, unknown>;
      const tools = body.tools as Array<{ name?: string; input_schema?: Record<string, unknown> }>;
      const tool = tools[0];
      if (!tool?.name) throw new Error("Expected one forced Anthropic Action Rule authoring tool.");
      calls.push(tool.name);
      if (tool.name.endsWith("submit_effect_envelope_draft")) {
        effectSchema = structuredClone(tool.input_schema);
      }
      return {
        status: 200,
        body: {
          content: [{
            type: "tool_use",
            id: `toolu_${calls.length}`,
            name: tool.name,
            input: payloadFor(tool.name),
          }],
        },
      };
    });

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "anthropic",
        model: "claude-test",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { ANTHROPIC_API_KEY: "provider-test-key" },
    });

    expect(result).toMatchObject({
      state: "ready",
      provider: "anthropic",
      authority_granted: false,
      source_database_changed: false,
    });
    expect(calls).toHaveLength(4);
    const variants = effectSchema?.oneOf as Array<{
      required?: string[];
      properties?: Record<string, { const?: string }>;
    }>;
    const updateVariant = variants.find((variant) => variant.properties?.operation?.const === "update");
    const insertVariant = variants.find((variant) => variant.properties?.operation?.const === "insert");
    expect(updateVariant?.required).toContain("target_binding");
    expect(insertVariant?.required).not.toContain("target_binding");
    expect(insertVariant?.properties).not.toHaveProperty("target_binding");
    expect(JSON.stringify(requestJson.mock.calls.map(([request]) => request.body)))
      .not.toContain("provider-test-key");
  });

  it("infers one unambiguous UPDATE subject when a provider omits target_binding", async () => {
    const calls: string[] = [];
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_effect_envelope_draft")) return undefined;
      const effect = payloadFor(name);
      delete effect.target_binding;
      return effect;
    });
    const askClarification = vi.fn(async () => "The operator should not be asked for a Runner binding.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_effect_envelope_draft"))).toHaveLength(1);
    expect(result.compiled.draft.effect.target_binding).toBe("account");
    expect(result.compiled.effect_envelope).toMatchObject({
      operation: "update",
      target_resource: "billing.accounts",
      target_binding: "account",
      max_rows: 1,
      writeback: { mode: "none" },
    });
    expect(result.authority_granted).toBe(false);
    expect(result.source_database_changed).toBe(false);
  });

  it("internally corrects an explicit UPDATE binding that points at another subject", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let effectCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_effect_envelope_draft")) return undefined;
      const effect = payloadFor(name);
      if (effectCalls++ === 0) effect.target_binding = "other";
      return effect;
    }, requestBodies);

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(calls.filter((name) => name.endsWith("submit_effect_envelope_draft"))).toHaveLength(2);
    expect(result.compiled.draft.effect.target_binding).toBe("account");
    expect(result.correction_used).toBe(true);
    expect(requestBodies.some((body) => body.includes("Eligible one-row subject targets"))).toBe(true);
  });

  it("asks one business clarification rather than guessing between UPDATE subjects", async () => {
    const calls: string[] = [];
    let verificationCalls = 0;
    let effectCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_verification_boundary_draft")) {
        verificationCalls += 1;
        return {
          status: "draft",
          name: "billing.pause_account_verification",
          resources: ["primary_account", "secondary_account"].map((binding) => ({
            binding,
            resource: "billing.accounts",
            source: { kind: "subject_ref" },
            fields: ["status", "risk_hold"],
          })),
        };
      }
      if (name.endsWith("submit_effect_envelope_draft")) {
        const effect = payloadFor(name);
        if (effectCalls++ === 0) delete effect.target_binding;
        else if (effectCalls === 2) {
          return {
            status: "clarification",
            question: "Should the proposal change the customer's primary or secondary account record?",
          };
        } else effect.target_binding = "primary_account";
        return effect;
      }
      if (name.endsWith("submit_action_rule_draft")) {
        return rulePayload(eligiblePredicate("primary_account"));
      }
      return undefined;
    });
    const askClarification = vi.fn(async () => "Change the customer's primary account record.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(verificationCalls).toBe(1);
    expect(askClarification).toHaveBeenCalledWith(
      "Should the proposal change the customer's primary or secondary account record?",
    );
    expect(result.compiled.draft.effect.target_binding).toBe("primary_account");
    expect(result.clarification_count).toBe(1);
  });

  it("fails before Rule or approval drafting when UPDATE has no reviewed subject target", async () => {
    const calls: string[] = [];
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_verification_boundary_draft")) {
        return {
          status: "draft",
          name: "billing.pause_account_verification",
          resources: [{
            binding: "supporting_account",
            resource: "billing.accounts",
            source: {
              kind: "relationship",
              from_binding: "missing_parent",
              relationship: "missing_relationship",
              direction: "forward",
            },
            fields: ["status", "risk_hold"],
          }],
        };
      }
      if (!name.endsWith("submit_effect_envelope_draft")) return undefined;
      const effect = payloadFor(name);
      delete effect.target_binding;
      return effect;
    });

    await expect(generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    })).rejects.toThrow(/could not identify which reviewed billing\.accounts row/u);
    expect(calls.filter((name) => name.endsWith("submit_action_rule_draft"))).toHaveLength(0);
    expect(calls.filter((name) => name.endsWith("submit_approval_policy_draft"))).toHaveLength(0);
  });

  it("keeps INSERT free of target_binding and retains Runner-derived deduplication", async () => {
    const calls: string[] = [];
    const insertCatalog = structuredClone(builtCatalog());
    insertCatalog.authoring.resources[0]!.operations.insert = true;
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_effect_envelope_draft")) return undefined;
      const effect = payloadFor(name);
      effect.operation = "insert";
      delete effect.target_binding;
      return effect;
    });

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an agent propose one new paused account record for human review.",
      builtCatalog: insertCatalog,
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(result.compiled.draft.effect).not.toHaveProperty("target_binding");
    expect(result.compiled.effect_envelope).toMatchObject({
      operation: "insert",
      deduplication: {
        components: [
          { column: "account_id", source: "proposal_id" },
          { column: "tenant_id", source: "trusted_tenant" },
        ],
      },
      writeback: { mode: "none" },
    });
  });

  it("normalizes an omitted empty approval-limit list before authority validation", async () => {
    const calls: string[] = [];
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_approval_policy_draft")) return undefined;
      const approval = payloadFor(name);
      delete approval.shared_limits;
      return approval;
    });

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(result.compiled.approval_class).toMatchObject({
      mode: "human",
      shared_limits: [],
    });
    expect(calls.filter((name) => name.endsWith("submit_approval_policy_draft"))).toHaveLength(1);
  });

  it("repairs a per-person counter that weakens an explicit customer-account limit", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let approvalCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_approval_policy_draft")) return undefined;
      approvalCalls += 1;
      return {
        status: "draft",
        class_name: "billing.policy_pause",
        mode: "policy",
        auto_approve_when: eligiblePredicate(),
        required_role: "billing_reviewer",
        required_approvals: 1,
        shared_limits: [
          {
            id: "pause_action_24h",
            kind: "count",
            scope: "capability",
            maximum: 10,
            window_seconds: 86_400,
            capability: "billing.pause_account",
          },
          {
            id: "pause_account_24h",
            kind: "count",
            scope: approvalCalls === 1 ? "tenant_principal" : "tenant",
            maximum: 3,
            window_seconds: 86_400,
            capability: "billing.pause_account",
          },
        ],
      };
    }, requestBodies);
    const askClarification = vi.fn(async () => "The account-wide limit was already stated.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Auto-approve at most 10 plan changes for this action in a rolling 24-hour period and no more than 3 for the same customer account in a rolling 24-hour period.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_approval_policy_draft"))).toHaveLength(2);
    expect(result.compiled.approval_class.shared_limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "capability", maximum: 10, window_seconds: 86_400 }),
      expect.objectContaining({ scope: "tenant", maximum: 3, window_seconds: 86_400 }),
    ]));
    expect(requestBodies.some((body) => body.includes("same customer account"))).toBe(true);
    expect(requestBodies.some((body) => body.includes("Bare 'per customer' is ambiguous"))).toBe(true);
  });

  it("repairs omitted automatic-policy limits from the stated intent without repeating them to the operator", async () => {
    const calls: string[] = [];
    let approvalCalls = 0;
    const actionLimit = {
      id: "pause_action_24h",
      kind: "count" as const,
      scope: "capability" as const,
      maximum: 100,
      window_seconds: 86_400,
      capability: "billing.pause_account",
    };
    const principalLimit = {
      id: "pause_principal_15d",
      kind: "count" as const,
      scope: "tenant_principal" as const,
      maximum: 1,
      window_seconds: 1_296_000,
      capability: "billing.pause_account",
    };
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_approval_policy_draft")) return undefined;
      approvalCalls += 1;
      return {
        status: "draft",
        class_name: "billing.policy_pause",
        mode: "policy",
        auto_approve_when: eligiblePredicate(),
        required_role: "support_reviewer",
        required_approvals: 1,
        ...(approvalCalls === 1 ? {} : { shared_limits: [actionLimit, principalLimit] }),
      };
    });
    const askClarification = vi.fn(async () => "This should not be needed.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Auto-approve eligible pauses at most 100 per rolling 24 hours and one per trusted tenant plus principal per rolling 15 days; otherwise require one support_reviewer.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_approval_policy_draft"))).toHaveLength(2);
    expect(result.compiled.approval_class.shared_limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "capability", maximum: 100, window_seconds: 86_400 }),
      expect.objectContaining({ scope: "tenant_principal", maximum: 1, window_seconds: 1_296_000 }),
    ]));
  });

  it("redirects a redundant tenant-wide limit question when tenant plus principal is already exact", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let approvalCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_approval_policy_draft")) return undefined;
      approvalCalls += 1;
      if (approvalCalls === 1) {
        return {
          status: "clarification",
          question: "What separate maximum should apply per tenant in a rolling 24-hour window?",
        };
      }
      return {
        status: "draft",
        class_name: "billing.policy_pause",
        mode: "policy",
        auto_approve_when: eligiblePredicate(),
        required_role: "support_reviewer",
        required_approvals: 1,
        shared_limits: [
          {
            id: "pause_action_24h",
            kind: "count",
            scope: "capability",
            maximum: 100,
            window_seconds: 86_400,
            capability: "billing.pause_account",
          },
          {
            id: "pause_principal_15d",
            kind: "count",
            scope: "tenant_principal",
            maximum: 1,
            window_seconds: 1_296_000,
            capability: "billing.pause_account",
          },
        ],
      };
    }, requestBodies);
    const askClarification = vi.fn(async () => "A redundant tenant-wide answer.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Auto-approve at most 100 pauses for this action per rolling 24 hours and one per trusted tenant plus principal per rolling 15 days; otherwise require one support_reviewer.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_approval_policy_draft"))).toHaveLength(2);
    expect(requestBodies.some((body) =>
      body.includes("Rejected redundant approval clarification"))).toBe(true);
    expect(result.compiled.approval_class.shared_limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "capability", maximum: 100, window_seconds: 86_400 }),
      expect.objectContaining({ scope: "tenant_principal", maximum: 1, window_seconds: 1_296_000 }),
    ]));
  });

  it("repairs a compiled policy that weakened an explicit tenant plus principal scope", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let approvalCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_approval_policy_draft")) return undefined;
      approvalCalls += 1;
      return {
        status: "draft",
        class_name: "billing.policy_pause",
        mode: "policy",
        auto_approve_when: eligiblePredicate(),
        required_role: "support_reviewer",
        required_approvals: 1,
        shared_limits: [
          {
            id: "pause_action_24h",
            kind: "count",
            scope: "capability",
            maximum: 100,
            window_seconds: 86_400,
            capability: "billing.pause_account",
          },
          {
            id: "pause_owner_15d",
            kind: "count",
            scope: approvalCalls === 1 ? "tenant" : "tenant_principal",
            maximum: 1,
            window_seconds: 1_296_000,
            capability: "billing.pause_account",
          },
        ],
      };
    }, requestBodies);
    const askClarification = vi.fn(async () => "The operator should not need to repeat the exact policy.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Auto-approve at most 100 pauses for this action per rolling 24 hours and one per trusted tenant plus principal per rolling 15 days; otherwise require one support_reviewer.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_approval_policy_draft"))).toHaveLength(2);
    expect(requestBodies.some((body) => body.includes("must preserve the operator's explicit tenant_principal accounting"))).toBe(true);
    expect(result.compiled.approval_class.shared_limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "capability", maximum: 100, window_seconds: 86_400 }),
      expect.objectContaining({ scope: "tenant_principal", maximum: 1, window_seconds: 1_296_000 }),
    ]));
  });

  it("repairs crossed maxima and windows instead of accepting all requested values somewhere", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let approvalCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_approval_policy_draft")) return undefined;
      approvalCalls += 1;
      const exact = approvalCalls > 1;
      return {
        status: "draft",
        class_name: "billing.policy_pause",
        mode: "policy",
        auto_approve_when: eligiblePredicate(),
        required_role: "support_reviewer",
        required_approvals: 1,
        shared_limits: [
          {
            id: "pause_action",
            kind: "count",
            scope: "capability",
            maximum: exact ? 100 : 1,
            window_seconds: exact ? 86_400 : 1_296_000,
            capability: "billing.pause_account",
          },
          {
            id: "pause_owner",
            kind: "count",
            scope: "tenant_principal",
            maximum: exact ? 1 : 100,
            window_seconds: exact ? 1_296_000 : 86_400,
            capability: "billing.pause_account",
          },
        ],
      };
    }, requestBodies);

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Limit automatic approvals to 100 for this exact action in a rolling 24-hour window and one per trusted tenant plus principal in a rolling 15-day window.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(calls.filter((name) => name.endsWith("submit_approval_policy_draft"))).toHaveLength(2);
    expect(requestBodies.some((body) => body.includes("exact capability count limit of 100 in a rolling 1 day window"))).toBe(true);
    expect(result.compiled.approval_class.shared_limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "capability", maximum: 100, window_seconds: 86_400 }),
      expect.objectContaining({ scope: "tenant_principal", maximum: 1, window_seconds: 1_296_000 }),
    ]));
  });

  it("preserves slash-delimited tenant/principal accounting without inventing a tenant-only limit", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let approvalCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_approval_policy_draft")) return undefined;
      approvalCalls += 1;
      return {
        status: "draft",
        class_name: "support.refund_policy",
        mode: "policy",
        auto_approve_when: eligiblePredicate(),
        required_role: "support_reviewer",
        required_approvals: 1,
        shared_limits: [
          {
            id: "refund_action_24h",
            kind: "count",
            scope: "capability",
            maximum: 100,
            window_seconds: 86_400,
            capability: "billing.pause_account",
          },
          {
            id: "refund_owner_15d",
            kind: "count",
            scope: "tenant_principal",
            maximum: 1,
            window_seconds: 1_296_000,
            capability: "billing.pause_account",
          },
        ],
      };
    }, requestBodies);
    const askClarification = vi.fn(async () => "This exact policy was already stated.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Auto-approve no more than 100 proposals in rolling 24 hours and one refund per trusted tenant/principal in rolling 15 days; otherwise require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_approval_policy_draft"))).toHaveLength(1);
    expect(requestBodies.some((body) => body.includes("explicit tenant accounting"))).toBe(false);
    expect(result.compiled.approval_class.shared_limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "tenant_principal", maximum: 1, window_seconds: 1_296_000 }),
    ]));
  });

  it("recognizes a trusted tenant plus principal pair as one combined accounting scope", async () => {
    const calls: string[] = [];
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_approval_policy_draft")) return undefined;
      return {
        status: "draft",
        class_name: "billing.policy_pause",
        mode: "policy",
        auto_approve_when: eligiblePredicate(),
        required_role: "support_reviewer",
        required_approvals: 1,
        shared_limits: [
          {
            id: "pause_action_24h",
            kind: "count",
            scope: "capability",
            maximum: 100,
            window_seconds: 86_400,
            capability: "billing.pause_account",
          },
          {
            id: "pause_owner_15d",
            kind: "count",
            scope: "tenant_principal",
            maximum: 1,
            window_seconds: 1_296_000,
            capability: "billing.pause_account",
          },
        ],
      };
    });
    const askClarification = vi.fn(async () => "This exact policy was already stated.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Allow at most one approved proposal for a trusted tenant plus principal pair in a rolling 15-day window.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(result.compiled.approval_class.shared_limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "tenant_principal", window_seconds: 1_296_000 }),
    ]));
  });

  it("edits one exact reviewed baseline without letting the model rename its authority or target", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_verification_boundary_draft")) {
        return { ...payloadFor(name), changed_fields: [], name: "model.renamed_verification" };
      }
      if (name.endsWith("submit_effect_envelope_draft")) {
        return {
          ...payloadFor(name),
          name: "model.renamed_effect",
          operation: "insert",
          target_resource: "model.unreviewed_target",
          target_binding: "other",
          changed_fields: [],
        };
      }
      if (name.endsWith("submit_action_rule_draft")) {
        return {
          ...payloadFor(name),
          name: "model.renamed_rule",
          outcome: "model.renamed_outcome",
          changed_fields: [],
        };
      }
      if (name.endsWith("submit_approval_policy_draft")) {
        return {
          ...payloadFor(name),
          class_name: "model.renamed_approval",
          required_approvals: 2,
          changed_fields: ["required_approvals"],
        };
      }
      return undefined;
    }, requestBodies);

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Keep the same pause outcome and require two billing reviewers instead of one.",
      existingDraft: modelDraft(),
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(result.compiled.draft).toMatchObject({
      name: "billing.pause_account",
      outcome: "billing.pause_account",
      verification: { name: "billing.pause_account_verification" },
      effect: {
        name: "billing.pause_account_effect",
        operation: "update",
        target_resource: "billing.accounts",
        target_binding: "account",
      },
      approval: {
        class_name: "billing.human_pause",
        required_approvals: 2,
      },
    });
    expect(result.revision).toEqual({
      outcome: "billing.pause_account",
      changed_phases: ["approval"],
    });
    expect(requestBodies).toHaveLength(4);
    for (const body of requestBodies) {
      expect(body).toContain("Existing reviewed rule baseline");
      expect(body).toContain("Preserve every baseline value");
      expect(body).not.toContain("provider-test-key");
    }
  });

  it("retains an automatic policy when a revision changes only its fallback quorum", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    const baseline = policyModelDraft();
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_approval_policy_draft")) {
        return {
          ...payloadFor(name),
          changed_fields: ["required_approvals"],
          mode: "human",
          required_role: "reviewer",
          required_approvals: 2,
          shared_limits: [],
        };
      }
      return { ...payloadFor(name), changed_fields: [] };
    }, requestBodies);

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Change only the fallback human-review quorum from one support reviewer to two. Preserve automatic approval and both limits.",
      existingDraft: baseline,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(result.compiled.draft.approval).toEqual({
      ...baseline.approval,
      required_approvals: 2,
    });
    expect(result.compiled.draft.require).toEqual(baseline.require);
    expect(result.compiled.draft.effect).toEqual(baseline.effect);
    expect(result.compiled.draft.verification).toEqual({
      ...baseline.verification,
      resources: [{
        ...baseline.verification.resources[0]!,
        fields: ["account_id", "risk_hold", "status", "version"],
      }],
    });
    expect(calls).toEqual(["runner__submit_approval_policy_draft"]);
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toContain("Existing reviewed rule baseline");
    expect(result.revision).toEqual({
      outcome: "billing.pause_account",
      changed_phases: ["approval"],
    });
  });

  it("keeps all four model phases for an ambiguous multi-phase revision", async () => {
    const calls: string[] = [];
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_approval_policy_draft")) {
        return {
          ...payloadFor(name),
          changed_fields: ["required_approvals"],
          required_approvals: 2,
        };
      }
      return { ...payloadFor(name), changed_fields: [] };
    });

    await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Revise the pause policy and require two reviewers while keeping the Read Boundary unchanged.",
      existingDraft: modelDraft(),
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(calls).toEqual([
      "runner__submit_verification_boundary_draft",
      "runner__submit_effect_envelope_draft",
      "runner__submit_action_rule_draft",
      "runner__submit_approval_policy_draft",
    ]);
  });

  it("reconciles a newly reviewed trusted scope field before compiling the Action target", async () => {
    const calls: string[] = [];
    const unreviewedCatalog = structuredClone(builtCatalog());
    delete unreviewedCatalog.catalog.resources[0]!.principal_scope_key;
    unreviewedCatalog.authoring.resources[0]!.principal_scope = "none";
    delete unreviewedCatalog.authoring.resources[0]!.principal_key;
    const candidatePrincipal = unreviewedCatalog.authoring.resources[0]!.fields.find((field) =>
      field.name === "principal_id")!;
    candidatePrincipal.role = "model_visible";
    candidatePrincipal.writable = true;
    const unreviewedBoundary = structuredClone(boundary());
    delete unreviewedBoundary.pack.resources[0]!.principal_key;
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_effect_envelope_draft")) return undefined;
      const effect = payloadFor(name);
      effect.allowed_fields = [
        { name: "status", values: ["paused"] },
        { name: "principal_id" },
      ];
      effect.set = {
        status: statusLiteral("paused"),
        principal_id: { kind: "literal", value: "caller-controlled", value_type: stringId },
      };
      return effect;
    });
    const prepareResources = vi.fn(async ({ phase }: { phase: "verification" | "effect" }) =>
      phase === "verification"
        ? {
            builtCatalog: unreviewedCatalog,
            readBoundary: unreviewedBoundary,
            readBoundaryDigest: readDigest,
          }
        : {
            builtCatalog: builtCatalog(),
            readBoundary: boundary(),
            readBoundaryDigest: readDigest,
          });

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: unreviewedCatalog,
      readBoundary: unreviewedBoundary,
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      prepareResources,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(prepareResources).toHaveBeenNthCalledWith(1, {
      context: { builtCatalog: unreviewedCatalog, readBoundary: unreviewedBoundary, readBoundaryDigest: readDigest },
      phase: "verification",
      resourceIds: ["billing.accounts"],
      principalScopeResourceIds: ["billing.accounts"],
    });
    expect(prepareResources).toHaveBeenNthCalledWith(2, {
      context: { builtCatalog: unreviewedCatalog, readBoundary: unreviewedBoundary, readBoundaryDigest: readDigest },
      phase: "effect",
      resourceIds: ["billing.accounts"],
      principalScopeResourceIds: ["billing.accounts"],
    });
    expect(result.compiled.draft.effect.allowed_fields).toEqual([
      { name: "status", values: ["paused"] },
    ]);
    expect(result.compiled.draft.effect.set).toEqual({ status: statusLiteral("paused") });
    expect(result.compiled.effect_envelope.principal_scope_key).toBe("principal_id");
  });

  it("asks a genuine business clarification and resumes the same focused phase", async () => {
    const calls: string[] = [];
    let verificationCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_verification_boundary_draft") && verificationCalls++ === 0) {
        return {
          status: "clarification",
          question: "Should a risk hold make the request ineligible?",
        };
      }
      return undefined;
    });
    const askClarification = vi.fn(async () => "Yes. A risk hold must refuse the request.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).toHaveBeenCalledWith("Should a risk hold make the request ineligible?");
    expect(calls.filter((name) => name.endsWith("submit_verification_boundary_draft"))).toHaveLength(2);
    expect(result.clarification_count).toBe(1);
    expect(result.authority_granted).toBe(false);
  });

  it("permits one compiler-directed mechanical repair without broadening the effect", async () => {
    const calls: string[] = [];
    let ruleCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_action_rule_draft") && ruleCalls++ === 0) {
        return rulePayload({
          kind: "compare",
          operator: "gt",
          left: { kind: "field", binding: "account", field: "status" },
          right: statusLiteral("active"),
        });
      }
      return undefined;
    });

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(calls.filter((name) => name.endsWith("submit_action_rule_draft"))).toHaveLength(2);
    expect(result.correction_used).toBe(true);
    expect(result.compiled.effect_envelope).toMatchObject({
      target_resource: "billing.accounts",
      allowed_fields: [{ name: "status", values: ["paused"] }],
    });
  });

  it("routes an invalid effect-field bound back to the effect phase", async () => {
    const calls: string[] = [];
    let effectCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_effect_envelope_draft") && effectCalls++ === 0) {
        return {
          ...payloadFor(name),
          allowed_fields: [{ name: "status", minimum: 1, maximum: 2 }],
        };
      }
      return undefined;
    });

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(calls.filter((name) => name.endsWith("submit_effect_envelope_draft"))).toHaveLength(2);
    expect(calls.filter((name) => name.endsWith("submit_action_rule_draft"))).toHaveLength(1);
    expect(result.correction_used).toBe(true);
    expect(result.compiled.effect_envelope.allowed_fields).toMatchObject([{ name: "status", values: ["paused"] }]);
  });

  it("routes a rule expression binding error back to the rule phase", async () => {
    const calls: string[] = [];
    let ruleCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_action_rule_draft") && ruleCalls++ === 0) {
        return rulePayload({
          kind: "compare",
          operator: "eq",
          left: { kind: "field", binding: "subject", field: "status" },
          right: statusLiteral("active"),
        });
      }
      return undefined;
    });

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(calls.filter((name) => name.endsWith("submit_action_rule_draft"))).toHaveLength(2);
    expect(calls.filter((name) => name.endsWith("submit_verification_boundary_draft"))).toHaveLength(1);
    expect(result.correction_used).toBe(true);
    expect(result.compiled.rule.require).toEqual(eligiblePredicate());
  });

  it("turns an omitted required circuit breaker into one bounded business clarification", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let approvalCalls = 0;
    const question = "What maximum total account pauses may auto-approve in a rolling 24 hours?";
    const scopedLimit = {
      id: "pause_principal_24h",
      kind: "count" as const,
      scope: "tenant_principal" as const,
      maximum: 1,
      window_seconds: 86_400,
      capability: "billing.pause_account",
    };
    const actionLimit = {
      id: "pause_action_24h",
      kind: "count" as const,
      scope: "capability" as const,
      maximum: 100,
      window_seconds: 86_400,
      capability: "billing.pause_account",
    };
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_approval_policy_draft")) return undefined;
      const call = approvalCalls++;
      if (call === 1) return { status: "clarification", question };
      return {
        status: "draft",
        class_name: "billing.policy_pause",
        mode: "policy",
        auto_approve_when: eligiblePredicate(),
        required_role: "billing_reviewer",
        required_approvals: 1,
        shared_limits: call === 0 ? [scopedLimit] : [actionLimit, scopedLimit],
      };
    }, requestBodies);
    const askClarification = vi.fn(async () => "At most 100 total account pauses per rolling 24 hours.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Auto-approve an eligible account pause at most once per customer each day.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).toHaveBeenCalledWith(question);
    expect(calls.filter((name) => name.endsWith("submit_approval_policy_draft"))).toHaveLength(3);
    expect(result.compiled.approval_class.shared_limits).toHaveLength(2);
    expect(requestBodies.some((body) =>
      body.includes("ask one concise clarification instead of guessing"))).toBe(true);
    expect(requestBodies.some((body) =>
      body.includes("Resolve only the named problem"))).toBe(true);
    expect(requestBodies.every((body) =>
      !body.includes("This diagnostic is operator-owned"))).toBe(true);
  });

  it("binds model-supplied approval limit targets to the validated semantic outcome", async () => {
    const calls: string[] = [];
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_action_rule_draft")) {
        return {
          ...payloadFor(name),
          name: "billing.request_pause",
          outcome: "billing.pause_requested",
        };
      }
      if (name.endsWith("submit_approval_policy_draft")) {
        return {
          ...payloadFor(name),
          class_name: "billing.request_pause",
          mode: "policy",
          auto_approve_when: eligiblePredicate(),
          shared_limits: [
            {
              id: "pause_action_24h",
              kind: "count",
              scope: "capability",
              maximum: 100,
              window_seconds: 86_400,
              capability: "billing.request_pause",
            },
            {
              id: "pause_principal_24h",
              kind: "count",
              scope: "tenant_principal",
              maximum: 1,
              window_seconds: 86_400,
              capability: "billing.request_pause",
            },
          ],
        };
      }
      return undefined;
    });

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a pause with one action-wide rolling limit.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(result.compiled.rule.outcome).toBe("billing.pause_requested");
    expect(result.compiled.approval_class.shared_limits).toEqual([
      expect.objectContaining({
        capability: "billing.pause_requested",
        scope: "capability",
        maximum: 100,
      }),
      expect.objectContaining({
        capability: "billing.pause_requested",
        scope: "tenant_principal",
        maximum: 1,
      }),
    ]);
  });

  it("explains that lifetime approval counts are unsupported and accepts one exact rolling replacement", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let approvalCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_approval_policy_draft")) return undefined;
      if (approvalCalls++ === 0) {
        return {
          status: "clarification",
          question: "What window should apply to the maximum of 100 approved pauses?",
        };
      }
      return {
        status: "draft",
        class_name: "billing.policy_pause",
        mode: "policy",
        auto_approve_when: eligiblePredicate(),
        required_role: "billing_reviewer",
        required_approvals: 1,
        shared_limits: [
          {
            id: "pause_action_15d",
            kind: "count",
            scope: "capability",
            maximum: 100,
            window_seconds: 1_296_000,
            capability: "billing.pause_account",
          },
          {
            id: "pause_principal_15d",
            kind: "count",
            scope: "tenant_principal",
            maximum: 1,
            window_seconds: 1_296_000,
            capability: "billing.pause_account",
          },
        ],
      };
    }, requestBodies);
    const answers = ["A lifetime total; is that supported?", "Use a rolling 15-day window."];
    const askClarification = vi.fn(async (_question: string) => answers.shift());

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Auto-approve an eligible account pause at most once per customer and at most 100 total.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification.mock.calls.map(([question]) => question)).toEqual([
      "What window should apply to the maximum of 100 approved pauses?",
      expect.stringContaining("lifetime or non-resetting total is not representable"),
    ]);
    expect(result.clarification_count).toBe(1);
    expect(result.compiled.approval_class.shared_limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "capability", maximum: 100, window_seconds: 1_296_000 }),
      expect.objectContaining({ scope: "tenant_principal", maximum: 1, window_seconds: 1_296_000 }),
    ]));
    expect(requestBodies.some((body) => body.includes("15 days as 1296000"))).toBe(true);
  });

  it("keeps a second missing approval breaker in the same bounded model conversation", async () => {
    const calls: string[] = [];
    let approvalCalls = 0;
    const questions = [
      "What maximum total account pauses may auto-approve in a rolling 24 hours?",
      "Confirm the action-wide pause limit for the same rolling 24-hour window.",
    ];
    const scopedLimit = {
      id: "pause_principal_24h",
      kind: "count" as const,
      scope: "tenant_principal" as const,
      maximum: 1,
      window_seconds: 86_400,
      capability: "billing.pause_account",
    };
    const actionLimit = {
      id: "pause_action_24h",
      kind: "count" as const,
      scope: "capability" as const,
      maximum: 100,
      window_seconds: 86_400,
      capability: "billing.pause_account",
    };
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_approval_policy_draft")) return undefined;
      const call = approvalCalls++;
      if (call === 1) return { status: "clarification", question: questions[0] };
      if (call === 3) return { status: "clarification", question: questions[1] };
      return {
        status: "draft",
        class_name: "billing.policy_pause",
        mode: "policy",
        auto_approve_when: eligiblePredicate(),
        required_role: "billing_reviewer",
        required_approvals: 1,
        shared_limits: call < 4 ? [scopedLimit] : [actionLimit, scopedLimit],
      };
    });
    const answers = [
      "At most 100 total account pauses per rolling 24 hours.",
      "Use 100 total account pauses in that rolling 24-hour window.",
    ];
    const askClarification = vi.fn(async (_question: string) => answers.shift());

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Auto-approve an eligible account pause once per customer each day and at most 100 total each day.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification.mock.calls.map(([question]) => question)).toEqual(questions);
    expect(calls.filter((name) => name.endsWith("submit_approval_policy_draft"))).toHaveLength(5);
    expect(result.clarification_count).toBe(2);
    expect(result.compiled.approval_class.shared_limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "capability", maximum: 100 }),
      expect.objectContaining({ scope: "tenant_principal", maximum: 1 }),
    ]));
  });

  it("redirects database-mechanics questions to the model instead of burdening the operator", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let verificationCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_verification_boundary_draft") && verificationCalls++ === 0) {
        return {
          status: "clarification",
          question: "Which version column detects stale proposals, and which approval history table stores the rolling limit?",
        };
      }
      return undefined;
    }, requestBodies);
    const askClarification = vi.fn(async () => "The operator should never be asked this.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_verification_boundary_draft"))).toHaveLength(2);
    expect(result.clarification_count).toBe(0);
    expect(result.correction_used).toBe(true);
    expect(requestBodies[1]).toContain("Runner-resolved mechanics (not an operator answer)");
    expect(requestBodies[1]).toContain("Do not ask the operator about these mechanics again");
  });

  it("keeps reviewer and rolling-count relationship questions behind Runner", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let verificationCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_verification_boundary_draft") && verificationCalls++ === 0) {
        return {
          status: "clarification",
          question: "Which validated Verification bindings provide the rolling approval counts for this action and tenant plus principal? The supplied relationship is __invalid__.",
        };
      }
      return undefined;
    }, requestBodies);
    const askClarification = vi.fn(async () => "This is not an operator-owned business question.");

    await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Request an eligible account pause with one support_reviewer and exact rolling approval limits.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_verification_boundary_draft"))).toHaveLength(2);
    expect(requestBodies.some((body) => body.includes("Rejected mechanical clarification"))).toBe(true);
  });

  it("keeps the proposal ledger out of private source verification bindings", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let ruleCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_action_rule_draft") && ruleCalls++ === 0) {
        return {
          status: "clarification",
          question: "Where is the authoritative control-store policy/history binding for counting automatic approvals in the rolling 15-day limit?",
        };
      }
      return undefined;
    }, requestBodies);
    const askClarification = vi.fn(async () => "The operator should never be asked this.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Auto-approve one eligible account pause per customer in a rolling 15-day window.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_action_rule_draft"))).toHaveLength(2);
    expect(result.clarification_count).toBe(0);
    expect(requestBodies.some((body) => body.includes("approval-ledger storage"))).toBe(true);
  });

  it("keeps authenticated ownership in trusted scope instead of asking for another rule field", async () => {
    const calls: string[] = [];
    let verificationCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_verification_boundary_draft") && verificationCalls++ === 0) {
        return {
          status: "clarification",
          question: "May the binding expose billing.accounts.principal_id so WHEN can enforce that the authenticated principal owns the account?",
        };
      }
      return undefined;
    });
    const askClarification = vi.fn(async () => "The operator should never be asked this.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Auto-approve an eligible pause once per trusted tenant and principal each day.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_verification_boundary_draft"))).toHaveLength(2);
    expect(result.clarification_count).toBe(0);
    expect(result.correction_used).toBe(true);
  });

  it("answers approval-policy separation mechanics without interrupting the operator", async () => {
    const calls: string[] = [];
    let verificationCalls = 0;
    let ruleCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_verification_boundary_draft") && verificationCalls++ === 0) {
        return {
          status: "clarification",
          question: "The validated bindings expose only the account, and approval state/history must remain control-store policy. Should this draft omit rolling approval limits from WHEN while Runner's approval policy enforces them?",
        };
      }
      if (name.endsWith("submit_action_rule_draft") && ruleCalls++ === 0) {
        return {
          status: "clarification",
          question: "The policy requires automatic approval and rolling approval limits; should those approval decisions and limits be enforced separately in control-store policy, with this draft limited to eligible proposals?",
        };
      }
      return undefined;
    });
    const askClarification = vi.fn(async () => "The operator should never be asked this.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Auto-approve eligible account pauses under reviewed rolling limits; otherwise require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_verification_boundary_draft"))).toHaveLength(2);
    expect(calls.filter((name) => name.endsWith("submit_action_rule_draft"))).toHaveLength(2);
    expect(result.clarification_count).toBe(0);
    expect(result.correction_used).toBe(true);
  });

  it("does not ask the operator for an unshown accepted binding name", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let verificationCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_verification_boundary_draft") && verificationCalls++ === 0) {
        return {
          status: "clarification",
          question: "What is the accepted binding name for the selected charge amount used by this Action rule?",
        };
      }
      return undefined;
    }, requestBodies);
    const askClarification = vi.fn(async () => "The operator should never be asked this.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a bounded refund.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_verification_boundary_draft"))).toHaveLength(2);
    expect(result.clarification_count).toBe(0);
    expect(result.correction_used).toBe(true);
    expect(requestBodies.some((body) => body.includes("do not ask the operator to name an expression or binding"))).toBe(true);
  });

  it("adds source identity needed for deterministic derivation without asking the operator", async () => {
    const calls: string[] = [];
    let effectCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_effect_envelope_draft") && effectCalls++ === 0) {
        return {
          status: "clarification",
          question: "The accepted Verification draft does not expose account_id on the account binding, so the required deterministic account_id insert expression cannot be drafted. Please validate a Verification draft that exposes it.",
        };
      }
      return undefined;
    });
    const askClarification = vi.fn(async () => "The operator should never be asked this.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Derive an exact proposal value from the reviewed account subject and require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_effect_envelope_draft"))).toHaveLength(2);
    expect(result.clarification_count).toBe(0);
    expect(result.correction_used).toBe(true);
  });

  it.each([
    "What validated Verification binding and exact field represent the required billing reviewer?",
    "What is the fixed reviewer-role label for a warehouse manager (for example, warehouse_manager)?",
    "What fixed reviewed reviewer-role label should represent a human warehouse manager?",
    "Runner requires a fixed control-store reviewer-role label; please provide the established label.",
  ])("keeps reviewer role mechanics in Runner's control plane: %s", async (question) => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let approvalCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_approval_policy_draft") && approvalCalls++ === 0) {
        return {
          status: "clarification",
          question,
        };
      }
      return undefined;
    }, requestBodies);
    const askClarification = vi.fn(async () => "The operator should not map control-store policy to a source field.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_approval_policy_draft"))).toHaveLength(2);
    expect(result.clarification_count).toBe(0);
    expect(result.correction_used).toBe(true);
    expect(requestBodies.at(-1)).toContain("Reviewer roles are control-store labels");
  });

  it("redirects derived-expression mechanics while preserving two genuine business clarifications", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let effectCalls = 0;
    const methodQuestion = "Should the request use account credit or the original payment method?";
    const mechanicalQuestion = "What reviewed Runner-derived expression identifiers must populate amount_cents from the verified charge, and status for auto-approval versus support_reviewer approval?";
    const statusQuestion = "Which reviewed business status should a newly created refund request store?";
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_effect_envelope_draft")) return undefined;
      const call = effectCalls++;
      if (call === 0) return { status: "clarification", question: methodQuestion };
      if (call === 1) return { status: "clarification", question: mechanicalQuestion };
      if (call === 2) return { status: "clarification", question: statusQuestion };
      return undefined;
    }, requestBodies);
    const askClarification = vi.fn(async (question: string) => {
      if (question === methodQuestion) return "Use the original payment method.";
      if (question === statusQuestion) return "Store submitted.";
      throw new Error(`Unexpected operator question: ${question}`);
    });

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification.mock.calls.map(([question]) => question)).toEqual([methodQuestion, statusQuestion]);
    expect(calls.filter((name) => name.endsWith("submit_effect_envelope_draft"))).toHaveLength(4);
    expect(result.clarification_count).toBe(2);
    expect(result.correction_used).toBe(true);
    expect(requestBodies.some((body) => body.includes("deterministic source-field expression bindings"))).toBe(true);
    expect(requestBodies.some((body) => body.includes("Never use source status to represent automatic versus human approval"))).toBe(true);
    const effectBodies = requestBodies.filter((body) =>
      body.includes("runner__submit_effect_envelope_draft"));
    expect(effectBodies.at(-1)).toContain("Use the original payment method.");
    expect(effectBodies.at(-1)).toContain("Store submitted.");
    expect(effectBodies.at(-1)).toContain("oldest to newest");
  });

  it("names the final unresolved business question when the bounded dialogue is exhausted", async () => {
    const calls: string[] = [];
    let effectCalls = 0;
    const questions = [
      "Which reviewed method should the request store?",
      "Which reviewed status should the request store?",
      "Which reviewed currency should this outcome use?",
    ];
    const requestJson = phaseResponder(calls, (name) => {
      if (!name.endsWith("submit_effect_envelope_draft")) return undefined;
      return { status: "clarification", question: questions[Math.min(effectCalls++, questions.length - 1)] };
    });

    await expect(generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification: async () => "Use the reviewed business value.",
      env: { OPENAI_API_KEY: "provider-test-key" },
    })).rejects.toThrow(/Last unresolved model question: Which reviewed currency should this outcome use\?/u);
  });

  it("lets the model repair one refused required-tool payload before completing the phase", async () => {
    const calls: string[] = [];
    let approvalCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_approval_policy_draft") && approvalCalls++ === 0) {
        return {
          status: "draft",
          class_name: "billing.human_pause",
          mode: "human",
          required_role: "billing_reviewer",
          required_approvals: 1,
          shared_limits: "not-an-array",
        };
      }
      return undefined;
    });

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(calls.filter((name) => name.endsWith("submit_approval_policy_draft"))).toHaveLength(2);
    expect(result.compiled.approval_class).toMatchObject({
      mode: "human",
      shared_limits: [],
    });
  });

  it("derives internal outcome names without asking the operator", async () => {
    const calls: string[] = [];
    let ruleCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_action_rule_draft") && ruleCalls++ === 0) {
        return {
          status: "clarification",
          question: "What exact dotted outcome identifier should label this proposal-only change?",
        };
      }
      return undefined;
    });
    const askClarification = vi.fn(async () => "The operator should not name internal authority objects.");

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dependencies: { requestJson },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
      askClarification,
      env: { OPENAI_API_KEY: "provider-test-key" },
    });

    expect(askClarification).not.toHaveBeenCalled();
    expect(calls.filter((name) => name.endsWith("submit_action_rule_draft"))).toHaveLength(2);
    expect(result.correction_used).toBe(true);
  });

  it("uses a flat status envelope for OpenAI-compatible authoring while retaining Runner validation", async () => {
    const requestSchemas: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const responder = phaseResponder(calls);

    const result = await generateModelActionRuleDraft({
      session: {
        provider: "openai_compatible",
        model: "local-fixture",
        baseUrl: "http://127.0.0.1:11434/v1",
        dependencies: {
          requestJson: async (request) => {
            const body = request.body as Record<string, unknown>;
            const tools = body.tools as Array<{ function?: { parameters?: Record<string, unknown> } }>;
            requestSchemas.push(structuredClone(tools[0]?.function?.parameters ?? {}));
            return responder(request);
          },
        },
      },
      intent: "Let an eligible account request a temporary pause, but require human review.",
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      egressAcknowledged: true,
    });

    expect(result.state).toBe("ready");
    expect(requestSchemas).toHaveLength(4);
    for (const schema of requestSchemas) {
      expect(schema).not.toHaveProperty("oneOf");
      expect(schema).toMatchObject({
        type: "object",
        required: ["status"],
        properties: { status: { enum: ["draft", "clarification"] } },
      });
    }
    expect(requestSchemas.every((schema) => !JSON.stringify(schema).includes("#/$defs/"))).toBe(true);
  });
});

function phaseResponder(
  calls: string[],
  override?: (name: string) => Record<string, unknown> | undefined,
  requestBodies?: string[],
): NonNullable<AskProviderDependencies["requestJson"]> {
  return vi.fn(async (request) => {
    const body = request.body as Record<string, unknown>;
    requestBodies?.push(JSON.stringify(body));
    const choice = body.tool_choice as { name?: string; function?: { name?: string } } | undefined;
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const firstTool = tools[0] as { name?: string; function?: { name?: string } } | undefined;
    const name = choice?.name ?? choice?.function?.name ?? firstTool?.name ?? firstTool?.function?.name;
    if (!name) throw new Error("Expected a forced Action Rule authoring tool.");
    calls.push(name);
    const argumentsValue = override?.(name) ?? payloadFor(name);
    return {
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: `call_${calls.length}`,
          name,
          arguments: JSON.stringify(argumentsValue),
        }],
      },
    };
  });
}

function payloadFor(name: string): Record<string, unknown> {
  if (name.endsWith("submit_verification_boundary_draft")) {
    return {
      status: "draft",
      name: "billing.pause_account_verification",
      resources: [{
        binding: "account",
        resource: "billing.accounts",
        source: { kind: "subject_ref" },
        fields: ["status", "risk_hold"],
      }],
    };
  }
  if (name.endsWith("submit_effect_envelope_draft")) {
    return {
      status: "draft",
      name: "billing.pause_account_effect",
      operation: "update",
      target_resource: "billing.accounts",
      target_binding: "account",
      allowed_fields: [{ name: "status", values: ["paused"] }],
      set: { status: statusLiteral("paused") },
      writeback: "proposal_only",
    };
  }
  if (name.endsWith("submit_action_rule_draft")) return rulePayload(eligiblePredicate());
  if (name.endsWith("submit_approval_policy_draft")) {
    return {
      status: "draft",
      class_name: "billing.human_pause",
      mode: "human",
      required_role: "billing_reviewer",
      required_approvals: 1,
      shared_limits: [],
    };
  }
  throw new Error(`Unexpected authoring tool ${name}.`);
}

function rulePayload(require: ActionRuleBooleanExpressionV1): Record<string, unknown> {
  return {
    status: "draft",
    name: "billing.pause_account",
    outcome: "billing.pause_account",
    require,
    derive: {},
    ttl_seconds: 300,
    review: {
      when: "The account is active and has no risk hold.",
      then: "Propose setting the account status to paused.",
      refused: ["The account is already paused.", "A risk hold exists."],
      human_review: "Every eligible proposal requires one billing reviewer.",
      examples: [
        { kind: "eligible", scenario: "Active account without a hold", result: "Propose paused" },
        { kind: "ineligible", scenario: "Risk hold is present", result: "Refuse" },
      ],
    },
  };
}

function eligiblePredicate(binding = "account"): ActionRuleBooleanExpressionV1 {
  return {
    kind: "all",
    expressions: [
      {
        kind: "compare",
        operator: "eq",
        left: { kind: "field", binding, field: "status" },
        right: statusLiteral("active"),
      },
      {
        kind: "compare",
        operator: "eq",
        left: { kind: "field", binding, field: "risk_hold" },
        right: { kind: "literal", value: false, value_type: { kind: "boolean" } },
      },
    ],
  };
}

function modelDraft(): ActionRuleModelDraftV1 {
  const { status: _verificationStatus, ...verification } = payloadFor("submit_verification_boundary_draft");
  const { status: _effectStatus, ...effect } = payloadFor("submit_effect_envelope_draft");
  const { status: _approvalStatus, ...approval } = payloadFor("submit_approval_policy_draft");
  return {
    schema_version: "synapsor.action-rule-model-draft.v1",
    name: "billing.pause_account",
    outcome: "billing.pause_account",
    verification: verification as ActionRuleModelDraftV1["verification"],
    effect: effect as ActionRuleModelDraftV1["effect"],
    require: eligiblePredicate(),
    derive: {},
    approval: approval as ActionRuleModelDraftV1["approval"],
    ttl_seconds: 300,
    review: rulePayload(eligiblePredicate()).review as ActionRuleModelDraftV1["review"],
  };
}

function policyModelDraft(): ActionRuleModelDraftV1 {
  const draft = modelDraft();
  return {
    ...draft,
    approval: {
      class_name: "billing.policy_pause",
      mode: "policy",
      auto_approve_when: eligiblePredicate(),
      required_role: "support_reviewer",
      required_approvals: 1,
      shared_limits: [
        {
          id: "pause_action_24h",
          kind: "count",
          scope: "capability",
          maximum: 100,
          window_seconds: 86_400,
          capability: "billing.pause_account",
        },
        {
          id: "pause_principal_24h",
          kind: "count",
          scope: "tenant_principal",
          maximum: 1,
          window_seconds: 86_400,
          capability: "billing.pause_account",
        },
      ],
    },
  };
}

function statusLiteral(value: "active" | "paused") {
  return { kind: "literal" as const, value, value_type: structuredClone(statusType) };
}

function builtCatalog(): BuiltActionRuleAuthoringCatalogV1 {
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [{
      name: "billing.accounts",
      source: "local_postgres",
      engine: "postgres",
      schema: "billing",
      table: "accounts",
      primary_key: "account_id",
      tenant_key: "tenant_id",
      principal_scope_key: "principal_id",
      version_field: "version",
      fields: [
        { name: "account_id", type: stringId, nullable: false },
        { name: "tenant_id", type: stringId, nullable: false },
        { name: "principal_id", type: stringId, nullable: false },
        { name: "status", type: statusType, nullable: false },
        { name: "risk_hold", type: { kind: "boolean" }, nullable: false },
        { name: "version", type: { kind: "integer" }, nullable: false },
      ],
    }],
    relationships: [],
  };
  return {
    catalog,
    authoring: {
      schema_version: "synapsor.action-rule-authoring-catalog.v1",
      source: "local_postgres",
      engine: "postgres",
      read_boundary_name: "billing_read",
      generation_lock_fingerprint: lock,
      resources: [{
        name: "billing.accounts",
        primary_key: "account_id",
        tenant_scope: "direct",
        tenant_key: "tenant_id",
        principal_scope: "direct",
        principal_key: "principal_id",
        version_candidates: ["version"],
        selected_version_field: "version",
        operations: { update: true, insert: false },
        fields: catalog.resources[0]!.fields.map((field) => ({
          ...field,
          role: ["account_id", "tenant_id", "principal_id", "version"].includes(field.name)
            ? "guard" as const
            : field.name === "risk_hold"
              ? "runner_verification_only" as const
              : "model_visible" as const,
          writable: field.name === "status" || field.name === "risk_hold",
          ...(field.type.kind === "string" && field.type.enum ? { enum_source: "schema" as const } : {}),
        })),
      }],
      relationships: [],
      supported_language: {
        comparisons: ["eq", "neq", "lt", "lte", "gt", "gte"],
        predicates: ["all", "any", "not", "null_check", "in", "exists"],
        aggregates: ["count", "sum", "min", "max"],
        arithmetic: ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration", "date_of"],
        effects: ["single_row_update", "single_row_insert"],
      },
      diagnostics: [],
      digest: `sha256:${"c".repeat(64)}`,
    },
  };
}

function boundary(): ExplorationBoundaryDraft {
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "production",
    source: "local_postgres",
    compiler_version: "test",
    spec_version: "test",
    trusted_context: { provider: "environment", tenant_env: "TENANT", principal_env: "PRINCIPAL" },
    generation_lock_fingerprint: lock,
    role_posture_fingerprint: `sha256:${"d".repeat(64)}`,
    pack: {
      name: "billing_read",
      resources: [{
        id: "billing.accounts",
        schema: "billing",
        table: "accounts",
        primary_key: "account_id",
        tenant_key: "tenant_id",
        principal_key: "principal_id",
        field_types: {},
        field_enums: {},
        selectable_fields: ["status"],
        filterable_fields: {},
        sortable_fields: [],
        groupable_fields: [],
        aggregate_measures: [],
        count_distinct_fields: [],
        time_bucket_fields: {},
        kept_out_fields: ["risk_hold"],
        relationships: [],
        minimum_cohort_size: 5,
        suppression_aware_totals: true,
      }],
    },
    budgets: {
      max_rows: 50,
      max_groups: 50,
      max_top_n: 25,
      max_measures: 3,
      max_dimensions: 3,
      max_time_ranges: 2,
      max_relationship_hops: 2,
      max_response_cells: 500,
      max_response_bytes: 65_536,
      statement_timeout_ms: 3_000,
      max_complexity: 24,
      max_queries_per_session: 1_000,
      max_extracted_cells_per_session: 4_000,
      max_differencing_queries: 16,
      rate_limit_per_minute: 120,
    },
    unresolved_decisions: [],
  };
}

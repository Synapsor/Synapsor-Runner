import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import type {
  ActionRuleBooleanExpressionV1,
  ActionRuleScalarTypeSpecV1,
} from "@synapsor/spec";
import { describe, expect, it, vi } from "vitest";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";
import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { generateModelActionRuleDraft } from "./action-rule-model.js";
import type { AskProviderDependencies } from "./model-ask.js";

const lock = `sha256:${"a".repeat(64)}` as const;
const readDigest = `sha256:${"b".repeat(64)}` as const;
const stringId = { kind: "string", max_length: 64, comparison: "exact" } as const;
const statusType: ActionRuleScalarTypeSpecV1 = {
  kind: "string",
  max_length: 8,
  comparison: "exact",
  enum: ["active", "paused"],
};

describe("model-guided Action Rule authoring", () => {
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
    expect(requestBodies[1]).toContain("Never put numeric bounds on strings or values on money fields");
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
      phase: "verification",
      resourceIds: ["billing.accounts"],
    });
    expect(prepareResources).toHaveBeenNthCalledWith(2, {
      phase: "effect",
      resourceIds: ["billing.accounts"],
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

  it("keeps reviewer roles and approval sources in Runner's control plane", async () => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let approvalCalls = 0;
    const requestJson = phaseResponder(calls, (name) => {
      if (name.endsWith("submit_approval_policy_draft") && approvalCalls++ === 0) {
        return {
          status: "clarification",
          question: "What validated Verification binding and exact field represent the required billing reviewer?",
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
        aggregates: [],
        arithmetic: ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration"],
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

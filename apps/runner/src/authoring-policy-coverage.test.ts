import {derivedScopedResponse} from "./test-fixtures/coverage-derived.js";
import { reviewUnestablishedCounting } from "./authoring-counting-decision-review.js";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createTerminalAnalyticsShellIo } from "./analytics-shell.js";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { newPolicySourceSession, policyTextSnapshot, authoringDestination, type PolicyPassage } from "./authoring-policy-source.js";
import { parsePolicyCoverage, policyCoverageSummary, reviewPolicyCoverage, isMechanicalApprovalCounterPassage, isReadOnlyPolicyPassage, referencesReadPolicy, actionablePolicyRequirements, prioritizePolicyRepairs } from "./authoring-policy-coverage.js";
import { policyReadinessItems, policyReviewReadiness } from "./authoring-review-readiness.js";
import { AskError, type AskProviderDependencies } from "./model-ask.js";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { policyCoverageDraft, policyCoverageActionTargets } from "./authoring-policy-evidence.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { mcpClientPickerTransition } from "./post-activation-ask.js";
import { parseManagedMcpProjectClient } from "./managed-mcp-project.js";
import type { CompiledActionRuleModelDraftV1 } from "./action-rule-draft.js";

const clientPointer = "/runner_evidence/runtime_contract/deployment_prerequisites/runner_client_connection";
const clientEvidence = () => ({ actions: [], runner_evidence: { runtime_contract: { deployment_prerequisites: {
  runner_client_connection: { supported: true, stage: "after_authority_review", configuration_checked: false, verified: false },
} } } });
const clientSource = policyTextSnapshot(Buffer.from(`${"\n".repeat(10)}Connect my Claude Code client when ready.`), "service-rules.txt");
// Exact client-connection passage from the owned service acceptance report.
const savedClientPassage: PolicyPassage = {
  start: 11, end: 11, disposition: "needs_decision",
  interpretation: "service-rules.txt v1 line 11 asks to connect a Claude Code client. The reviewed Boundary establishes the service behavior but does not establish a configured client connection.",
  draft_paths: ["/runner_evidence/runtime_contract/deployment_prerequisites"],
  topic: "Claude Code client connection", responsibility: "deployment", issue_kind: "missing_configuration",
  next_step: "After authority review, choose and configure the Claude Code client connection.",
};

describe("private Action field policy evidence", () => {
  const resource = "quality.lab_samples", outcome = "quality.release";
  const privatePath = `/runner_evidence/actions/${outcome}/scoped_bindings/samples/fields/sample_number`;
  const absentReadPath = `/runner_evidence/read_access/${resource}/fields/sample_number`;
  const source = policyTextSnapshot(Buffer.from("Keep sample identifiers and sample numbers private, including analysis."), "quality-rules.txt");
  const passage = { start: 1, end: 1, disposition: "implemented", responsibility: "runner",
    interpretation: "Sample fields remain private verification evidence, not public values or analysis.",
    draft_paths: [`/runner_evidence/actions/${outcome}/scoped_bindings/samples`],
    field_checks: ["sample_id", "sample_number"].map(field => ({ resource, field, expectation: "private" })),
  };
  function fixture() {
    const read: ExplorationBoundaryDraft = {
      schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "staging",
      source: "local_postgres", compiler_version: "1.8.0", spec_version: "1.11.0", reporting_timezone: "UTC",
      trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
      generation_lock_fingerprint: `sha256:${"a".repeat(64)}`, role_posture_fingerprint: `sha256:${"b".repeat(64)}`,
      budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [], pack: { name: "quality_read", resources: [] },
    };
    // Only the typed compiled fields consumed by evidence generation are needed;
    // this unit fixture does not claim authoring/compiler or runtime qualification.
    const action = {
      draft: { outcome, approval: { shared_limits: [] } }, rule: { outcome },
      loaded: { authority: { action_boundary: { name: "quality_actions" } } },
      verification_boundary: { resources: [{ binding: "samples", resource, primary_key: "sample_id",
        scope: { mode: "columns", tenant_field: "factory", principal_field: "coordinator" },
        source: { kind: "relationship", from_binding: "lot", relationship: "samples_lot_fk", direction: "inverse" },
        cardinality: "many", collection_consistency: "complete_locked", max_rows: 16,
        deterministic_order: [{ field: "sample_number", direction: "asc" }, { field: "sample_id", direction: "asc" }],
        fields: [{ name: "sample_id", type: { kind: "string", comparison: "exact", max_length: 36 }, nullable: false, model_visible: false },
          { name: "sample_number", type: { kind: "integer" }, nullable: false, model_visible: false }],
      }] },
      effect_envelope: { target_resource: "quality.lots", operation: "update", allowed_fields: [], writeback: { mode: "direct_sql" } },
    } as unknown as CompiledActionRuleModelDraftV1;
    return { read, actions: [action], decisions: [] };
  }
  function addRead(input: ReturnType<typeof fixture>) {
    const raw: ExplorationBoundaryDraft["pack"]["resources"][number] = {
      id: resource, schema: "quality", table: "lab_samples", primary_key: "sample_id",
      tenant_key: "factory", principal_key: "coordinator", field_types: { sample_id: "uuid", sample_number: "integer" },
      field_enums: {}, selectable_fields: [], filterable_fields: {}, sortable_fields: [], groupable_fields: [],
      aggregate_measures: [], aggregate_measure_functions: {}, count_distinct_fields: [], time_bucket_fields: {},
      kept_out_fields: [], relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true,
    };
    input.read.pack.resources.push(raw);
    return raw;
  }

  it.each(["development", "staging", "production"] as const)("states actual profile semantics without attesting to source data or production authentication (%s)", profile => {
    const input = fixture();
    input.read.deployment_profile = profile;
    if (profile === "production") input.read.trusted_context = { provider: "http_claims", tenant_claim: "organization", principal_claim: "subject" };
    const before = structuredClone(input), draft = policyCoverageDraft(input);
    const pointer = "/runner_evidence/runtime_contract/deployment_profile";
    expect(draft.runner_evidence.runtime_contract.deployment_profile).toMatchObject({ configured_profile: profile,
      identity_provider: profile === "production" ? "http_claims" : "environment", local_identity_mode: profile !== "production",
      production_authentication_verified: false });
    const source = policyTextSnapshot(Buffer.from("Review the configured identity mode; production integration remains unverified."), "Deployment.txt");
    const passage = { start: 1, end: 1, disposition: "implemented", interpretation: "The configured mode is described, not proof of live deployment.",
      draft_paths: [pointer], evidence_checks: [{ path: `${pointer}/configured_profile`, equals: profile },
        { path: `${pointer}/production_authentication_verified`, equals: false }] };
    expect(parsePolicyCoverage({ passages: [passage] }, source, draft, []).passages).toHaveLength(1);
    expect(() => parsePolicyCoverage({ passages: [{ ...passage, evidence_checks: [
      { path: `${pointer}/production_authentication_verified`, equals: true }] }] }, source, draft, [])).toThrow("Mechanical evidence mismatch");
    expect(draft.runner_evidence.runtime_contract.deployment_profile.meaning).toContain("explicit requirement for a specific profile");
    expect(input).toEqual(before);
  });

  it("supplies current local policy metadata without treating resume as completed authority", () => {
    const input = fixture(), policySources = newPolicySourceSession();
    const source = policyTextSnapshot(Buffer.from("Preserve these rules and accepted meanings on resume unless explicitly edited."), "Workflow.txt");
    policySources.snapshots = [source]; policySources.active = source.version;
    policySources.operator_messages = ["Keep the unanswered action pending; this is not a waiver."];
    const before = structuredClone({ input, policySources });
    const draft = policyCoverageDraft({ ...input, policySources });
    const pointer = "/runner_evidence/runtime_contract/authoring_lifecycle";
    const evidence = draft.runner_evidence.runtime_contract.authoring_lifecycle;
    expect(evidence).toMatchObject({ current_policy_snapshot: { digest: source.digest, version: source.version, bytes: source.bytes, lines: source.lines },
      retained_business_answers: 1, retained_read_interpretations: 0, automatic_activation: false, external_client_behavior_verified: false });
    expect(JSON.stringify(evidence)).not.toContain(policySources.operator_messages[0]);
    expect(evidence.resume).toContain("unanswered decisions remain pending");
    expect(parsePolicyCoverage({ passages: [{ start: 1, end: 1, disposition: "implemented",
      interpretation: "The saved snapshot uses Runner's reviewed authoring lifecycle, not automatic authority.", draft_paths: [pointer],
      evidence_checks: [{ path: `${pointer}/current_policy_snapshot/digest`, equals: source.digest }] }] }, source, draft, []).passages).toHaveLength(1);
    for (const name of ["automatic_activation", "external_client_behavior_verified"]) {
      expect(() => parsePolicyCoverage({ passages: [{ start: 1, end: 1, disposition: "implemented", interpretation: "Unproved claim.",
        draft_paths: [pointer], evidence_checks: [{ path: `${pointer}/${name}`, equals: true }] }] }, source, draft, [])).toThrow("Mechanical evidence mismatch");
    }
    expect(policyCoverageDraft(input).runner_evidence.runtime_contract.authoring_lifecycle.current_policy_snapshot).toBeNull();
    expect({ input, policySources }).toEqual(before);
  });

  it("derives private verification-only selection and analysis without adding public Read fields", () => {
    const input = fixture(), before = structuredClone(input);
    const draft = policyCoverageDraft(input);
    expect(draft.runner_evidence.read_access).not.toHaveProperty(resource);
    expect(draft.runner_evidence.actions[outcome]!.scoped_bindings.samples!.fields.sample_number).toMatchObject({
      name: "sample_number", type: { kind: "integer" }, model_visible: false, read_access_present: false,
      actual_values_returned: false, model_analysis: [], private_read_selection: false, private_action_verification: true,
    });
    expect(parsePolicyCoverage({ passages: [passage] }, source, draft, []).passages[0]!.disposition).toBe("implemented");
    expect(input).toEqual(before);
  });

  it.each(["return", "filter", "sort", "group", "measure", "count_distinct"])("does not hide actual Read %s access behind a private Action flag", (mode) => {
    const input = fixture(), raw = addRead(input);
    if (mode === "return") raw.selectable_fields = ["sample_number"];
    if (mode === "filter") raw.filterable_fields = { sample_number: ["eq"] };
    if (mode === "sort") raw.sortable_fields = ["sample_number"];
    if (mode === "group") raw.groupable_fields = ["sample_number"];
    if (mode === "measure") { raw.aggregate_measures = ["sample_number"]; raw.aggregate_measure_functions = { sample_number: ["sum"] }; }
    if (mode === "count_distinct") raw.count_distinct_fields = ["sample_number"];
    const draft = policyCoverageDraft(input);
    const actual = draft.runner_evidence.actions[outcome]!.scoped_bindings.samples!.fields.sample_number!;
    expect(actual.model_visible).toBe(false);
    expect(actual).toMatchObject({ read_access_present: true, actual_values_returned: mode === "return" });
    expect(() => parsePolicyCoverage({ passages: [passage] }, source, draft, [])).toThrow(`Field coverage mismatch: ${resource}.sample_number`);
    expect(parsePolicyCoverage({ passages: [{ ...passage, disposition: "conflict" }] }, source, draft, []).passages[0]!.disposition).toBe("conflict");
    if (mode === "return") expect(parsePolicyCoverage({ passages: [{ ...passage,
      field_checks: [{ resource, field: "sample_number", expectation: "business_visible" }],
    }] }, source, draft, []).passages[0]!.disposition).toBe("implemented");
    else expect(actual.model_analysis.length).toBeGreaterThan(0);
  });

  it("keeps private Read selection distinct from both raw return and model analysis", () => {
    const input = fixture(), raw = addRead(input);
    raw.selectable_fields = ["sample_id"]; raw.model_withheld_fields = ["sample_id"];
    const draft = policyCoverageDraft(input);
    expect(draft.runner_evidence.actions[outcome]!.scoped_bindings.samples!.fields.sample_id).toMatchObject({
      read_access_present: true, actual_values_returned: false, private_read_selection: true, model_analysis: [],
    });
    expect(() => parsePolicyCoverage({ passages: [passage] }, source, draft, [])).not.toThrow();
  });

  it("checks every Action use even when a public Read entry reports the field private", () => {
    const input = fixture(); addRead(input);
    const second = structuredClone(input.actions[0]!);
    second.rule.outcome = "quality.audit"; second.draft.outcome = second.rule.outcome;
    second.verification_boundary.resources[0]!.fields[1]!.model_visible = true;
    input.actions.push(second);
    const draft = policyCoverageDraft(input);
    expect(draft.runner_evidence.actions[outcome]!.scoped_bindings.samples!.fields.sample_number!.actual_values_returned).toBe(false);
    expect(draft.runner_evidence.actions[second.rule.outcome]!.scoped_bindings.samples!.fields.sample_number!.actual_values_returned).toBe(true);
    expect(() => parsePolicyCoverage({ passages: [passage] }, source, draft, [])).toThrow(`Field coverage mismatch: ${resource}.sample_number`);
  });

  it("requires actual visible-value evidence for business-visible private-only fields", () => {
    const input = fixture();
    const visible = { ...passage, field_checks: [{ resource, field: "sample_number", expectation: "business_visible" }] };
    expect(() => parsePolicyCoverage({ passages: [visible] }, source, policyCoverageDraft(input), [])).toThrow("Field coverage mismatch");
    input.actions[0]!.verification_boundary.resources[0]!.fields[1]!.model_visible = true;
    expect(() => parsePolicyCoverage({ passages: [visible] }, source, policyCoverageDraft(input), [])).not.toThrow();
  });

  it("normalizes optional verification visibility without claiming a new public permission", () => {
    const input = fixture();
    delete input.actions[0]!.verification_boundary.resources[0]!.fields[1]!.model_visible;
    const draft = policyCoverageDraft(input);
    expect(draft.runner_evidence.actions[outcome]!.scoped_bindings.samples!.fields.sample_number!.model_visible).toBe(false);
    expect(() => canonicalJsonDigest(draft)).not.toThrow();
    expect(() => parsePolicyCoverage({ passages: [passage] }, source, draft, [])).not.toThrow();
  });

  it("uses exact escaped resource, outcome, binding and field identities without fuzzy aliases", () => {
    const input = fixture(), action = input.actions[0]!, binding = action.verification_boundary.resources[0]!;
    action.rule.outcome = "quality/release~batch"; action.draft.outcome = action.rule.outcome;
    binding.resource = "quality/lab~samples"; binding.binding = "checks/ordered~";
    binding.fields[1]!.name = "sample/number~";
    const exact = "/runner_evidence/actions/quality~1release~0batch/scoped_bindings/checks~1ordered~0/fields/sample~1number~0";
    const draft = policyCoverageDraft(input);
    const claim = { ...passage, draft_paths: [exact],
      evidence_checks: [{ path: `${exact}/actual_values_returned`, equals: false }],
      field_checks: [{ resource: binding.resource, field: binding.fields[1]!.name, expectation: "private" }],
    };
    expect(parsePolicyCoverage({ passages: [claim] }, source, draft, []).passages[0]!.draft_paths).toEqual([exact]);
    expect(() => parsePolicyCoverage({ passages: [{ ...claim, draft_paths: [privatePath] }] }, source, draft, [])).toThrow("Draft pointer");
    expect(() => parsePolicyCoverage({ passages: [{ ...claim,
      field_checks: [{ resource: binding.resource, field: "sample_number", expectation: "private" }],
    }] }, source, draft, [])).toThrow("Field privacy evidence is not present");
  });

  it("refuses invented Read paths, unknown fields and incomplete private evidence instead of guessing", () => {
    const draft = policyCoverageDraft(fixture());
    expect(() => parsePolicyCoverage({ passages: [{ ...passage, draft_paths: [absentReadPath] }] }, source, draft, [])).toThrow("Draft pointer");
    expect(() => parsePolicyCoverage({ passages: [{ ...passage,
      field_checks: [{ resource, field: "invented_sample", expectation: "private" }],
    }] }, source, draft, [])).toThrow("Field privacy evidence is not present");
    Reflect.deleteProperty(draft.runner_evidence.actions[outcome]!.scoped_bindings.samples!.fields.sample_number!, "model_analysis");
    expect(() => parsePolicyCoverage({ passages: [passage] }, source, draft, [])).toThrow("Incomplete field privacy evidence");
  });

  it.each(["return", "analysis", "action"])("rejects stale private coverage after %s exposure changes", (mode) => {
    const input = fixture(), previous = policyCoverageDraft(input);
    const report = parsePolicyCoverage({ passages: [passage] }, source, previous, []);
    if (mode === "action") input.actions[0]!.verification_boundary.resources[0]!.fields[1]!.model_visible = true;
    else {
      const raw = addRead(input);
      if (mode === "return") raw.selectable_fields = ["sample_number"];
      else raw.filterable_fields = { sample_number: ["eq"] };
    }
    const current = policyCoverageDraft(input), before = structuredClone(current);
    expect(canonicalJsonDigest(current)).not.toBe(report.draft_digest);
    expect(() => policyCoverageActionTargets({ report, draft: current, passages: report.passages, editableOutcomes: [outcome] }))
      .toThrow("POLICY_COVERAGE_DRAFT_CHANGED");
    expect(() => parsePolicyCoverage({ passages: report.passages }, source, current, [])).toThrow("Field coverage mismatch");
    expect(current).toEqual(before);
    if (mode !== "action") {
      current.runner_evidence.actions[outcome]!.scoped_bindings.samples!.fields.sample_number =
        structuredClone(previous.runner_evidence.actions[outcome]!.scoped_bindings.samples!.fields.sample_number!);
      // Even stale private Action evidence cannot conceal independently exposed Read access.
      expect(() => parsePolicyCoverage({ passages: report.passages }, source, current, [])).toThrow("Field coverage mismatch");
    }
  });

  it.each([
    absentReadPath,
    `/read_access/${resource}/fields/sample_number`,
    privatePath.replace("quality.release", "quality.other_release"),
    privatePath.replace("/samples/", "/other_samples/"),
    privatePath.replace("/sample_number", "/sample_Number"),
    `${privatePath}/model_analysis/0`,
  ])("does not redirect nonexistent pointer %s to similar private evidence", (pointer) => {
    const draft = policyCoverageDraft(fixture()), before = structuredClone(draft);
    expect(() => parsePolicyCoverage({ passages: [{ ...passage, draft_paths: [pointer] }] }, source, draft, [])).toThrow("Draft pointer");
    expect(draft).toEqual(before);
  });

  it("rejects a removed private field through both its old pointer and an unchanged parent reference", () => {
    const input = fixture();
    input.actions[0]!.verification_boundary.resources[0]!.fields = input.actions[0]!.verification_boundary.resources[0]!.fields
      .filter(field => field.name !== "sample_number");
    const draft = policyCoverageDraft(input);
    expect(() => parsePolicyCoverage({ passages: [{ ...passage, draft_paths: [privatePath] }] }, source, draft, [])).toThrow("Draft pointer");
    expect(() => parsePolicyCoverage({ passages: [passage] }, source, draft, [])).toThrow("Field privacy evidence is not present");
  });

  it("does not accept inherited field evidence or model-supplied privacy overrides", () => {
    const draft = policyCoverageDraft(fixture()), fields = draft.runner_evidence.actions[outcome]!.scoped_bindings.samples!.fields;
    Object.setPrototypeOf(fields, { invented_sample: fields.sample_number });
    const forged = { ...passage, field_checks: [{ resource, field: "invented_sample", expectation: "private" }] };
    expect(() => parsePolicyCoverage({ passages: [{ ...forged, draft_paths: [privatePath.replace("sample_number", "invented_sample")] }] }, source, draft, []))
      .toThrow("Draft pointer");
    expect(() => parsePolicyCoverage({ passages: [forged] }, source, draft, [])).toThrow("Field privacy evidence is not present");
    expect(() => parsePolicyCoverage({ passages: [passage], runner_evidence: {} }, source, draft, [])).toThrow("unexpected top-level keys");
    expect(() => parsePolicyCoverage({ passages: [{ ...passage, field_checks: [{ resource, field: "sample_number", expectation: "private",
      actual_values_returned: false, model_analysis: [],
    }] }] }, source, draft, [])).toThrow("Field checks require a reviewed resource");
  });

  it.each(["corrected", "still invalid"])("lists exact private references in bounded coverage correction (%s)", async (resultKind) => {
    const input = fixture(), draft = policyCoverageDraft(input), before = structuredClone(draft);
    const conversation = createModelAuthoringConversation(); conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [source]; conversation.policySources.active = source.version;
    conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
    const requests: string[] = [];
    const rejected = { ...passage, draft_paths: [absentReadPath] };
    const run = reviewPolicyCoverage({ source, draft, env: { OPENAI_API_KEY: "test-key" },
      session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson: async request => {
        requests.push(JSON.stringify(request.body));
        const derived: any = derivedScopedResponse(request.body,{ passages: [requests.length > 1
          ? { ...passage, draft_paths: [privatePath] } : rejected] });
        // Submit the invalid pointer through the real host parser, rather than
        // letting the DERIVED fixture adapter refuse before serialization.
        if (requests.length > 1 && resultKind === "still invalid")
          derived.groups[0].replacements[0].passage.draft_paths = [absentReadPath];
        return { status: 200, body: { output: [{ type: "function_call", call_id: `private_${requests.length}`,
          name: "runner__review_policy_coverage", arguments: JSON.stringify(derived) }] } };
      } } },
    });
    if (resultKind === "corrected") expect((await run).passages[0]!.disposition).toBe("implemented");
    else await expect(run).rejects.toThrow("COVERAGE_SCOPED_CORRECTION_REFUSED");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain(privatePath);
    expect(requests[0]).toContain("verification-only fields");
    expect(requests[1]).not.toContain("Previous untrusted coverage submission");
    expect(draft).toEqual(before);
  });
});

describe("execution setup is not a business-rule revision", () => {
  const pointer = "/runner_evidence/runtime_contract/deployment_prerequisites/runner_execution_setup";
  const source = policyTextSnapshot(Buffer.from("Keep a separate reader. Review a dedicated writer before enabling automatic completion."), "rules.txt");
  const previous: PolicyPassage = { start: 1, end: 1, disposition: "needs_decision",
    responsibility: "deployment", issue_kind: "missing_configuration", topic: "Separate reader and dedicated writer",
    interpretation: "Execution is prepared, but dedicated writer authorization and reader separation are not verified.",
    draft_paths: ["/read", "/runner_evidence/actions/work.finish/execution"],
    next_step: "Review the dedicated writer and keep the reader separate before enabling execution." };
  const evidence = () => ({ read: {}, runner_evidence: { actions: { "work.finish": { execution: { configured_mode: "direct_sql" } } },
    runtime_contract: { deployment_prerequisites: { runner_execution_setup: {
      supported: true, stage: "after_authority_review", configuration_checked: false, verified: false,
    } } } } });
  const deferred = { ...previous, deployment_prerequisite: "runner_execution_setup", draft_paths: [pointer] };

  it("corrects the preserved writer/Read classification without asking for a business edit", async () => {
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [source]; conversation.policySources.active = 1;
    conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
    const draft = evidence(), before = structuredClone(draft), requests: string[] = [];
    const result = await reviewPolicyCoverage({ source, draft,
      previousReport: { source_digest: source.digest, draft_digest: canonicalJsonDigest(draft), passages: [previous] },
      session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson: async (request) => {
        requests.push(JSON.stringify(request.body));
        return { status: 200, body: { output: [{ type: "function_call", call_id: `coverage_${requests.length}`,
          name: "runner__review_policy_coverage", arguments: JSON.stringify(derivedScopedResponse(request.body,{ passages: [requests.length === 1 ? previous : deferred] })) }] } };
      } } }, env: { OPENAI_API_KEY: "test-key" },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("COVERAGE_DEPLOYMENT_COMPONENT_MIXED");
    expect(requests[1]).toContain("runner_execution_setup");
    expect(requests[0]).not.toContain("Previous untrusted coverage submission");
    expect(requests[1]).not.toContain("Previous untrusted coverage submission");
    expect(requests[1]).toContain("Split receipt-mode/setup, Read/privacy and business claims");
    expect(policyReviewReadiness(source, result).ready).toBe(false); // Incomplete Action metadata still needs a current client contract.
    expect(policyReadinessItems(result)).toMatchObject([{ kind: "business_decision", blocksReview: true }, { kind: "deployment_prerequisite", blocksReview: false }]);
    expect(policyReviewReadiness(source, result).summary.join("\n")).toContain("writer review");
    expect(policyReadinessItems(result).find(i => i.kind === "deployment_prerequisite")!.nextStep).toContain("After authority review");
    expect(result.passages[0]!.disposition).toBe("needs_decision");
    expect(draft).toEqual(before);
  });

  it("does not waive unsupported execution, business decisions, privacy or counters", () => {
    expect(() => parsePolicyCoverage({ passages: [deferred] }, source, evidence(), "")).not.toThrow();
    for (const change of [{ supported: false }, { stage: "unknown" }, { verified: true }, { configuration_checked: true }]) {
      const draft = evidence(); Object.assign(draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup, change);
      expect(() => parsePolicyCoverage({ passages: [deferred] }, source, draft, "Trust me")).toThrow();
    }
    for (const change of [
      { disposition: "implemented" }, { disposition: "unsupported" }, { responsibility: "operator" }, { issue_kind: "business_choice" },
      { draft_paths: [pointer, "/read"] }, { application_obligations: ["status_presentation"] },
      { field_checks: [{ resource: "work.records", field: "internal", expectation: "private" }] },
      { counter_requirements: [{ path: pointer, current_capability: null, required_capability: null }] },
    ]) expect(() => parsePolicyCoverage({ passages: [{ ...deferred, ...change }] }, source, evidence(), "")).toThrow();
    expect(() => parsePolicyCoverage({ passages: [deferred] }, source, {}, "")).toThrow();
    const report = parsePolicyCoverage({ passages: [{ ...previous, disposition: "unsupported" }] }, source, evidence(), "");
    expect(policyReviewReadiness(source, report).ready).toBe(false);
  });
});

describe("policy clarification evidence", () => {
  const source = policyTextSnapshot(Buffer.from("Allow at most ten automatic changes per day."), "rules.txt");
  const passage = { start: 1, end: 1, disposition: "overridden", interpretation: "The operator tightened the daily maximum.", draft_paths: [] };
  const messages = ["Keep the same job.", "Use three automatic changes per day instead of ten."];

  it("resolves a bounded operator message reference to its exact quote without changing the draft", () => {
    const draft = { maximum: 3 }, before = structuredClone({ draft, messages });
    const report = parsePolicyCoverage({ passages: [{ ...passage, operator_message_id: 2 }] }, source, draft, messages);
    expect(report.passages[0]).toMatchObject({ disposition: "overridden", operator_override: messages[1] });
    expect(report.passages[0]).not.toHaveProperty("operator_message_id");
    expect({ draft, messages }).toEqual(before);
  });

  it("rejects fabricated, conflicting and cross-message override evidence", () => {
    for (const change of [
      { operator_message_id: 0 }, { operator_message_id: 3 }, { operator_message_id: 1.5 },
      { operator_message_id: "2" }, { operator_message_id: 2, operator_override: "No daily limit." },
      { operator_override: "Same job; three per day." }, { operator_override: messages.join("\n") },
    ]) expect(() => parsePolicyCoverage({ passages: [{ ...passage, ...change }] }, source, {}, messages)).toThrow("operator message");
    expect(() => parsePolicyCoverage({ passages: [{ ...passage, operator_message_id: 1 }] }, source, {}, "Not an indexed message")).toThrow("operator message");
  });

  it("accepts genuine clarification evidence on implemented coverage without treating it as an override", () => {
    const draft = { requirement: true };
    const evidence = { ...passage, disposition: "implemented", draft_paths: ["/requirement"],
      operator_message_id: 2, operator_override: messages[1] };
    const parsed = parsePolicyCoverage({ passages: [evidence] }, source, draft, messages).passages[0]!;
    expect(parsed.disposition).toBe("implemented");
    expect(parsed).not.toHaveProperty("operator_override");
    expect(parsed).not.toHaveProperty("operator_message_id");
    expect(() => parsePolicyCoverage({ passages: [{ ...evidence, draft_paths: [] }] }, source, draft, messages))
      .toThrow("Implemented passages must reference exact draft decisions");
    expect(() => parsePolicyCoverage({ passages: [{ ...evidence, operator_override: "invented" }] }, source, draft, messages))
      .toThrow("operator_override disagrees with the indexed message");
  });

  it("stops an unsupported purported override without asking another opinion", async () => {
    const pending = policyTextSnapshot(Buffer.from("Automatically release an advising hold after a verified recent staff meeting."), "student.txt");
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [pending]; conversation.policySources.active = pending.version;
    conversation.policySources.operator_messages = ["Leave advising-hold release pending unsupported. Continue only with review of the two prepared actions; do not claim the policy is fully implemented."];
    conversation.policySources.approvals = [{ digest: pending.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
    const requests: string[] = [];
    const result = reviewPolicyCoverage({ source: pending, draft: {},
      session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson: async (request) => {
        requests.push(JSON.stringify(request.body));
        return { status: 200, body: { output: [{ type: "function_call", call_id: `coverage_${requests.length}`,
          name: "runner__review_policy_coverage", arguments: JSON.stringify(derivedScopedResponse(request.body,{ passages: [{
            start: 1, end: 1, draft_paths: [], interpretation: "The advising action has not been implemented.",
            ...(requests.length === 1 ? { disposition: "overridden", operator_override: "Skip the third action." }
              : { disposition: "unsupported", responsibility: "operator", issue_kind: "unsupported_requirement", next_step: "Resolve the missing automatic-approval limits." }),
          }] })) }] } };
      } } }, env: { OPENAI_API_KEY: "test-key" },
    });
    await expect(result).rejects.toThrow("COVERAGE_OVERRIDE_UNESTABLISHED");
    expect(requests).toHaveLength(1);
    expect(conversation.policySources.coverage).toBeUndefined();
  });
});

describe("application obligation correction diagnostics", () => {
  const source = policyTextSnapshot(Buffer.from([
    "Only currently admitted students may read their own registration information.",
    "A student is told their enrolment is complete only after the university's record has actually been changed.",
    "Release an advising hold automatically after a verified meeting less than 90 days old.",
  ].join("\n")), "student-rules.txt");
  const applicationPath = "/runner_evidence/runtime_contract/application_obligations/status_presentation";
  const draft = { read: { current_admission_required: true }, runner_evidence: { runtime_contract: {
    receipts: "completed requires an applied source change",
    application_obligations: { status_presentation: "Present returned status accurately; client behavior is unverified." },
  } } };
  const completion = { start: 2, end: 2, disposition: "needs_decision", responsibility: "application",
    interpretation: "The client must present completed only for an applied receipt.", draft_paths: [applicationPath],
    application_obligations: ["status_presentation"] };
  const passages = (entry: Record<string, unknown>) => [
    { start: 1, end: 1, disposition: "implemented", responsibility: "runner",
      interpretation: "The disabled Read checks current admission.", draft_paths: ["/read"] },
    entry,
    { start: 3, end: 3, disposition: "unsupported", responsibility: "operator", draft_paths: [],
      interpretation: "Advising release remains unsupported; no automatic limits were authorized." },
  ];

  it.each([
    ["implemented disposition", { disposition: "implemented" }, "disposition"],
    ["wrong responsibility", { responsibility: "runner" }, "responsibility"],
    ["empty obligations", { application_obligations: [] }, "application_obligations"],
    ["null obligations", { application_obligations: null }, "application_obligations"],
    ["unknown obligation", { application_obligations: ["authentication"] }, "application_obligations"],
    ["duplicate obligations", { application_obligations: ["status_presentation", "status_presentation"] }, "application_obligations"],
    ["missing exact reference", { draft_paths: ["/runner_evidence/runtime_contract/receipts"] }, "missing exact contract"],
    ["mixed privacy check", { field_checks: [{ resource: "university.student_records", field: "internal_note", expectation: "private" }] }, "field_checks"],
  ] as const)("identifies the exact rejected passage and reason (%s)", (_label, change, reason) => {
    const args = { passages: passages({ ...completion, ...change }) };
    const before = structuredClone({ args, draft, source });
    let message = "";
    try { parsePolicyCoverage(args, source, draft, []); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Source lines 2-2");
    expect(message).toContain("passages[1]");
    expect(message).toContain(source.text.split("\n")[1]);
    expect(message).toContain(reason);
    expect(message).toContain(applicationPath);
    expect(message).toContain("Return the complete corrected coverage");
    expect(message).toContain("do not change the draft");
    expect({ args, draft, source }).toEqual(before);
  });

  it("accepts genuinely split clauses on the same source line without transferring the Read rule", () => {
    const mixedSource = policyTextSnapshot(Buffer.from("Only currently admitted students may read their own registrations; show completion only after an applied receipt."), "mixed.txt");
    const report = parsePolicyCoverage({ passages: [
      { ...passages(completion)[0], start: 1, end: 1 },
      { ...completion, start: 1, end: 1, draft_paths: [applicationPath, "/runner_evidence/runtime_contract/receipts"] },
    ] }, mixedSource, draft, []);
    expect(report.passages).toMatchObject([
      { responsibility: "runner", disposition: "implemented", draft_paths: ["/read"] },
      { responsibility: "application", disposition: "needs_decision", application_obligations: ["status_presentation"] },
    ]);
    expect(policyReviewReadiness(mixedSource, report).ready).toBe(false);
  });

  it("redacts and bounds untrusted offending text without echoing unrelated draft values", () => {
    const secret = "sk-coverage-diagnostic-secret123456";
    const unsafeSource = policyTextSnapshot(Buffer.from(`Do not print postgres://reader:private-password@localhost/university ${secret} ${"x".repeat(8_000)}`), "untrusted.txt");
    let message = "";
    try { parsePolicyCoverage({ passages: [{ ...completion, start: 1, end: 1, disposition: "implemented",
      interpretation: `Model suggestion \u001b[31m${secret} Bearer private-token-123456`,
    }] }, unsafeSource, { ...draft, private_data: "unrelated-sensitive-draft-value" }, []); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Source lines 1-1");
    expect(message).toContain("Submitted interpretation");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("private-password");
    expect(message).not.toContain("private-token-123456");
    expect(message).not.toContain("unrelated-sensitive-draft-value");
    expect(message).not.toContain("\u001b");
    expect(message.length).toBeLessThan(6_000);
  });

  it.each(["corrected", "still invalid"])("provides bounded exact correction evidence while keeping mandatory work unmet (%s)", async (resultKind) => {
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [source]; conversation.policySources.active = source.version;
    conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
    const before = structuredClone({ draft, conversation });
    const requests: string[] = [];
    const rejected = { ...completion, disposition: "implemented" };
    const run = reviewPolicyCoverage({ source, draft, env: { OPENAI_API_KEY: "test-key" },
      session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson: async (request) => {
        requests.push(JSON.stringify(request.body));
        return { status: 200, body: { output: [{ type: "function_call", call_id: `application_${requests.length}`,
          name: "runner__review_policy_coverage", arguments: JSON.stringify(derivedScopedResponse(request.body,{ passages: passages(
            resultKind === "corrected" && requests.length > 1 ? completion : rejected,
          ) })) }] } };
      } } },
    });
    if (resultKind === "corrected") {
      const result = await run;
      expect(requests).toHaveLength(2);
      expect(result.passages[1]).toMatchObject({ responsibility: "application", disposition: "needs_decision" });
      expect(result.passages[2]).toMatchObject({ disposition: "unsupported", responsibility: "operator" });
      expect(policyReviewReadiness(source, result).ready).toBe(false);
    } else {
      await expect(run).rejects.toThrow(/POLICY_COVERAGE_INVALID:.*COVERAGE_.*STRUCTURE_INVALID/s);
      expect(requests).toHaveLength(2);
    }
    expect(requests[0]).toContain("Requires responsibility=application and disposition=needs_decision or unsupported");
    expect(requests[0]).toContain("never null or []");
    expect(requests[1]).toContain("/passages/1");
    expect(requests[1]).toContain("disposition");
    expect(requests[1]).toContain("exact host-scoped replacement DATA");
    expect(requests[1]).toContain("fully validated assembled report");
    expect({ draft, conversation }).toEqual(before);
  });
});

describe("Runner client connection is a later unverified handoff", () => {
  it("supplies current installation evidence without implying a configured client or reviewed customer scope", () => {
    const read: ExplorationBoundaryDraft = {
      schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "staging",
      source: "local_postgres", compiler_version: "1.8.0", spec_version: "1.11.0", reporting_timezone: "UTC",
      trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
      generation_lock_fingerprint: `sha256:${"a".repeat(64)}`, role_posture_fingerprint: `sha256:${"b".repeat(64)}`,
      budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [], pack: { name: "reviewed", resources: [] },
    };
    const before = structuredClone(read), evidence = policyCoverageDraft({ read, decisions: [], actions: [] });
    const deployment = evidence.runner_evidence.runtime_contract.deployment_prerequisites;
    expect(deployment.runner_client_connection).toMatchObject({ supported: true, supported_clients: ["claude-code", "cursor", "vscode"],
      stage: "after_authority_review", transport: "local_stdio", configuration_checked: false, verified: false });
    const pickerClients: string[] = [];
    for (let selected = 0; pickerClients.length < 16;) {
      pickerClients.push(mcpClientPickerTransition(selected, { name: "enter" }).client!);
      selected = mcpClientPickerTransition(selected, { name: "down" }).selected;
      if (selected === 0) break;
    }
    expect(deployment.runner_client_connection.supported_clients).toEqual(pickerClients);
    for (const client of pickerClients) expect(parseManagedMcpProjectClient(client)).toBe(client);
    for (const unsupported of ["codex", "claude-desktop"]) expect(() => parseManagedMcpProjectClient(unsupported)).toThrow();
    expect(deployment.authenticated_identity).toMatchObject({ reviewed_customer_scope: false, verified: false });
    expect(evidence.runner_evidence.runtime_contract.read_eligibility).toMatchObject({
      trusted_record_scope_configured: false,
      runner_private_source_predicates_supported: true,
      configured_current_state_prerequisite: null,
      action_requirements_apply_to_reads: false,
      database_business_predicates_verified: false,
    });
    const legacy = structuredClone(evidence);
    Reflect.deleteProperty(legacy.runner_evidence.runtime_contract.deployment_prerequisites, "runner_client_connection");
    expect(canonicalJsonDigest(evidence)).not.toBe(canonicalJsonDigest(legacy));
    expect(read).toEqual(before);
    read.pack.resources.push({ id: "public.orders", schema: "public", table: "orders", primary_key: "id",
      tenant_key: "tenant_id", principal_key: "principal_id", field_types: { id: "uuid", tenant_id: "text", principal_id: "text", status: "text" },
      field_enums: {}, selectable_fields: ["status"], filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [],
      aggregate_measure_functions: {}, count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["id", "tenant_id", "principal_id"],
      relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true });
    const scoped = policyCoverageDraft({ read, decisions: [], actions: [] }).runner_evidence.runtime_contract;
    expect(scoped.read_eligibility).toMatchObject({ trusted_record_scope_configured: true,
      configured_current_state_prerequisite: null, database_business_predicates_verified: false });
    expect(scoped.deployment_prerequisites.authenticated_identity.verified).toBe(false);
    delete read.pack.resources[0]!.principal_key;
    expect(policyCoverageDraft({ read, decisions: [], actions: [] }).runner_evidence.runtime_contract.read_eligibility.trusted_record_scope_configured).toBe(false);
  });

  it("rechecks the saved service classification with exact current evidence instead of reopening business authoring", async () => {
    const previousReport = { source_digest: clientSource.digest, draft_digest: `sha256:${"a".repeat(64)}`, passages: [savedClientPassage] };
    expect(policyReadinessItems(previousReport)).toMatchObject([{ kind: "business_decision", blocksReview: true }, { kind: "mechanical_correction", blocksReview: true }]);
    const draft = clientEvidence(), before = structuredClone({ draft, previousReport });
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [clientSource]; conversation.policySources.active = 1;
    conversation.policySources.approvals = [{ digest: clientSource.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
    const requests: string[] = [];
    const result = await reviewPolicyCoverage({ source: clientSource, draft, previousReport,
      session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson: async (request) => {
        requests.push(JSON.stringify(request.body));
        return { status: 200, body: { output: [{ type: "function_call", call_id: `coverage_${requests.length}`,
          name: "runner__review_policy_coverage", arguments: JSON.stringify(derivedScopedResponse(request.body,{ passages: [requests.length === 1 ? savedClientPassage
            : { ...savedClientPassage, draft_paths: [clientPointer], deployment_prerequisite: "runner_client_connection" }] })) }] } };
      } } }, env: { OPENAI_API_KEY: "test-key" },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("COVERAGE_DEPLOYMENT_COMPONENT_MIXED");
    expect(requests[1]).toContain("Do not change the draft");
    expect(result.passages[0]).toMatchObject({ disposition: "needs_decision", deployment_prerequisite: "runner_client_connection" });
    expect(policyReviewReadiness(clientSource, result)).toMatchObject({ ready: true, privacy: false });
    expect(policyReviewReadiness(clientSource, result).summary.join("\n")).toContain("Runner client connection");
    expect(policyReadinessItems(result).find(i => i.kind === "deployment_prerequisite")!.nextStep).toContain("After authority review");
    expect(policyCoverageSummary(clientSource, result).join("\n")).not.toContain("needs review before activation");
    expect(policyCoverageSummary(clientSource, result).join("\n")).toContain("1 open check(s)");
    expect({ draft, previousReport }).toEqual(before);
  });

  it("requires exact pending Runner-installation evidence, not a generic deployment waiver", () => {
    const passage = { ...savedClientPassage, deployment_prerequisite: "runner_client_connection", draft_paths: [clientPointer] };
    for (const change of [
      { disposition: "implemented" }, { disposition: "conflict" }, { responsibility: "application" }, { issue_kind: "business_choice" },
      { application_obligations: ["status_presentation"] },
      { field_checks: [{ resource: "service.appointments", field: "version", expectation: "private" }] },
      { draft_paths: [clientPointer, "/runner_evidence/runtime_contract/deployment_prerequisites"] },
    ]) expect(() => parsePolicyCoverage({ passages: [{ ...passage, ...change }] }, clientSource, clientEvidence(), "Already connected")).toThrow();
    for (const change of [{ supported: false }, { configuration_checked: true }, { verified: true }, { stage: "before_activation" }]) {
      const draft = clientEvidence();
      Object.assign(draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_client_connection, change);
      expect(() => parsePolicyCoverage({ passages: [passage] }, clientSource, draft, "Trust me")).toThrow("Runner client setup");
    }
    expect(() => parsePolicyCoverage({ passages: [{ ...passage, draft_paths: [clientPointer] }] }, clientSource, {}, "")).toThrow("Draft pointer");
    const unclassified = { source_digest: clientSource.digest, draft_digest: "pending", passages: [{ ...savedClientPassage, draft_paths: [] }] };
    expect(policyReadinessItems(unclassified)[0]!.blocksReview).toBe(true);
  });

  it("bounds recovery when the provider keeps returning the old unclassified report", async () => {
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [clientSource]; conversation.policySources.active = 1;
    conversation.policySources.approvals = [{ digest: clientSource.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
    const requestJson = vi.fn(async (request:any) => ({ status: 200, body: { output: [{ type: "function_call", call_id: "coverage",
      name: "runner__review_policy_coverage", arguments: JSON.stringify(derivedScopedResponse(request.body,{ passages: [savedClientPassage] })) }] } }));
    await expect(reviewPolicyCoverage({ source: clientSource, draft: clientEvidence(),
      session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson } }, env: { OPENAI_API_KEY: "test-key" },
    })).rejects.toThrow("POLICY_COVERAGE_INVALID");
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
});

describe("Read eligibility is not authentication or an Action prerequisite", () => {
  it.skipIf(process.env.SYNAPSOR_LIVE_ADMISSION_COVERAGE !== "1")("keeps unmet admission-gated reads blocked with the live authoring model", async () => {
    const source = policyTextSnapshot(Buffer.from("Only currently admitted students may read their own registration information. Missing, expired or withdrawn admission must deny reading. Do not weaken this rule."), "university-admission.txt");
    const conversation = createModelAuthoringConversation();
    const model = "gpt-5.6-terra";
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [source]; conversation.policySources.active = source.version;
    conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model }) }];
    conversation.policySources.operator_messages = ["Admission is a separate authoritative source. Authentication and registration are not proof. A fixture extension is only source completion. Save setup pending any unmet enforcement requirement."];
    for (const sourceAvailable of [false, true]) {
      const draft = { read: { scope: "trusted institution and student", runtime_identity: "required outside model arguments" },
        runner_evidence: { runtime_contract: { read_eligibility: {
          runner_private_source_predicates_supported: false,
          action_requirements_apply_to_reads: false,
          database_business_predicates_verified: false,
        } }, source_review: { admission_source_available: sourceAvailable,
          ...(sourceAvailable ? { resource: "university.student_admissions", scope: ["institution_id", "student_id"],
            current: "status=admitted and effective_from <= trusted time < effective_until", fixture_only: true } : {}),
          read_enforcement_configured: false,
        } } };
      const before = structuredClone(draft);
      const report = await reviewPolicyCoverage({ source, draft, session: { provider: "openai", model, conversation } });
      expect(policyReviewReadiness(source, report).ready).toBe(false);
      expect(report.passages.some((passage) => ["unsupported", "needs_decision", "conflict"].includes(passage.disposition)
        && !passage.deployment_prerequisite)).toBe(true);
      expect(report.passages.some((passage) => passage.disposition === "overridden")).toBe(false);
      expect(draft).toEqual(before);
    }
  }, 300_000);

  it("keeps a missing current-admission Read condition pending after source completion without waiving policy", async () => {
    const source = policyTextSnapshot(Buffer.from("Only currently admitted students may read their registration information."), "university.txt");
    const pointer = "/runner_evidence/runtime_contract/read_eligibility";
    const draft = { actions: [], runner_evidence: { runtime_contract: { read_eligibility: {
      runner_private_source_predicates_supported: false, action_requirements_apply_to_reads: false,
      database_business_predicates_verified: false,
    } } } };
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [source]; conversation.policySources.active = source.version;
    conversation.policySources.operator_messages = ["The new admission fixture supplies current status and effective dates, but does not enforce reads. Preserve the original policy and save pending enforcement."];
    conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
    const before = structuredClone({ draft, conversation }), requests: string[] = [];
    const report = await reviewPolicyCoverage({ source, draft,
      session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson: async (request) => {
        requests.push(JSON.stringify(request.body));
        return { status: 200, body: { output: [{ type: "function_call", call_id: "admission_read",
          name: "runner__review_policy_coverage", arguments: JSON.stringify(derivedScopedResponse(request.body,{ passages: [{
            start: 1, end: 1, disposition: "unsupported", responsibility: "operator", issue_kind: "unsupported_requirement",
            topic: "Current admission before viewing records", draft_paths: [pointer],
            interpretation: "Admission source data exists, but current admission is not enforced on reads. The Read requirement remains unmet.",
            evidence_checks: [{ path: `${pointer}/runner_private_source_predicates_supported`, equals: false }],
            next_step: "Keep setup pending until an authoritative admission check is enforced for reads.",
          }] })) }] } };
      } } }, env: { OPENAI_API_KEY: "test-key" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("Read eligibility is distinct from identity");
    expect(requests[0]).toContain("A fixture extension is not proof of integration or enforcement");
    expect(report.passages[0]).not.toHaveProperty("operator_override");
    expect(report.passages[0]).not.toHaveProperty("deployment_prerequisite");
    expect(policyReviewReadiness(source, report).ready).toBe(false);
    expect(policyReadinessItems(report)).toMatchObject([{ blocksReview: true }]);
    const serialized = JSON.parse(JSON.stringify(report));
    expect(policyReviewReadiness(source, serialized).ready).toBe(false);
    expect(() => parsePolicyCoverage({ passages: [{ ...report.passages[0], disposition: "implemented",
      evidence_checks: [{ path: `${pointer}/runner_private_source_predicates_supported`, equals: true }],
    }] }, source, draft, [])).toThrow("Mechanical evidence mismatch");
    expect({ draft, conversation }).toEqual(before);
  });
});

describe("attached-rules cancellation", () => {
  it.each(["escape", "ctrl-c"])("awaits provider cleanup on %s without coverage retry or publication", async (key) => {
    const readable = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(value: boolean) { this.isRaw = value; } });
    const writable = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 24 });
    writable.resume();
    const chat = createBoundaryAuthoringChat({ io: createTerminalAnalyticsShellIo({ readable, writable, terminal: true }) });
    const conversation = createModelAuthoringConversation(), source = policyTextSnapshot(Buffer.from("Completion requires an applied receipt."), "rules.txt");
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [source]; conversation.policySources.active = source.version;
    conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
    const draft = { receipts: "Applied receipt required." }, before = structuredClone({ draft, conversation });
    let entered!: () => void, abortSeen!: () => void, release!: () => void, settled = false;
    const started = new Promise<void>((resolve) => { entered = resolve; }), aborted = new Promise<void>((resolve) => { abortSeen = resolve; }),
      cleanup = new Promise<void>((resolve) => { release = resolve; });
    const requestJson = vi.fn(async ({ signal }: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      signal.addEventListener("abort", abortSeen, { once: true });
      entered(); await aborted; await cleanup;
      // A dependency may report the wrong error during abort. It must not trigger
      // the coverage parser's prose-only retry or overwrite the saved report.
      throw new AskError("ASK_REQUIRED_TOOL_NOT_CALLED", "Late provider failure", 422);
    });
    try {
      const pending = chat.progress("Checking attached rules", () => reviewPolicyCoverage({
        session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson, signal: chat.signal } },
        source, draft, env: { OPENAI_API_KEY: "test-key" },
      })).finally(() => { settled = true; });
      const refused = expect(pending).rejects.toMatchObject({ code: "ASK_CANCELLED" });
      await started;
      if (key === "escape") readable.emit("keypress", "\u001b", { name: "escape" });
      else readable.write("\u0003");
      await aborted;
      expect(settled).toBe(false);
      release(); await refused;
      expect(requestJson).toHaveBeenCalledOnce();
      expect({ draft, conversation }).toEqual(before);
    } finally { release(); chat.close(); readable.destroy(); writable.destroy(); }
  });
});

function counterCoverageFixture(filtered = false) {
  const outcomes = ["service.archive", "service.duration", "service.reminder"];
  const actions = outcomes.map((outcome) => ({ outcome, approval: { shared_limits: [{
    id: `${outcome}.diagnostic_label`, kind: "count", scope: "tenant", maximum: 3, window_seconds: 86_400,
    ...(filtered ? { capability: outcome } : {}),
  }] } }));
  return { actions, runner_evidence: {
    actions: Object.fromEntries(actions.map((action) => [action.outcome, { outcome: action.outcome,
      automatic_limits: action.approval.shared_limits.map((limit) => ({ ...limit,
        history_selector: { action_boundary_name: "service.actions", approval_status: "approved", window_seconds: 86_400,
          capability: filtered ? action.outcome : null, tenant: "current_proposal.tenant_id", principal: null, object_id: null, business_object: null },
      })),
    }])), runtime_contract: { approval_counter_selection: { diagnostic_only: ["limit.id"],
      not_history_filters: ["limit.id", "approval_class", "action_boundary_digest"] } },
  } };
}

describe("counter coverage correction diagnostics", () => {
  const outcome = "civic.notice_delivery_change";
  const root = `/runner_evidence/actions/${outcome}/automatic_limits`;
  const source = policyTextSnapshot(Buffer.from([
    "Allow at most 8 automatic notice delivery approvals overall in rolling 24 hours.",
    "Allow at most 2 automatic notice delivery approvals per organization in rolling 24 hours.",
    "Keep notification_id private, including analysis.",
    "An additional mandatory integration remains unconfigured.",
  ].join("\n")), "municipal-rules.txt");
  const operatorMessage = "Lower only the organization maximum from 2 to 1; retain overall 8 and all other rules.";
  const limits = [
    { id: "organization_24h", kind: "count", scope: "tenant", maximum: 1, window_seconds: 86400, capability: outcome },
    { id: "outcome_24h", kind: "count", scope: "capability", maximum: 8, window_seconds: 86400, capability: outcome },
  ];
  const draft = { actions: [{ outcome, approval: { shared_limits: limits } }], runner_evidence: {
    actions: { [outcome]: { automatic_limits: limits.map(limit => ({ ...limit, history_selector: {
      action_boundary_name: "municipal_actions", capability: outcome, window_seconds: 86400,
      tenant: limit.scope === "tenant" ? "current_proposal.tenant_id" : null,
    } })) } },
    read_access: { "civic.renewal_notices": { fields: { notification_id: { actual_values_returned: false, model_analysis: [] } } } },
  } };
  const check = { path: `${root}/0/history_selector/capability`, current_capability: outcome, required_capability: outcome };
  const override = { start: 2, end: 2, disposition: "overridden", responsibility: "operator",
    interpretation: "The operator replaced only the organization threshold with 1, retaining scope, window and outcome.",
    draft_paths: ["/actions/0/approval", root], operator_message_id: 1 };
  const selector = { start: 2, end: 2, disposition: "implemented", responsibility: "runner",
    interpretation: "The unchanged organization history selector counts this outcome only.",
    draft_paths: [root], counter_requirements: [check] };
  const passages = (entry: Record<string, unknown> = override) => [
    { ...selector, start: 1, end: 1, interpretation: "The overall maximum remains 8 for this outcome.",
      counter_requirements: [{ ...check, path: `${root}/1/history_selector/capability` }] },
    entry, selector,
    { start: 3, end: 3, disposition: "implemented", responsibility: "runner", interpretation: "The identifier remains private.",
      draft_paths: ["/runner_evidence/read_access/civic.renewal_notices/fields/notification_id"],
      field_checks: [{ resource: "civic.renewal_notices", field: "notification_id", expectation: "private" }] },
    { start: 4, end: 4, disposition: "unsupported", responsibility: "application",
      interpretation: "The additional mandatory integration remains unsupported.", draft_paths: [] },
  ];

  it.each([
    ["empty array", { counter_requirements: [] }, "1-16"],
    ["null", { counter_requirements: null }, "1-16"],
    ["object", { counter_requirements: {} }, "1-16"],
    ["too many", { counter_requirements: Array.from({ length: 17 }, () => check) }, "1-16"],
    ["missing responsibility", { responsibility: undefined }, 'responsibility must be "runner"'],
    ["operator responsibility", { responsibility: "operator" }, 'responsibility must be "runner"'],
    ["override", { disposition: "overridden" }, "disposition must be"],
    ["pending choice", { disposition: "needs_decision" }, "disposition must be"],
    ["unsupported", { disposition: "unsupported" }, "disposition must be"],
    ["background", { disposition: "background" }, "disposition must be"],
  ] as const)("identifies the rejected counter passage without changing validation (%s)", (_label, change, reason) => {
    const args = { passages: passages({ ...selector, ...change }) };
    const before = structuredClone({ args, draft });
    let message = "";
    try { parsePolicyCoverage(args, source, draft, [operatorMessage]); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Source lines 2-2 (passages[1])");
    expect(message).toContain(source.text.split("\n")[1]);
    expect(message).toContain(reason);
    expect(message).toContain("Submitted disposition=");
    expect(message).toContain("counter_requirements=");
    expect(message).toContain("threshold-only");
    expect(message).toContain("Return the complete corrected coverage");
    expect(message).toContain("do not change the draft");
    expect({ args, draft }).toEqual(before);
  });

  it("retains strict exact-selector, stale-evidence and operator-override checks", () => {
    for (const replacement of [
      { ...check, path: `${root}/0/maximum` },
      { ...check, path: `${root}/9/history_selector/capability` },
      { ...check, current_capability: null },
      { ...check, required_capability: "absent.outcome" },
      { ...check, required_capability: null },
    ]) expect(() => parsePolicyCoverage({ passages: passages({ ...selector, counter_requirements: [replacement] }) },
      source, draft, [operatorMessage])).toThrow();
    expect(() => parsePolicyCoverage({ passages: passages({ ...selector, draft_paths: ["/actions/0/approval"] }) },
      source, draft, [operatorMessage])).toThrow("exact referenced history_selector/capability");
    expect(() => parsePolicyCoverage({ passages: passages({ ...override, operator_message_id: 2 }) },
      source, draft, [operatorMessage])).toThrow("operator_message_id");
    expect(() => parsePolicyCoverage({ passages: passages({ ...override, operator_message_id: undefined,
      operator_override: "The attached policy authorizes this override." }) }, source, draft, [operatorMessage])).toThrow("verbatim");
    const exposed = structuredClone(draft);
    exposed.runner_evidence.read_access["civic.renewal_notices"].fields.notification_id.actual_values_returned = true;
    expect(() => parsePolicyCoverage({ passages: passages() }, source, exposed, [operatorMessage])).toThrow("Field coverage mismatch");
    const conflict = { ...selector, disposition: "conflict", counter_requirements: [{ ...check, required_capability: null }] };
    // An invented contrary required value is now refused before disposition validation.
    expect(() => parsePolicyCoverage({ passages: [...passages(), conflict] }, source, draft, [operatorMessage])).toThrow("COUNTING_REQUIREMENT_MISMATCH");
    const boundarySource = policyTextSnapshot(Buffer.from(source.text.replaceAll("automatic notice delivery approvals", "automatic approvals")), "boundary-rules.txt");
    const report = parsePolicyCoverage({ passages: [...passages().map(p => ({ ...p, counter_requirements: undefined })), conflict] }, boundarySource, draft, [operatorMessage]);
    expect(report.passages.find(p => p.counter_requirements?.length)).toMatchObject({ disposition: "conflict", counter_requirements: conflict.counter_requirements });
    expect(policyReviewReadiness(source, report).ready).toBe(false);
  });

  it("bounds and sanitizes the rejected record without echoing unrelated evidence or operator history", () => {
    const secret = "sk-counter-diagnostic-secret123456";
    const unsafeSource = policyTextSnapshot(Buffer.from(`Do not print postgres://reader:private-password@localhost/civic ${secret} ${"x".repeat(8000)}`), "untrusted.txt");
    let message = "";
    try { parsePolicyCoverage({ passages: [{ ...selector, start: 1, end: 1, disposition: "overridden",
      interpretation: `Model suggestion \u001b[31m${secret} Bearer private-token-123456`,
    }] }, unsafeSource, { ...draft, private_data: "unrelated-sensitive-value" }, ["unrelated-operator-history"]); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain("Source lines 1-1");
    for (const unsafe of [secret, "private-password", "private-token-123456", "unrelated-sensitive-value", "unrelated-operator-history", "\u001b"]) {
      expect(message).not.toContain(unsafe);
    }
    expect(message.length).toBeLessThan(6000);
  });

  it.each(["corrected", "still invalid"])("corrects a threshold-override classification once without waiving other requirements (%s)", async mode => {
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    Object.assign(conversation.policySources, { snapshots: [source], active: source.version, operator_messages: [operatorMessage],
      approvals: [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }] });
    const before = structuredClone({ draft, conversation });
    const requests: string[] = [];
    const rejected = { ...override, counter_requirements: [check] };
    const run = reviewPolicyCoverage({ source, draft, env: { OPENAI_API_KEY: "test-key" },
      session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson: async request => {
        requests.push(JSON.stringify(request.body));
        return { status: 200, body: { output: [{ type: "function_call", call_id: `counter_shape_${requests.length}`,
          name: "runner__review_policy_coverage", arguments: JSON.stringify(derivedScopedResponse(request.body,{ passages: passages(
            mode === "corrected" && requests.length > 1 ? override : rejected,
          ) })) }] } };
      } } },
    });
    if (mode === "corrected") {
      const report = await run;
      expect(report.passages[1]).toMatchObject({ disposition: "overridden", operator_override: operatorMessage });
      expect(report.passages[1]?.counter_requirements).toBeUndefined();
      expect(report.passages[2]).toMatchObject(selector);
      expect(report.passages[3]?.field_checks).toHaveLength(1);
      expect(report.passages[4]?.disposition).toBe("unsupported");
      expect(policyReviewReadiness(source, report).ready).toBe(false);
    } else await expect(run).rejects.toThrow(/POLICY_COVERAGE_INVALID:.*COVERAGE_.*STRUCTURE_INVALID/s);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("Requires responsibility=runner and disposition=implemented or conflict");
    expect(requests[0]).toContain("threshold-only");
    expect(requests[1]).toContain("/passages/1");
    expect(requests[1]).not.toContain("Previous untrusted coverage submission");
    expect(requests[1]).toContain("retain every unchanged scope, window, filter and limit");
    expect({ draft, conversation }).toEqual(before);
  });
});

describe("exact approval counter evidence and full-bundle targets", () => {
  it("distinguishes a real outcome-history mismatch from an invented diagnostic-ID problem", () => {
    const source = policyTextSnapshot(Buffer.from("Limit automatic archival approvals, not other actions, to three per customer per day."), "policy.txt");
    const draft = counterCoverageFixture();
    const pointer = "/runner_evidence/actions/service.archive/automatic_limits/0/history_selector/capability";
    const passage: PolicyPassage = { start: 1, end: 1, responsibility: "runner", issue_kind: "contradiction", disposition: "conflict",
      interpretation: "The source counts archival only, but the current selector counts all outcomes.",
      draft_paths: ["/runner_evidence/actions/service.archive/automatic_limits"],
      counter_requirements: [{ path: pointer, current_capability: null, required_capability: "service.archive" }],
    };
    const parse = (item: PolicyPassage) => parsePolicyCoverage({ passages: [item] }, source, draft, []);
    expect(isMechanicalApprovalCounterPassage(parse(passage).passages[0]!)).toBe(false);
    expect(policyReadinessItems(parse(passage)).length).toBeGreaterThan(0);
    expect(policyReadinessItems(parse(passage)).filter(item => item.passages.length).every(item => item.kind === "mechanical_correction" && item.blocksReview)).toBe(true);
    expect(parse(passage).passages[0]?.counter_requirements).toEqual(passage.counter_requirements);
    expect(() => parse({ ...passage, disposition: "implemented" })).toThrow("COUNTING_REQUIREMENT_AMBIGUOUS");
    for (const replacement of [
      { path: pointer.replace("history_selector/capability", "id"), current_capability: null, required_capability: "service.archive" },
      { path: pointer, current_capability: "service.archive", required_capability: null },
      { path: pointer, current_capability: null, required_capability: "absent.action" },
      { path: pointer, current_capability: null, required_capability: null },
    ]) expect(() => parse({ ...passage, counter_requirements: [replacement] })).toThrow();
    const readPassage: PolicyPassage = { ...passage, counter_requirements: undefined, draft_paths: ["/read/pack/resources/1", "/runner_evidence/read_access/university.courses"],
      interpretation: "Course details must only be reached through the student's registrations." };
    const diagnostics = { ...passage, counter_requirements: undefined };
    const items = actionablePolicyRequirements([{ title: "Mixed findings", passages: [diagnostics, readPassage, passage] }]);
    expect(items[0]?.passages).toEqual([readPassage, passage]);
    const pending = [{ title: "Scope interpretation", passages: [readPassage] },
      { title: "Exact counter mismatch", passages: [passage] }, { title: "Diagnostic grouping", passages: [diagnostics] }];
    const before = structuredClone(pending);
    const prioritized = prioritizePolicyRepairs(pending);
    expect(prioritized.map(item => item.title)).toEqual(["Exact counter mismatch", "Scope interpretation", "Diagnostic grouping"]);
    expect(prioritized).toHaveLength(pending.length);
    expect(pending).toEqual(before);
    expect(prioritized.flatMap(item => item.passages).every(passage => passage.disposition === "conflict")).toBe(true);
    expect(isReadOnlyPolicyPassage(readPassage)).toBe(true);
    expect(isReadOnlyPolicyPassage({ ...readPassage, draft_paths: [
      "/read", "/runner_evidence/runtime_contract/read_eligibility/configured_current_state_prerequisite",
    ] })).toBe(true);
    expect(isReadOnlyPolicyPassage({ ...readPassage, draft_paths: [
      "/runner_evidence/runtime_contract/read_eligibility", "/actions/0/require",
    ] })).toBe(false);
    expect(isReadOnlyPolicyPassage({ ...readPassage, draft_paths: [...readPassage.draft_paths, "/actions/0/require"] })).toBe(false);
    expect(isReadOnlyPolicyPassage({ ...readPassage, draft_paths: [] })).toBe(false);
    expect(referencesReadPolicy({ ...readPassage, draft_paths: ["/runner_evidence/runtime_contract/read_eligibility", "/actions/0/require"] })).toBe(true);
    expect(referencesReadPolicy({ ...readPassage, draft_paths: ["/actions/0/require", "/runner_evidence/actions/example/read_boundary"] })).toBe(false);
    expect(referencesReadPolicy({ ...readPassage, draft_paths: ["/reading", "/runner_evidence/runtime_contract/read_eligibility_other"] })).toBe(false);
  });

  const source = policyTextSnapshot(Buffer.from("Across all three actions allow 3 automatic approvals per company in 24 hours."), "joint-rules.txt");
  const conflict: PolicyPassage = { start: 1, end: 1, disposition: "conflict", responsibility: "runner", issue_kind: "contradiction",
    topic: "Joint automatic-approval limits", interpretation: "Different limit IDs were interpreted as separate history pools.",
    next_step: "Reconcile the counter grouping with the exact Runner selectors.",
    draft_paths: ["/actions/0/approval", "/actions/1/approval", "/actions/2/approval",
      ...["archive", "duration", "reminder"].map((name) => `/runner_evidence/actions/service.${name}/automatic_limits`)],
  };

  it.each(["corrected", "persistent", "distinct_capability"] as const)("bounds semantic counter reconciliation without editing valid rules (%s)", async (mode) => {
    const draft = counterCoverageFixture(mode === "distinct_capability");
    // This wording is outside bounded source recognition. Explicit operator
    // interpretation supplies the missing positive basis; model equality does not.
    const decisions = await reviewUnestablishedCounting({ source, draft, messages: [], assertCurrent: async () => {},
      session: { chooseOption: async () => "boundary", confirm: async () => true } });
    Object.assign(draft.runner_evidence, { counting_decisions: decisions });
    const before = structuredClone(draft);
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [source]; conversation.policySources.active = 1;
    conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
    const requests: string[] = [];
    const report = await reviewPolicyCoverage({ source, draft,
      previousReport: { source_digest: source.digest, draft_digest: canonicalJsonDigest(draft), passages: [conflict] },
      session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson: async (request) => {
        requests.push(JSON.stringify(request.body));
        const corrected = requests.length === 2 && mode === "corrected";
        return { status: 200, body: { output: [{ type: "function_call", call_id: `counter_${requests.length}`,
          name: "runner__review_policy_coverage", arguments: JSON.stringify(derivedScopedResponse(request.body,{ passages: [{ ...conflict,
            disposition: corrected ? "implemented" : "conflict",
            interpretation: corrected ? "The same trusted tenant and boundary history is shared despite different diagnostic IDs."
              : mode === "distinct_capability" ? "These explicit capability filters select different histories; the shared requirement remains unresolved." : conflict.interpretation,
            ...(corrected ? { evidence_checks: [{ path: "/runner_evidence/actions/service.archive/automatic_limits/0/history_selector/capability", equals: null }] } : {}),
          }] })) }] } };
      } } }, env: { OPENAI_API_KEY: "test-key" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("Do not infer separate counters from ID spelling");
    expect(policyReadinessItems(report).filter(item => item.passages.length).every(item => !item.blocksReview)).toBe(false);
    expect(policyReviewReadiness(source, report).ready).toBe(false); // Synthetic counter-only metadata does not establish a current client contract.
    expect(draft).toEqual(before);
    expect(isMechanicalApprovalCounterPassage(conflict)).toBe(true);
    expect(isMechanicalApprovalCounterPassage({ ...conflict, responsibility: "operator", issue_kind: "business_choice" })).toBe(false);
  });

  it.each([
    { paths: ["/actions/2/approval"], editable: ["service.reminder"], referenced: ["service.reminder"], selected: ["service.reminder"] },
    { paths: ["/actions/0/approval"], editable: ["service.reminder"], referenced: ["service.archive"], selected: [] },
    { paths: ["/actions/2/approval", "/runner_evidence/actions/service.reminder/automatic_limits"], editable: ["service.reminder"], referenced: ["service.reminder"], selected: ["service.reminder"] },
    { paths: conflict.draft_paths, editable: ["service.archive"], referenced: ["service.archive", "service.duration", "service.reminder"], selected: ["service.archive"] },
    { paths: ["/runner_evidence/actions/service.duration/automatic_limits"], editable: ["service.reminder", "service.duration"], referenced: ["service.duration"], selected: ["service.duration"] },
  ])("maps exact coverage references to outcome identity, not the editable index (%j)", ({ paths, editable, referenced, selected }) => {
    const draft = counterCoverageFixture() as unknown as ReturnType<typeof policyCoverageDraft>;
    const report = { source_digest: source.digest, draft_digest: canonicalJsonDigest(draft), passages: [{ ...conflict, draft_paths: paths }] };
    expect(policyCoverageActionTargets({ report, draft, passages: report.passages, editableOutcomes: editable }))
      .toEqual({ referenced, editable: selected });
  });

  it("refuses stale, missing and duplicate outcome identities instead of guessing", () => {
    const draft = counterCoverageFixture() as unknown as ReturnType<typeof policyCoverageDraft>;
    const report = { source_digest: source.digest, draft_digest: canonicalJsonDigest(draft), passages: [conflict] };
    const resolve = () => policyCoverageActionTargets({ report, draft, passages: report.passages, editableOutcomes: ["service.archive"] });
    draft.actions.reverse();
    expect(resolve).toThrow("POLICY_COVERAGE_DRAFT_CHANGED");
    draft.actions.reverse();
    for (const pointer of ["/actions/3/approval", "/actions/01/approval", "/runner_evidence/actions/service.absent/automatic_limits"]) {
      report.passages = [{ ...conflict, draft_paths: [pointer] }];
      expect(resolve).toThrow("POLICY_COVERAGE_ACTION_TARGET_INVALID");
    }
    report.passages = [conflict];
    draft.actions.push(structuredClone(draft.actions[0]!));
    report.draft_digest = canonicalJsonDigest(draft);
    expect(resolve).toThrow("POLICY_COVERAGE_ACTION_TARGET_INVALID");
  });
});

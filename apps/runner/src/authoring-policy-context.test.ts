import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary } from "./auto-boundary.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { parsePolicyCoverage, reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { authoringDestination, newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";

const root = "/runner_evidence/runtime_contract";

describe("post-change verification is a later observation, not an Action expression", () => {
  it("keeps unassigned client duties separate from readback on the same source range without topic labels", () => {
    const source = policyTextSnapshot(Buffer.from("The client selects the record. Independently verify the changed source row after execution."), "rules.txt");
    const draft = policyCoverageDraft(fixture());
    const report = parsePolicyCoverage({ passages: [
      { start: 1, end: 1, disposition: "needs_decision", responsibility: "application", issue_kind: "missing_configuration",
        interpretation: "Independent source readback is required later and unverified.", application_obligations: ["independent_source_readback"],
        draft_paths: [`${root}/application_obligations/independent_source_readback`] },
      { start: 1, end: 1, disposition: "needs_decision", responsibility: "application", issue_kind: "missing_configuration",
        interpretation: "The client must capture the intended selection; no assignment is current.", application_obligations: ["customer_selection"],
        draft_paths: [`${root}/application_obligations/customer_selection`] },
    ] }, source, draft, []);
    const ready = policyReviewReadiness(source, report);
    expect(ready.ready).toBe(false);
    expect(ready.items).toHaveLength(2);
    expect(ready.items?.filter(item => item.blocksReview).flatMap(item => item.passages).map(passage => passage.application_obligations)).toEqual([["customer_selection"]]);
    expect(ready.summary.join(" ")).toContain("Independent source readback remains unverified");
  });
  it("retains required independent readback without blocking the earlier business review or claiming it happened", () => {
    const input = fixture(), before = structuredClone(input), draft = policyCoverageDraft(input);
    const source = policyTextSnapshot(Buffer.from("Independently verify the changed source row after execution."), "rules.txt");
    const report = parsePolicyCoverage({ passages: [{ start: 1, end: 1,
      disposition: "needs_decision", responsibility: "application", issue_kind: "missing_configuration",
      interpretation: "A separate per-execution observation is required after the change; it has not been performed.",
      draft_paths: [`${root}/application_obligations/independent_source_readback`],
      application_obligations: ["independent_source_readback"],
      next_step: "After execution, independently read the permitted source state and compare it with the exact change; retain this obligation until observed.",
    }] }, source, draft, []);
    expect(policyReviewReadiness(source, report)).toMatchObject({ ready: true });
    expect(report.passages[0]).toMatchObject({ disposition: "needs_decision", responsibility: "application" });
    expect(policyReviewReadiness(source, report).summary.join(" ")).toMatch(/readback.*unverified|unverified.*readback/i);
    expect(input).toEqual(before);
  });

  it("does not route an unsupported automatic runtime postcondition as a mechanical Action correction", () => {
    const source = policyTextSnapshot(Buffer.from("Automatically verify an independent postcondition before completing every execution."), "rules.txt");
    const draft = policyCoverageDraft(fixture());
    const report = parsePolicyCoverage({ passages: [{ start: 1, end: 1,
      disposition: "unsupported", responsibility: "runner", issue_kind: "unsupported_requirement",
      interpretation: "This automatic postcondition is not represented by the existing Action or receipt engine.",
      draft_paths: [`${root}/receipts`], next_step: "Keep the exact unsupported guarantee unresolved.",
    }] }, source, draft, []);
    expect(policyReviewReadiness(source, report)).toMatchObject({ ready: false,
      items: [{ kind: "unsupported_runtime", blocksReview: true }] });
  });
});
function fixture() {
  const inspection: SchemaInspection = {
    engine: "postgres", current_user: "inspected_reader", server_version: "17", inspected_at: "2026-09-11T19:30:00Z",
    role_posture: { verified: true, read_only: true, superuser: false, bypass_rls: false, owned_relations: [], writable_relations: [], reasons: [] },
    schemas: ["records"], warnings: [], tables: [{ schema: "records", name: "items", type: "table", writable: true,
      columns: ["id", "organization_id", "person_id", "reference"].map((name, i) => ({ name, data_type: "text", nullable: false,
        generated: false, ordinal_position: i + 1, suggestions: { tenant: name === "organization_id", conflict: false,
          sensitive: false, immutable: false, large_or_binary: false } })),
      primary_key: ["id"], unique_constraints: [], indexes: [], foreign_keys: [], row_level_security: false,
      role_posture: { owner: "source_owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: false, row_security_effective_for_current_role: false, row_security_applicable_policies: [] },
      suggestions: { tenant_columns: ["organization_id"], conflict_columns: [], sensitive_columns: [], default_visible_columns: ["reference"] },
    }],
  };
  const generated = build(inspection);
  return { read: generated.exploration_boundary, source: { inspection, generationLock: generated.lock }, actions: [], decisions: [] };
}
function build(inspection: SchemaInspection) {
  return buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "records",
    project: { root: "/fixture/policy-context", package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
}
function refresh(input: ReturnType<typeof fixture>) {
  const generated = build(input.source.inspection);
  input.source.generationLock = generated.lock;
  input.read.generation_lock_fingerprint = canonicalJsonDigest(generated.lock);
  input.read.role_posture_fingerprint = generated.exploration_boundary.role_posture_fingerprint;
}

describe("current authoring context is separate from runtime deployment", () => {
  it("exposes only the selected authoring provider/model, not credentials or runtime connection claims", () => {
    const input = { ...fixture(), authoringSession: { provider: "openai" as const, model: "gpt-5.6-terra",
      apiKey: "never-disclose-key", baseUrl: "https://private-endpoint.invalid", conversation: { secret: "private-history" } } };
    const before = structuredClone(input), draft = policyCoverageDraft(input), evidence = draft.runner_evidence.runtime_contract;
    expect(evidence.authoring_provider).toMatchObject({ provider: "openai", model: "gpt-5.6-terra", purpose: "disabled_policy_authoring",
      runtime_client_verified: false, provider_response_verified: false, authority_granted: false });
    expect(evidence.agent_interface.tools).toEqual(["app.describe_data", "app.explore_data", "app.describe_actions", "app.request_change"]);
    expect(evidence.deployment_prerequisites.runner_client_connection.verified).toBe(false);
    expect(evidence.deployment_prerequisites.runner_execution_setup.verified).toBe(false);
    expect(JSON.stringify(draft)).not.toMatch(/never-disclose-key|private-endpoint|private-history/);
    expect(input).toEqual(before);
  });

  it("does not infer a provider from saved policy text or an absent current session", () => {
    const policySources = newPolicySourceSession();
    policySources.snapshots = [policyTextSnapshot(Buffer.from("Use Terra for drafting."), "rules.txt")];
    policySources.active = 1;
    const draft = policyCoverageDraft({ ...fixture(), policySources });
    expect(draft.runner_evidence.runtime_contract.authoring_provider).toBeNull();
  });

  it("rekeys coverage when the actual selected provider changes without rewriting authority", () => {
    const input = fixture(), before = structuredClone(input);
    const first = policyCoverageDraft({ ...input, authoringSession: { provider: "openai", model: "gpt-5.6-terra" } });
    const second = policyCoverageDraft({ ...input, authoringSession: { provider: "anthropic", model: "another-reviewed-model" } });
    expect(canonicalJsonDigest(first)).not.toBe(canonicalJsonDigest(second));
    expect(first.read).toEqual(second.read);
    expect(first.actions).toEqual(second.actions);
    expect(input).toEqual(before);
  });

  it("supplies exact inspected reader posture without treating it as RLS, writer or authentication proof", () => {
    const input = fixture(), before = structuredClone(input), evidence = policyCoverageDraft(input).runner_evidence.runtime_contract;
    expect(evidence.onboarding_reader).toMatchObject({ source: input.read.source, engine: "postgres", role_verified: true,
      read_only: true, non_owner: true, non_bypass: true, generation_lock_fingerprint: input.read.generation_lock_fingerprint,
      role_posture_fingerprint: input.read.role_posture_fingerprint, live_connection_rechecked: false,
      writer_separation_verified: false, production_integration_verified: false });
    expect(evidence.onboarding_reader?.meaning).toContain("not RLS");
    expect(evidence.deployment_prerequisites.authenticated_identity.verified).toBe(false);
    expect(evidence.deployment_prerequisites.runner_execution_setup.verified).toBe(false);
    expect(input).toEqual(before);
  });

  it.each(["role", "read_role", "schema", "lock"])("never supplies stale %s reader proof even without an RLS-only resource", change => {
    const input = fixture();
    if (change === "role") input.source.inspection.current_user = "new_reader";
    if (change === "read_role") input.read.role_posture_fingerprint = canonicalJsonDigest("old-role");
    if (change === "schema") input.source.inspection.tables[0]!.columns[0]!.data_type = "uuid";
    if (change === "lock") input.source.generationLock.source_env = "OTHER_DATABASE_URL";
    if (change === "schema" || change === "lock") expect(() => policyCoverageDraft(input)).toThrow("POLICY_SOURCE_EVIDENCE_STALE");
    else expect(policyCoverageDraft(input).runner_evidence.runtime_contract.onboarding_reader).toBeNull();
  });

  it("leaves absent inspected reader evidence unavailable", () => {
    const { source: _source, ...input } = fixture();
    expect(policyCoverageDraft(input).runner_evidence.runtime_contract.onboarding_reader).toBeNull();
  });

  it.each(["unverified", "writes", "owner", "owner_membership", "bypass", "superuser", "unknown", "missing_relation"])("does not turn current %s posture into a satisfied reader prerequisite", change => {
    const input = fixture(), inspection = input.source.inspection, role = inspection.role_posture!;
    if (change === "unverified") role.verified = false;
    if (change === "writes") { role.read_only = false; role.writable_relations = ["records.items"]; }
    if (change === "owner") role.owned_relations = ["records.items"];
    if (change === "owner_membership") inspection.tables[0]!.role_posture!.current_role_can_assume_owner = true;
    if (change === "bypass") role.bypass_rls = true;
    if (change === "superuser") role.superuser = true;
    if (change === "unknown") { role.superuser = "unknown"; role.bypass_rls = "unknown"; }
    if (change === "missing_relation") delete inspection.tables[0]!.role_posture;
    refresh(input);
    const evidence = policyCoverageDraft(input).runner_evidence.runtime_contract.onboarding_reader!;
    expect(evidence.role_verified && evidence.read_only && evidence.non_owner && evidence.non_bypass).toBe(false);
  });

  it("keeps database-clock origin distinct from the supported trusted evaluation timestamp", () => {
    const draft = policyCoverageDraft(fixture()), path = `${root}/trusted_time`;
    expect(draft.runner_evidence.runtime_contract.trusted_time).toMatchObject({ binding: "transaction_time",
      origin: "runner_supplied_evaluation_time", database_clock_verified: false, model_supplied: false });
    const source = policyTextSnapshot(Buffer.from("Compare against the database current UTC timestamp."), "rules.txt");
    const entry = { start: 1, end: 1, disposition: "unsupported", responsibility: "runner", issue_kind: "unsupported_requirement",
      interpretation: "Trusted Runner evaluation time does not establish database-origin time.", draft_paths: [path],
      evidence_checks: [{ path: `${path}/database_clock_verified`, equals: false }], next_step: "Keep the exact clock-origin requirement pending." };
    expect(parsePolicyCoverage({ passages: [entry] }, source, draft, []).passages[0]!.disposition).toBe("unsupported");
    expect(() => parsePolicyCoverage({ passages: [{ ...entry, disposition: "implemented",
      evidence_checks: [{ path: `${path}/database_clock_verified`, equals: true }] }] }, source, draft, [])).toThrow("Mechanical evidence mismatch");
  });

  it("provides the actual coverage callback with current authoring, reader and clock evidence plus explicit classification guidance", async () => {
    const source = policyTextSnapshot(Buffer.from("Use Terra for drafting and Claude Code later.\nUse the inspected non-owner, non-bypass read-only reader.\nUse database current UTC time."), "rules.txt");
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [source]; conversation.policySources.active = source.version;
    conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "gpt-5.6-terra" }) }];
    const draft = policyCoverageDraft({ ...fixture(), authoringSession: { provider: "openai", model: "gpt-5.6-terra" } });
    const before = structuredClone(draft), requests: string[] = [];
    const passages = [
      { start: 1, end: 1, disposition: "implemented", interpretation: "The current authoring session selects Terra, separately from runtime clients.",
        draft_paths: [`${root}/authoring_provider`], evidence_checks: [{ path: `${root}/authoring_provider/model`, equals: "gpt-5.6-terra" }] },
      { start: 1, end: 1, disposition: "needs_decision", responsibility: "deployment", issue_kind: "missing_configuration",
        deployment_prerequisite: "runner_client_connection", interpretation: "Claude Code connection is still pending.",
        draft_paths: [`${root}/deployment_prerequisites/runner_client_connection`], next_step: "Review client installation after authority review." },
      { start: 2, end: 2, disposition: "implemented", interpretation: "The bound inspection establishes this reader posture, not writer readiness.",
        draft_paths: [`${root}/onboarding_reader`], evidence_checks: [{ path: `${root}/onboarding_reader/read_only`, equals: true }] },
      { start: 3, end: 3, disposition: "unsupported", responsibility: "runner", issue_kind: "unsupported_requirement",
        interpretation: "Database-origin time is not proved by trusted evaluation time.", draft_paths: [`${root}/trusted_time`],
        evidence_checks: [{ path: `${root}/trusted_time/database_clock_verified`, equals: false }], next_step: "Keep the original clock requirement pending." },
    ];
    const report = await reviewPolicyCoverage({ source, draft, env: { OPENAI_API_KEY: "test-key" }, session: {
      provider: "openai", model: "gpt-5.6-terra", conversation, dependencies: { requestJson: async request => {
        requests.push(JSON.stringify(request.body));
        return { status: 200, body: { output: [{ type: "function_call", call_id: `context_${requests.length}`,
          name: "runner__review_policy_coverage", arguments: JSON.stringify({ passages }) }] } };
      } },
    } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("authoring_provider");
    expect(requests[0]).toContain("not a runtime MCP client");
    expect(requests[0]).toContain("Do not ask to provision the already inspected reader");
    expect(requests[0]).toContain("database-origin clock requirement remains unresolved");
    expect(report.passages.map(p => p.disposition)).toEqual(["implemented", "needs_decision", "implemented", "unsupported"]);
    expect(draft).toEqual(before);
  });

  it.each([false, true])("keeps the independent clock requirement blocked with either initial provider disposition (derived correction=%s)", async corrected => {
    // The provider interpretation is verbatim from the saved 3478 coverage.
    // This is a focused excerpt replay, not a claim to recreate its missing wire log.
    const source = policyTextSnapshot(Buffer.from("Use Claude Code as the runtime MCP client and Terra for drafting.\nUse the database's current UTC timestamp."), "rules.txt");
    const providerPassage = {
      start: 1, end: 1, disposition: "conflict", responsibility: "runner", issue_kind: "contradiction",
      interpretation: "The source requires Terra for drafting, while the host-selected current authoring provider is OpenAI gpt-5.6-terra. A model name does not establish Terra as the required drafting provider; this is separate from the Claude Code runtime-client requirement.",
      draft_paths: [`${root}/authoring_provider`], topic: "Terra drafting requirement",
      next_step: "Is Terra required as the drafting provider for this job?",
    };
    const clockPassage = {
      start: 2, end: 2, disposition: "conflict", responsibility: "runner", issue_kind: "contradiction",
      interpretation: "Runner-supplied evaluation time does not establish the required database-server UTC clock.",
      draft_paths: [`${root}/trusted_time`],
      evidence_checks: [{ path: `${root}/trusted_time/database_clock_verified`, equals: false }],
      next_step: "Do not activate while the unchanged database-clock requirement is unmet.",
    };
    const clientPassage = {
      start: 1, end: 1, disposition: "needs_decision", responsibility: "deployment", issue_kind: "missing_configuration",
      deployment_prerequisite: "runner_client_connection", draft_paths: [`${root}/deployment_prerequisites/runner_client_connection`],
      interpretation: "Claude Code installation and connection remain unverified.",
    };
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [source]; conversation.policySources.active = source.version;
    conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "gpt-5.6-terra" }) }];
    const answer = "Yes. The database server's current UTC time is required. Runner-supplied host evaluation time is not a substitute. Keep the requirement unchanged; do not activate while it is unmet.";
    conversation.policySources.operator_messages = [answer];
    const draft = policyCoverageDraft({ ...fixture(), policySources: conversation.policySources,
      authoringSession: { provider: "openai", model: "gpt-5.6-terra" } });
    const before = structuredClone({ draft, conversation }), requests: string[] = [];
    const report = await reviewPolicyCoverage({ source, draft, env: { OPENAI_API_KEY: "test-key" }, session: {
      provider: "openai", model: "gpt-5.6-terra", conversation, dependencies: { requestJson: async request => {
        requests.push(JSON.stringify(request.body));
        const provider = corrected ? { ...providerPassage, disposition: "implemented",
          interpretation: "The current host selection is the requested drafting model; it does not verify runtime client deployment.",
          next_step: "Retain this selection; review the separate client connection later.",
          evidence_checks: [{ path: `${root}/authoring_provider/model`, equals: "gpt-5.6-terra" }] } : providerPassage;
        return { status: 200, body: { output: [{ type: "function_call", call_id: `replay_${requests.length}`,
          name: "runner__review_policy_coverage", arguments: JSON.stringify({ passages: [provider, clientPassage, clockPassage] }) }] } };
      } },
    } });
    expect(requests).toHaveLength(1);
    for (const request of requests) {
      expect(request).toContain(answer);
      expect(request).toContain("gpt-5.6-terra");
      expect(request).toContain("not a runtime MCP client");
      expect(request).toContain("database-origin clock requirement remains unresolved");
    }
    // A structurally valid unresolved report is not an invitation for another opinion.
    // The corrected=true first reply is a derived positive control, not a captured reply.
    expect(requests[0]).not.toContain("Recheck these mechanical coverage gaps");
    expect(requests[0]).not.toContain("Previous untrusted coverage submission");
    expect(report.passages[0]!.disposition).toBe(corrected ? "implemented" : "conflict");
    expect(report.passages[1]!.deployment_prerequisite).toBe("runner_client_connection");
    expect(report.passages[2]).toEqual(clockPassage);
    expect(policyReviewReadiness(source, report).ready).toBe(false);
    expect(report.passages.some(passage => passage.disposition === "overridden")).toBe(false);
    expect({ draft, conversation }).toEqual(before);
  });

  it("transmits retained field meanings outside bounded narration history without declaring them permission", async () => {
    const source = policyTextSnapshot(Buffer.from("Keep the tracking reference visible; internal keys stay private."), "rules.txt");
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [source]; conversation.policySources.active = source.version;
    conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
    const meaning = "records.items.reference is the human-readable tracking reference, not the internal primary key or a trusted identity value.";
    conversation.policySources.operator_messages = [meaning];
    const input = fixture(), draft = policyCoverageDraft({ ...input, policySources: conversation.policySources });
    const contextPath = `${root}/authoring_lifecycle`;
    const before = structuredClone({ draft, conversation }), requests: string[] = [];
    const report = await reviewPolicyCoverage({ source, draft, env: { OPENAI_API_KEY: "test-key" }, session: {
      provider: "openai", model: "fixture", conversation, dependencies: { requestJson: async request => {
        requests.push(JSON.stringify(request.body));
        return { status: 200, body: { output: [{ type: "function_call", call_id: "meaning",
          name: "runner__review_policy_coverage", arguments: JSON.stringify({ passages: [{
            start: 1, end: 1, disposition: "needs_decision", responsibility: "operator", issue_kind: "schema_meaning",
            interpretation: "The model still asks about a meaning already supplied. This is not proof that the host lost it.",
            draft_paths: [contextPath], next_step: "What does the tracking reference mean?",
          }] }) }] } };
      } },
    } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(meaning);
    expect(requests[0]).toContain("Indexed operator messages");
    expect(conversation.turns).toEqual([]);
    expect(report.passages[0]!.disposition).toBe("needs_decision");
    expect(policyReviewReadiness(source, report).ready).toBe(false);
    expect(draft.runner_evidence.runtime_contract.authoring_lifecycle.retained_business_answers).toBe(1);
    expect({ draft, conversation }).toEqual(before);
  });
});

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createTerminalAnalyticsShellIo } from "./analytics-shell.js";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { newPolicySourceSession, policyTextSnapshot, authoringDestination, type PolicyPassage } from "./authoring-policy-source.js";
import { parsePolicyCoverage, policyCoverageSummary, reviewPolicyCoverage, isMechanicalApprovalCounterPassage } from "./authoring-policy-coverage.js";
import { policyReadinessItems, policyReviewReadiness } from "./authoring-review-readiness.js";
import { AskError, type AskProviderDependencies } from "./model-ask.js";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { policyCoverageDraft, policyCoverageActionTargets } from "./authoring-policy-evidence.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { mcpClientPickerTransition } from "./post-activation-ask.js";
import { parseManagedMcpProjectClient } from "./managed-mcp-project.js";

const clientPointer = "/runner_evidence/runtime_contract/deployment_prerequisites/runner_client_connection";
const clientEvidence = () => ({ runner_evidence: { runtime_contract: { deployment_prerequisites: {
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
    const legacy = structuredClone(evidence);
    Reflect.deleteProperty(legacy.runner_evidence.runtime_contract.deployment_prerequisites, "runner_client_connection");
    expect(canonicalJsonDigest(evidence)).not.toBe(canonicalJsonDigest(legacy));
    expect(read).toEqual(before);
  });

  it("rechecks the saved service classification with exact current evidence instead of reopening business authoring", async () => {
    const previousReport = { source_digest: clientSource.digest, draft_digest: `sha256:${"a".repeat(64)}`, passages: [savedClientPassage] };
    expect(policyReadinessItems(previousReport)).toMatchObject([{ kind: "mechanical_correction", blocksReview: true }]);
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
          name: "runner__review_policy_coverage", arguments: JSON.stringify({ passages: [requests.length === 1 ? savedClientPassage
            : { ...savedClientPassage, draft_paths: [clientPointer], deployment_prerequisite: "runner_client_connection" }] }) }] } };
      } } }, env: { OPENAI_API_KEY: "test-key" },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("Classify the deployment prerequisite");
    expect(requests[1]).toContain("Do not change the draft");
    expect(result.passages[0]).toMatchObject({ disposition: "needs_decision", deployment_prerequisite: "runner_client_connection" });
    expect(policyReviewReadiness(clientSource, result)).toMatchObject({ ready: true, privacy: false });
    expect(policyReviewReadiness(clientSource, result).summary.join("\n")).toContain("Runner client connection");
    expect(policyReadinessItems(result)[0]!.nextStep).toContain("After authority review");
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
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "coverage",
      name: "runner__review_policy_coverage", arguments: JSON.stringify({ passages: [savedClientPassage] }) }] } }));
    await expect(reviewPolicyCoverage({ source: clientSource, draft: clientEvidence(),
      session: { provider: "openai", model: "fixture", conversation, dependencies: { requestJson } }, env: { OPENAI_API_KEY: "test-key" },
    })).rejects.toThrow("POLICY_COVERAGE_INVALID");
    expect(requestJson).toHaveBeenCalledTimes(2);
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

describe("exact approval counter evidence and full-bundle targets", () => {
  const source = policyTextSnapshot(Buffer.from("Across all three actions allow 3 automatic approvals per company in 24 hours."), "joint-rules.txt");
  const conflict: PolicyPassage = { start: 1, end: 1, disposition: "conflict", responsibility: "runner", issue_kind: "contradiction",
    topic: "Joint automatic-approval limits", interpretation: "Different limit IDs were interpreted as separate history pools.",
    next_step: "Reconcile the counter grouping with the exact Runner selectors.",
    draft_paths: ["/actions/0/approval", "/actions/1/approval", "/actions/2/approval",
      ...["archive", "duration", "reminder"].map((name) => `/runner_evidence/actions/service.${name}/automatic_limits`)],
  };

  it.each(["corrected", "persistent", "distinct_capability"] as const)("bounds semantic counter reconciliation without editing valid rules (%s)", async (mode) => {
    const draft = counterCoverageFixture(mode === "distinct_capability"), before = structuredClone(draft);
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
          name: "runner__review_policy_coverage", arguments: JSON.stringify({ passages: [{ ...conflict,
            disposition: corrected ? "implemented" : "conflict",
            interpretation: corrected ? "The same trusted tenant and boundary history is shared despite different diagnostic IDs."
              : mode === "distinct_capability" ? "These explicit capability filters select different histories; the shared requirement remains unresolved." : conflict.interpretation,
            ...(corrected ? { evidence_checks: [{ path: "/runner_evidence/actions/service.archive/automatic_limits/0/history_selector/capability", equals: null }] } : {}),
          }] }) }] } };
      } } }, env: { OPENAI_API_KEY: "test-key" },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("history_selector, not limit.id or approval_class");
    expect(requests[1]).toContain("Do not infer separate counters from ID spelling");
    expect(policyReviewReadiness(source, report).ready).toBe(mode === "corrected");
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

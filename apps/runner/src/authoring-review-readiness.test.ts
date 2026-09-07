import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { authoringDestination, newPolicySourceSession, policyTextSnapshot, savePolicySources, loadPolicySources, type PolicyCoverage } from "./authoring-policy-source.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { parsePolicyCoverage, policyCoverageSection, reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { applicationObligationAssigned, policyReadinessItems, policyReviewReadiness } from "./authoring-review-readiness.js";

const source = policyTextSnapshot(Buffer.from("Capture the customer's selected offer.\nReport completion only from receipts."), "service-policy.txt");
const draft = { runner_evidence: { runtime_contract: { application_obligations: {
  customer_selection: "Client captures the selected offer; Runner verifies it.", status_presentation: "Client reports receipt states accurately.",
} } } };
function report(): PolicyCoverage {
  return parsePolicyCoverage({ passages: ["customer_selection", "status_presentation"].map((name, index) => ({
    start: index + 1, end: index + 1, disposition: "unsupported", responsibility: "application", issue_kind: "unsupported_requirement",
    interpretation: "Runner verifies the operation, but not the client interaction.",
    topic: index ? "Accurate customer confirmation" : "Customer-selected offer", next_step: "Test this behavior in the client application.",
    draft_paths: [`/runner_evidence/runtime_contract/application_obligations/${name}`], application_obligations: [name],
  })) }, source, draft, "");
}

describe("one authoritative guided review readiness model", () => {
  it("repairs mixed deployment evidence in the bounded model correction, without changing scope or needing identity values", async () => {
    const identitySource = policyTextSnapshot(Buffer.from("Allow only signed-in customers to see their authorized account."), "identity.txt");
    const pointer = "/runner_evidence/runtime_contract/deployment_prerequisites/authenticated_identity";
    const evidence = { read: { trusted_scope: true }, runner_evidence: { read_access: {}, runtime_contract: {
      deployment_prerequisites: { authenticated_identity: { reviewed_customer_scope: true, verified: false } },
    } } };
    const before = structuredClone(evidence);
    const passage = { start: 1, end: 1, disposition: "needs_decision", responsibility: "deployment", issue_kind: "missing_configuration",
      topic: "Authenticated session", interpretation: "Connect the authenticated session to reviewed scope before use.",
      deployment_prerequisite: "authenticated_identity", draft_paths: ["/read", "/runner_evidence/read_access", pointer] };
    const requests: string[] = [];
    const conversation = createModelAuthoringConversation();
    conversation.policySources = newPolicySourceSession();
    conversation.policySources.snapshots = [identitySource];
    conversation.policySources.active = identitySource.version;
    conversation.policySources.approvals = [{ digest: identitySource.digest,
      destination: authoringDestination({ provider: "openai", model: "gpt-test" }) }];
    const result = await reviewPolicyCoverage({ source: identitySource, draft: evidence,
      session: { provider: "openai", model: "gpt-test", conversation, dependencies: { requestJson: async (request) => {
        requests.push(JSON.stringify(request.body));
        const corrected = { ...passage, draft_paths: [pointer] };
        return { status: 200, body: { output: [{ type: "function_call", call_id: `coverage_${requests.length}`,
          name: "runner__review_policy_coverage", arguments: JSON.stringify({ passages: [requests.length === 1 ? passage : corrected] }) }] } };
      } } }, env: { OPENAI_API_KEY: "test-provider-key" },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("Remove unrelated links");
    expect(requests[1]).toContain("Source lines 1-1");
    expect(policyReviewReadiness(identitySource, result).ready).toBe(true);
    expect(result.passages[0]!.disposition).toBe("needs_decision");
    expect(evidence).toEqual(before);
  });
  it("carries authenticated identity to deployment without waiving an undecided row scope or claiming authentication", () => {
    const identitySource = policyTextSnapshot(Buffer.from("Authenticate each customer and supply the reviewed trusted session identity."), "identity.txt");
    const pointer = "/runner_evidence/runtime_contract/deployment_prerequisites/authenticated_identity";
    const evidence = { runner_evidence: { runtime_contract: { deployment_prerequisites: {
      authenticated_identity: { reviewed_customer_scope: true, verified: false },
    } } } };
    const passage = { start: 1, end: 1, disposition: "needs_decision", responsibility: "deployment", issue_kind: "missing_configuration",
      topic: "Authenticated session", interpretation: "Connect authenticated identity to the reviewed scope before customer use.",
      deployment_prerequisite: "authenticated_identity", draft_paths: [pointer] };
    const checked = parsePolicyCoverage({ passages: [passage] }, identitySource, evidence, "I say authentication is verified");
    expect(checked.passages[0]!.disposition).toBe("needs_decision");
    expect(policyReviewReadiness(identitySource, checked)).toMatchObject({ ready: true });
    expect(policyReadinessItems(checked)[0]).toMatchObject({ kind: "deployment_prerequisite", blocksReview: false });
    expect(policyReadinessItems(checked)[0]!.nextStep).toContain("fixed test identity only for local testing");
    for (const changed of [
      { ...passage, disposition: "implemented" }, { ...passage, issue_kind: "business_choice" },
      { ...passage, responsibility: "application" }, { ...passage, deployment_prerequisite: "eligibility" },
      { ...passage, field_checks: [{ resource: "offers", field: "private_eligibility", expectation: "private" }] },
    ]) expect(() => parsePolicyCoverage({ passages: [changed] }, identitySource, evidence, "")).toThrow("Identity setup");
    evidence.runner_evidence.runtime_contract.deployment_prerequisites.authenticated_identity.reviewed_customer_scope = false;
    expect(() => parsePolicyCoverage({ passages: [passage] }, identitySource, evidence, "Verified, trust me")).toThrow("Identity setup");
  });
  it("keeps unassigned application requirements pending without calling database behavior unsupported", () => {
    const coverage = report();
    expect(policyReadinessItems(coverage).map((item) => [item.kind, item.blocksReview])).toEqual([
      ["deployment_prerequisite", true], ["deployment_prerequisite", true],
    ]);
    expect(policyReviewReadiness(source, coverage).ready).toBe(false);
    expect(policyCoverageSection(source, coverage).children?.map((entry) => entry.title).join("\n")).not.toContain("Not supported");
  });

  it("persists exact operator assignments without claiming verification and invalidates them on source/draft changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-review-readiness-"));
    try {
      const coverage = report(), session = newPolicySourceSession();
      session.snapshots = [source]; session.active = source.version; session.coverage = coverage;
      session.application_assignments = coverage.passages.map((passage) => ({
        source_digest: coverage.source_digest, draft_digest: coverage.draft_digest, start: passage.start, end: passage.end,
        obligations: passage.application_obligations!, owner: "client_application", verified: false, assigned_at: new Date().toISOString(),
      }));
      await savePolicySources(root, session);
      const saved = await loadPolicySources(root, session.id);
      expect(policyReviewReadiness(source, coverage, saved)).toMatchObject({ ready: true });
      expect(policyReviewReadiness(source, coverage, saved).summary.join("\n")).toContain("still unverified");
      expect(coverage.passages.every((entry) => entry.disposition === "unsupported")).toBe(true);
      for (const changed of [{ ...coverage, draft_digest: `sha256:${"a".repeat(64)}` }, { ...coverage, source_digest: `sha256:${"b".repeat(64)}` }]) {
        expect(policyReviewReadiness(source, changed, saved).ready).toBe(false);
      }
      expect(applicationObligationAssigned(coverage, { ...coverage.passages[0]!, field_checks: [{ resource: "offers", field: "eligibility", expectation: "private" }] }, saved)).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("cannot assign away privacy, authorization or arbitrary runtime requirements", () => {
    const entry = report().passages[0]!;
    for (const changed of [
      { ...entry, responsibility: "runner" }, { ...entry, application_obligations: ["authorization"] },
      { ...entry, disposition: "implemented" }, { ...entry, draft_paths: ["/runner_evidence/runtime_contract"] },
      { ...entry, field_checks: [{ resource: "offers", field: "eligibility", expectation: "private" }] },
    ]) expect(() => parsePolicyCoverage({ passages: [changed, report().passages[1]] }, source, draft, "")).toThrow("Application obligations");
    const unsupported = { ...entry, application_obligations: undefined, responsibility: "runner" as const };
    expect(policyReadinessItems({ ...report(), passages: [unsupported] })[0]!.blocksReview).toBe(true);
  });

  it("does not lose mixed business, mechanical and client duties behind an all-passages test", () => {
    const coverage = report();
    coverage.passages.push({ start: 1, end: 1, disposition: "needs_decision", issue_kind: "schema_meaning", responsibility: "operator",
      interpretation: "Does c7 record a private revision or a customer-visible update?", topic: "Revision meaning", draft_paths: [] });
    coverage.passages.push({ start: 2, end: 2, disposition: "conflict", issue_kind: "coverage_link", responsibility: "runner",
      interpretation: "Check current evidence.", topic: "Existing controls", draft_paths: [] });
    expect(policyReadinessItems(coverage).map((item) => item.kind)).toEqual([
      "deployment_prerequisite", "deployment_prerequisite", "business_decision", "mechanical_correction",
    ]);
    expect(policyReadinessItems()).toMatchObject([{ kind: "provider_failure", blocksReview: true }]);
  });
});

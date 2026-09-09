import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { parsePolicyCoverage } from "./authoring-policy-coverage.js";
import { newPolicySourceSession, policyTextSnapshot, type PolicyPassage } from "./authoring-policy-source.js";
import { readPrivacyReview, readPrivacySummary, readPrivacyExplanationFacts } from "./read-boundary-privacy-review.js";
import { readBoundaryReviewSections } from "./read-boundary-review-view.js";
import { automaticApprovalBusinessSummary } from "./authoring-business-review.js";
import { formatReadActivationBusinessSummary } from "./boundary-commands.js";

function fixture() {
  const boundary: ExplorationBoundaryDraft = {
    schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "staging",
    source: "local_postgres", compiler_version: "1.8.0", spec_version: "1.11.0", reporting_timezone: "UTC",
    trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
    generation_lock_fingerprint: `sha256:${"a".repeat(64)}`, role_posture_fingerprint: `sha256:${"b".repeat(64)}`,
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [],
    pack: { name: "reviewed", resources: [{ id: "telecom.support_cases", label: "Support cases", schema: "telecom", table: "support_cases",
      primary_key: "case_id", tenant_key: "account_id",
      field_types: { case_id: "uuid", account_id: "uuid", case_number: "text", version: "integer", updated_at: "timestamp" }, field_enums: {},
      field_metadata: { updated_at: { label: "Last updated date" } },
      selectable_fields: ["case_number", "updated_at"], kept_out_fields: ["account_id"], model_withheld_fields: ["case_id", "version"],
      filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [], count_distinct_fields: [],
      time_bucket_fields: {}, relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true,
    }] },
  };
  const source = policyTextSnapshot(Buffer.from("Customers may see relevant dates. Internal revision markers remain private."), "rules.txt");
  const session = newPolicySourceSession();
  session.snapshots.push(source); session.active = 1;
  session.operator_messages = ["Customers may see when their support case was last updated. Keep version counters private."];
  const draft = policyCoverageDraft({ read: boundary, decisions: [], actions: [] });
  const passage: PolicyPassage = { start: 1, end: 1, disposition: "implemented",
    interpretation: "The operator clarified that support_cases.updated_at is a customer-facing update date; the separate version stays private.",
    draft_paths: ["/runner_evidence/read_access/telecom.support_cases"], field_checks: [
      { resource: "telecom.support_cases", field: "updated_at", expectation: "business_visible" },
      { resource: "telecom.support_cases", field: "version", expectation: "private" },
    ] };
  const report = parsePolicyCoverage({ passages: [passage] }, source, draft, session.operator_messages.join("\n"));
  return { boundary, session, coverage: { report, draft } };
}

describe("exact-revision privacy explanation evidence", () => {
  it("names rolling business scope only when a reviewed identity binding proves it", () => {
    const { boundary } = fixture();
    const action = { approval_class: { shared_limits: [
      { id: "customer", scope: "tenant" as const, kind: "count" as const, maximum: 3, window_seconds: 86400 },
      { id: "all", scope: "capability" as const, kind: "count" as const, maximum: 10, window_seconds: 86400 },
    ] } };
    expect(automaticApprovalBusinessSummary(action, boundary)).toBe("At most 10 automatic approvals for this outcome overall and 3 automatic approvals per trusted group in any rolling 24 hours");
    const root = structuredClone(boundary.pack.resources[0]!);
    root.primary_key = "account_id"; root.id = "telecom.accounts"; root.table = "accounts"; root.label = "Customer accounts";
    boundary.pack.resources.push(root);
    expect(automaticApprovalBusinessSummary(action, boundary)).toContain("3 automatic approvals per customer account in any rolling 24 hours");
    root.label = "Campus groups";
    expect(automaticApprovalBusinessSummary(action, boundary)).toContain("per campus group");
    root.primary_key = "other_id";
    expect(automaticApprovalBusinessSummary(action, boundary)).not.toContain("per campus group");
  });
  it("reconciles the older checkpoint's checked date interpretation without a new permission or interpretation record", () => {
    const input = fixture(), before = structuredClone(input);
    expect(input.session.read_interpretations).toBeUndefined();
    const review = readPrivacyReview(input);
    expect(review.coverage).toBe("current");
    expect(review.checkedPrivateFields).toBe(1);
    expect(readPrivacySummary(review).join("\n")).toContain("unavailable to customer viewing AND analysis");
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({ resource: "telecom.support_cases", field: "updated_at", raw: true,
      status: "business_meaning_checked" });
    expect(readPrivacySummary(review).join("\n")).toContain("Support cases / Last updated date");
    expect(readPrivacySummary(review).join("\n")).not.toMatch(/Privacy decision|Privacy advisory/u);
    expect(readPrivacyExplanationFacts(review).join("\n")).toContain("telecom.support_cases.updated_at");
    expect(input).toEqual(before);
    expect(input.boundary.pack.resources[0]!.selectable_fields).toEqual(["case_number", "updated_at"]);
  });
  it("keeps a different exposed version field visible as its own advisory without a blanket waiver", () => {
    const input = fixture();
    input.boundary.pack.resources[0]!.selectable_fields.push("version");
    input.boundary.pack.resources[0]!.model_withheld_fields = ["case_id"];
    input.coverage.draft = policyCoverageDraft({ read: input.boundary, decisions: [], actions: [] });
    input.coverage.report = parsePolicyCoverage({ passages: [{ ...input.coverage.report.passages[0],
      field_checks: [{ resource: "telecom.support_cases", field: "updated_at", expectation: "business_visible" }] }] },
    input.session.snapshots[0]!, input.coverage.draft, input.session.operator_messages!.join("\n"));
    const review = readPrivacyReview(input);
    expect(review.findings.find((finding) => finding.field === "updated_at")!.status).toBe("business_meaning_checked");
    expect(review.findings.find((finding) => finding.field === "version")!.status).toBe("advisory");
    expect(readPrivacySummary(review).join("\n")).toContain("Support cases / version");
  });
  it("honors the r3 operator override only when its exact quote, revision and returned field are validated", () => {
    const input = fixture();
    input.coverage.report.passages[0]!.disposition = "overridden";
    input.coverage.report.passages[0]!.operator_override = input.session.operator_messages![0]!;
    expect(readPrivacyReview(input).findings[0]!.status).toBe("business_meaning_checked");
    expect(readPrivacySummary(readPrivacyReview(input)).join("\n")).toContain("as you requested");
    input.coverage.report.passages[0]!.operator_override = "Invented operator approval";
    expect(readPrivacyReview(input).findings[0]!.status).toBe("advisory");
    input.coverage.report.passages[0]!.operator_override = input.session.operator_messages![0]!;
    input.boundary.pack.resources[0]!.selectable_fields = ["case_number"];
    expect(readPrivacyReview(input).findings.some((finding) => finding.field === "updated_at" && finding.status === "business_meaning_checked")).toBe(false);
  });
  it.each(["source", "read", "action", "missing", "invalid_claim"] as const)("does not reuse %s coverage as current interpretation evidence", (change) => {
    const input = fixture();
    if (change === "source") { input.session.snapshots.push(policyTextSnapshot(Buffer.from("New policy"), "rules.txt", 2)); input.session.active = 2; }
    if (change === "read") input.boundary.budgets.max_queries_per_session -= 1;
    if (change === "action") input.coverage.report.draft_digest = `sha256:${"d".repeat(64)}`;
    if (change === "invalid_claim") input.coverage.report.passages[0]!.field_checks![0]!.expectation = "private";
    const review = readPrivacyReview({ ...input, coverage: change === "missing" ? undefined : input.coverage });
    expect(review.coverage).toBe("unavailable");
    expect(review.checkedPrivateFields).toBeUndefined();
    expect(readPrivacySummary(review).join("\n")).not.toContain("Policy-private information:");
    expect(review.findings[0]!.status).toBe("advisory");
    expect(readPrivacySummary(review).join("\n")).toContain("verification is unavailable");
    expect(readPrivacySummary(review).join("\n")).not.toContain("Confirmed meaning:");
  });
  it("keeps an explicit conflicting policy requirement unresolved even alongside a checked visible meaning", () => {
    const input = fixture();
    input.coverage.report.passages.push({ ...input.coverage.report.passages[0]!, disposition: "conflict",
      interpretation: "An unresolved policy requires this date to remain private.", field_checks: [
        { resource: "telecom.support_cases", field: "updated_at", expectation: "private" },
      ] });
    const review = readPrivacyReview(input);
    expect(review.findings[0]!.status).toBe("policy_decision");
    expect(readPrivacySummary(review).join("\n")).toContain("Privacy decision:");
  });
  it("provides complete direct local evidence without a model or table hunt", () => {
    const input = fixture(), privacy = readPrivacyReview(input);
    const sections = readBoundaryReviewSections({ boundary: input.boundary, digest: privacy.digest, privacy });
    expect(sections[0]!.id).toBe("privacy_findings");
    const lines = sections[0]!.lines.join("\n");
    for (const fact of ["telecom.support_cases.updated_at", "Agent receives values: yes", "Reason for flagging", "operator clarified", privacy.digest]) expect(lines).toContain(fact);
    expect(sections[0]!.children).toBeUndefined();
    expect(sections.find((section) => section.id === "json")!.lines.join("\n")).toContain('"case_number"');
  });
  it("explains a hidden-value analysis advisory distinctly from raw exposure", () => {
    const input = fixture();
    input.boundary.pack.resources[0]!.filterable_fields.version = ["eq"];
    const review = readPrivacyReview({ boundary: input.boundary });
    expect(review.findings.find((finding) => finding.field === "version")).toMatchObject({ raw: false, status: "advisory", analysis: ["filter:eq"] });
    const summary = formatReadActivationBusinessSummary({ candidate: input.boundary } as never).join("\n");
    expect(summary).toContain("Analysis without raw values: 1 field permits some analysis but not direct viewing");
    expect(summary).toContain("These are not fully private");
    const stale = readPrivacyReview(input);
    expect(stale.checkedPrivateFields).toBeUndefined();
    expect(readPrivacySummary(stale).join("\n")).not.toContain("Policy-private information:");
  });
});

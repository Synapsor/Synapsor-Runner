import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { parsePolicyCoverage } from "./authoring-policy-coverage.js";
import { newPolicySourceSession, policyTextSnapshot, type PolicyPassage } from "./authoring-policy-source.js";
import { readPrivacyReview, readPrivacySummary, readPrivacyExplanationFacts, readPrivacyFindingLines } from "./read-boundary-privacy-review.js";
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

function studentPrivacyFixture() {
  const { boundary } = fixture();
  const visible: Record<string, string[]> = {
    courses: ["course_code", "course_title"], class_sections: ["section_label", "meeting_days", "instructor_name"],
    registration_cases: ["credits", "registration_state", "waitlist_position"],
    waitlist_offers: ["offer_state", "expires_at"], student_holds: ["hold_type", "hold_state"],
  };
  const extra: Record<string, string[]> = {
    advising_completions: ["advisor_name", "completed_at", "recorded_by"],
    prerequisite_satisfactions: ["evidence_source", "satisfied_on"], registration_cases: ["drop_reason", "dropped_at", "term_code"],
    student_holds: ["placed_at", "released_at"], student_records: ["program_name"], waitlist_offers: ["opens_at"],
  };
  const template = boundary.pack.resources[0]!;
  boundary.pack.resources = [...new Set([...Object.keys(visible), ...Object.keys(extra)])].map((table) => {
    const fields = [...(visible[table] ?? []), ...(extra[table] ?? [])];
    const registration = table === "registration_cases";
    return { ...structuredClone(template), id: `university.${table}`, schema: "university", table, label: table,
      primary_key: "record_id", tenant_key: "institution_id", principal_key: "student_id", field_metadata: {},
      field_types: Object.fromEntries([...fields, "record_id", "institution_id", "student_id",
        ...(registration ? ["updated_at", "row_version"] : [])].map((field) => [field, "text"])),
      selectable_fields: [...fields, ...(registration ? ["updated_at"] : [])],
      kept_out_fields: ["institution_id", "student_id"], model_withheld_fields: registration ? ["updated_at"] : [],
    };
  });
  const source = policyTextSnapshot(Buffer.from("Students may see the listed registration, course, section, offer and hold facts.\nInternal records, revision markers and staff notes stay private."), "student-rules.txt");
  const session = newPolicySourceSession();
  session.snapshots.push(source); session.active = 1;
  const checks = (fields: Record<string, string[]>, expectation: "private" | "business_visible") =>
    Object.entries(fields).flatMap(([table, fields]) => fields.map((field) => ({ resource: `university.${table}`, field, expectation })));
  const passages: PolicyPassage[] = [
    { start: 1, end: 1, disposition: "conflict", draft_paths: ["/read"], issue_kind: "contradiction",
      interpretation: "Listed student facts are returned, but unlisted verification details are also returned.",
      field_checks: [...checks(visible, "business_visible"), ...checks(extra, "private")] },
    { start: 2, end: 2, disposition: "conflict", draft_paths: ["/read"], issue_kind: "contradiction",
      interpretation: "Revision markers and updated_at are already private, but staff completion evidence is returned.",
      field_checks: checks({ advising_completions: extra.advising_completions!, registration_cases: ["updated_at", "row_version"] }, "private") },
  ];
  const draft = policyCoverageDraft({ read: boundary, decisions: [], actions: [] });
  const report = parsePolicyCoverage({ passages }, source, draft, "");
  return { boundary, session, coverage: { report, draft } };
}

describe("exact-revision privacy explanation evidence", () => {
  it("compares all 26 student field expectations without inheriting the two passage conflicts", () => {
    const input = studentPrivacyFixture(), before = structuredClone(input);
    const review = readPrivacyReview(input);
    expect(review.coverage).toBe("current");
    expect(review.findings).toHaveLength(26);
    const decisions = review.findings.filter((finding) => finding.status === "policy_decision");
    expect(decisions).toHaveLength(12);
    expect(decisions.every((finding) => finding.raw && !finding.analysis.length)).toBe(true);
    expect(review.findings.filter((finding) => finding.status === "field_access_matches")).toHaveLength(14);
    expect(review.findings.filter((finding) => finding.status === "business_meaning_checked")).toHaveLength(0);
    expect(review.checkedPrivateFields).toBe(2);
    expect(readPrivacySummary(review).join("\n")).toContain("Privacy decision: 12 fields");
    expect(readPrivacySummary(review).join("\n")).not.toContain("Privacy decision: 26 fields");
    expect(readPrivacySummary(review).join("\n")).toContain("Unresolved Read passages: 2. Inspect privacy findings");
    const details = readBoundaryReviewSections({ boundary: input.boundary, digest: review.digest, privacy: review })[0]!.lines.join("\n");
    expect(details).toContain("Unresolved Read passage, lines 1-1");
    expect(details).toContain("Unresolved Read passage, lines 2-2");
    const returned = decisions.find((finding) => finding.field === "advisor_name")!;
    expect(readPrivacyFindingLines(returned).join("\n")).toContain("field values are returned");
    expect(readPrivacyFindingLines(returned).join("\n")).not.toContain("analysis of hidden values");
    const privateDate = review.findings.find((finding) => finding.field === "updated_at")!;
    expect(privateDate).toMatchObject({ raw: false, analysis: [], status: "field_access_matches" });
    expect(readPrivacyFindingLines(privateDate).join("\n")).toContain("Expected access: private. Current access matches");
    expect(input).toEqual(before);
  });
  it("retains a Read passage concern without fabricating field-level failures or resolving policy", () => {
    const input = fixture();
    input.boundary.pack.resources[0]!.selectable_fields = ["case_number"];
    input.coverage.draft = policyCoverageDraft({ read: input.boundary, decisions: [], actions: [] });
    input.coverage.report = parsePolicyCoverage({ passages: [{ start: 1, end: 1, disposition: "conflict", draft_paths: ["/read"],
      interpretation: "This Read passage still needs a field-specific privacy decision." }] }, input.session.snapshots[0]!, input.coverage.draft, "");
    const before = structuredClone(input), review = readPrivacyReview(input);
    expect(review.coverage).toBe("current");
    expect(review.findings).toHaveLength(0);
    const summary = readPrivacySummary(review).join("\n");
    expect(summary).toContain("Unresolved Read passages: 1. Inspect privacy findings");
    expect(summary).toContain("View exact Read Boundary details");
    const details = readBoundaryReviewSections({ boundary: input.boundary, digest: review.digest, privacy: review })[0]!.lines.join("\n");
    expect(details).toContain("Unresolved Read passage, lines 1-1");
    expect(details).toContain("No field-specific expectation supplied");
    expect(readPrivacyExplanationFacts(review).join("\n")).toContain(input.coverage.report.passages[0]!.interpretation);
    expect(summary).not.toContain("Privacy decision:");
    expect(input).toEqual(before);
  });
  it.each(["missing_display", "hidden_analysis"] as const)("retains an exact %s mismatch as a field decision", (change) => {
    const input = studentPrivacyFixture();
    const resource = input.boundary.pack.resources.find((resource) => resource.table === "registration_cases")!;
    if (change === "missing_display") resource.model_withheld_fields!.push("credits");
    else resource.filterable_fields.updated_at = ["eq"];
    input.coverage.draft = policyCoverageDraft({ read: input.boundary, decisions: [], actions: [] });
    input.coverage.report = parsePolicyCoverage({ passages: input.coverage.report.passages }, input.session.snapshots[0]!, input.coverage.draft, "");
    const field = change === "missing_display" ? "credits" : "updated_at";
    const finding = readPrivacyReview(input).findings.find((finding) => finding.field === field)!;
    expect(finding).toMatchObject({ raw: false, status: "policy_decision" });
    expect(readPrivacyFindingLines(finding).join("\n")).toContain("Current access differs");
    if (change === "missing_display") expect(readPrivacyFindingLines(finding).join("\n")).not.toContain("analysis of hidden values");
  });
  it("uses the hidden-analysis reason only when a raw-withheld field actually allows analysis", () => {
    const input = studentPrivacyFixture();
    const resource = input.boundary.pack.resources.find((resource) => resource.table === "advising_completions")!;
    resource.model_withheld_fields = ["recorded_by"];
    resource.groupable_fields = ["recorded_by"];
    input.coverage.draft = policyCoverageDraft({ read: input.boundary, decisions: [], actions: [] });
    input.coverage.report = parsePolicyCoverage({ passages: input.coverage.report.passages }, input.session.snapshots[0]!, input.coverage.draft, "");
    const finding = readPrivacyReview(input).findings.find((finding) => finding.field === "recorded_by")!;
    expect(finding).toMatchObject({ raw: false, analysis: ["group"], roles: [], status: "policy_decision" });
    expect(readPrivacyFindingLines(finding).join("\n")).toContain("Reason for flagging: analysis of hidden values");
  });
  it("does not include a structural advisory in the field decision count", () => {
    const input = studentPrivacyFixture();
    const resource = input.boundary.pack.resources.find((resource) => resource.table === "registration_cases")!;
    resource.field_types.internal_marker = "text";
    resource.selectable_fields.push("internal_marker");
    input.coverage.draft = policyCoverageDraft({ read: input.boundary, decisions: [], actions: [] });
    input.coverage.report = parsePolicyCoverage({ passages: input.coverage.report.passages }, input.session.snapshots[0]!, input.coverage.draft, "");
    const review = readPrivacyReview(input), summary = readPrivacySummary(review).join("\n");
    expect(review.findings.find((finding) => finding.field === "internal_marker")!.status).toBe("advisory");
    expect(summary).toContain("Privacy decision: 12 fields");
    expect(summary).toContain("Privacy advisory: registration_cases / internal marker");
  });
  it("does not certify a hidden field private when its recorded expectations contradict each other", () => {
    const input = fixture();
    input.boundary.pack.resources[0]!.model_withheld_fields!.push("updated_at");
    input.coverage.draft = policyCoverageDraft({ read: input.boundary, decisions: [], actions: [] });
    input.coverage.report = parsePolicyCoverage({ passages: [
      { ...input.coverage.report.passages[0]!, field_checks: [
        { resource: "telecom.support_cases", field: "updated_at", expectation: "private" },
      ] },
      { ...input.coverage.report.passages[0]!, disposition: "conflict", field_checks: [
        { resource: "telecom.support_cases", field: "updated_at", expectation: "business_visible" },
      ] },
    ] }, input.session.snapshots[0]!, input.coverage.draft, "");
    const review = readPrivacyReview(input);
    expect(review.checkedPrivateFields).toBe(0);
    expect(review.findings[0]).toMatchObject({ status: "policy_decision", raw: false });
    const lines = readPrivacyFindingLines(review.findings[0]!).join("\n");
    expect(lines).toContain("Recorded field expectations conflict with each other");
    expect(lines).not.toContain("analysis of hidden values");
  });
  it("keeps 40 long passage concerns out of the default screen while retaining all exact details and a bounded model explanation", () => {
    const input = studentPrivacyFixture(), review = readPrivacyReview(input);
    review.passageConcerns = Array.from({ length: 40 }, (_, index) => ({ start: index + 1, end: index + 1,
      interpretation: `Concern ${index + 1}: ${"An unresolved Read concern. ".repeat(40)}`, hasFieldChecks: false }));
    const before = structuredClone(review), facts = readPrivacyExplanationFacts(review).join("\n");
    const summary = readPrivacySummary(review), defaultScreen = formatReadActivationBusinessSummary({ candidate: input.boundary } as never, new Set(), review);
    expect(summary).toHaveLength(readPrivacySummary({ ...review, passageConcerns: review.passageConcerns.slice(0, 1) }).length);
    expect(summary.join("\n")).toContain("Unresolved Read passages: 40. Inspect privacy findings");
    expect(summary.join("\n")).not.toContain("Concern 1:");
    expect(Buffer.byteLength(summary.join("\n"))).toBeLessThan(1_500);
    expect(defaultScreen.length).toBeLessThanOrEqual(12);
    expect(Buffer.byteLength(defaultScreen.join("\n"))).toBeLessThan(2_500);
    const details = readBoundaryReviewSections({ boundary: input.boundary, digest: review.digest, privacy: review })[0]!.lines.join("\n");
    for (const passage of review.passageConcerns) {
      expect(details).toContain(`Unresolved Read passage, lines ${passage.start}-${passage.end}`);
      expect(details).toContain(passage.interpretation);
      expect(defaultScreen.join("\n")).not.toContain(passage.interpretation);
    }
    expect(details.match(/No field-specific expectation supplied/gu)).toHaveLength(40);
    expect(Buffer.byteLength(facts)).toBeLessThanOrEqual(24_000);
    expect(facts).toContain("Additional findings are in Inspect privacy findings");
    expect(facts).toContain("Unresolved Read passages: 40");
    expect(review).toEqual(before);
  });
  it("shows outcome-filtered approval accounting without implying a bundle-wide pool", () => {
    const { boundary } = fixture();
    const action = { rule: { outcome: "telecom.offered_plan_change" }, approval_class: { shared_limits: [
      { id: "process", scope: "boundary" as const, kind: "count" as const, maximum: 10, window_seconds: 86400, capability: "telecom.offered_plan_change" },
      { id: "customer", scope: "tenant" as const, kind: "count" as const, maximum: 3, window_seconds: 86400, capability: "telecom.offered_plan_change" },
      { id: "unrelated", scope: "boundary" as const, kind: "count" as const, maximum: 99, window_seconds: 86400, capability: "telecom.case_update" },
    ] } };
    const before = structuredClone(action);
    const summary = automaticApprovalBusinessSummary(action, boundary);
    expect(summary).toBe("At most 10 automatic approvals for this outcome overall and 3 automatic approvals per trusted group for this outcome in any rolling 24 hours");
    expect(summary).not.toMatch(/across this action bundle|99/u);
    expect(action).toEqual(before);
  });
  it("keeps unfiltered limits explicitly shared and names filters when no current outcome is supplied", () => {
    const { boundary } = fixture();
    const limits = [{ id: "all", scope: "boundary" as const, kind: "count" as const, maximum: 10, window_seconds: 86400 }];
    expect(automaticApprovalBusinessSummary({ approval_class: { shared_limits: limits } }, boundary)).toContain("across this action bundle");
    expect(automaticApprovalBusinessSummary({ approval_class: { shared_limits: [{ ...limits[0]!, capability: "telecom.offered_plan_change" }] } }, boundary))
      .toContain("for outcome telecom.offered_plan_change overall");
    expect(automaticApprovalBusinessSummary({ approval_class: { shared_limits: [{ ...limits[0]!, maximum: 1 }] } }, boundary))
      .toContain("1 automatic approval across this action bundle");
  });
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

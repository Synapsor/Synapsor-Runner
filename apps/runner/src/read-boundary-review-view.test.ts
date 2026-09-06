import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { loadReadReviewDiff, saveReadReviewDiff, readRevisionDiff, readBoundaryReviewSections, findReviewSection, reviewSectionLines } from "./read-boundary-review-view.js";
import { restrictPrivateFieldAnalysis } from "./read-field-privacy.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { formatReadActivationDecisionSummary } from "./boundary-commands.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { knownPolicyPrivacyReductions, policyReviewReadiness } from "./authoring-review-readiness.js";
import { policyTextSnapshot, type PolicyCoverage } from "./authoring-policy-source.js";

function fixture(): ExplorationBoundaryDraft {
  return { schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "staging",
    source: "local_postgres", compiler_version: "1.8.0", spec_version: "1.11.0", reporting_timezone: "UTC",
    trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
    generation_lock_fingerprint: `sha256:${"a".repeat(64)}`, role_posture_fingerprint: `sha256:${"b".repeat(64)}`,
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [],
    pack: { name: "review", resources: [{ id: "university.r17", schema: "university", table: "r17", primary_key: "id", tenant_key: "org",
      field_types: { id: "uuid", org: "text", c7: "integer", course_number: "text", created_at: "timestamp" },
      field_metadata: { c7: { label: "Private eligibility score", description: "Internal enrollment approval control." } },
      field_enums: {}, selectable_fields: ["id", "c7", "course_number"], kept_out_fields: ["org"], model_withheld_fields: ["c7"],
      filterable_fields: { c7: ["eq"] }, sortable_fields: ["c7"], groupable_fields: [], aggregate_measures: ["c7"],
      count_distinct_fields: ["c7"], time_bucket_fields: {}, relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true,
      derived_measures: [{ name: "score_total", label: "Score total", shape: "running_total", base_measure: { function: "sum", field: "c7" } }],
      numeric_bands: [{ name: "score_band", label: "Score band", field: "c7", edges: [0, 50, 100], bucket_labels: ["low", "high"] }],
    }] } };
}

describe("progressive Read authority review", () => {
  it("keeps mandatory coverage distinct from optional role hints and refuses automatic guesses", () => {
    const read = fixture();
    read.pack.resources[0]!.selectable_fields.push("created_at");
    const report: PolicyCoverage = { source_digest: `sha256:${"a".repeat(64)}`, draft_digest: `sha256:${"b".repeat(64)}`, passages: [{
      start: 1, end: 1, disposition: "conflict", topic: "Internal-field privacy", interpretation: "IDs must be private.", draft_paths: ["/read"],
      responsibility: "runner", issue_kind: "contradiction", field_checks: [
        { resource: "university.r17", field: "id", expectation: "private" },
        { resource: "university.r17", field: "org", expectation: "private" },
        { resource: "university.r17", field: "created_at", expectation: "private" },
      ],
    }] };
    const original = structuredClone(read);
    expect(knownPolicyPrivacyReductions({ report, read, actions: [] }).map((change) => change.field)).toEqual(["id"]);
    report.passages[0]!.issue_kind = "schema_meaning";
    expect(knownPolicyPrivacyReductions({ report, read, actions: [] })).toEqual([]);
    const source = policyTextSnapshot(Buffer.from("Keep internal fields private."), "Rules.txt");
    const readiness = policyReviewReadiness(source, report);
    expect(readiness).toMatchObject({ ready: false, privacy: true });
    expect(readiness.summary.join("\n")).toContain("Activation is unavailable");
    expect(policyReviewReadiness(source)).toMatchObject({ ready: false });
    report.passages[0]!.disposition = "implemented";
    expect(policyReviewReadiness(source, report)).toMatchObject({ ready: true });
    expect(read).toEqual(original);
  });

  it("names reductions and explains overlapping private grants without a technical counting exercise", () => {
    const before = fixture(), after = structuredClone(before);
    after.pack.resources[0]!.model_withheld_fields!.push("id");
    let diff = readRevisionDiff(before, after);
    expect(diff.lines.join("\n")).toContain("Hidden from the agent: university.r17.id");
    expect(diff.lines.join("\n")).toContain("No new information becomes readable");
    expect(diff.lines.join("\n")).not.toMatch(/0 fields|individual access|Total:/u);
    after.pack.resources[0]!.kept_out_fields = [];
    after.pack.resources[0]!.model_withheld_fields!.push("org");
    after.pack.resources[0]!.selectable_fields.push("org");
    diff = readRevisionDiff(before, after);
    expect(diff.lines.join("\n")).toContain("same newly readable fields, not 1 additional fields");
    expect(findReviewSection([diff], "university.r17.org")!.lines[0]).toContain("necessity has not been established");
  });
  it("does not describe an analytical restriction as hiding visible values", () => {
    const before = fixture(), after = structuredClone(before);
    before.pack.resources[0]!.filterable_fields.course_number = ["eq"];
    const diff = readRevisionDiff(before, after);
    expect(diff.lines.join("\n")).toContain("Fewer ways to query information: university.r17.course_number");
    expect(diff.lines.join("\n")).not.toContain("Hidden from the agent");
  });
  it("gives coverage current confirmation and effective privacy evidence, not a stale checklist", () => {
    const read = fixture(), before = structuredClone(read);
    const result = policyCoverageDraft({ read, actions: [], decisions: [
      { decision: "Reviewed customer scope", confirmed: true }, { decision: "Resolve coded score meaning", confirmed: false },
    ] });
    expect(result.runner_evidence.read_review).toMatchObject({ confirmed: ["Reviewed customer scope"], pending: ["Resolve coded score meaning"], activation: "separate_operator_review" });
    const resource = result.runner_evidence.read_access["university.r17"]!;
    expect(resource.trusted_tenant_field).toBe("org");
    const fields = resource.fields;
    expect(fields.c7).toMatchObject({ actual_values_returned: false, private_read_selection: true });
    expect(fields.c7!.model_analysis.length).toBeGreaterThan(0); // Withholding values is not full privacy.
    expect(fields.course_number).toMatchObject({ actual_values_returned: true, kept_out: false });
    expect(fields.org).toMatchObject({ actual_values_returned: false, kept_out: true });
    expect(fields.created_at).toMatchObject({ actual_values_returned: false, private_read_selection: false });
    expect(read).toEqual(before);
    expect(() => canonicalJsonDigest(result)).not.toThrow();
    expect(result.runner_evidence.runtime_contract.request_identity).toContain("not a client-supplied request ID");
  });
  it("distinguishes new model-visible access from new private use", () => {
    const before = fixture(), after = structuredClone(before);
    before.pack.resources[0]!.kept_out_fields.push("course_number");
    const diff = readRevisionDiff(before, after);
    const change = findReviewSection([diff], "university.r17.course_number")!;
    expect(change.title).toContain("agent can see values");
    expect(change.lines.join("\n")).toContain("raw values may now be returned to the model");
    expect(diff.changeCounts).toMatchObject({ rawAdded: 1, selectionAdded: 1 });
  });

  it("removes derived inference through reviewed links without removing the private link", () => {
    const before = fixture();
    const target = before.pack.resources[0]!;
    target.id = "university.r:17";
    const related = structuredClone(target);
    related.id = "university.enrollments";
    related.table = "enrollments";
    related.relationships = [{ id: "course", target_resource: target.id, local_columns: ["id"], target_columns: ["id"],
      cardinality: "many_to_one", counted_entity: "enrollments", max_fan_out: 1 }];
    related.numeric_bands![0]!.relationship = "course";
    const measure = related.derived_measures![0]!;
    if ("base_measure" in measure && "field" in measure.base_measure) measure.base_measure.relationship = "course";
    before.pack.resources.push(related);
    const after = structuredClone(before);
    restrictPrivateFieldAnalysis(after, target.id, ["c7"]);
    expect(after.pack.resources[1]!.relationships).toEqual(related.relationships);
    expect(after.pack.resources[1]!.derived_measures).toEqual([]);
    expect(after.pack.resources[1]!.numeric_bands).toEqual([]);
    const diff = readRevisionDiff(before, after);
    expect(diff.changeCounts!.fields).toBe(1);
    expect(findReviewSection([diff], "university.enrollments:derived_measures")).toBeDefined();
  });

  it("accounts for operations, no-return classifications and new private access without conflating counts", async () => {
    const before = fixture(), after = structuredClone(before), resource = after.pack.resources[0]!;
    resource.kept_out_fields.push("id");
    const original = structuredClone(after);
    resource.kept_out_fields = resource.kept_out_fields.filter((field) => field !== "id");
    resource.model_withheld_fields!.push("id");
    restrictPrivateFieldAnalysis(after, resource.id, ["id", "c7"]);
    expect(() => canonicalJsonDigest(after)).not.toThrow();
    expect(resource.derived_measures).toEqual([]);
    expect(resource.numeric_bands).toEqual([]);
    expect(resource.selectable_fields).toContain("c7");
    expect(resource.selectable_fields).toContain("course_number");
    const diff = readRevisionDiff(original, after, [{ resource: resource.id, field: "id", rationale: "Opaque reference identity." }]);
    expect(diff.changeCounts).toMatchObject({ fields: 2, rawRemoved: 0, rawAdded: 0, selectionAdded: 1 });
    expect(findReviewSection([diff], "university.r17.id")!.lines.join("\n")).toContain("NEW ACCESS");
    expect(findReviewSection([diff], "university.r17.c7")!.lines.join("\n")).toContain("Model analysis after: none");
    const sections = readBoundaryReviewSections({ boundary: after, digest: "new", changes: diff });
    expect(sections[0]!.children![0]!.children!.find((child) => child.id === "created_at")!.title).toContain("NO RAW RETURN");
    expect(sections[0]!.children![0]!.children!.find((child) => child.id === "c7")!.lines.join("\n")).toContain("Private eligibility score");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-review-diff-"));
    try {
      await saveReadReviewDiff(root, "new", diff);
      expect(await loadReadReviewDiff(root, "new")).toEqual(diff);
      expect(await loadReadReviewDiff(root, "other")).toBeUndefined();
      expect(await loadReadReviewDiff(root + "/missing", "new")).toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
    expect(before.pack.resources[0]!.derived_measures).toHaveLength(1);
  });

  it("separates representation-only changes from unselected field access expansions", () => {
    const before = fixture(), after = structuredClone(before);
    after.pack.resources[0]!.model_withheld_fields!.push("created_at");
    let diff = readRevisionDiff(before, after);
    expect(diff.changeCounts).toMatchObject({ fields: 1, permissions: 0, representation: 1, selectionAdded: 0 });
    expect(findReviewSection([diff], "university.r17.created_at")!.title).toContain("classification only; access unchanged");
    after.pack.resources[0]!.selectable_fields.push("created_at");
    diff = readRevisionDiff(before, after);
    expect(diff.changeCounts).toMatchObject({ rawAdded: 0, rawRemoved: 0, permissions: 1, selectionAdded: 1, representation: 0 });
    expect(reviewSectionLines(diff).join("\n")).toContain("Runner row selection: not allowed -> allowed");
    expect(reviewSectionLines(diff).join("\n")).not.toContain("Conflict/version guard remains");
  });

  it.each([52, 80, 100, 160, 240])("formats the decision without overflowing %i columns", (width) => {
    const lines = ["Automatic completion: execution review pending; not enabled.", "Information: account details and offered plans.", "Scope: signed-in customer's account only."];
    const rendered = formatReadActivationDecisionSummary(lines, width);
    if (width < 96) expect(rendered).toEqual(lines);
    else {
      expect(rendered[1]).toContain("DECISION");
      expect(rendered.every((line) => line.length <= width)).toBe(true);
      expect(rendered.filter((line) => line.startsWith("+"))).toHaveLength(3);
    }
  });
});

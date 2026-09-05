import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { loadReadReviewDiff, saveReadReviewDiff, readRevisionDiff, readBoundaryReviewSections } from "./read-boundary-review-view.js";
import { restrictPrivateFieldAnalysis } from "./read-field-privacy.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { formatReadActivationDecisionSummary } from "./boundary-commands.js";

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
  it("distinguishes new model-visible access from new private use", () => {
    const before = fixture(), after = structuredClone(before);
    before.pack.resources[0]!.kept_out_fields.push("course_number");
    const diff = readRevisionDiff(before, after);
    const change = diff.children!.find((item) => item.id.endsWith(".course_number"))!;
    expect(change.title).toContain("KEPT OUT -> MODEL RAW");
    expect(change.lines.join("\n")).toContain("raw values may now be returned to the model");
    expect(change.lines.join("\n")).not.toContain("private use");
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
    expect(diff.lines[0]).toContain("1 changed resource-qualified fields");
    expect(diff.children!.map((section) => section.id)).toContain("university.enrollments:derived_measures");
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
    expect(diff.lines[0]).toContain("2 changed resource-qualified fields");
    expect(diff.children!.find((child) => child.id.endsWith(".id"))!.lines.join("\n")).toContain("NEW ACCESS");
    expect(diff.children!.find((child) => child.id.endsWith(".c7"))!.lines.join("\n")).toContain("Model analysis after: none");
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

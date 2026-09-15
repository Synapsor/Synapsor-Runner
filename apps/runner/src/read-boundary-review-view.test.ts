import { clientDutyInventory } from "./authoring-client-duties.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { loadReadReviewDiff, saveReadReviewDiff, readRevisionDiff, readBoundaryReviewSections, findReviewSection, reviewSectionLines } from "./read-boundary-review-view.js";
import { restrictPrivateFieldAnalysis } from "./read-field-privacy.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { formatReadActivationDecisionSummary } from "./boundary-commands.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { knownPolicyPrivacyReductions, policyReviewReadiness } from "./authoring-review-readiness.js";
import { policyTextSnapshot, type PolicyCoverage } from "./authoring-policy-source.js";
import { terminalContentWidth, wrapStyledTerminalLine } from "./terminal-layout.js";

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

function permissionsFixture(): ExplorationBoundaryDraft {
  const read = fixture(), resource = read.pack.resources[0]!;
  resource.label = "Enrollment records";
  resource.field_types.internal_note = "text";
  resource.model_withheld_fields!.push("internal_note");
  resource.filterable_fields.c7 = ["eq", "neq", "lt", "lte", "gt", "gte", "in"];
  resource.groupable_fields = ["c7"];
  resource.aggregate_measure_functions = { c7: ["sum", "avg", "stddev_samp", "stddev_pop", "var_samp", "var_pop"] };
  resource.presence_measure_fields = ["c7"];
  resource.time_bucket_fields.created_at = ["day", "week", "month", "year"];
  resource.field_enums.course_number = ["001", "quote\"value", "", ...Array.from({ length: 45 }, (_, index) => `COURSE_${index}`)];
  resource.field_enums.c7 = ["0", "50", "100"];
  resource.derived_measures!.push(
    { name: "score_share", label: "Score share", shape: "percentage", numerator: { function: "count_distinct", field: "course_number" },
      denominator: { function: "count" }, null_policy: "null_on_zero_or_null_denominator" },
    { name: "linked_score", label: "Linked score", shape: "per_unit_average", numerator: { function: "sum", field: "c7", relationship: "course" },
      denominator: { function: "count" }, null_policy: "null_on_zero_or_null_denominator" },
    { name: "score_window", label: "Score window", shape: "moving_average", base_measure: { function: "avg", field: "c7" }, window_size: 3 },
    { name: "score_rank", label: "Score rank", shape: "rank", base_measure: { function: "sum", field: "c7" }, direction: "desc" },
    { name: "child_total", label: "Child total", shape: "child_count_total", child_resource: "university.children", relationship: "parent" },
  );
  resource.numeric_bands!.push({ name: "linked_band", label: "Linked band", field: "c7", relationship: "course", edges: [0, 20, 100], bucket_labels: ["first", "second"] });
  resource.auto_bands = [{ field: "c7", methods: ["quantile", "equal_width"], min_buckets: 2, max_buckets: 8,
    min_bucket_width: 0.5, label_style: "rounded", label_round_to: 0.1 }];
  return read;
}

function overviewField(lines: string[], field: string): string[] {
  const start = lines.findIndex((line) => line === `Field: ${field}` || line.startsWith(`Field: ${field} (`));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf("", start + 1);
  return lines.slice(start, end < 0 ? undefined : end);
}

describe("complete Read field-permission overviews", () => {
  it("shows every field and exact grants in both overview levels without opening child fields", () => {
    const read = permissionsFixture(), first = read.pack.resources[0]!;
    read.pack.resources.push({ ...structuredClone(first), id: "university.r18", table: "r18", label: "Second reviewed resource" });
    const original = structuredClone(read), digest = canonicalJsonDigest(read);
    const resources = findReviewSection(readBoundaryReviewSections({ boundary: read, digest }), "resources")!;
    expect(resources.lines[0]).toContain("all 2 reviewed resources");
    for (const resource of read.pack.resources) {
      const overview = resources.children!.find((section) => section.id === resource.id)!;
      expect(resources.lines.join("\n")).toContain([overview.title, ...overview.lines].join("\n"));
      for (const field of Object.keys(resource.field_types)) overviewField(overview.lines, field);
      const expectedAnalysis = "filter:eq, filter:neq, filter:lt, filter:lte, filter:gt, filter:gte, filter:in, sort, group, measure:sum, measure:avg, measure:stddev_samp, measure:stddev_pop, measure:var_samp, measure:var_pop, presence, distinct, band:score_band, auto band";
      expect(overviewField(overview.lines, "c7")).toEqual([
        "Field: c7 (Private eligibility score)", "Raw access: RUNNER ONLY", "Runner row selection: yes",
        `Model-invocable analysis: ${expectedAnalysis}`, "Presence functions: null_count, non_null_count, completion_rate",
        'Reviewed value allowlist: "0", "50", "100"',
      ]);
      expect(overviewField(overview.lines, "course_number")).toContain("Raw access: MODEL RAW");
      expect(overviewField(overview.lines, "org")).toEqual(["Field: org", "Raw access: KEPT OUT", "Runner row selection: no",
        "Model-invocable analysis: none", "Reviewed value allowlist: none"]);
      expect(overviewField(overview.lines, "created_at")).toEqual(["Field: created_at", "Raw access: NO RAW RETURN", "Runner row selection: no",
        "Model-invocable analysis: time:day, time:week, time:month, time:year", "Reviewed value allowlist: none"]);
      expect(overviewField(overview.lines, "internal_note")).toEqual(["Field: internal_note", "Raw access: RUNNER ONLY", "Runner row selection: no",
        "Model-invocable analysis: none", "Reviewed value allowlist: none"]);
      for (const value of resource.field_enums.course_number!) {
        expect(overviewField(overview.lines, "course_number").join("\n")).toContain(JSON.stringify(value));
      }
      expect(overview.lines.at(-1)).toBe(`End of ${resource.id}: all 6 fields and reviewed analysis definitions shown.`);
      expect(overview.children!.find((field) => field.id === "c7")!.lines).toContain("Label: Private eligibility score");
      expect(overview.children!.find((field) => field.id === "resource_settings")).toBeDefined();
    }
    expect(read).toEqual(original);
    expect(canonicalJsonDigest(read)).toBe(digest);
  });

  it("lists complete named derived definitions and exact fixed/adaptive band policies without JSON", () => {
    const read = permissionsFixture();
    const lines = findReviewSection(readBoundaryReviewSections({ boundary: read, digest: "review" }), "resources")!.lines;
    for (const line of ["Derived measure: score_total (Score total)", "Shape: running_total", 'Base measure: sum(field "c7")',
      "Derived measure: score_share (Score share)", "Shape: percentage", 'Numerator: count_distinct(field "course_number")',
      "Denominator: count()", "Null policy: null_on_zero_or_null_denominator", "Derived measure: linked_score (Linked score)",
      "Shape: per_unit_average", 'Numerator: sum(relationship "course", field "c7")', "Derived measure: score_window (Score window)",
      "Shape: moving_average", 'Base measure: avg(field "c7")', "Window size: 3", "Derived measure: score_rank (Score rank)", "Direction: desc",
      "Derived measure: child_total (Child total)", "Shape: child_count_total", "Child resource: university.children", "Relationship: parent",
      "Numeric band: score_band (Score band)", 'Field reference: field "c7"', "Edges: 0, 50, 100", 'Bucket labels: "low", "high"',
      "Numeric band: linked_band (Linked band)", 'Field reference: relationship "course", field "c7"', "Edges: 0, 20, 100",
      'Bucket labels: "first", "second"', "Auto band field: c7", "Methods: quantile, equal_width", "Bucket count: 2 to 8",
      "Minimum bucket width: 0.5", "Label style: rounded", "Label rounding: 0.1"]) expect(lines).toContain(line);
    expect(lines.some((line) => /^\s*[\[{]/u.test(line))).toBe(false);
  });

  it.each(["legacy", "explicit_empty", "explicit_subset"])("uses exact reviewed aggregate defaults and exclusions (%s)", (mode) => {
    const read = fixture(), resource = read.pack.resources[0]!;
    if (mode === "explicit_empty") resource.aggregate_measure_functions = {};
    if (mode === "explicit_subset") resource.aggregate_measure_functions = { c7: ["var_pop"] };
    resource.filterable_fields.org = ["eq"];
    resource.selectable_fields.push("org");
    resource.field_metadata!.created_at = { label: "Public display name is not an access grant" };
    const lines = findReviewSection(readBoundaryReviewSections({ boundary: read, digest: "review" }), "resources")!.lines;
    const analysis = overviewField(lines, "c7").find((line) => line.startsWith("Model-invocable analysis:"))!;
    expect(analysis.includes("measure:sum")).toBe(mode === "legacy");
    expect(analysis.includes("measure:avg")).toBe(mode === "legacy");
    expect(analysis.includes("measure:var_pop")).toBe(mode === "explicit_subset");
    expect(overviewField(lines, "org")).toContain("Model-invocable analysis: none");
    expect(overviewField(lines, "org")).toContain("Runner row selection: no");
    expect(overviewField(lines, "created_at")).toContain("Raw access: NO RAW RETURN");
    expect(overviewField(lines, "created_at")).toContain("Model-invocable analysis: none");
  });

  it.each([52, 80, 120])("retains complete logical facts while the existing pager wraps at %i columns", (columns) => {
    const read = permissionsFixture(), resource = read.pack.resources[0]!;
    const longField = `schema_code_${"1234567890".repeat(13)}`;
    resource.field_types[longField] = "text";
    resource.field_metadata![longField] = { label: "A reviewed business meaning that remains complete when a narrow terminal wraps this field" };
    const section = findReviewSection(readBoundaryReviewSections({ boundary: read, digest: "review" }), "resources")!;
    for (const logical of [section.lines, section.children![0]!.lines]) {
      const original = [...logical], width = terminalContentWidth(columns);
      const rendered = logical.flatMap((line) => wrapStyledTerminalLine(line, width));
      expect(rendered.every((line) => line.length <= width)).toBe(true);
      expect(rendered.join("").replace(/\s/gu, "")).toBe(logical.join("").replace(/\s/gu, ""));
      const wide = logical.flatMap((line) => wrapStyledTerminalLine(line, terminalContentWidth(120)));
      expect(rendered.length).toBeGreaterThanOrEqual(wide.length);
      expect(logical).toEqual(original);
    }
  });

  it("projects a frozen candidate without scoped values, calls, writes or changes to exact child views", () => {
    const read = permissionsFixture();
    read.organization_scope = { mode: "single_organization", organization_id: "private_organization_value_never_render",
      acknowledgement: "all_rows_belong_to_one_organization" };
    read.trusted_context = { provider: "environment", tenant_env: "PRIVATE_TENANT_BINDING", principal_env: "PRIVATE_PRINCIPAL_BINDING" };
    const digest = canonicalJsonDigest(read), original = JSON.stringify(read);
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    };
    freeze(read);
    const fetch = vi.spyOn(globalThis, "fetch"), readFile = vi.spyOn(fs, "readFile"), writeFile = vi.spyOn(fs, "writeFile");
    try {
      const changes = readRevisionDiff(read, read);
      const sections = readBoundaryReviewSections({ boundary: read, digest, changes });
      const overview = findReviewSection(sections, "resources")!;
      const text = [overview.lines, ...overview.children!.map((resource) => resource.lines)].flat().join("\n");
      for (const value of ["private_organization_value_never_render", "PRIVATE_TENANT_BINDING", "PRIVATE_PRINCIPAL_BINDING"]) expect(text).not.toContain(value);
      expect(findReviewSection(sections, "changes")).toBe(changes);
      expect(findReviewSection(sections, "json")!.lines.slice(2).join("\n")).toBe(JSON.stringify(read, null, 2));
      expect(fetch).not.toHaveBeenCalled(); expect(readFile).not.toHaveBeenCalled(); expect(writeFile).not.toHaveBeenCalled();
      expect(JSON.stringify(read)).toBe(original);
      expect(canonicalJsonDigest(read)).toBe(digest);
    } finally { fetch.mockRestore(); readFile.mockRestore(); writeFile.mockRestore(); }
  });
});

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
    report.source_digest = source.digest; report.client_duties = clientDutyInventory({ actions: [] });
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
    const resourceSection = sections.find((section) => section.id === "resources")!.children![0]!;
    expect(resourceSection.children!.find((child) => child.id === "created_at")!.title).toContain("NO RAW RETURN");
    expect(resourceSection.children!.find((child) => child.id === "c7")!.lines.join("\n")).toContain("Private eligibility score");
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

  it.each([52, 80, 100, 160, 240])("renders complete concise decision facts at %i columns", (width) => {
    const lines = ["Automatic completion: execution review pending; not enabled.", "Information: account details and offered plans.", "Scope: signed-in customer's account only."];
    const rendered = formatReadActivationDecisionSummary(lines, width);
    expect(rendered.join(" ").replace(/:/gu, "").replace(/\s+/gu, " ")).toBe(lines.join(" ").replace(/:/gu, ""));
    expect(rendered.every((line) => line.length <= width)).toBe(true);
    if (width < 72) expect(rendered).toContain("Automatic completion:");
    expect(rendered.filter((line) => line.startsWith("+"))).toHaveLength(0);
  });
});

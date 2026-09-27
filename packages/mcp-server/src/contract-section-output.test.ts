import { describe, expect, it } from "vitest";
import { scopedExploreDescribeToolOutputSchema } from "./analytics-output-schema.js";
import { withResultEvidence } from "./result-evidence.js";

// Derived final envelopes; the real section producers/transport have their own
// tests. These declarations confer no authorization or completeness.
const revision = `rev_${"a".repeat(43)}`;
const base = { ok: true, source_database_changed: false, metadata_only: true, contains_source_values: false,
  catalog_version: "synapsor.scoped-catalog.v2", catalog_view: "contract_sections", resources: [{ id: "public.items", contract_status: "partial_navigable" }],
  pagination: { page_item_count: 1, has_more: false, total: { kind: "exact", value: 1 }, state: "exhausted", consistency: "fixed_authorized_contract", scope: "selected_contract_section" }, next_cursor: null };

describe("bounded contract output grammar and honest evidence", () => {
  it("accepts typed index/section envelopes and preserves exact values including null", () => {
    const section = { ...base, contract_section: { subject: "public.items", revision, section: "fields", representation: "array", items: [{ key: "0", value: { id: "name", optional_value: null } }], complete_section: true } };
    const output = withResultEvidence("app.describe_data", section);
    expect(scopedExploreDescribeToolOutputSchema.parse(output)).toEqual(output);
    expect(output.result_evidence).toEqual({ runner_history: "not_inspected" });
    expect(output.evidence_summary).toContain("not the complete contract");
    const index = { ...base, pagination: { ...base.pagination, scope: "contract_section_index" }, contract_navigation: {
      subject: "public.items", revision, complete_contract: false, complete_section_index: true,
      sections: [{ section: "fields", representation: "array", item_count: 1, next_call: { tool: "app.describe_data", arguments: { resource: "public.items", section: "fields", contract_revision: revision, limit: 5 } } }], reconstruction: "Collect this index and all section units." } };
    const projected = withResultEvidence("app.describe_data", index);
    expect(scopedExploreDescribeToolOutputSchema.parse(projected)).toEqual(projected);
    expect(projected.evidence_summary).toContain("partial contract metadata");
  });
  it("refuses malformed section declarations and keeps catalog and section pagination modes distinct", () => {
    const section = { subject: "public.items", revision, section: "fields", representation: "array", items: [{ key: "0", value: null }], complete_section: false };
    for (const contract_section of [ { ...section, revision: "stale-invalid" }, { ...section, representation: "string_slice" }, { ...section, items: [{ value: null }] }, { ...section, items: [{ key: "0" }] }, { ...section, complete_section: "true" }, { ...section, forged_complete_contract: true } ]) {
      expect(scopedExploreDescribeToolOutputSchema.safeParse({ ...base, contract_section }).success).toBe(false);
    }
    expect(scopedExploreDescribeToolOutputSchema.safeParse({ ...base, pagination: { ...base.pagination, consistency: "fixed_authorized_catalog" }, contract_section: section }).success).toBe(false);
    const forged = withResultEvidence("app.describe_data", { ...base, contract_navigation: { complete_contract: true, sections: [] } });
    expect(forged.result_evidence).toHaveProperty("family", "unknown");
    expect(forged.evidence_summary).not.toContain("complete metadata");
  });
});

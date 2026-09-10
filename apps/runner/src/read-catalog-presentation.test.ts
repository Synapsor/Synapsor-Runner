import { describe, expect, it } from "vitest";
import { projectDescribeDataForModel } from "./read-catalog-presentation.js";

type Entry = Record<string, unknown> & { fields: Record<string, unknown>[]; relationships?: Entry[] };

describe("Read catalog inherited field semantics", () => {
  it("losslessly inherits only identical descriptive statuses across root and relationship fields", () => {
    const raw = catalog();
    const before = structuredClone(raw);
    const baseline = projectDescribeDataForModel(raw, true, "exact");
    const compact = projectDescribeDataForModel({ ...raw, catalog_version: "synapsor.scoped-catalog.v2" }, true, "exact");
    const original = (baseline.resources as Entry[])[0]!;
    const root = (compact.resources as Entry[])[0]!;
    expect(root.field_defaults).toEqual({ semantic_status: "descriptive_identifier" });
    expect(root.field_contract).toContain("field_defaults apply to root and relationship fields; explicit field values override defaults.");
    for (const [index, entry] of [root, ...root.relationships!].entries()) {
      const expected = [original, ...original.relationships!][index]!;
      expect(entry.fields.map((field) => ({ ...(root.field_defaults as object), ...field }))).toEqual(expected.fields);
      expect(entry.fields[0]).not.toHaveProperty("semantic_status");
      expect(entry.fields.slice(1).map((field) => field.semantic_status)).toEqual([
        "opaque_identifier", "coded_values", "future_policy_review_required",
      ]);
      expect(entry.fields[3]!.operations).toEqual({ future_operation: { maximum: 7 } });
      expect(entry.fields[3]!.allowed_values).toEqual(["only-this-value"]);
    }
    expect(raw).toEqual(before);
  });

  it.each(["root", "relationship", "review_required_relationship"])("skips defaults when a %s field lacks a status", location => {
    const raw = catalog();
    const root = raw.resources[0]!;
    const entry = location === "root" ? root : root.relationships![location === "relationship" ? 0 : 1]!;
    delete entry.fields[0]!.semantic_status;
    const baseline = (projectDescribeDataForModel(raw, true, "exact").resources as Entry[])[0]!;
    const output = (projectDescribeDataForModel({ ...raw, catalog_version: "synapsor.scoped-catalog.v2" }, true, "exact")
      .resources as Entry[])[0]!;
    for (const [index, result] of [output, ...output.relationships!].entries()) {
      expect(result).not.toHaveProperty("field_defaults");
      expect(result.fields).toEqual([baseline, ...baseline.relationships!][index]!.fields);
    }
    expect(output.field_contract).not.toContain("field_defaults");
  });

  it("does not invent a default when no fields have descriptive semantics", () => {
    const raw = catalog();
    for (const entry of [raw.resources[0]!, ...raw.resources[0]!.relationships!]) {
      entry.fields = entry.fields.slice(1);
    }
    const output = (projectDescribeDataForModel({ ...raw, catalog_version: "synapsor.scoped-catalog.v2" }, true, "exact")
      .resources as Entry[])[0]!;
    expect(output).not.toHaveProperty("field_defaults");
    expect(output.fields.map((field) => field.semantic_status)).toEqual([
      "opaque_identifier", "coded_values", "future_policy_review_required",
    ]);
  });
});

function catalog(): { resources: Entry[] } {
  const fields = () => ["descriptive_identifier", "opaque_identifier", "coded_values", "future_policy_review_required"]
    .map((semantic_status, index) => ({ id: `field_${index}`, semantic_status, label: `Reviewed field ${index}`,
      description: "Preserved reviewed meaning", operations: { future_operation: { maximum: 7 } },
      allowed_values: ["only-this-value"] }));
  return { resources: [{ id: "public.records", fields: fields(), relationships: [
    { id: "related_record", activation: "active", fields: fields() },
    { id: "review_required_record", activation: "review_required", operator_review_required: true, fields: fields() },
  ] }] };
}

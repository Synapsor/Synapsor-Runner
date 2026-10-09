import { describe, expect, it } from "vitest";
import {
  type ExploreVocabularyResource,
  exploreFieldVocabularyStatus,
  exploreVocabularyCoverage,
  exploreVocabularyMetadataProfile,
} from "./explore-vocabulary.js";

// Preserve the previous identifier/enum variants. They now test the retired
// classifier's replacement contract: metadata only, with no semantic readiness.
// Actual scope readiness is exercised by explore-vocabulary-native.test.ts.
describe("Explore reviewed presentation vocabulary", () => {
  it.each([
    "legacy.val_1", "legacy.dim_a", "legacy.c7", "legacy.t_0031", "col17",
    "public.orders", "carrier_mode", "warehouse_zone", "licence_number", "x_coordinate",
  ])("does not infer field meaning or require a label from identifier %s", identifier => {
    const resource: ExploreVocabularyResource = { id: identifier, selectable_fields: [identifier] };
    expect(exploreFieldVocabularyStatus(resource, identifier)).toBe("unspecified");
    expect(exploreVocabularyMetadataProfile(resource)).toEqual({ resource_vocabulary: "unspecified",
      field_vocabulary: { [identifier]: "unspecified" } });
    expect(exploreVocabularyCoverage(resource)).toEqual({ kind: "presentation_metadata", model_facing_fields: 1,
      fields_with_labels: 0, fields_with_descriptions: 0, fields_with_reviewed_vocabulary: 0,
      resource_has_reviewed_vocabulary: false, fields_without_reviewed_vocabulary: [identifier] });
  });

  it("counts only model-facing fields and either reviewed metadata field without establishing meaning", () => {
    const resource: ExploreVocabularyResource = {
      id: "legacy.t_0031", label: "Clinical encounters",
      field_metadata: { c7: { label: "Event type" }, c8: { description: "The reviewed department responsible for the encounter." } },
      selectable_fields: ["c7", "c8", "c9"], filterable_fields: { c7: ["eq"] }, sortable_fields: [],
      groupable_fields: ["c7", "c8"], aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["c9"],
    };
    expect(exploreFieldVocabularyStatus(resource, "c7")).toBe("reviewed_metadata");
    expect(exploreVocabularyCoverage(resource)).toEqual({ kind: "presentation_metadata", model_facing_fields: 2,
      fields_with_labels: 1, fields_with_descriptions: 1, fields_with_reviewed_vocabulary: 2,
      resource_has_reviewed_vocabulary: true, fields_without_reviewed_vocabulary: [] });
  });

  it("reports every model-facing field without optional metadata without classifying its name", () => {
    const resource = { id: "legacy.t_0031", selectable_fields: ["val_1", "status"], filterable_fields: {},
      sortable_fields: [], groupable_fields: ["val_1"], aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: [] };
    expect(exploreVocabularyCoverage(resource)).toEqual({ kind: "presentation_metadata", model_facing_fields: 2,
      fields_with_labels: 0, fields_with_descriptions: 0, fields_with_reviewed_vocabulary: 0,
      resource_has_reviewed_vocabulary: false, fields_without_reviewed_vocabulary: ["status", "val_1"] });
  });

  it.each([
    ["P1", "P2", "P3"], ["W1", "W2", "W3", "W4"], ["Thames Valley", "North West"], ["P1"], ["P1", "phase two"],
  ].map(values => [values]))("does not infer semantic status from schema enum values %j", values => {
    const resource: ExploreVocabularyResource = { id: "public.sites", field_types: { ph_code: "text" },
      field_enums: { ph_code: values as string[] }, selectable_fields: ["ph_code"] };
    expect(exploreFieldVocabularyStatus(resource, "ph_code")).toBe("unspecified");
    expect(exploreVocabularyMetadataProfile(resource)).toEqual({ resource_vocabulary: "unspecified",
      field_vocabulary: { ph_code: "unspecified" } });
    expect(exploreVocabularyCoverage(resource)).toEqual({ kind: "presentation_metadata", model_facing_fields: 1,
      fields_with_labels: 0, fields_with_descriptions: 0, fields_with_reviewed_vocabulary: 0,
      resource_has_reviewed_vocabulary: false, fields_without_reviewed_vocabulary: ["ph_code"] });
  });

  it("changes only presentation coverage when optional reviewed labels are added to enum fields", () => {
    const resource: ExploreVocabularyResource = { id: "public.sites", field_types: { ph_code: "text", region: "text" },
      field_enums: { ph_code: ["P1", "P2", "P3"], region: ["Thames Valley", "North West"] },
      selectable_fields: ["ph_code", "region"], filterable_fields: { ph_code: ["eq"], region: ["eq"] },
      sortable_fields: ["ph_code", "region"], groupable_fields: ["ph_code", "region"], aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: [] };
    expect(exploreFieldVocabularyStatus(resource, "ph_code")).toBe("unspecified");
    expect(exploreFieldVocabularyStatus(resource, "region")).toBe("unspecified");
    const before = exploreVocabularyCoverage(resource);
    expect(before.fields_without_reviewed_vocabulary).toEqual(["ph_code", "region"]);
    expect(Object.hasOwn(before, "status")).toBe(false);
    expect(exploreVocabularyMetadataProfile(resource)).toEqual({ resource_vocabulary: "unspecified",
      field_vocabulary: { ph_code: "unspecified", region: "unspecified" } });
    resource.field_metadata = { ph_code: { label: "Construction phase" } };
    expect(exploreFieldVocabularyStatus(resource, "ph_code")).toBe("reviewed_metadata");
    expect(exploreVocabularyCoverage(resource)).toEqual({ ...before, fields_with_labels: 1,
      fields_with_reviewed_vocabulary: 1, fields_without_reviewed_vocabulary: ["region"] });
  });
});

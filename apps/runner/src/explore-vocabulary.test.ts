import { describe, expect, it } from "vitest";
import {
  exploreBoundaryVocabularyGaps,
  exploreFieldSemanticStatus,
  exploreVocabularyCoverage,
  isClearlyOpaqueExploreIdentifier,
} from "./explore-vocabulary.js";

describe("Explore reviewed vocabulary", () => {
  it.each([
    "legacy.val_1",
    "legacy.dim_a",
    "legacy.c7",
    "legacy.t_0031",
    "col17",
  ])("recognizes clear placeholder identifier %s without domain assumptions", (identifier) => {
    expect(isClearlyOpaqueExploreIdentifier(identifier)).toBe(true);
  });

  it.each([
    "public.orders",
    "carrier_mode",
    "warehouse_zone",
    "licence_number",
    "x_coordinate",
  ])("does not gate descriptive identifier %s", (identifier) => {
    expect(isClearlyOpaqueExploreIdentifier(identifier)).toBe(false);
  });

  it("counts only model-facing fields and closes an opaque gap with either reviewed metadata field", () => {
    const resource = {
      id: "legacy.t_0031",
      label: "Clinical encounters",
      field_metadata: {
        c7: { label: "Event type" },
        c8: { description: "The reviewed department responsible for the encounter." },
      },
      selectable_fields: ["c7", "c8", "c9"],
      filterable_fields: { c7: ["eq"] },
      sortable_fields: [],
      groupable_fields: ["c7", "c8"],
      aggregate_measures: [],
      count_distinct_fields: [],
      time_bucket_fields: {},
      kept_out_fields: ["c9"],
    };

    expect(exploreFieldSemanticStatus(resource, "c7")).toBe("reviewed_vocabulary");
    expect(exploreVocabularyCoverage(resource)).toMatchObject({
      status: "ready",
      model_facing_fields: 2,
      fields_with_labels: 1,
      fields_with_descriptions: 1,
      opaque_resource_without_vocabulary: false,
      opaque_fields_without_vocabulary: [],
    });
    expect(exploreBoundaryVocabularyGaps([resource])).toEqual([]);
  });

  it("names every opaque model-facing identifier still requiring review", () => {
    const resource = {
      id: "legacy.t_0031",
      selectable_fields: ["val_1", "status"],
      filterable_fields: {},
      sortable_fields: [],
      groupable_fields: ["val_1"],
      aggregate_measures: [],
      count_distinct_fields: [],
      time_bucket_fields: {},
      kept_out_fields: [],
    };

    expect(exploreBoundaryVocabularyGaps([resource])).toEqual([{
      resource: "legacy.t_0031",
      resource_gap: true,
      fields: ["val_1"],
    }]);
  });
});

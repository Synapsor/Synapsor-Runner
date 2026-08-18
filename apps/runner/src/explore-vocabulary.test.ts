import { describe, expect, it } from "vitest";
import {
  type ExploreVocabularyResource,
  exploreBoundaryVocabularyGaps,
  exploreFieldSemanticStatus,
  exploreVocabularyCoverage,
  exploreVocabularyStructuralProfile,
  isCodedExploreValueDomain,
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
    const resource: ExploreVocabularyResource = {
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

  it.each([
    [["P1", "P2", "P3"], true],
    [["W1", "W2", "W3", "W4"], true],
    [["Thames Valley", "North West"], false],
    [["P1"], false],
    [["P1", "phase two"], false],
  ])("classifies bounded schema vocabulary %j structurally", (values, expected) => {
    expect(isCodedExploreValueDomain(values)).toBe(expected);
  });

  it("advises on coded values without widening the activation-blocking opaque gate", () => {
    const resource: ExploreVocabularyResource = {
      id: "public.sites",
      field_types: { ph_code: "text", region: "text" },
      field_enums: {
        ph_code: ["P1", "P2", "P3"],
        region: ["Thames Valley", "North West"],
      },
      selectable_fields: ["ph_code", "region"],
      filterable_fields: { ph_code: ["eq"], region: ["eq"] },
      sortable_fields: ["ph_code", "region"],
      groupable_fields: ["ph_code", "region"],
      aggregate_measures: [],
      count_distinct_fields: [],
      time_bucket_fields: {},
      kept_out_fields: [],
    };

    expect(exploreFieldSemanticStatus(resource, "ph_code")).toBe("coded_values");
    expect(exploreFieldSemanticStatus(resource, "region")).toBe("descriptive_identifier");
    expect(exploreVocabularyCoverage(resource)).toMatchObject({
      status: "review_advised",
      opaque_fields_without_vocabulary: [],
      coded_fields_without_vocabulary: ["ph_code"],
    });
    expect(exploreBoundaryVocabularyGaps([resource])).toEqual([]);
    expect(exploreVocabularyStructuralProfile(resource)).toEqual({
      resource_identifier_opaque: false,
      field_semantic_status: {
        ph_code: "coded_values",
        region: "descriptive_identifier",
      },
    });

    resource.field_metadata = { ph_code: { label: "Construction phase" } };
    expect(exploreFieldSemanticStatus(resource, "ph_code")).toBe("reviewed_vocabulary");
    expect(exploreVocabularyCoverage(resource)).toMatchObject({
      status: "ready",
      coded_fields_without_vocabulary: [],
    });
  });
});

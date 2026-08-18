type ExploreVocabularyFieldMetadata = {
  label?: string;
  description?: string;
};

export type ExploreVocabularyResource = {
  id: string;
  label?: string;
  description?: string;
  field_metadata?: Record<string, ExploreVocabularyFieldMetadata>;
  field_types?: Record<string, unknown>;
  field_enums?: Record<string, string[]>;
  selectable_fields?: string[];
  filterable_fields?: Record<string, unknown>;
  sortable_fields?: string[];
  groupable_fields?: string[];
  aggregate_measures?: string[];
  presence_measure_fields?: string[];
  count_distinct_fields?: string[];
  time_bucket_fields?: Record<string, unknown>;
  kept_out_fields?: string[];
};

export type ExploreFieldSemanticStatus =
  | "reviewed_vocabulary"
  | "descriptive_identifier"
  | "coded_values"
  | "opaque_identifier";

export type ExploreVocabularyStructuralProfile = {
  resource_identifier_opaque: boolean;
  field_semantic_status: Record<
    string,
    Exclude<ExploreFieldSemanticStatus, "reviewed_vocabulary">
  >;
};

export type ExploreVocabularyCoverage = {
  status: "ready" | "review_advised" | "review_required";
  model_facing_fields: number;
  fields_with_labels: number;
  fields_with_descriptions: number;
  fields_with_reviewed_vocabulary: number;
  opaque_resource_without_vocabulary: boolean;
  opaque_fields_without_vocabulary: string[];
  coded_fields_without_vocabulary: string[];
};

const MAX_CODED_ENUM_VALUES = 64;
const CODED_ENUM_VALUE = /^[A-Za-z]{1,4}\d{1,4}$/u;

const PLACEHOLDER_PREFIXES = new Set([
  "attr",
  "attribute",
  "class",
  "cls",
  "col",
  "column",
  "dim",
  "dimension",
  "field",
  "fld",
  "measure",
  "metric",
  "table",
  "tbl",
  "val",
  "value",
  "var",
  "variable",
]);

function resourceLocalId(value: string): string {
  return value.split(".").at(-1) ?? value;
}

function identifierWords(value: string): string[] {
  return resourceLocalId(value).toLowerCase().split(/[_-]+/u).filter(Boolean);
}

function placeholderRemainder(words: string[]): boolean {
  if (words.length < 2 || !PLACEHOLDER_PREFIXES.has(words[0]!)) return false;
  return words.slice(1).every((word) =>
    /^\d+$/u.test(word)
    || /^[a-z]$/u.test(word)
    || /^[a-z]{0,2}\d+$/u.test(word));
}

/**
 * Detects generated or placeholder-like names without assuming an English
 * business vocabulary. The result is deliberately narrow because it may gate
 * activation until a reviewer supplies a label or description.
 */
export function isClearlyOpaqueExploreIdentifier(value: string): boolean {
  const local = resourceLocalId(value).toLowerCase();
  const words = identifierWords(local);
  if (!local || words.length === 0) return true;
  if (placeholderRemainder(words)) return true;
  if (/^(?:attr|cls|col|dim|field|fld|measure|metric|table|tbl|val|var)\d+$/u.test(local)) {
    return true;
  }
  if (/^[a-z]{1,3}_?\d{1,8}$/u.test(local)) return true;
  return /^[a-z]$/u.test(local);
}

/**
 * Detects a bounded schema vocabulary whose members are structural codes rather
 * than readable business words. This signal is advisory: unlike an opaque
 * identifier, it never blocks activation by itself.
 */
export function isCodedExploreValueDomain(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_CODED_ENUM_VALUES) {
    return false;
  }
  const values = value.filter((item): item is string => typeof item === "string");
  return values.length === value.length
    && new Set(values).size >= 2
    && values.every((item) => CODED_ENUM_VALUE.test(item));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function recordKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

export function exploreModelFacingFieldIds(resource: ExploreVocabularyResource): string[] {
  const keptOut = new Set(stringList(resource.kept_out_fields));
  return [...new Set([
    ...stringList(resource.selectable_fields),
    ...recordKeys(resource.filterable_fields),
    ...stringList(resource.sortable_fields),
    ...stringList(resource.groupable_fields),
    ...stringList(resource.aggregate_measures),
    ...stringList(resource.presence_measure_fields),
    ...stringList(resource.count_distinct_fields),
    ...recordKeys(resource.time_bucket_fields),
  ])].filter((field) => !keptOut.has(field)).sort((left, right) => left.localeCompare(right));
}

export function exploreFieldSemanticStatus(
  resource: ExploreVocabularyResource,
  field: string,
): ExploreFieldSemanticStatus {
  const metadata = resource.field_metadata?.[field];
  if (metadata?.label || metadata?.description) return "reviewed_vocabulary";
  return exploreFieldStructuralSemanticStatus(resource, field);
}

function exploreFieldStructuralSemanticStatus(
  resource: ExploreVocabularyResource,
  field: string,
): Exclude<ExploreFieldSemanticStatus, "reviewed_vocabulary"> {
  if (isClearlyOpaqueExploreIdentifier(field)) return "opaque_identifier";
  return isCodedExploreValueDomain(resource.field_enums?.[field])
    ? "coded_values"
    : "descriptive_identifier";
}

export function exploreVocabularyStructuralProfile(
  resource: ExploreVocabularyResource,
): ExploreVocabularyStructuralProfile {
  const fields = [...new Set([
    ...Object.keys(resource.field_types ?? {}),
    ...Object.keys(resource.field_enums ?? {}),
    ...exploreModelFacingFieldIds(resource),
  ])].sort((left, right) => left.localeCompare(right));
  return {
    resource_identifier_opaque: isClearlyOpaqueExploreIdentifier(resource.id),
    field_semantic_status: Object.fromEntries(fields.map((field) => [
      field,
      exploreFieldStructuralSemanticStatus(resource, field),
    ])),
  };
}

export function exploreVocabularyCoverage(
  resource: ExploreVocabularyResource,
): ExploreVocabularyCoverage {
  const fields = exploreModelFacingFieldIds(resource);
  const fieldsWithLabels = fields.filter((field) => Boolean(resource.field_metadata?.[field]?.label));
  const fieldsWithDescriptions = fields.filter((field) => Boolean(resource.field_metadata?.[field]?.description));
  const fieldsWithReviewedVocabulary = fields.filter((field) => {
    const metadata = resource.field_metadata?.[field];
    return Boolean(metadata?.label || metadata?.description);
  });
  const opaqueFields = fields.filter((field) =>
    exploreFieldSemanticStatus(resource, field) === "opaque_identifier");
  const codedFields = fields.filter((field) =>
    exploreFieldSemanticStatus(resource, field) === "coded_values");
  const opaqueResource = isClearlyOpaqueExploreIdentifier(resource.id)
    && !resource.label
    && !resource.description;
  return {
    status: opaqueResource || opaqueFields.length > 0
      ? "review_required"
      : codedFields.length > 0
        ? "review_advised"
        : "ready",
    model_facing_fields: fields.length,
    fields_with_labels: fieldsWithLabels.length,
    fields_with_descriptions: fieldsWithDescriptions.length,
    fields_with_reviewed_vocabulary: fieldsWithReviewedVocabulary.length,
    opaque_resource_without_vocabulary: opaqueResource,
    opaque_fields_without_vocabulary: opaqueFields,
    coded_fields_without_vocabulary: codedFields,
  };
}

export function formatExploreVocabularyCoverage(
  resource: ExploreVocabularyResource,
): string {
  const coverage = exploreVocabularyCoverage(resource);
  const counts = `${coverage.fields_with_labels}/${coverage.model_facing_fields} field labels; `
    + `${coverage.fields_with_descriptions}/${coverage.model_facing_fields} field descriptions`;
  const gaps = [
    ...(coverage.opaque_resource_without_vocabulary ? ["table name"] : []),
    ...coverage.opaque_fields_without_vocabulary,
  ];
  if (gaps.length > 0) {
    return `${counts}; reviewed vocabulary required for ${gaps.join(", ")}`;
  }
  if (coverage.coded_fields_without_vocabulary.length > 0) {
    return `${counts}; reviewed vocabulary advised for coded value fields `
      + `${coverage.coded_fields_without_vocabulary.join(", ")}; activation remains available`;
  }
  return `${counts}; no opaque or coded model-facing vocabulary gaps`;
}

export function exploreBoundaryVocabularyGaps(
  resources: ExploreVocabularyResource[],
): Array<{ resource: string; resource_gap: boolean; fields: string[] }> {
  return resources.flatMap((resource) => {
    const coverage = exploreVocabularyCoverage(resource);
    return coverage.opaque_resource_without_vocabulary
      || coverage.opaque_fields_without_vocabulary.length > 0
      ? [{
          resource: resource.id,
          resource_gap: coverage.opaque_resource_without_vocabulary,
          fields: coverage.opaque_fields_without_vocabulary,
        }]
      : [];
  });
}

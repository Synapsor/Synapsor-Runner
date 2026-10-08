type ExploreVocabularyFieldMetadata = {
  label?: string;
  description?: string;
};

/** Presentation metadata only. Callers supply existing reviewed boundary metadata,
 * never raw comments. Neither presence nor absence establishes business meaning. */
export function hasReviewedExploreVocabulary(metadata: ExploreVocabularyFieldMetadata | undefined): boolean {
  return Boolean(metadata && [metadata.label, metadata.description]
    .some(value => typeof value === "string" && value.trim().length > 0));
}

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

export type ExploreFieldVocabularyStatus = "reviewed_metadata" | "unspecified";
export type ExploreVocabularyMetadataProfile = {
  resource_vocabulary: ExploreFieldVocabularyStatus;
  field_vocabulary: Record<string, ExploreFieldVocabularyStatus>;
};
export type ExploreVocabularyCoverage = {
  kind: "presentation_metadata";
  model_facing_fields: number;
  fields_with_labels: number;
  fields_with_descriptions: number;
  fields_with_reviewed_vocabulary: number;
  resource_has_reviewed_vocabulary: boolean;
  fields_without_reviewed_vocabulary: string[];
};

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

export function exploreFieldVocabularyStatus(resource: ExploreVocabularyResource, field: string): ExploreFieldVocabularyStatus {
  return hasReviewedExploreVocabulary(resource.field_metadata?.[field]) ? "reviewed_metadata" : "unspecified";
}

export function exploreVocabularyMetadataProfile(resource: ExploreVocabularyResource): ExploreVocabularyMetadataProfile {
  const fields = [...new Set([...Object.keys(resource.field_types ?? {}), ...Object.keys(resource.field_enums ?? {}),
    ...exploreModelFacingFieldIds(resource)])].sort((left, right) => left.localeCompare(right));
  return { resource_vocabulary: hasReviewedExploreVocabulary(resource) ? "reviewed_metadata" : "unspecified",
    field_vocabulary: Object.fromEntries(fields.map(field => [field, exploreFieldVocabularyStatus(resource, field)])) };
}

/** Counts optional reviewed metadata. Read meaning/currentness belongs to the
 * existing native Read scope owner; missing labels do not request another review. */
export function exploreVocabularyCoverage(resource: ExploreVocabularyResource): ExploreVocabularyCoverage {
  const fields = exploreModelFacingFieldIds(resource);
  const supplied = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  const fieldsWithReviewedVocabulary = fields.filter(field => hasReviewedExploreVocabulary(resource.field_metadata?.[field]));
  return { kind: "presentation_metadata", model_facing_fields: fields.length,
    fields_with_labels: fields.filter(field => supplied(resource.field_metadata?.[field]?.label)).length,
    fields_with_descriptions: fields.filter(field => supplied(resource.field_metadata?.[field]?.description)).length,
    fields_with_reviewed_vocabulary: fieldsWithReviewedVocabulary.length,
    resource_has_reviewed_vocabulary: hasReviewedExploreVocabulary(resource),
    fields_without_reviewed_vocabulary: fields.filter(field => !hasReviewedExploreVocabulary(resource.field_metadata?.[field])) };
}

export function formatExploreVocabularyCoverage(resource: ExploreVocabularyResource): string {
  const coverage = exploreVocabularyCoverage(resource);
  return `${coverage.fields_with_labels}/${coverage.model_facing_fields} field labels; `
    + `${coverage.fields_with_descriptions}/${coverage.model_facing_fields} field descriptions; optional presentation metadata`;
}

import type { ExplorationBoundaryDraft, ExplorationDerivedBaseMeasure } from "./auto-boundary.js";

export function reviewedModelAnalysisOperations(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number], field: string,
): string[] {
  if (resource.kept_out_fields.includes(field)) return [];
  return [
    ...(resource.filterable_fields[field] ?? []).map((op) => `filter:${op}`),
    ...(resource.sortable_fields.includes(field) ? ["sort"] : []),
    ...(resource.groupable_fields.includes(field) ? ["group"] : []),
    ...(resource.aggregate_measures.includes(field)
      ? (resource.aggregate_measure_functions ? resource.aggregate_measure_functions[field] ?? [] : ["sum", "avg"])
        .map((operation) => `measure:${operation}`) : []),
    ...(resource.presence_measure_fields?.includes(field) ? ["presence"] : []),
    ...(resource.count_distinct_fields.includes(field) ? ["distinct"] : []),
    ...(resource.time_bucket_fields[field] ?? []).map((bucket) => `time:${bucket}`),
    ...(resource.numeric_bands ?? []).filter((band) => band.field === field && !band.relationship).map((band) => `band:${band.name}`),
    ...(resource.auto_bands ?? []).filter((band) => band.field === field).map(() => "auto band"),
  ];
}

/** Narrow model-invocable analysis without changing private row loading or scope. */
export function restrictPrivateFieldAnalysis(
  boundary: ExplorationBoundaryDraft, resourceId: string, fields: string[],
): void {
  const resource = boundary.pack.resources.find((item) => item.id === resourceId);
  if (!resource) throw new Error(`Private field resource ${resourceId} is unavailable.`);
  const privateFields = new Set(fields);
  for (const field of fields) {
    if (!resource.model_withheld_fields?.includes(field) || !resource.selectable_fields.includes(field)) {
      throw new Error(`Reviewed model-withheld decision for ${resourceId}.${field} was not reflected in the disabled candidate. Runner-only access is required before restricting model analysis.`);
    }
  }
  for (const key of ["sortable_fields", "groupable_fields", "aggregate_measures", "count_distinct_fields", "presence_measure_fields"] as const) {
    if (resource[key]) resource[key] = resource[key]!.filter((field) => !privateFields.has(field));
  }
  for (const key of ["filterable_fields", "time_bucket_fields", "aggregate_measure_functions"] as const) {
    if (resource[key]) for (const field of fields) delete resource[key]![field];
  }
  if (resource.auto_bands) resource.auto_bands = resource.auto_bands.filter((band) => !privateFields.has(band.field));
  // Derived analytical grants on other resources may reference the same field.
  // Remove those grants too; relationship proofs and private Action facts remain.
  for (const owner of boundary.pack.resources) {
    const referencesPrivate = (reference: { field: string; relationship?: string }) =>
      privateFields.has(reference.field) && (reference.relationship
        ? owner.relationships.find((link) => link.id === reference.relationship)?.target_resource === resourceId
        : owner.id === resourceId);
    const privateMeasure = (measure: ExplorationDerivedBaseMeasure) =>
      "field" in measure && referencesPrivate(measure);
    if (owner.numeric_bands) owner.numeric_bands = owner.numeric_bands.filter((band) => !referencesPrivate(band));
    if (owner.derived_measures) owner.derived_measures = owner.derived_measures.filter((measure) =>
      "numerator" in measure ? !privateMeasure(measure.numerator) && !privateMeasure(measure.denominator)
        : "base_measure" in measure ? !privateMeasure(measure.base_measure) : true);
  }
}

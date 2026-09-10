import { isDeepStrictEqual } from "node:util";
import { projectAuthorityMetadataForModel, type ModelAuthorityMetadataMode } from "@synapsor-runner/mcp-server";

export function projectDescribeDataForModel(
  result: Record<string, unknown>,
  resourceDetail: boolean,
  authorityMetadata: ModelAuthorityMetadataMode = "semantic",
): Record<string, unknown> {
  if (result.ok === false || !Array.isArray(result.resources)) {
    return projectAuthorityMetadataForModel(result, authorityMetadata).value;
  }
  const resources = result.resources
    .filter(modelRecord)
    .map((resource) => resourceDetail
      ? result.catalog_version === "synapsor.scoped-catalog.v2"
        ? compactCatalogResourceDetail(modelResourceDetail(resource), result.vocabulary_policy)
        : modelResourceDetail(resource)
      : result.catalog_version === "synapsor.scoped-catalog.v2"
        ? withoutUndefined({ id: modelString(resource.id), label: modelString(resource.label),
            description: modelString(resource.description), boundary_name: modelString(resource.boundary_name) })
      : modelResourceIndex(resource));
  const projected: Record<string, unknown> = {
    ...structuredClone(result),
    resources,
    catalog_view: resourceDetail ? "resource_detail" : "resource_index",
    metadata_only: true,
    contains_source_values: false,
    next_action: resourceDetail
      ? "For application-data values, call app.explore_data with one smallest valid plan. Do not answer from this metadata."
      : typeof result.next_cursor === "number" || typeof result.next_cursor === "string"
        ? "More authorized resources are available. Continue with the returned cursor and unchanged query/limit, or search another phrase. Request exact resource details before app.explore_data. Discovery does not answer a data question."
        : "This is the final catalog page. Choose an exact resource id, request its focused details when needed, then call app.explore_data for values. Do not answer from this metadata.",
  };
  // Keep the compact index small for weaker models. The fixed vocabulary is
  // useful only after one resource and its reviewed time fields are selected.
  if (!resourceDetail) delete projected.relative_time_windows;
  if (result.catalog_version === "synapsor.scoped-catalog.v2") {
    if (resourceDetail) projected.next_action = "Metadata only; use app.explore_data for values.";
    if (projected.pack === projected.boundary_name) delete projected.pack;
    if (modelRecord(projected.discovery)
      && projected.discovery.next_step === "Search or browse a shortlist, request exact details, then use the selected contract. Discovery grants no authority.") projected.discovery = { ...projected.discovery,
      next_step: "Discovery grants no authority; use the exact contract." };
    if (modelRecord(projected.vocabulary_policy)) {
      const policy = { ...projected.vocabulary_policy };
      if (policy.opaque_identifier_behavior === "do_not_guess; ask the operator to add a reviewed label or description") {
        policy.opaque_identifier_behavior = "do_not_guess; request reviewed vocabulary";
      }
      if (policy.coded_value_behavior === "do_not_infer_business_meaning_from_codes; use exact codes only when the question names them or reviewed metadata explains them") {
        policy.coded_value_behavior = "do_not_infer; use exact codes named by the question or explained in reviewed metadata";
      }
      projected.vocabulary_policy = policy;
    }
  }
  return projectAuthorityMetadataForModel(projected, authorityMetadata).value;
}

function compactCatalogResourceDetail(resource: Record<string, unknown>, vocabularyPolicy: unknown): Record<string, unknown> {
  // Keep executable grammar intact. Only omit operator statistics and metadata
  // already stated globally or in the same contract's examples.
  const compact = (entry: Record<string, unknown>, throughRelationship = false): Record<string, unknown> => {
    const result = { ...entry };
    if (modelRecord(result.vocabulary)) {
      const vocabulary = { ...result.vocabulary };
      for (const key of ["model_facing_fields", "fields_with_labels", "fields_with_descriptions", "fields_with_reviewed_vocabulary"]) {
        delete vocabulary[key];
      }
      // "ready" already means there are no opaque/coded vocabulary gaps.
      // Keep every nonempty warning, false-ready inconsistency, and future fact.
      if (vocabulary.status === "ready" && vocabulary.opaque_resource_without_vocabulary === false
        && isDeepStrictEqual(vocabulary.opaque_fields_without_vocabulary, [])
        && isDeepStrictEqual(vocabulary.coded_fields_without_vocabulary, [])) {
        delete vocabulary.opaque_resource_without_vocabulary;
        delete vocabulary.opaque_fields_without_vocabulary;
        delete vocabulary.coded_fields_without_vocabulary;
      }
      result.vocabulary = vocabulary;
    }
    if (modelRecord(vocabularyPolicy) && vocabularyPolicy.exact_ids_required_in_plans === true) {
      result.fields = modelRecords(result.fields).map((field) => {
        const copy = { ...field };
        if (copy.plan_reference === "exact_id_only") delete copy.plan_reference;
        return copy;
      });
    }
    result.fields = modelRecords(result.fields).map((field) => {
      const copy = { ...field };
      const id = modelString(field.id);
      if (!id) return copy;
      // The operation maps remain the executable contract. Remove a per-field
      // copy only when ALL its facts are recoverable exactly, including denials.
      const operations = {
        return_value: modelStrings(entry.selectable_fields).includes(id),
        model_egress: modelStrings(entry.model_withheld_fields).includes(id) ? "withheld" : "visible",
        filter_operators: modelStringArrayRecord(entry.filter_operators)[id] ?? [],
        sortable: !throughRelationship && modelStrings(entry.sortable_fields).includes(id),
        groupable: modelStrings(entry.groupable_fields).includes(id),
        aggregate_functions: modelStringArrayRecord(entry.aggregate_measure_functions)[id] ?? [],
        presence_functions: modelStrings(entry.presence_measure_fields).includes(id)
          ? modelStrings(entry.presence_measure_functions) : [],
        count_distinct: modelStrings(entry.count_distinct_fields).includes(id),
        time_buckets: modelStringArrayRecord(entry.time_bucket_fields)[id] ?? [],
      };
      if (isDeepStrictEqual(copy.operations, operations)) delete copy.operations;
      if (modelRecord(entry.field_enums) && Array.isArray(copy.allowed_values)
        && isDeepStrictEqual(copy.allowed_values, entry.field_enums[id])) delete copy.allowed_values;
      return copy;
    });
    return result;
  };
  const result = compact(resource);
  result.field_contract = "Only listed operations/values are allowed. model_withheld_fields stay private. Field operations, if present, also apply.";
  delete result.valid_plan_example;
  result.relationships = modelRecords(resource.relationships).map((relationship) => compact(relationship, true));
  const entries = [result, ...modelRecords(result.relationships)];
  const fields = entries.flatMap((entry) => modelRecords(entry.fields));
  // A missing status must stay missing, never inherit permissive semantics.
  if (fields.length && fields.every((field) => typeof field.semantic_status === "string")
    && fields.some((field) => field.semantic_status === "descriptive_identifier")) {
    result.field_defaults = { semantic_status: "descriptive_identifier" };
    result.field_contract += " field_defaults apply to root and relationship fields; explicit field values override defaults.";
    for (const entry of entries) {
      entry.fields = modelRecords(entry.fields).map((field) => {
        const copy = { ...field };
        if (copy.semantic_status === "descriptive_identifier") delete copy.semantic_status;
        return copy;
      });
    }
  }
  return result;
}

function modelResourceIndex(resource: Record<string, unknown>): Record<string, unknown> {
  const relationships = modelRecords(resource.relationships).map((relationship) => ({
    id: modelString(relationship.id),
    target_resource: modelString(relationship.target_resource),
    target_label: modelString(relationship.target_label),
    target_description: modelString(relationship.target_description),
    activation: modelString(relationship.activation),
    path_depth: modelNumber(relationship.path_depth),
  }));
  return withoutUndefined({
    id: modelString(resource.id),
    label: modelString(resource.label),
    description: modelString(resource.description),
    vocabulary: modelRecordOrUndefined(resource.vocabulary),
    boundary_name: modelString(resource.boundary_name),
    fields: modelReviewedFields(resource.fields, false),
    selectable_fields: modelStrings(resource.selectable_fields),
    ...(resource.relationship_only === true ? { relationship_only: true } : {}),
    ...(relationships.length ? { related_rows: { syntax: { related: [{ relationship: "<reviewed relationship id>", select: ["<target field>"] }] },
      max_relationships: 3, max_total_fields: 20, output_names: "<relationship id>.<field>", scope: "Every target remains independently scoped; private join keys are not returned." } } : {}),
    filter_operators: modelStringArrayRecord(resource.filter_operators),
    sortable_fields: modelStrings(resource.sortable_fields),
    groupable_fields: modelStrings(resource.groupable_fields),
    aggregate_measure_functions: modelStringArrayRecord(resource.aggregate_measure_functions),
    presence_measure_fields: modelStrings(resource.presence_measure_fields),
    presence_measure_functions: modelStrings(resource.presence_measure_functions),
    derived_measures: modelRecords(resource.derived_measures),
    numeric_bands: modelRecords(resource.numeric_bands),
    auto_bands: modelRecords(resource.auto_bands).map((policy) => withoutUndefined({
      field: modelString(policy.field),
      methods: modelStrings(policy.methods),
      min_buckets: modelNumber(policy.min_buckets),
      max_buckets: modelNumber(policy.max_buckets),
      label_style: modelString(policy.label_style),
      raw_edges_returned: false,
    })),
    count_distinct_fields: modelStrings(resource.count_distinct_fields),
    time_bucket_fields: modelStringArrayRecord(resource.time_bucket_fields),
    relative_time_window_fields: modelStrings(resource.relative_time_window_fields),
    time_coverage: modelRecordOrEmpty(resource.time_coverage),
    field_enums: modelRecordOrEmpty(resource.field_enums),
    relationships,
    minimum_cohort_size: modelNumber(resource.minimum_cohort_size),
    maximum_rows: modelNumber(resource.maximum_rows),
    maximum_groups: modelNumber(resource.maximum_groups),
    valid_plan_example: modelValidAggregatePlan(resource),
    valid_plan_examples: withoutUndefined({
      rows: modelValidRowsPlan(resource),
      aggregate: modelValidAggregatePlan(resource),
    }),
  });
}

function modelValidRowsPlan(resource: Record<string, unknown>): Record<string, unknown> | undefined {
  if (resource.relationship_only === true) return undefined;
  const resourceId = modelString(resource.id);
  const withheld = new Set(withheldFieldNames(resource.field_egress));
  const selected = modelStrings(resource.selectable_fields)
    .filter((field) => !withheld.has(field))
    .slice(0, 3);
  return resourceId && selected.length
    ? { kind: "rows", resource: resourceId, select: selected }
    : undefined;
}

function modelValidAggregatePlan(resource: Record<string, unknown>): Record<string, unknown> | undefined {
  if (resource.relationship_only === true) return undefined;
  const resourceId = modelString(resource.id) ?? "";
  const semanticStatus = new Map(modelRecords(resource.fields).flatMap((field) => {
    const id = modelString(field.id);
    const status = modelString(field.semantic_status);
    return id && status ? [[id, status] as const] : [];
  }));
  const dimension = modelStrings(resource.groupable_fields).find((field) => {
    const status = semanticStatus.get(field);
    return status !== "opaque_identifier" && status !== "coded_values";
  });
  return {
    kind: "aggregate",
    resource: resourceId,
    measures: [{ function: "count" }],
    ...(dimension ? { dimensions: [{ field: dimension }] } : {}),
  };
}

function modelResourceDetail(resource: Record<string, unknown>): Record<string, unknown> {
  const indexed = modelResourceIndex(resource);
  const relationships = modelRecords(resource.relationships).map((relationship) => withoutUndefined({
    id: modelString(relationship.id),
    activation: modelString(relationship.activation),
    operator_review_required: typeof relationship.operator_review_required === "boolean"
      ? relationship.operator_review_required
      : undefined,
    target_resource: modelString(relationship.target_resource),
    selectable_fields: modelStrings(relationship.selectable_fields),
    target_label: modelString(relationship.target_label),
    target_description: modelString(relationship.target_description),
    vocabulary: modelRecordOrUndefined(relationship.vocabulary),
    cardinality: modelString(relationship.cardinality),
    counted_entity: modelString(relationship.counted_entity),
    path_depth: modelNumber(relationship.path_depth),
    path: modelRelationshipPath(relationship.path),
    nullable: typeof relationship.nullable === "boolean" ? relationship.nullable : undefined,
    unmatched_rows: modelString(relationship.unmatched_rows),
    model_withheld_fields: withheldFieldNames(relationship.field_egress),
    fields: modelReviewedFields(relationship.fields, true),
    filter_operators: modelStringArrayRecord(relationship.filter_operators),
    groupable_fields: modelStrings(relationship.groupable_fields),
    aggregate_measure_functions: modelStringArrayRecord(relationship.aggregate_measure_functions),
    presence_measure_fields: modelStrings(relationship.presence_measure_fields),
    presence_measure_functions: modelStrings(relationship.presence_measure_functions),
    derived_measures: modelRecords(relationship.derived_measures),
    count_distinct_fields: modelStrings(relationship.count_distinct_fields),
    time_bucket_fields: modelStringArrayRecord(relationship.time_bucket_fields),
    relative_time_window_fields: modelStrings(relationship.relative_time_window_fields),
    field_enums: modelRecordOrEmpty(relationship.field_enums),
  }));
  return withoutUndefined({
    ...indexed,
    primary_key: modelString(resource.primary_key),
    fields: modelReviewedFields(resource.fields, true),
    model_withheld_fields: withheldFieldNames(resource.field_egress),
    kept_out_field_count: modelNumber(resource.kept_out_field_count),
    relationships,
  });
}

function modelRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(modelRecord) : [];
}

function modelReviewedFields(
  value: unknown,
  includeGrammar: boolean,
): Array<Record<string, unknown>> {
  return modelRecords(value).flatMap((field) => {
    const id = modelString(field.id);
    if (!id) return [];
    return [withoutUndefined({
      id,
      label: modelString(field.label),
      description: modelString(field.description),
      plan_reference: modelString(field.plan_reference),
      semantic_status: modelString(field.semantic_status),
      ...(includeGrammar ? {
        operations: modelRecordOrUndefined(field.operations),
        allowed_values: Array.isArray(field.allowed_values)
          ? structuredClone(field.allowed_values)
          : undefined,
      } : {}),
    })];
  });
}

function modelRecordOrEmpty(value: unknown): Record<string, unknown> {
  return modelRecord(value) ? structuredClone(value) : {};
}

function modelRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return modelRecord(value) ? structuredClone(value) : undefined;
}

function modelString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function modelNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function modelStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function modelStringArrayRecord(value: unknown): Record<string, string[]> {
  if (!modelRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, modelStrings(item)]));
}

function modelRelationshipPath(value: unknown): Record<string, unknown> | undefined {
  if (!modelRecord(value)) return undefined;
  return {
    resources: modelStrings(value.resources),
    via_columns: Array.isArray(value.via_columns)
      ? value.via_columns.map((columns) => modelStrings(columns))
      : [],
  };
}

function withheldFieldNames(value: unknown): string[] {
  if (!modelRecord(value)) return [];
  return Object.entries(value).flatMap(([field, egress]) =>
    modelRecord(egress) && egress.model_egress === "withheld" ? [field] : []);
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

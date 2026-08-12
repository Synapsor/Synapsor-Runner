import type {
  ActivatedExplorationBoundary,
  ExplorationRelationship,
  RelationshipLinkProof,
} from "./auto-boundary.js";

export const BOUNDARY_CATALOG_SCHEMA_VERSION = "synapsor.boundary-catalog.v1" as const;

export type BoundaryCatalogField = {
  name: string;
  data_type: string;
  label?: string;
  description?: string;
};

export type BoundaryCatalogTable = {
  id: string;
  label: string;
  description?: string;
  model_visible_fields: BoundaryCatalogField[];
  runner_only_field_count: number;
  kept_out_field_count: number;
  outside_boundary_relationship_count: number;
  reachable_tables: string[];
  groupable_fields: string[];
  aggregate_measures: string[];
  count_distinct_fields: string[];
  time_bucket_fields: string[];
  numeric_bands: Array<{
    name: string;
    label: string;
    field: string;
  }>;
  auto_bands: Array<{
    field: string;
    methods: Array<"quantile" | "equal_width">;
    min_buckets: number;
    max_buckets: number;
    label_style: "ordinal" | "rounded";
  }>;
  suggested_questions: string[];
  runner_only_analysis: {
    groupable_fields: string[];
    aggregate_measures: string[];
    count_distinct_fields: string[];
    time_bucket_fields: string[];
  };
};

export type BoundaryCatalogPathLink = {
  source_table: string;
  target_table: string;
  source_key: string;
  target_key: string;
  hidden_join_key: boolean;
  proven: boolean;
  nullable: boolean;
};

export type BoundaryCatalogRelationship = {
  id: string;
  source_table: string;
  target_table: string;
  source_key: string;
  target_key: string;
  hidden_join_key: boolean;
  cardinality: "many_to_one";
  proven: boolean;
  nullable: boolean;
  path_depth: 1 | 2 | 3;
  links: BoundaryCatalogPathLink[];
  suggested_questions: string[];
};

export type BoundaryCatalogBoundary = {
  name: string;
  digest: string;
  tables: BoundaryCatalogTable[];
  relationships: BoundaryCatalogRelationship[];
  physical_relationship_count: number;
};

export type BoundaryCatalogModel = {
  schema_version: typeof BOUNDARY_CATALOG_SCHEMA_VERSION;
  table_count: number;
  relationship_count: number;
  physical_relationship_count: number;
  boundaries: BoundaryCatalogBoundary[];
};

export type BoundaryCatalogDiagramExport = {
  boundary_name: string;
  digest: string;
  file_name: string;
  large: boolean;
  mermaid: string;
  markdown: string;
};

type BoundaryCatalogTopologyRoute = {
  tables: string[];
  links: BoundaryCatalogPathLink[];
};

type BoundaryResource = ActivatedExplorationBoundary["pack"]["resources"][number];

export function buildBoundaryCatalogModel(
  activeBoundaries: ActivatedExplorationBoundary[],
): BoundaryCatalogModel {
  const boundaries = [...activeBoundaries]
    .sort((left, right) => left.pack.name.localeCompare(right.pack.name))
    .map((boundary): BoundaryCatalogBoundary => {
      const resources = [...boundary.pack.resources]
        .sort((left, right) => left.id.localeCompare(right.id));
      const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
      const relationships: BoundaryCatalogRelationship[] = [];
      const outsideCounts = new Map<string, number>();

      for (const resource of resources) {
        for (const relationship of [...resource.relationships]
          .sort((left, right) => left.id.localeCompare(right.id))) {
          const target = resourcesById.get(relationship.target_resource);
          if (!target) {
            outsideCounts.set(resource.id, (outsideCounts.get(resource.id) ?? 0) + 1);
            continue;
          }
          const links = catalogPathLinks(resource, relationship, resourcesById);
          if (!links.length) {
            outsideCounts.set(resource.id, (outsideCounts.get(resource.id) ?? 0) + 1);
            continue;
          }
          const hiddenJoinKey = links.some((link) => link.hidden_join_key);
          const pathDepth = (links.length === 3 ? 3 : links.length === 2 ? 2 : 1) as 1 | 2 | 3;
          relationships.push({
            id: relationship.id,
            source_table: resource.id,
            target_table: target.id,
            source_key: links[0]!.source_key,
            target_key: links.at(-1)!.target_key,
            hidden_join_key: hiddenJoinKey,
            cardinality: relationship.cardinality,
            proven: relationship.proof?.source === "database_catalog"
              && links.every((link) => link.proven),
            nullable: relationship.nullable === true,
            path_depth: pathDepth,
            links,
            suggested_questions: reviewedRelationshipQuestions(resource, target),
          });
        }
      }
      relationships.sort((left, right) =>
        left.source_table.localeCompare(right.source_table)
        || left.path_depth - right.path_depth
        || left.target_table.localeCompare(right.target_table)
        || left.id.localeCompare(right.id));

      const tables = resources.map((resource): BoundaryCatalogTable => {
        const withheld = new Set(resource.model_withheld_fields ?? []);
        const visibleFields = resource.selectable_fields
          .filter((field) => !withheld.has(field) && !resource.kept_out_fields.includes(field))
          .sort((left, right) => left.localeCompare(right))
          .map((field) => ({
            name: field,
            data_type: resource.field_types[field] ?? "reviewed",
            ...(resource.field_metadata?.[field]?.label
              ? { label: resource.field_metadata[field]!.label }
              : {}),
            ...(resource.field_metadata?.[field]?.description
              ? { description: resource.field_metadata[field]!.description }
              : {}),
          }));
        return {
          id: resource.id,
          label: resource.label ?? humanizeIdentifier(resource.table),
          ...(resource.description ? { description: resource.description } : {}),
          model_visible_fields: visibleFields,
          runner_only_field_count: withheld.size,
          kept_out_field_count: resource.kept_out_fields.length,
          outside_boundary_relationship_count: outsideCounts.get(resource.id) ?? 0,
          reachable_tables: reachableTables(resource.id, relationships),
          groupable_fields: modelVisibleOperationFields(resource.groupable_fields, resource),
          aggregate_measures: modelVisibleOperationFields(resource.aggregate_measures, resource),
          count_distinct_fields: modelVisibleOperationFields(resource.count_distinct_fields, resource),
          time_bucket_fields: modelVisibleOperationFields(
            Object.keys(resource.time_bucket_fields),
            resource,
          ),
          numeric_bands: (resource.numeric_bands ?? [])
            .filter((band) => !hiddenFields(resource).has(band.field))
            .map((band) => ({ name: band.name, label: band.label, field: band.field })),
          auto_bands: (resource.auto_bands ?? [])
            .filter((policy) => !hiddenFields(resource).has(policy.field))
            .map((policy) => ({
              field: policy.field,
              methods: [...policy.methods],
              min_buckets: policy.min_buckets,
              max_buckets: policy.max_buckets,
              label_style: policy.label_style,
            })),
          suggested_questions: reviewedTableQuestions(resource),
          runner_only_analysis: {
            groupable_fields: runnerOnlyOperationFields(resource.groupable_fields, resource),
            aggregate_measures: runnerOnlyOperationFields(resource.aggregate_measures, resource),
            count_distinct_fields: runnerOnlyOperationFields(resource.count_distinct_fields, resource),
            time_bucket_fields: runnerOnlyOperationFields(
              Object.keys(resource.time_bucket_fields),
              resource,
            ),
          },
        };
      });

      return {
        name: boundary.pack.name,
        digest: boundary.activation.digest,
        tables,
        relationships,
        physical_relationship_count: physicalLinks(relationships).length,
      };
    });

  return {
    schema_version: BOUNDARY_CATALOG_SCHEMA_VERSION,
    table_count: boundaries.reduce((total, boundary) => total + boundary.tables.length, 0),
    relationship_count: boundaries.reduce(
      (total, boundary) => total + boundary.relationships.length,
      0,
    ),
    physical_relationship_count: boundaries.reduce(
      (total, boundary) => total + boundary.physical_relationship_count,
      0,
    ),
    boundaries,
  };
}

export function renderBoundaryCatalogAscii(
  model: BoundaryCatalogModel,
  options: { width?: number } = {},
): string {
  const width = Math.max(48, Math.min(120, options.width ?? 96));
  if (!model.boundaries.length) return "No active reviewed boundary diagram is available.";
  const lines: string[] = [];
  for (const boundary of model.boundaries) {
    lines.push(
      `Boundary ${boundary.name}`,
      `${boundary.tables.length} ${plural(boundary.tables.length, "table")} | `
      + `${boundary.physical_relationship_count} physical ${plural(boundary.physical_relationship_count, "join")} | `
      + `${boundary.relationships.length} reviewed ${plural(boundary.relationships.length, "path")}`,
      "",
      "TABLES AND REVIEWED ANALYSIS",
    );
    for (const table of boundary.tables) {
      lines.push(`[${table.label}]  ${table.id}`);
      if (table.description) {
        lines.push(...wrapWithPrefixes(table.description, width, "  ", "  "));
      }
      lines.push(...wrapWithPrefixes(
        `Model-visible: ${table.model_visible_fields.map(catalogFieldDisplay).join(", ") || "none"}`,
        width,
        "  ",
        "    ",
      ));
      lines.push(...wrapWithPrefixes(
        `Can analyze: ${tableAnalysisSummary(table)}`,
        width,
        "  ",
        "    ",
      ));
      const runnerOnlySummary = boundaryCatalogRunnerOnlyAnalysisSummary(table);
      if (runnerOnlySummary) {
        lines.push(...wrapWithPrefixes(
          `Runner-only analysis: ${runnerOnlySummary}`,
          width,
          "  ",
          "    ",
        ));
      }
      lines.push(
        `  Runner-only: ${table.runner_only_field_count} | Kept out: ${table.kept_out_field_count}`,
      );
      if (table.outside_boundary_relationship_count > 0) {
        lines.push(
          `  Outside boundary: ${table.outside_boundary_relationship_count} relationship not available`,
        );
      }
      lines.push("");
    }

    if (!boundary.relationships.length) {
      lines.push(
        "RELATIONSHIPS",
        boundary.tables.length === 1
          ? "No join arrows are shown because this reviewed boundary contains one table."
          : "No join arrows are shown because no relationship path is reviewed in this boundary.",
        "Ask can still run the single-table counts, totals, groupings, filters, and time trends listed above.",
        `To add a join: /access -> highlight ${boundary.name} -> Enter -> A Add related tables -> C Review + activate.`,
      );
    } else {
      lines.push("REVIEWED RELATIONSHIP MAP");
      for (const table of boundary.tables) {
        const outgoing = boundary.relationships.filter((relationship) =>
          relationship.source_table === table.id);
        if (!outgoing.length) continue;
        lines.push(`[${table.id}]`);
        outgoing.forEach((relationship, index) => {
          const last = index === outgoing.length - 1;
          const branch = last ? "`--" : "|--";
          const continuation = last ? "    " : "|   ";
          lines.push(...wrapWithPrefixes(
            `${relationshipPathLabel(relationship)} `
            + `[many-to-one, ${relationship.proven ? "proven" : "proof unavailable"}, `
            + `${relationship.path_depth} ${plural(relationship.path_depth, "join")}]`,
            width,
            `  ${branch} `,
            `  ${continuation}`,
          ));
          for (const question of relationship.suggested_questions.slice(0, 1)) {
            lines.push(...wrapWithPrefixes(
              `Ask: "${question}"`,
              width,
              `  ${continuation}`,
              `  ${continuation}     `,
            ));
          }
        });
        lines.push("");
      }
    }

    const questions = unique([
      ...boundary.relationships.flatMap((relationship) => relationship.suggested_questions),
      ...boundary.tables.flatMap((table) => table.suggested_questions ?? []),
    ]);
    if (questions.length) {
      lines.push("", boundary.relationships.length
        ? "TRY CROSS-TABLE QUESTIONS"
        : "TRY SINGLE-TABLE QUESTIONS");
      questions.slice(0, 6).forEach((question, index) => {
        lines.push(...wrapWithPrefixes(
          `"${question}"`,
          width,
          `${index + 1}. `,
          "   ",
        ));
      });
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderBoundaryCatalogTopologyAscii(
  model: BoundaryCatalogModel,
  options: { width?: number } = {},
): string {
  const width = Math.max(48, Math.min(120, options.width ?? 96));
  if (!model.boundaries.length) return "No active reviewed boundary diagram is available.";
  const lines: string[] = [];
  for (const boundary of model.boundaries) {
    const links = physicalLinks(boundary.relationships);
    const tablesById = new Map(boundary.tables.map((table) => [table.id, table]));
    lines.push(
      ...wrapWithPrefixes(`Boundary ${boundary.name}`, width, "", "  "),
      ...wrapWithPrefixes(
        `${boundary.tables.length} ${plural(boundary.tables.length, "table")} | `
        + `${links.length} physical ${plural(links.length, "join")} | `
        + `${boundary.relationships.length} reviewed ${plural(boundary.relationships.length, "path")}`,
        width,
        "",
        "  ",
      ),
      "",
    );
    if (!links.length) {
      lines.push("ANALYSIS NODE", "");
      for (const table of boundary.tables) {
        lines.push(...renderTopologyNode(table, width), "");
      }
      lines.push(...wrapLine(
        boundary.tables.length === 1
          ? "No arrow is drawn because this boundary contains one reviewed table."
          : "No arrow is drawn because this boundary has no reviewed physical join.",
        width,
      ));
      lines.push(...wrapLine(
        "Use /catalog to inspect the fields and operations available on each table.",
        width,
      ));
    } else {
      const routes = topologyRoutes(links);
      lines.push(
        "REVIEWED JOIN TOPOLOGY",
      );
      lines.push(...wrapLine(
        "Arrows point from the many-row table to its reviewed one-row parent.",
        width,
      ), "");
      routes.forEach((route, index) => {
        if (routes.length > 1) lines.push(`Route ${index + 1} of ${routes.length}`, "");
        lines.push(...renderTopologyRoute(route, width, tablesById));
        if (index < routes.length - 1) lines.push("");
      });
      const linkedTables = new Set(links.flatMap((link) => [link.source_table, link.target_table]));
      const disconnected = boundary.tables.filter((table) => !linkedTables.has(table.id));
      if (disconnected.length > 0) {
        lines.push("", "REVIEWED TABLES WITHOUT A JOIN PATH", "");
        disconnected.forEach((table, index) => {
          lines.push(...renderTopologyNode(table, width));
          if (index < disconnected.length - 1) lines.push("");
        });
      }
      const composedPaths = Math.max(0, boundary.relationships.length - links.length);
      if (composedPaths > 0) {
        lines.push("");
        lines.push(...wrapLine(
          `${composedPaths} reviewed multi-join ${plural(composedPaths, "path")} `
          + `${composedPaths === 1 ? "is" : "are"} composed from the arrows above; `
          + "no duplicate shortcut is drawn.",
          width,
        ));
      }
    }

    const questions = catalogQuestions(boundary);
    if (questions.length) {
      lines.push("", links.length ? "QUESTIONS ACROSS THIS MAP" : "QUESTIONS FOR THIS TABLE");
      questions.slice(0, 6).forEach((question, index) => {
        lines.push(...wrapWithPrefixes(`"${question}"`, width, `${index + 1}. `, "   "));
      });
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderBoundaryCatalogMermaid(model: BoundaryCatalogModel): string {
  const lines = ["flowchart LR"];
  const identifiers = mermaidIdentifiers(model);
  for (const boundary of model.boundaries) {
    lines.push(`  %% Boundary: ${mermaidComment(boundary.name)}`);
    for (const table of boundary.tables) {
      const identifier = identifiers.get(tableKey(boundary.name, table.id))!;
      const nodeLines = [
        table.label,
        table.id,
        ...table.model_visible_fields.map(catalogFieldDisplay),
        ...(table.runner_only_field_count > 0
          ? [`${table.runner_only_field_count} Runner-only ${plural(table.runner_only_field_count, "field")}`]
          : []),
        ...(table.kept_out_field_count > 0
          ? [`${table.kept_out_field_count} kept-out ${plural(table.kept_out_field_count, "field")}`]
          : []),
      ];
      lines.push(`  ${identifier}["${nodeLines.map(mermaidFlowLabel).join("<br/>")}"]`);
    }
    for (const link of physicalLinks(boundary.relationships)) {
      const source = identifiers.get(tableKey(boundary.name, link.source_table))!;
      const target = identifiers.get(tableKey(boundary.name, link.target_table))!;
      const label = [
        `${link.source_key} -> ${link.target_key}`,
        `many-to-one; ${link.proven ? "catalog proven" : "proof unavailable"}`
          + (link.nullable ? "; nullable" : ""),
      ].map(mermaidFlowLabel).join("<br/>");
      lines.push(`  ${source} ${link.proven ? "-->" : "-.->"}|"${label}"| ${target}`);
    }
  }
  return lines.join("\n");
}

export function buildBoundaryCatalogDiagramExports(
  model: BoundaryCatalogModel,
  options: { width?: number; includeMermaid?: boolean } = {},
): BoundaryCatalogDiagramExport[] {
  return model.boundaries.map((boundary) => {
    const scoped = boundaryCatalogModelFor(model, boundary);
    const digestSuffix = boundary.digest.replace(/^sha256:/, "").slice(0, 12);
    const fileName = `${safeCatalogFileName(boundary.name)}-${digestSuffix}.boundary-diagram.md`;
    const mermaid = renderBoundaryCatalogMermaid(scoped);
    return {
      boundary_name: boundary.name,
      digest: boundary.digest,
      file_name: fileName,
      large: boundaryCatalogDiagramIsLarge(boundary),
      mermaid,
      markdown: renderBoundaryCatalogMarkdown(scoped, {
        width: options.width,
        mermaid,
        includeMermaid: options.includeMermaid,
      }),
    };
  });
}

export function boundaryCatalogModelFor(
  model: BoundaryCatalogModel,
  boundary: BoundaryCatalogBoundary,
): BoundaryCatalogModel {
  return {
    schema_version: model.schema_version,
    table_count: boundary.tables.length,
    relationship_count: boundary.relationships.length,
    physical_relationship_count: boundary.physical_relationship_count,
    boundaries: [boundary],
  };
}

export function boundaryCatalogDiagramIsLarge(boundary: BoundaryCatalogBoundary): boolean {
  return boundary.tables.length > 10 || boundary.physical_relationship_count > 15;
}

export function renderBoundaryCatalogMarkdown(
  model: BoundaryCatalogModel,
  options: { width?: number; mermaid?: string; includeMermaid?: boolean } = {},
): string {
  if (model.boundaries.length !== 1) {
    throw new Error("A boundary diagram export must contain exactly one reviewed boundary.");
  }
  const boundary = model.boundaries[0]!;
  const relationshipSection = boundary.physical_relationship_count > 0 && options.includeMermaid !== false
    ? [
        "## Mermaid Relationship Diagram",
        "",
        "```mermaid",
        options.mermaid ?? renderBoundaryCatalogMermaid(model),
        "```",
      ]
    : boundary.physical_relationship_count > 0
      ? [
        "## Relationships",
        "",
        "The reviewed joins are shown in the readable map above.",
      ]
      : [
        "## Relationships",
        "",
        options.includeMermaid === false
          ? "This boundary has no reviewed join to draw."
          : "No Mermaid relationship diagram is included because this boundary has no reviewed join to draw.",
      ];
  return [
    `# Reviewed Boundary: ${boundary.name}`,
    "",
    `Fingerprint: \`${boundary.digest}\``,
    "",
    "This is the exact reviewed table, field, operation, and relationship map available to Ask.",
    "It was generated from activated boundary metadata; no source rows were read.",
    "",
    "## Readable Map",
    "",
    "```text",
    renderBoundaryCatalogTopologyAscii(model, { width: options.width ?? 96 }),
    "```",
    "",
    "## Reviewed Analysis",
    "",
    "```text",
    renderBoundaryCatalogAscii(model, { width: options.width ?? 96 }),
    "```",
    "",
    ...relationshipSection,
    "",
  ].join("\n");
}

function catalogPathLinks(
  root: BoundaryResource,
  relationship: ExplorationRelationship,
  resourcesById: Map<string, BoundaryResource>,
): BoundaryCatalogPathLink[] {
  const rawLinks: Array<Pick<RelationshipLinkProof,
    "source_resource" | "target_resource" | "source_columns" | "target_columns" | "nullable">> =
    relationship.proof?.links?.length
      ? relationship.proof.links
      : [{
        source_resource: root.id,
        target_resource: relationship.target_resource,
        source_columns: relationship.local_columns,
        target_columns: relationship.target_columns,
        nullable: relationship.nullable === true,
      }];
  const links: BoundaryCatalogPathLink[] = [];
  for (const raw of rawLinks) {
    const source = resourcesById.get(raw.source_resource);
    const target = resourcesById.get(raw.target_resource);
    if (!source || !target) return [];
    const hiddenJoinKey = raw.source_columns.some((field) => hiddenFields(source).has(field))
      || raw.target_columns.some((field) => hiddenFields(target).has(field));
    links.push({
      source_table: source.id,
      target_table: target.id,
      source_key: hiddenJoinKey
        ? "[reviewed hidden join key]"
        : raw.source_columns.join(", "),
      target_key: hiddenJoinKey
        ? "[reviewed hidden join key]"
        : raw.target_columns.join(", "),
      hidden_join_key: hiddenJoinKey,
      proven: relationship.proof?.source === "database_catalog",
      nullable: raw.nullable === true,
    });
  }
  return links;
}

function reviewedRelationshipQuestions(source: BoundaryResource, target: BoundaryResource): string[] {
  const targetVisible = new Set(target.selectable_fields.filter((field) =>
    !target.kept_out_fields.includes(field)
    && !(target.model_withheld_fields ?? []).includes(field)));
  const group = target.groupable_fields.find((field) => targetVisible.has(field));
  if (!group) return [];
  const measure = source.aggregate_measures
    .filter((field) => !source.kept_out_fields.includes(field))
    .filter((field) => measureUsefulness(field) > 0)
    .sort((left, right) => measureUsefulness(right) - measureUsefulness(left)
      || left.localeCompare(right))[0];
  const time = Object.keys(source.time_bucket_fields).find((field) =>
    !source.kept_out_fields.includes(field));
  const sourcePlural = reviewedResourceLabel(source).toLowerCase();
  const groupPhrase = reviewedDimensionPhrase(target, group);
  const metric = reviewedMetricPhrase(source, measure);
  return unique([
    measure
      ? `What is the ${metric} by ${groupPhrase}?`
      : `How many ${sourcePlural} are there by ${groupPhrase}?`,
    ...(time ? [`How did ${metricForTrend(metric)} change by month for each ${groupPhrase}?`] : []),
  ]);
}

function reviewedTableQuestions(resource: BoundaryResource): string[] {
  const hidden = hiddenFields(resource);
  const groups = resource.groupable_fields.filter((field) => !hidden.has(field));
  const measures = resource.aggregate_measures
    .filter((field) => !hidden.has(field) && measureUsefulness(field) > 0)
    .sort((left, right) => measureUsefulness(right) - measureUsefulness(left)
      || left.localeCompare(right));
  const times = Object.keys(resource.time_bucket_fields).filter((field) => !hidden.has(field));
  const pluralNoun = reviewedResourceLabel(resource).toLowerCase();
  const group = groups[0];
  const measure = measures[0];
  const metric = reviewedMetricPhrase(resource, measure);
  const fixedBand = (resource.numeric_bands ?? []).find((band) => !hidden.has(band.field));
  const autoBand = (resource.auto_bands ?? []).find((policy) => !hidden.has(policy.field));
  const automaticBucketCount = autoBand
    ? Math.min(autoBand.max_buckets, Math.max(autoBand.min_buckets, 5))
    : undefined;
  return unique([
    ...(group
      ? [measure
          ? `What is the ${metric} by ${reviewedDimensionPhrase(resource, group)}?`
          : `How many ${pluralNoun} are there by ${reviewedDimensionPhrase(resource, group)}?`]
      : []),
    ...(group && measure ? [`How many ${pluralNoun} are there by ${reviewedDimensionPhrase(resource, group)}?`] : []),
    ...(times.length ? [`How did ${metricForTrend(metric)} change by week?`] : []),
    ...(fixedBand
      ? [`How many ${pluralNoun} are there by ${humanizeIdentifier(fixedBand.label).toLowerCase()}?`]
      : []),
    ...(autoBand && automaticBucketCount
      ? [`How many ${pluralNoun} fall into ${automaticBucketCount} automatic ${autoBand.methods[0]!.replace("_", "-")} bands of ${reviewedFieldLabel(resource, autoBand.field).toLowerCase()}?`]
      : []),
    ...(!group && !times ? [`How many ${pluralNoun} are there?`] : []),
  ]).slice(0, 5);
}

function reviewedMetricPhrase(resource: BoundaryResource, measure?: string): string {
  const pluralNoun = reviewedResourceLabel(resource).toLowerCase();
  if (!measure) return `number of ${pluralNoun}`;
  const sourceNoun = singularize(pluralNoun);
  const normalized = reviewedFieldLabel(resource, measure)
    .toLowerCase()
    .replace(/\s+cents?$/, "")
    .trim();
  const metric = normalized === "total"
    ? "value"
    : normalized.replace(/^total\s+/, "") || "value";
  return `total ${sourceNoun} ${metric}`;
}

function reviewedDimensionPhrase(resource: BoundaryResource, field: string): string {
  const resourceWords = singularize(reviewedResourceLabel(resource).toLowerCase()).split(/\s+/);
  const fieldWords = reviewedFieldLabel(resource, field).toLowerCase().split(/\s+/);
  if (/^(?:name|title|label|display name)$/.test(fieldWords.join(" "))) {
    return resourceWords.join(" ");
  }
  let overlap = Math.min(resourceWords.length, fieldWords.length);
  while (overlap > 0) {
    const resourceSuffix = resourceWords.slice(resourceWords.length - overlap).join(" ");
    const fieldPrefix = fieldWords.slice(0, overlap).join(" ");
    if (resourceSuffix === fieldPrefix) break;
    overlap -= 1;
  }
  if (overlap > 0) return [...resourceWords, ...fieldWords.slice(overlap)].join(" ");
  if (fieldWords.length > 1) return fieldWords.join(" ");
  return [...resourceWords, ...fieldWords].join(" ");
}

function metricForTrend(metric: string): string {
  return metric.startsWith("number of ") ? `the ${metric}` : metric;
}

function hiddenFields(resource: BoundaryResource): Set<string> {
  return new Set([
    ...resource.kept_out_fields,
    ...(resource.model_withheld_fields ?? []),
  ]);
}

function reviewedOperationFields(fields: string[], resource: BoundaryResource): string[] {
  return unique(fields.filter((field) => !resource.kept_out_fields.includes(field)))
    .sort((left, right) => left.localeCompare(right));
}

function modelVisibleOperationFields(fields: string[], resource: BoundaryResource): string[] {
  const withheld = new Set(resource.model_withheld_fields ?? []);
  return reviewedOperationFields(fields, resource).filter((field) => !withheld.has(field));
}

function runnerOnlyOperationFields(fields: string[], resource: BoundaryResource): string[] {
  const withheld = new Set(resource.model_withheld_fields ?? []);
  return reviewedOperationFields(fields, resource).filter((field) => withheld.has(field));
}

function reachableTables(
  source: string,
  relationships: BoundaryCatalogRelationship[],
): string[] {
  const outgoing = new Map<string, string[]>();
  for (const relationship of relationships) {
    const targets = outgoing.get(relationship.source_table) ?? [];
    targets.push(relationship.target_table);
    outgoing.set(relationship.source_table, targets);
  }
  const visited = new Set<string>();
  const queue = [...(outgoing.get(source) ?? [])];
  while (queue.length) {
    const target = queue.shift()!;
    if (target === source || visited.has(target)) continue;
    visited.add(target);
    queue.push(...(outgoing.get(target) ?? []));
  }
  return [...visited].sort((left, right) => left.localeCompare(right));
}

function tableAnalysisSummary(table: BoundaryCatalogTable): string {
  return [
    "record counts",
    ...(table.aggregate_measures.length
      ? [`totals/averages of ${table.aggregate_measures.join(", ")}`]
      : []),
    ...(table.count_distinct_fields.length
      ? [`unique counts of ${table.count_distinct_fields.join(", ")}`]
      : []),
    ...(table.groupable_fields.length
      ? [`group by ${table.groupable_fields.join(", ")}`]
      : []),
    ...(table.time_bucket_fields.length
      ? [`day/week/month using ${table.time_bucket_fields.join(", ")}`]
      : []),
    ...((table.numeric_bands ?? []).length
      ? [`reviewed numeric bands ${(table.numeric_bands ?? []).map((band) => `${band.name} (${band.field})`).join(", ")}`]
      : []),
    ...((table.auto_bands ?? []).length
      ? [`automatic numeric bands ${(table.auto_bands ?? []).map((policy) =>
        `${policy.field} (${policy.methods.map((method) => method.replace("_", " ")).join(" or ")}; `
        + `${policy.min_buckets}-${policy.max_buckets} buckets; ${policy.label_style} labels)`).join(", ")}`]
      : []),
  ].join("; ");
}

export function boundaryCatalogRunnerOnlyAnalysisSummary(table: BoundaryCatalogTable): string {
  return [
    ...(table.runner_only_analysis.aggregate_measures.length
      ? [`totals/averages of ${table.runner_only_analysis.aggregate_measures.join(", ")} (raw values withheld)`]
      : []),
    ...(table.runner_only_analysis.count_distinct_fields.length
      ? [`unique counts of ${table.runner_only_analysis.count_distinct_fields.join(", ")} (raw values withheld)`]
      : []),
    ...(table.runner_only_analysis.groupable_fields.length
      ? [`group by ${table.runner_only_analysis.groupable_fields.join(", ")} (labels tokenized)`]
      : []),
    ...(table.runner_only_analysis.time_bucket_fields.length
      ? [`day/week/month using ${table.runner_only_analysis.time_bucket_fields.join(", ")} (labels tokenized)`]
      : []),
  ].join("; ");
}

function relationshipPathLabel(relationship: BoundaryCatalogRelationship): string {
  return relationship.links.map((link, index) =>
    `${index === 0 ? link.source_key : link.source_key} -> [${link.target_table}].${link.target_key}`)
    .join(" -> ");
}

function catalogQuestions(boundary: BoundaryCatalogBoundary): string[] {
  return unique([
    ...boundary.relationships.flatMap((relationship) => relationship.suggested_questions),
    ...boundary.tables.flatMap((table) => table.suggested_questions),
  ]);
}

function topologyRoutes(links: BoundaryCatalogPathLink[]): BoundaryCatalogTopologyRoute[] {
  const remaining = new Map(links.map((link) => [physicalLinkKey(link), link]));
  const routes: BoundaryCatalogTopologyRoute[] = [];
  while (remaining.size > 0) {
    const available = [...remaining.values()];
    const targets = new Set(available.map((link) => link.target_table));
    const first = available.find((link) => !targets.has(link.source_table)) ?? available[0]!;
    const route: BoundaryCatalogTopologyRoute = {
      tables: [first.source_table],
      links: [],
    };
    let current = first.source_table;
    while (true) {
      const next = [...remaining.values()].find((link) => link.source_table === current);
      if (!next) break;
      remaining.delete(physicalLinkKey(next));
      route.links.push(next);
      route.tables.push(next.target_table);
      current = next.target_table;
    }
    routes.push(route);
  }
  return routes;
}

function renderTopologyRoute(
  route: BoundaryCatalogTopologyRoute,
  width: number,
  tablesById: Map<string, BoundaryCatalogTable>,
): string[] {
  const insideWidth = Math.max(
    18,
    Math.min(width - 6, Math.max(...route.tables.map((id) => {
      const table = tablesById.get(id);
      return Math.max(id.length, table?.label.length ?? 0);
    }))),
  );
  const boxWidth = insideWidth + 4;
  const connectorColumn = 2 + Math.floor(boxWidth / 2);
  const lines = renderTopologyNode(
    tablesById.get(route.tables[0]!) ?? { id: route.tables[0]!, label: route.tables[0]! } as BoundaryCatalogTable,
    width,
    insideWidth,
  );
  route.links.forEach((link, index) => {
    lines.push(" ".repeat(connectorColumn) + "|");
    lines.push(...renderTopologyConnectorLine(
      `${link.source_key} -> ${link.target_key}`,
      connectorColumn,
      width,
    ));
    lines.push(...renderTopologyConnectorLine(
      `many-to-one; ${link.proven ? "catalog proven" : "proof unavailable"}`
        + (link.nullable ? "; nullable" : ""),
      connectorColumn,
      width,
    ));
    lines.push(" ".repeat(connectorColumn) + "v");
    const tableId = route.tables[index + 1]!;
    lines.push(...renderTopologyNode(
      tablesById.get(tableId) ?? { id: tableId, label: tableId } as BoundaryCatalogTable,
      width,
      insideWidth,
    ));
  });
  return lines;
}

function renderTopologyNode(
  table: BoundaryCatalogTable,
  width: number,
  requestedInsideWidth?: number,
): string[] {
  const insideWidth = requestedInsideWidth
    ?? Math.max(18, Math.min(width - 6, Math.max(table.label.length, table.id.length)));
  const chunks = [table.label, table.id].flatMap((value) => hardWrapText(value, insideWidth));
  const border = `  +${"-".repeat(insideWidth + 2)}+`;
  return [
    border,
    ...chunks.map((chunk) => `  | ${chunk.padEnd(insideWidth)} |`),
    border,
  ];
}

function catalogFieldDisplay(field: BoundaryCatalogField): string {
  return field.label ? `${field.label} (${field.name})` : field.name;
}

function reviewedResourceLabel(resource: BoundaryResource): string {
  return resource.label ?? humanizeIdentifier(resource.table);
}

function reviewedFieldLabel(resource: BoundaryResource, field: string): string {
  return resource.field_metadata?.[field]?.label ?? humanizeIdentifier(field);
}

function renderTopologyConnectorLine(
  value: string,
  connectorColumn: number,
  width: number,
): string[] {
  const prefix = `${" ".repeat(connectorColumn)}| `;
  return wrapHardLine(value, Math.max(12, width - prefix.length)).map((line) => `${prefix}${line}`);
}

function hardWrapText(value: string, width: number): string[] {
  if (!value) return [""];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += width) {
    chunks.push(value.slice(index, index + width));
  }
  return chunks;
}

function wrapHardLine(value: string, width: number): string[] {
  const words = value.split(/\s+/).flatMap((word) => hardWrapText(word, width));
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

function physicalLinks(relationships: BoundaryCatalogRelationship[]): BoundaryCatalogPathLink[] {
  const links = new Map<string, BoundaryCatalogPathLink>();
  for (const relationship of relationships) {
    for (const link of relationship.links) {
      const key = [
        link.source_table,
        link.target_table,
        link.source_key,
        link.target_key,
      ].join("\u0000");
      const existing = links.get(key);
      if (!existing || (!existing.proven && link.proven)) links.set(key, link);
    }
  }
  return [...links.values()].sort((left, right) =>
    left.source_table.localeCompare(right.source_table)
    || left.target_table.localeCompare(right.target_table)
    || left.source_key.localeCompare(right.source_key));
}

function physicalLinkKey(link: BoundaryCatalogPathLink): string {
  return [
    link.source_table,
    link.target_table,
    link.source_key,
    link.target_key,
  ].join("\u0000");
}

function wrapLine(value: string, width: number, continuation = ""): string[] {
  if (value.length <= width) return [value];
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width || !current) {
      current = next;
      continue;
    }
    lines.push(current);
    current = `${continuation}${word}`;
  }
  if (current) lines.push(current);
  return lines;
}

function wrapWithPrefixes(
  value: string,
  width: number,
  firstPrefix: string,
  continuationPrefix: string,
): string[] {
  const contentWidth = Math.max(
    12,
    width - Math.max(firstPrefix.length, continuationPrefix.length),
  );
  return wrapLine(value, contentWidth).map((line, index) =>
    `${index === 0 ? firstPrefix : continuationPrefix}${line}`);
}

function mermaidIdentifiers(model: BoundaryCatalogModel): Map<string, string> {
  const tableOccurrences = new Map<string, number>();
  for (const boundary of model.boundaries) {
    for (const table of boundary.tables) {
      tableOccurrences.set(table.id, (tableOccurrences.get(table.id) ?? 0) + 1);
    }
  }
  const identifiers = new Map<string, string>();
  const used = new Set<string>();
  for (const boundary of model.boundaries) {
    for (const table of boundary.tables) {
      const source = tableOccurrences.get(table.id) === 1
        ? table.id
        : `${boundary.name}_${table.id}`;
      const base = mermaidIdentifier(source, "TABLE").toUpperCase();
      let identifier = base;
      let suffix = 2;
      while (used.has(identifier)) identifier = `${base}_${suffix++}`;
      used.add(identifier);
      identifiers.set(tableKey(boundary.name, table.id), identifier);
    }
  }
  return identifiers;
}

function tableKey(boundary: string, table: string): string {
  return `${boundary}\u0000${table}`;
}

function mermaidIdentifier(value: string, fallback: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  const prefixed = /^[A-Za-z]/.test(normalized) ? normalized : `N_${normalized}`;
  return prefixed || fallback;
}

function mermaidFlowLabel(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/\|/g, "&#124;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n]/g, " ");
}

function mermaidComment(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function singularize(value: string): string {
  if (value.endsWith("ies") && value.length > 3) return `${value.slice(0, -3)}y`;
  if (value.endsWith("sses")) return value.slice(0, -2);
  if (value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function measureUsefulness(field: string): number {
  const normalized = field.toLowerCase();
  if (normalized === "id" || normalized.endsWith("_id") || normalized === "version") return -100;
  if (/(amount|revenue|price|cost|balance|fee|discount|total|subtotal|tax|quantity|duration|usage|count)/.test(normalized)) {
    return 100;
  }
  return 0;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function safeCatalogFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "boundary";
}

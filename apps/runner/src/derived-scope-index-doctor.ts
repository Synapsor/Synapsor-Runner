import type { SchemaInspection, SourceEngine, TableInfo } from "@synapsor-runner/schema-inspector";
import type { ActivatedExplorationBoundary, DerivedScopePath } from "./auto-boundary.js";
import type { DoctorCheck } from "./doctor-domain.js";
import { formatDerivedScopePath } from "./derived-scope-display.js";


type ScopeKind = "tenant" | "principal";

const DERIVED_SCOPE_ROW_HOP_WARNING = 500_000;
const DERIVED_SCOPE_SELECTIVITY_MIN_ROWS = 100_000;
const DERIVED_SCOPE_SELECTIVITY_MAX_DISTINCT = 50;


export function derivedScopeIndexDoctorChecks(input: {
  boundaries: ActivatedExplorationBoundary[];
  inspectionsBySource: ReadonlyMap<string, readonly SchemaInspection[]>;
}): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  let pathCount = 0;
  let missingCount = 0;

  for (const boundary of [...input.boundaries].sort((left, right) =>
    left.pack.name.localeCompare(right.pack.name))) {
    const reviewedScopes = boundary.pack.resources.flatMap((resource) => [
      ...(resource.tenant_scope ? [{ kind: "tenant" as const, scope: resource.tenant_scope }] : []),
      ...(resource.principal_scope ? [{ kind: "principal" as const, scope: resource.principal_scope }] : []),
    ]);
    if (reviewedScopes.length === 0) continue;
    pathCount += reviewedScopes.length;
    const inspections = input.inspectionsBySource.get(boundary.source) ?? [];
    if (inspections.length === 0) {
      missingCount += reviewedScopes.length;
      checks.push(unavailableSourceMetadataCheck(boundary, reviewedScopes.length));
      continue;
    }
    const liveTables = new Map(inspections.flatMap((inspection) => inspection.tables)
      .map((table) => [resourceId(table.schema, table.name), table] as const));
    const resources = new Map(boundary.pack.resources.map((resource) => [resource.id, resource]));
    const engine = inspections[0]?.engine;

    for (const { kind, scope } of reviewedScopes) {
      const pathLabel = derivedScopePathLabel(scope, kind);
      const rootTable = liveTables.get(scope.proof.links[0]?.source_resource ?? "");
      const costAdvisory = derivedScopeCostAdvisoryCheck({
        boundary,
        pathLabel,
        kind,
        depth: scope.proof.links.length,
        rootTable,
      });
      if (costAdvisory) checks.push(costAdvisory);

      for (const link of scope.proof.links) {
        const source = resources.get(link.source_resource);
        const target = resources.get(link.target_resource);
        const sourceTable = source ? liveTables.get(source.id) : undefined;
        const targetTable = target ? liveTables.get(target.id) : undefined;

        if (!sourceTable) {
          missingCount += 1;
          checks.push(unavailableMetadataCheck(boundary, pathLabel, link.source_resource));
        } else if (!hasUsableLeadingIndex(sourceTable, link.source_columns)) {
          missingCount += 1;
          checks.push(missingIndexCheck({
            boundary,
            pathLabel,
            role: "FK correlation",
            table: sourceTable,
            columns: link.source_columns,
            engine,
            advisory: "warning",
            effect: "the mandatory scoping EXISTS may scan the child table",
          }));
        }

        if (!targetTable) {
          missingCount += 1;
          checks.push(unavailableMetadataCheck(boundary, pathLabel, link.target_resource));
        } else if (!hasUsableLeadingIndex(targetTable, link.target_columns)) {
          missingCount += 1;
          checks.push(missingIndexCheck({
            boundary,
            pathLabel,
            role: "referenced key",
            table: targetTable,
            columns: link.target_columns,
            engine,
            advisory: "note",
            effect: "the mandatory scoping EXISTS cannot use a leading referenced-key index",
          }));
        }
      }

      const terminal = resources.get(scope.ancestor_resource);
      const terminalTable = terminal ? liveTables.get(terminal.id) : undefined;
      if (!terminalTable) {
        missingCount += 1;
        checks.push(unavailableMetadataCheck(boundary, pathLabel, scope.ancestor_resource));
      } else if (!hasUsableLeadingIndex(terminalTable, [scope.ancestor_column])) {
        missingCount += 1;
        checks.push(missingIndexCheck({
          boundary,
          pathLabel,
          role: `${kind} filter`,
          table: terminalTable,
          columns: [scope.ancestor_column],
          engine,
          advisory: "note",
          effect: `the terminal ${kind} predicate may require more filtering work`,
        }));
      } else {
        const selectivityAdvisory = derivedScopeSelectivityAdvisoryCheck({
          boundary,
          pathLabel,
          kind,
          terminalTable,
          terminalColumn: scope.ancestor_column,
          engine,
        });
        if (selectivityAdvisory) checks.push(selectivityAdvisory);
      }
    }
  }

  if (pathCount > 0 && missingCount === 0) {
    const pathSummary = pathCount === 1
      ? "the reviewed derived-scope path"
      : `all ${pathCount} reviewed derived-scope paths`;
    checks.push({
      name: "derived-scope-indexes:complete",
      ok: true,
      level: "pass",
      message: `The indexes required by ${pathSummary} exist in the live catalog (FK correlation, referenced keys, and terminal tenant/principal filters). This attests index availability only; the database planner may still choose scans for low-selectivity predicates.`,
    });
  }
  return checks;
}

function derivedScopeSelectivityAdvisoryCheck(input: {
  boundary: ActivatedExplorationBoundary;
  pathLabel: string;
  kind: ScopeKind;
  terminalTable: TableInfo;
  terminalColumn: string;
  engine: SourceEngine | undefined;
}): DoctorCheck | undefined {
  const rowEstimate = input.terminalTable.approximate_row_count;
  const distinctEstimate = leadingIndexDistinctEstimate(input.terminalTable, input.terminalColumn);
  if (rowEstimate === undefined
    || rowEstimate < DERIVED_SCOPE_SELECTIVITY_MIN_ROWS
    || distinctEstimate === undefined
    || distinctEstimate > DERIVED_SCOPE_SELECTIVITY_MAX_DISTINCT) {
    return undefined;
  }
  const boundedDistinct = Math.max(1, Math.min(distinctEstimate, rowEstimate));
  const rowsPerValue = Math.round(rowEstimate / boundedDistinct);
  const sharePerValue = 100 / boundedDistinct;
  const engineName = input.engine === "postgres"
    ? "PostgreSQL"
    : input.engine === "mysql"
      ? "MySQL"
      : "database";
  const terminal = `${resourceId(input.terminalTable.schema, input.terminalTable.name)}.${input.terminalColumn}`;
  return {
    name: `derived-scope-selectivity:${input.boundary.pack.name}:${doctorNamePart(input.pathLabel)}`,
    ok: true,
    level: "warn",
    advisory: "warning",
    message:
      `Derived-scope selectivity warning for boundary ${input.boundary.pack.name}, path ${input.pathLabel}: `
      + `the required index on ${terminal} exists, but live ${engineName} catalog statistics estimate about `
      + `${boundedDistinct.toLocaleString("en-US")} distinct ${input.kind} ${boundedDistinct === 1 ? "value" : "values"} across about `
      + `${rowEstimate.toLocaleString("en-US")} rows (roughly ${rowsPerValue.toLocaleString("en-US")} rows, or `
      + `${formatPercentage(sharePerValue)}, per value under a uniform estimate). The planner may choose scans at this selectivity; `
      + `index available does not mean index used. Catalog statistics are approximate and may be stale. Measure the real plan; `
      + `prefer a direct ${input.kind} column on a high-volume leaf or a shorter reviewed path where the schema permits, `
      + `or raise the reviewed statement_timeout_ms only after measuring.`,
  };
}

function derivedScopeCostAdvisoryCheck(input: {
  boundary: ActivatedExplorationBoundary;
  pathLabel: string;
  kind: ScopeKind;
  depth: number;
  rootTable: TableInfo | undefined;
}): DoctorCheck | undefined {
  const rowEstimate = input.rootTable?.approximate_row_count;
  const rowHops = rowEstimate === undefined ? undefined : rowEstimate * input.depth;
  if (input.depth < 3 && (rowHops === undefined || rowHops < DERIVED_SCOPE_ROW_HOP_WARNING)) {
    return undefined;
  }
  const timeout = input.boundary.budgets.statement_timeout_ms;
  const volume = rowEstimate === undefined
    ? "The live catalog did not provide a row estimate"
    : `The live catalog estimates about ${rowEstimate.toLocaleString("en-US")} total root rows (${rowHops!.toLocaleString("en-US")} row-hops before selectivity)`;
  return {
    name: `derived-scope-cost:${input.boundary.pack.name}:${doctorNamePart(input.pathLabel)}`,
    ok: true,
    level: "warn",
    advisory: "warning",
    message:
      `Derived-scope cost advisory for boundary ${input.boundary.pack.name}, path ${input.pathLabel}: `
      + `${input.depth} mandatory many-to-one hops under a reviewed ${timeout.toLocaleString("en-US")} ms statement timeout. `
      + `${volume}. Catalog volume is not tenant-specific and is not a latency prediction. `
      + `Verify every path index in this report and monitor measured source time in /details. `
      + `For a high-volume leaf, a direct ${input.kind} column is usually faster than traversal; changing the schema remains an operator decision.`,
  };
}


function unavailableSourceMetadataCheck(
  boundary: ActivatedExplorationBoundary,
  pathCount: number,
): DoctorCheck {
  return {
    name: `derived-scope-index:${boundary.pack.name}:source-metadata`,
    ok: true,
    level: "warn",
    advisory: "note",
    message: `Derived-scope index note for boundary ${boundary.pack.name}: live catalog metadata for source ${boundary.source} was unavailable, so ${pathCount} reviewed derived-scope ${pathCount === 1 ? "path" : "paths"} could not be attested. Explore authority is unchanged; resolve the source connectivity or environment warning and rerun doctor.`,
  };
}


function unavailableMetadataCheck(
  boundary: ActivatedExplorationBoundary,
  pathLabel: string,
  resource: string,
): DoctorCheck {
  return {
    name: `derived-scope-index:${boundary.pack.name}:${doctorNamePart(pathLabel)}:metadata:${resource}`,
    ok: true,
    level: "warn",
    advisory: "note",
    message: `Derived-scope index note for boundary ${boundary.pack.name}, path ${pathLabel}: live catalog metadata for ${resource} was unavailable, so index coverage could not be attested. Explore authority is unchanged; resolve the source metadata warning and rerun doctor.`,
  };
}


function missingIndexCheck(input: {
  boundary: ActivatedExplorationBoundary;
  pathLabel: string;
  role: string;
  table: TableInfo;
  columns: string[];
  engine: SourceEngine | undefined;
  advisory: "warning" | "note";
  effect: string;
}): DoctorCheck {
  const qualifiedColumns = input.columns
    .map((column) => `${resourceId(input.table.schema, input.table.name)}.${column}`)
    .join(", ");
  const suggestion = input.engine
    ? createIndexSuggestion(input.engine, input.table, input.columns)
    : "Rerun doctor after the source engine is available to receive engine-specific CREATE INDEX syntax.";
  return {
    name: `derived-scope-index:${input.boundary.pack.name}:${doctorNamePart(input.pathLabel)}:${doctorNamePart(input.role)}:${resourceId(input.table.schema, input.table.name)}:${input.columns.join("+")}`,
    ok: true,
    level: "warn",
    advisory: input.advisory,
    message: `${input.advisory === "note" ? "Derived-scope index note" : "Derived-scope index warning"} for boundary ${input.boundary.pack.name}, path ${input.pathLabel}: ${qualifiedColumns} has no usable full index with ${input.columns.join(", ")} as the leading ${input.columns.length === 1 ? "column" : "columns"} (${input.role}); ${input.effect}. Suggested (not executed): ${suggestion}`,
  };
}


function hasUsableLeadingIndex(table: TableInfo, requiredColumns: string[]): boolean {
  if (requiredColumns.length === 0) return false;
  return table.indexes.some((index) => {
    if (index.catalog_usable === false || index.catalog_partial === true) return false;
    const keyColumns = index.catalog_key_columns ?? index.columns ?? [];
    const leadingColumn = index.catalog_leading_column ?? keyColumns[0];
    if (leadingColumn !== requiredColumns[0]) return false;
    if (requiredColumns.length === 1) return true;
    return requiredColumns.every((column, offset) => keyColumns[offset] === column);
  });
}

function leadingIndexDistinctEstimate(table: TableInfo, column: string): number | undefined {
  const estimates = table.indexes
    .filter((index) => {
      if (index.catalog_usable === false || index.catalog_partial === true) return false;
      const keyColumns = index.catalog_key_columns ?? index.columns ?? [];
      return (index.catalog_leading_column ?? keyColumns[0]) === column;
    })
    .map((index) => index.catalog_distinct_estimate)
    .filter((estimate): estimate is number => estimate !== undefined && Number.isFinite(estimate) && estimate > 0);
  return estimates.length === 0 ? undefined : Math.max(...estimates);
}

function formatPercentage(value: number): string {
  if (value >= 10) return `${value.toFixed(1)}%`;
  if (value >= 1) return `${value.toFixed(2)}%`;
  return `${value.toFixed(3)}%`;
}


function derivedScopePathLabel(scope: DerivedScopePath, kind: ScopeKind): string {
  return `${formatDerivedScopePath(scope)} (${kind})`;
}


function createIndexSuggestion(engine: SourceEngine, table: TableInfo, columns: string[]): string {
  if (engine === "postgres") {
    return `CREATE INDEX ON ${postgresIdentifier(table.schema)}.${postgresIdentifier(table.name)} (${columns.map(postgresIdentifier).join(", ")});`;
  }
  const indexName = mysqlSuggestedIndexName(table.name, columns);
  return `CREATE INDEX ${mysqlIdentifier(indexName)} ON ${mysqlIdentifier(table.schema)}.${mysqlIdentifier(table.name)} (${columns.map(mysqlIdentifier).join(", ")});`;
}


function mysqlSuggestedIndexName(table: string, columns: string[]): string {
  const normalized = `idx_synapsor_${table}_${columns.join("_")}`
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "idx_synapsor_scope";
  return normalized.slice(0, 64);
}


function postgresIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}


function mysqlIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}


function resourceId(schema: string, table: string): string {
  return `${schema}.${table}`;
}


function doctorNamePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

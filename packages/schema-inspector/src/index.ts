import mysql from "mysql2/promise";
import { Pool } from "pg";

export type SourceEngine = "postgres" | "mysql";
export type InspectEngine = SourceEngine | "auto";

export type ColumnInfo = {
  name: string;
  data_type: string;
  nullable: boolean;
  default?: string;
  generated: boolean;
  ordinal_position: number;
  suggestions: {
    tenant: boolean;
    conflict: boolean;
    sensitive: boolean;
    immutable: boolean;
    large_or_binary: boolean;
  };
};

export type UniqueConstraintInfo = {
  name: string;
  columns: string[];
};

export type ForeignKeyInfo = {
  name: string;
  columns: string[];
  referenced_schema: string;
  referenced_table: string;
  referenced_columns: string[];
};

export type IndexInfo = {
  name: string;
  columns?: string[];
  unique?: boolean;
  definition?: string;
};

export type TableInfo = {
  schema: string;
  name: string;
  type: "table" | "view";
  writable: boolean;
  columns: ColumnInfo[];
  primary_key: string[];
  unique_constraints: UniqueConstraintInfo[];
  foreign_keys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  suggestions: {
    tenant_columns: string[];
    conflict_columns: string[];
    sensitive_columns: string[];
    default_visible_columns: string[];
  };
};

export type SchemaInspection = {
  engine: SourceEngine;
  server_version: string;
  current_user: string;
  inspected_at: string;
  schemas: string[];
  tables: TableInfo[];
  warnings: string[];
};

export type InspectOptions = {
  engine?: InspectEngine;
  databaseUrlEnv: string;
  schema?: string;
  statementTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type OnboardingSelectionSpec = {
  version?: 1;
  engine: SourceEngine;
  mode?: "read_only" | "shadow" | "review";
  source_name?: string;
  read_url_env?: string;
  database_url_env?: string;
  write_url_env?: string;
  statement_timeout_ms?: number;
  schema: string;
  table: string;
  primary_key: string;
  tenant_key?: string;
  single_tenant_dev?: boolean;
  conflict_column?: string;
  namespace: string;
  object_name?: string;
  inspect_tool_name?: string;
  proposal_tool_name?: string;
  lookup_arg?: string;
  visible_columns: string[];
  allowed_columns?: string[];
  patch?: Record<string, { fixed?: string | number | boolean | null; from_arg?: string }>;
  patch_args?: Record<string, { type?: "string" | "number" | "boolean"; required?: boolean; max_length?: number; enum?: Array<string | number | boolean | null> }>;
  trusted_context?: {
    tenant_id_env?: string;
    principal_env?: string;
  };
  approval?: {
    required_role?: string;
  };
};

export type GeneratedOnboardingFiles = {
  config: Record<string, unknown>;
  envExample: string;
  mcpSnippets: Record<string, unknown>;
};

const TENANT_COLUMNS = new Set(["tenant_id", "account_id", "organization_id", "org_id", "workspace_id", "customer_id"]);
const CONFLICT_COLUMNS = new Set(["updated_at", "modified_at", "row_version", "version", "lock_version", "etag"]);
const IMMUTABLE_COLUMNS = new Set(["id", "uuid", "created_at", "created_by"]);
const SENSITIVE_PATTERNS = [
  /password/i,
  /password_hash/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /private[_-]?key/i,
  /session/i,
  /cookie/i,
  /\bssn\b/i,
  /social[_-]?security/i,
  /credit[_-]?card/i,
  /card[_-]?number/i,
  /\bcvv\b/i,
  /refresh[_-]?token/i,
  /oauth/i,
];
const LARGE_OR_BINARY_TYPES = new Set([
  "bytea",
  "blob",
  "binary",
  "varbinary",
  "longblob",
  "mediumblob",
  "tinyblob",
  "vector",
  "json",
  "jsonb",
]);

export async function inspectDatabase(options: InspectOptions): Promise<SchemaInspection> {
  const env = options.env ?? process.env;
  if (!isEnvName(options.databaseUrlEnv)) {
    throw new Error("database-url-env must be an environment variable name.");
  }
  const url = env[options.databaseUrlEnv];
  if (!url) {
    throw new Error(`${options.databaseUrlEnv} is not set.`);
  }
  const engine = options.engine && options.engine !== "auto" ? options.engine : inferEngine(url);
  try {
    return engine === "postgres" ? await inspectPostgres({ ...options, env, engine, url }) : await inspectMysql({ ...options, env, engine, url });
  } catch (error) {
    throw new Error(`schema inspection failed for ${engine} using ${options.databaseUrlEnv}: ${sanitizeError(error)}`);
  }
}

export function generateRunnerConfigFromSpec(spec: OnboardingSelectionSpec): GeneratedOnboardingFiles {
  validateSelectionSpec(spec);
  const mode = spec.mode ?? "shadow";
  const sourceName = spec.source_name ?? (spec.engine === "postgres" ? "local_postgres" : "local_mysql");
  const readUrlEnv = spec.read_url_env ?? spec.database_url_env ?? "SYNAPSOR_DATABASE_READ_URL";
  const writeUrlEnv = spec.write_url_env ?? "SYNAPSOR_DATABASE_WRITE_URL";
  const tenantEnv = spec.trusted_context?.tenant_id_env ?? "SYNAPSOR_TENANT_ID";
  const principalEnv = spec.trusted_context?.principal_env ?? "SYNAPSOR_PRINCIPAL";
  const objectName = spec.object_name ?? singularize(safeName(spec.table));
  const lookupArg = spec.lookup_arg ?? `${objectName}_id`;
  const inspectToolName = spec.inspect_tool_name ?? `${spec.namespace}.inspect_${objectName}`;
  const proposalToolName = spec.proposal_tool_name ?? `${spec.namespace}.propose_${objectName}_update`;
  const visibleColumns = unique([spec.primary_key, spec.tenant_key, spec.conflict_column, ...spec.visible_columns].filter((value): value is string => Boolean(value)));
  const readCapability = {
    name: inspectToolName,
    kind: "read",
    source: sourceName,
    target: target(spec),
    args: {
      [lookupArg]: { type: "string", required: true, max_length: 128 },
    },
    lookup: { id_from_arg: lookupArg },
    visible_columns: visibleColumns,
    evidence: "required",
    max_rows: 1,
  };
  const capabilities: Array<Record<string, unknown>> = [readCapability];
  if (mode !== "read_only" && spec.patch && Object.keys(spec.patch).length > 0) {
    const patchArgs = inferPatchArgs(spec.patch, spec.patch_args);
    capabilities.push({
      name: proposalToolName,
      kind: "proposal",
      source: sourceName,
      target: target(spec),
      args: {
        [lookupArg]: { type: "string", required: true, max_length: 128 },
        ...patchArgs,
      },
      lookup: { id_from_arg: lookupArg },
      visible_columns: visibleColumns,
      evidence: "required",
      max_rows: 1,
      patch: spec.patch,
      allowed_columns: spec.allowed_columns ?? Object.keys(spec.patch),
      conflict_guard: spec.conflict_column ? { column: spec.conflict_column } : { weak_guard_ack: true },
      approval: { mode: "human", required_role: spec.approval?.required_role ?? "local_reviewer" },
    });
  }

  const config: Record<string, unknown> = {
    version: 1,
    mode,
    storage: { sqlite_path: "./.synapsor/local.db" },
    sources: {
      [sourceName]: {
        engine: spec.engine,
        read_url_env: readUrlEnv,
        ...(mode === "review" ? { write_url_env: writeUrlEnv } : {}),
        statement_timeout_ms: spec.statement_timeout_ms ?? 3000,
      },
    },
    trusted_context: {
      provider: "environment",
      values: {
        tenant_id_env: tenantEnv,
        principal_env: principalEnv,
      },
    },
    capabilities,
  };

  return {
    config,
    envExample: envExample({ readUrlEnv, writeUrlEnv, tenantEnv, principalEnv, mode, engine: spec.engine }),
    mcpSnippets: mcpSnippets(),
  };
}

export function summarizeInspection(inspection: SchemaInspection): string {
  const lines = [
    `Engine: ${inspection.engine}`,
    `Server: ${inspection.server_version}`,
    `Current user: ${inspection.current_user}`,
    `Schemas: ${inspection.schemas.join(", ") || "(none)"}`,
    `Objects: ${inspection.tables.length}`,
  ];
  for (const table of inspection.tables) {
    const parts = [
      `${table.schema}.${table.name}`,
      table.type,
      table.primary_key.length ? `pk=${table.primary_key.join(",")}` : "pk=none",
      table.suggestions.tenant_columns.length ? `tenant=${table.suggestions.tenant_columns.join(",")}` : "tenant=none",
      table.suggestions.conflict_columns.length ? `conflict=${table.suggestions.conflict_columns.join(",")}` : "conflict=none",
    ];
    lines.push(`- ${parts.join(" · ")}`);
  }
  if (inspection.warnings.length) {
    lines.push("Warnings:");
    for (const warning of inspection.warnings) lines.push(`! ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

async function inspectPostgres(options: InspectOptions & { engine: "postgres"; url: string }): Promise<SchemaInspection> {
  const pool = new Pool({ connectionString: options.url, connectionTimeoutMillis: options.statementTimeoutMs ?? 3000 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Number(options.statementTimeoutMs ?? 3000)}`);
    const version = await client.query("SELECT version() AS version, current_user AS current_user");
    const schemas = await client.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
       ORDER BY schema_name`,
    );
    const tables = await client.query<RawTable>(
      `SELECT table_schema AS schema, table_name AS name, table_type AS type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND ($1::text IS NULL OR table_schema = $1)
         AND table_type IN ('BASE TABLE', 'VIEW')
       ORDER BY table_schema, table_name`,
      [options.schema ?? null],
    );
    const columns = await client.query<RawColumn>(
      `SELECT table_schema AS schema, table_name AS table_name, column_name AS name,
              data_type, udt_name, is_nullable, column_default AS column_default,
              is_generated, ordinal_position
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND ($1::text IS NULL OR table_schema = $1)
       ORDER BY table_schema, table_name, ordinal_position`,
      [options.schema ?? null],
    );
    const keyColumns = await client.query<RawKeyColumn>(
      `SELECT tc.table_schema AS schema, tc.table_name, tc.constraint_name, tc.constraint_type,
              kcu.column_name, kcu.ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_schema = kcu.constraint_schema
        AND tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
       WHERE tc.table_schema NOT IN ('pg_catalog', 'information_schema')
         AND ($1::text IS NULL OR tc.table_schema = $1)
         AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
       ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position`,
      [options.schema ?? null],
    );
    const foreignKeys = await client.query<RawForeignKey>(
      `SELECT tc.table_schema AS schema, tc.table_name, tc.constraint_name,
              kcu.column_name, ccu.table_schema AS referenced_schema,
              ccu.table_name AS referenced_table, ccu.column_name AS referenced_column,
              kcu.ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_schema = kcu.constraint_schema
        AND tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_schema = tc.constraint_schema
        AND ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
         AND ($1::text IS NULL OR tc.table_schema = $1)
       ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position`,
      [options.schema ?? null],
    );
    const indexes = await client.query<RawIndex>(
      `SELECT schemaname AS schema, tablename AS table_name, indexname AS name, indexdef AS definition
       FROM pg_indexes
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
         AND ($1::text IS NULL OR schemaname = $1)
       ORDER BY schemaname, tablename, indexname`,
      [options.schema ?? null],
    );
    await client.query("COMMIT");
    return normalizeInspection({
      engine: "postgres",
      server_version: String(version.rows[0]?.version ?? "unknown"),
      current_user: String(version.rows[0]?.current_user ?? "unknown"),
      schemas: schemas.rows.map((row) => row.schema_name),
      tables: tables.rows,
      columns: columns.rows,
      keyColumns: keyColumns.rows,
      foreignKeys: foreignKeys.rows,
      indexes: indexes.rows,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function inspectMysql(options: InspectOptions & { engine: "mysql"; url: string }): Promise<SchemaInspection> {
  const connection = await mysql.createConnection({ uri: options.url, connectTimeout: options.statementTimeoutMs ?? 3000, dateStrings: true });
  try {
    await connection.query("START TRANSACTION READ ONLY").catch(() => connection.query("START TRANSACTION"));
    await connection.query("SET SESSION max_execution_time = ?", [Number(options.statementTimeoutMs ?? 3000)]).catch(() => undefined);
    const [versionRows] = await connection.query<mysql.RowDataPacket[]>("SELECT VERSION() AS version, CURRENT_USER() AS `current_user`");
    const schemaParam = options.schema ?? null;
    const [schemaRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
       ORDER BY schema_name`,
    );
    const [tableRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT table_schema AS \`schema\`, table_name AS name, table_type AS type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
         AND (? IS NULL OR table_schema = ?)
         AND table_type IN ('BASE TABLE', 'VIEW')
       ORDER BY table_schema, table_name`,
      [schemaParam, schemaParam],
    );
    const [columnRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT table_schema AS \`schema\`, table_name AS table_name, column_name AS name,
              data_type, column_type AS udt_name, is_nullable,
              column_default, extra AS is_generated, ordinal_position AS ordinal_position
       FROM information_schema.columns
       WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
         AND (? IS NULL OR table_schema = ?)
       ORDER BY table_schema, table_name, ordinal_position`,
      [schemaParam, schemaParam],
    );
    const [keyRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT tc.table_schema AS \`schema\`, tc.table_name AS table_name, tc.constraint_name AS constraint_name, tc.constraint_type AS constraint_type,
              kcu.column_name AS column_name, kcu.ordinal_position AS ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_schema = kcu.constraint_schema
        AND tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
       WHERE tc.table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
         AND (? IS NULL OR tc.table_schema = ?)
         AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
       ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position`,
      [schemaParam, schemaParam],
    );
    const [fkRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT tc.table_schema AS \`schema\`, tc.table_name AS table_name, tc.constraint_name AS constraint_name,
              kcu.column_name AS column_name, kcu.referenced_table_schema AS referenced_schema,
              kcu.referenced_table_name AS referenced_table,
              kcu.referenced_column_name AS referenced_column,
              kcu.ordinal_position AS ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_schema = kcu.constraint_schema
        AND tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
         AND (? IS NULL OR tc.table_schema = ?)
       ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position`,
      [schemaParam, schemaParam],
    );
    const [indexRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT table_schema AS \`schema\`, table_name AS table_name, index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns,
              MIN(non_unique) AS non_unique
       FROM information_schema.statistics
       WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
         AND (? IS NULL OR table_schema = ?)
       GROUP BY table_schema, table_name, index_name
       ORDER BY table_schema, table_name, index_name`,
      [schemaParam, schemaParam],
    );
    await connection.query("COMMIT").catch(() => undefined);
    return normalizeInspection({
      engine: "mysql",
      server_version: String(versionRows[0]?.version ?? "unknown"),
      current_user: String(versionRows[0]?.current_user ?? "unknown"),
      schemas: schemaRows.map((row) => String(row.schema_name)),
      tables: tableRows as RawTable[],
      columns: columnRows as RawColumn[],
      keyColumns: keyRows as RawKeyColumn[],
      foreignKeys: fkRows as RawForeignKey[],
      indexes: (indexRows as Array<Record<string, unknown>>).map((row) => ({
        schema: String(row.schema),
        table_name: String(row.table_name),
        name: String(row.name),
        columns: typeof row.columns === "string" ? row.columns.split(",") : undefined,
        unique: Number(row.non_unique) === 0,
      })),
    });
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await connection.end();
  }
}

type RawTable = { schema: string; name: string; type: string };
type RawColumn = {
  schema: string;
  table_name: string;
  name: string;
  data_type: string;
  udt_name?: string;
  is_nullable: string;
  column_default?: string | null;
  is_generated?: string | null;
  ordinal_position: number;
};
type RawKeyColumn = { schema: string; table_name: string; constraint_name: string; constraint_type: string; column_name: string; ordinal_position: number };
type RawForeignKey = {
  schema: string;
  table_name: string;
  constraint_name: string;
  column_name: string;
  referenced_schema: string;
  referenced_table: string;
  referenced_column: string;
  ordinal_position: number;
};
type RawIndex = { schema: string; table_name: string; name: string; definition?: string; columns?: string[]; unique?: boolean };

function normalizeInspection(input: {
  engine: SourceEngine;
  server_version: string;
  current_user: string;
  schemas: string[];
  tables: RawTable[];
  columns: RawColumn[];
  keyColumns: RawKeyColumn[];
  foreignKeys: RawForeignKey[];
  indexes: RawIndex[];
}): SchemaInspection {
  const columnsByTable = groupBy(input.columns, (row) => tableKey(row.schema, row.table_name));
  const keysByTable = groupBy(input.keyColumns, (row) => tableKey(row.schema, row.table_name));
  const fksByTable = groupBy(input.foreignKeys, (row) => tableKey(row.schema, row.table_name));
  const indexesByTable = groupBy(input.indexes, (row) => tableKey(row.schema, row.table_name));
  const tables = input.tables.map((raw): TableInfo => {
    const key = tableKey(raw.schema, raw.name);
    const rawColumns = columnsByTable.get(key) ?? [];
    const primary_key = constraintColumns(keysByTable.get(key) ?? [], "PRIMARY KEY")[0]?.columns ?? [];
    const unique_constraints = constraintColumns(keysByTable.get(key) ?? [], "UNIQUE");
    const columns = rawColumns.map((column) => normalizeColumn(column, primary_key));
    const sensitive = columns.filter((column) => column.suggestions.sensitive).map((column) => column.name);
    const default_visible_columns = columns
      .filter((column) => !column.suggestions.sensitive && !column.suggestions.large_or_binary)
      .map((column) => column.name);
    return {
      schema: raw.schema,
      name: raw.name,
      type: raw.type.toUpperCase().includes("VIEW") ? "view" : "table",
      writable: raw.type.toUpperCase().includes("TABLE"),
      columns,
      primary_key,
      unique_constraints,
      foreign_keys: normalizeForeignKeys(fksByTable.get(key) ?? []),
      indexes: (indexesByTable.get(key) ?? []).map((index) => ({
        name: index.name,
        columns: index.columns,
        unique: index.unique,
        definition: index.definition,
      })),
      suggestions: {
        tenant_columns: columns.filter((column) => column.suggestions.tenant).map((column) => column.name),
        conflict_columns: columns.filter((column) => column.suggestions.conflict).map((column) => column.name),
        sensitive_columns: sensitive,
        default_visible_columns,
      },
    };
  });
  return {
    engine: input.engine,
    server_version: input.server_version,
    current_user: input.current_user,
    inspected_at: new Date().toISOString(),
    schemas: input.schemas,
    tables,
    warnings: ["Inspection reads metadata only. Column classifications are suggestions, not a complete data-classification system."],
  };
}

function normalizeColumn(column: RawColumn, primaryKey: string[]): ColumnInfo {
  const name = String(column.name);
  const lower = name.toLowerCase();
  const type = String(column.udt_name || column.data_type || "unknown").toLowerCase();
  return {
    name,
    data_type: String(column.data_type || column.udt_name || "unknown"),
    nullable: String(column.is_nullable).toUpperCase() === "YES",
    default: column.column_default ?? undefined,
    generated: /always|stored|virtual|generated/i.test(String(column.is_generated ?? "")),
    ordinal_position: Number(column.ordinal_position),
    suggestions: {
      tenant: TENANT_COLUMNS.has(lower),
      conflict: CONFLICT_COLUMNS.has(lower),
      sensitive: SENSITIVE_PATTERNS.some((pattern) => pattern.test(lower)),
      immutable: primaryKey.includes(name) || TENANT_COLUMNS.has(lower) || IMMUTABLE_COLUMNS.has(lower),
      large_or_binary: LARGE_OR_BINARY_TYPES.has(type) || /blob|binary|bytea|vector/i.test(type),
    },
  };
}

function constraintColumns(rows: RawKeyColumn[], kind: string): UniqueConstraintInfo[] {
  const grouped = groupBy(rows.filter((row) => row.constraint_type === kind), (row) => row.constraint_name);
  return Array.from(grouped.entries()).map(([name, items]) => ({
    name,
    columns: items.sort((a, b) => Number(a.ordinal_position) - Number(b.ordinal_position)).map((item) => item.column_name),
  }));
}

function normalizeForeignKeys(rows: RawForeignKey[]): ForeignKeyInfo[] {
  const grouped = groupBy(rows, (row) => row.constraint_name);
  return Array.from(grouped.entries()).map(([name, items]) => {
    const sorted = items.sort((a, b) => Number(a.ordinal_position) - Number(b.ordinal_position));
    return {
      name,
      columns: sorted.map((item) => item.column_name),
      referenced_schema: sorted[0]?.referenced_schema ?? "",
      referenced_table: sorted[0]?.referenced_table ?? "",
      referenced_columns: sorted.map((item) => item.referenced_column),
    };
  });
}

function target(spec: OnboardingSelectionSpec): Record<string, unknown> {
  return {
    schema: spec.schema,
    table: spec.table,
    primary_key: spec.primary_key,
    ...(spec.tenant_key ? { tenant_key: spec.tenant_key } : { single_tenant_dev: Boolean(spec.single_tenant_dev) }),
  };
}

function inferPatchArgs(
  patch: NonNullable<OnboardingSelectionSpec["patch"]>,
  explicit: OnboardingSelectionSpec["patch_args"],
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const binding of Object.values(patch)) {
    if (binding.from_arg) {
      args[binding.from_arg] = explicit?.[binding.from_arg] ?? { type: "string", required: true, max_length: 500 };
    }
  }
  return args;
}

function envExample(input: {
  readUrlEnv: string;
  writeUrlEnv: string;
  tenantEnv: string;
  principalEnv: string;
  mode: string;
  engine: SourceEngine;
}): string {
  const readExample = input.engine === "postgres" ? "<postgres-read-url>" : "<mysql-read-url>";
  const writeExample = input.engine === "postgres" ? "<postgres-write-url>" : "<mysql-write-url>";
  return [
    "# Synapsor Runner local environment.",
    "# Replace examples locally. Do not commit real credentials.",
    `${input.readUrlEnv}="${readExample}"`,
    ...(input.mode === "review" ? [`${input.writeUrlEnv}="${writeExample}"`] : []),
    `${input.tenantEnv}="acme"`,
    `${input.principalEnv}="local_operator"`,
    "",
  ].join("\n");
}

function mcpSnippets(): Record<string, unknown> {
  const command = "synapsor";
  const args = ["mcp", "serve", "--config", "./synapsor.runner.json", "--store", "./.synapsor/local.db"];
  return {
    "generic-stdio.json": { command, args },
    "claude-desktop.json": { mcpServers: { synapsor: { command, args } } },
    "cursor.json": { mcpServers: { synapsor: { command, args } } },
    "vscode.json": { servers: { synapsor: { type: "stdio", command, args } } },
  };
}

function validateSelectionSpec(spec: OnboardingSelectionSpec): void {
  if (spec.version !== undefined && spec.version !== 1) throw new Error("onboarding selection version must be 1.");
  if (spec.engine !== "postgres" && spec.engine !== "mysql") throw new Error("selection engine must be postgres or mysql.");
  if (!["read_only", "shadow", "review", undefined].includes(spec.mode)) throw new Error("selection mode must be read_only, shadow, or review.");
  for (const [label, value] of Object.entries({
    schema: spec.schema,
    table: spec.table,
    primary_key: spec.primary_key,
    namespace: spec.namespace,
  })) {
    if (!value || typeof value !== "string") throw new Error(`selection ${label} is required.`);
  }
  if (!spec.tenant_key && !spec.single_tenant_dev) throw new Error("selection requires tenant_key or explicit single_tenant_dev.");
  if (!Array.isArray(spec.visible_columns) || spec.visible_columns.length === 0) throw new Error("selection visible_columns must not be empty.");
  if (spec.mode !== "read_only" && spec.patch && Object.keys(spec.patch).length > 0) {
    const allowed = new Set(spec.allowed_columns ?? Object.keys(spec.patch));
    for (const column of Object.keys(spec.patch)) {
      if (!allowed.has(column)) throw new Error(`patch column ${column} is not in allowed_columns.`);
    }
  }
  for (const name of [
    spec.source_name,
    spec.schema,
    spec.table,
    spec.primary_key,
    spec.tenant_key,
    spec.conflict_column,
    spec.lookup_arg,
    ...(spec.visible_columns ?? []),
    ...(spec.allowed_columns ?? []),
  ].filter(Boolean)) {
    assertSafeIdentifier(String(name));
  }
  for (const env of [
    spec.read_url_env,
    spec.database_url_env,
    spec.write_url_env,
    spec.trusted_context?.tenant_id_env,
    spec.trusted_context?.principal_env,
  ].filter(Boolean)) {
    if (!isEnvName(String(env))) throw new Error(`invalid environment variable name: ${env}`);
  }
}

function inferEngine(url: string): SourceEngine {
  if (/^postgres(?:ql)?:\/\//i.test(url)) return "postgres";
  if (/^mysql:\/\//i.test(url)) return "mysql";
  throw new Error("could not infer engine from database URL; pass --engine postgres or --engine mysql.");
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const group = map.get(value) ?? [];
    group.push(item);
    map.set(value, group);
  }
  return map;
}

function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function unique<T>(items: Array<T | undefined>): T[] {
  return Array.from(new Set(items.filter((item): item is T => item !== undefined)));
}

function singularize(value: string): string {
  return value.endsWith("ies") ? `${value.slice(0, -3)}y` : value.endsWith("s") ? value.slice(0, -1) : value;
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "record";
}

function assertSafeIdentifier(identifier: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe identifier in selection: ${identifier}`);
  }
}

function isEnvName(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value);
}

function sanitizeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/(postgres(?:ql)?:\/\/)([^:]+):([^@]+)@/gi, "$1<user>:<redacted>@")
    .replace(/(mysql:\/\/)([^:]+):([^@]+)@/gi, "$1<user>:<redacted>@")
    .replace(/password=[^&\s]+/gi, "password=<redacted>");
}

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
  identity?: boolean;
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
  delete_rule: "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT" | string;
};

export type ReferencingForeignKeyInfo = {
  name: string;
  schema: string;
  table: string;
  columns: string[];
  referenced_columns: string[];
  delete_rule: "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT" | string;
};

export type TriggerInfo = {
  name: string;
  timing: string;
  orientation: string;
  events: string[];
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
  referenced_by?: ReferencingForeignKeyInfo[];
  write_triggers?: TriggerInfo[];
  row_level_security?: boolean | "unknown";
  indexes: IndexInfo[];
  suggestions: {
    tenant_columns: string[];
    conflict_columns: string[];
    sensitive_columns: string[];
    default_visible_columns: string[];
  };
};

export type DirectWriteAssessmentInput = {
  operation: "update" | "insert" | "delete";
  primary_key: string;
  tenant_key?: string;
  allowed_columns: string[];
  patch_columns: string[];
  conflict_column?: string;
  version_advance?: { column: string; strategy: "integer_increment" | "database_generated" };
  dedup_columns?: string[];
};

export type DirectWritePrerequisite = {
  code: string;
  level: "pass" | "warn" | "fail";
  message: string;
};

/** Assess only source-enforced facts visible in inspected metadata. */
export function assessDirectWritePrerequisites(table: TableInfo, input: DirectWriteAssessmentInput): DirectWritePrerequisite[] {
  const checks: DirectWritePrerequisite[] = [];
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  const fail = (code: string, message: string) => checks.push({ code, level: "fail", message } as const);
  const pass = (code: string, message: string) => checks.push({ code, level: "pass", message } as const);
  const warn = (code: string, message: string) => checks.push({ code, level: "warn", message } as const);

  if (!table.writable || table.type !== "table") fail("TARGET_NOT_WRITABLE_TABLE", "Direct writeback requires an inspected writable base table.");
  if (table.primary_key.length !== 1 || table.primary_key[0] !== input.primary_key) {
    fail("PRIMARY_KEY_NOT_EXACT", `Configured primary key ${input.primary_key} must match the table's single-column primary key.`);
  } else pass("PRIMARY_KEY_EXACT", `Primary key ${input.primary_key} is source-enforced.`);
  if (!input.tenant_key || !columns.has(input.tenant_key)) fail("TENANT_COLUMN_MISSING", "Direct writeback requires a reviewed tenant column present in the target table.");
  else pass("TENANT_COLUMN_PRESENT", `Trusted tenant is forced through ${input.tenant_key}.`);

  for (const columnName of new Set([...input.allowed_columns, ...input.patch_columns])) {
    const column = columns.get(columnName);
    if (!column) {
      fail("WRITE_COLUMN_MISSING", `Reviewed write column ${columnName} does not exist in the target table.`);
      continue;
    }
    if (column.generated || column.identity) fail("GENERATED_COLUMN_WRITE_BLOCKED", `Reviewed write column ${columnName} is generated or identity-managed by the database.`);
  }

  if (input.operation === "update" || input.operation === "delete") {
    const conflict = input.conflict_column ? columns.get(input.conflict_column) : undefined;
    if (!conflict) fail("CONFLICT_COLUMN_MISSING", "UPDATE and DELETE require an inspected exact conflict/version column.");
    else pass("CONFLICT_COLUMN_PRESENT", `Conflict guard ${input.conflict_column} exists in the target table.`);
  }

  if (input.operation === "update" && input.version_advance) {
    const versionColumn = columns.get(input.version_advance.column);
    if (!versionColumn) fail("VERSION_ADVANCE_COLUMN_MISSING", `Version advancement column ${input.version_advance.column} does not exist.`);
    else if (input.version_advance.strategy === "integer_increment" && !/int|numeric|decimal|number/i.test(versionColumn.data_type)) {
      fail("VERSION_INCREMENT_NOT_NUMERIC", `Version column ${input.version_advance.column} is not an inspected numeric type.`);
    } else if (input.version_advance.strategy === "database_generated") {
      const updateTriggers = (table.write_triggers ?? []).filter((trigger) => trigger.events.includes("UPDATE"));
      if (!versionColumn.generated && updateTriggers.length === 0) {
        fail("DATABASE_VERSION_ADVANCE_UNPROVEN", `Database-generated advancement for ${input.version_advance.column} requires an inspected generated column or UPDATE trigger.`);
      } else pass("DATABASE_VERSION_ADVANCE_PRESENT", `Database metadata can produce a new value for ${input.version_advance.column}; apply still verifies it changed before commit.`);
    } else pass("INTEGER_VERSION_ADVANCE_PRESENT", `Runner will increment ${input.version_advance.column} in the guarded transaction.`);
  }

  if (input.operation === "insert") {
    const dedupColumns = input.dedup_columns ?? [];
    const sourceUniqueSets = [
      ...(table.primary_key.length ? [{ name: "PRIMARY", columns: table.primary_key }] : []),
      ...table.unique_constraints,
      ...table.indexes.filter((index) => index.unique && index.columns?.length).map((index) => ({ name: index.name, columns: index.columns ?? [] })),
    ];
    const dedupSet = new Set(dedupColumns);
    const matchingUnique = sourceUniqueSets.find((constraint) => constraint.columns.length > 0 && constraint.columns.every((column) => dedupSet.has(column)));
    if (!matchingUnique) fail("INSERT_DEDUP_NOT_SOURCE_UNIQUE", `INSERT dedup columns ${dedupColumns.join(", ") || "(none)"} must fully supply an inspected PRIMARY KEY or UNIQUE constraint.`);
    else pass("INSERT_DEDUP_SOURCE_UNIQUE", `INSERT dedup identity is source-enforced by ${matchingUnique.name}.`);

    const supplied = new Set([...input.patch_columns, ...dedupColumns]);
    const missingRequired = table.columns.filter((column) => !column.nullable && column.default === undefined && !column.generated && !column.identity && !supplied.has(column.name));
    if (missingRequired.length > 0) fail("INSERT_REQUIRED_COLUMNS_MISSING", `INSERT does not supply required columns: ${missingRequired.map((column) => column.name).join(", ")}.`);
    else pass("INSERT_REQUIRED_COLUMNS_SATISFIED", "All inspected required columns are supplied or database-generated/defaulted.");
  }

  if (input.operation === "delete") {
    const hiddenEffects = (table.referenced_by ?? []).filter((foreignKey) => !["NO ACTION", "RESTRICT"].includes(foreignKey.delete_rule.toUpperCase()));
    if (hiddenEffects.length > 0) fail("DELETE_REFERENTIAL_EFFECT_BLOCKED", `Hard DELETE has hidden referential effects through: ${hiddenEffects.map((item) => `${item.schema}.${item.table}:${item.delete_rule}`).join(", ")}.`);
    else pass("DELETE_NO_CASCADE", "No inspected incoming cascade/set-null/set-default delete effects were found.");
    const deleteTriggers = (table.write_triggers ?? []).filter((trigger) => trigger.events.includes("DELETE"));
    if (deleteTriggers.length > 0) fail("DELETE_TRIGGER_BLOCKED", `Hard DELETE has write triggers: ${deleteTriggers.map((trigger) => trigger.name).join(", ")}.`);
    else pass("DELETE_NO_WRITE_TRIGGER", "No inspected DELETE trigger can expand the reviewed effect.");
  }

  if (table.row_level_security === true) warn("ROW_LEVEL_SECURITY_ENABLED", "Row-level security is enabled; writer policy behavior must be verified with the exact production role.");
  return checks;
}

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
  inspect_description?: string;
  proposal_description?: string;
  inspect_returns_hint?: string;
  proposal_returns_hint?: string;
  lookup_arg?: string;
  result_format?: 1 | 2;
  visible_columns: string[];
  operation?: "update" | "insert" | "delete";
  deduplication?: {
    components: Array<{ column: string; source: "proposal_id" | "trusted_tenant" | "fixed"; fixed?: string | number | boolean | null }>;
  };
  version_advance?: {
    column: string;
    strategy: "integer_increment" | "database_generated";
  };
  receipts?: {
    authority: "source_db" | "runner_ledger";
    provisioning?: "precreated" | "auto_migrate";
    schema?: string;
    table?: string;
  };
  allowed_columns?: string[];
  patch?: Record<string, { fixed?: string | number | boolean | null; from_arg?: string }>;
  patch_args?: Record<string, { type?: "string" | "number" | "boolean"; required?: boolean; max_length?: number; minimum?: number; maximum?: number; enum?: Array<string | number | boolean | null> }>;
  numeric_bounds?: Record<string, { minimum?: number; maximum?: number }>;
  transition_guards?: Record<string, { from_column?: string; allowed: Record<string, string[]> }>;
  trusted_context?: {
    tenant_id_env?: string;
    principal_env?: string;
  };
  approval?: {
    required_role?: string;
  };
  writeback?: {
    executor?: "sql_update" | "http_handler" | "command_handler";
    executor_name?: string;
    handler_url_env?: string;
    handler_token_env?: string;
    handler_signing_secret_env?: string;
    handler_command_env?: string;
    timeout_ms?: number;
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
const DEFAULT_RESULT_FORMAT = 2;
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
  const writeback = normalizedWriteback(spec);
  const writeUrlEnv = writeback.executor === "sql_update" ? spec.write_url_env ?? "SYNAPSOR_DATABASE_WRITE_URL" : undefined;
  const tenantEnv = spec.trusted_context?.tenant_id_env ?? "SYNAPSOR_TENANT_ID";
  const principalEnv = spec.trusted_context?.principal_env ?? "SYNAPSOR_PRINCIPAL";
  const objectName = spec.object_name ?? singularize(safeName(spec.table));
  const operation = spec.operation ?? "update";
  const lookupArg = spec.lookup_arg ?? `${objectName}_id`;
  const inspectToolName = spec.inspect_tool_name ?? `${spec.namespace}.inspect_${objectName}`;
  const proposalToolName = spec.proposal_tool_name ?? `${spec.namespace}.propose_${objectName}_${operation}`;
  const objectLabel = objectName.replace(/_/g, " ");
  const visibleColumns = unique([spec.primary_key, spec.tenant_key, spec.conflict_column, ...spec.visible_columns].filter((value): value is string => Boolean(value)));
  const readCapability = {
    name: inspectToolName,
    kind: "read",
    description: spec.inspect_description ?? `Inspect one ${objectLabel} in trusted tenant scope before answering or proposing a change.`,
    returns_hint: spec.inspect_returns_hint ?? `Returns reviewed ${objectLabel} fields, evidence handle, query audit, and source_database_changed:false.`,
    source: sourceName,
    context: "local_operator",
    target: target(spec),
    args: {
      [lookupArg]: { type: "string", required: true, max_length: 128, description: `${capitalize(objectLabel)} id from the user request or trusted app context.` },
    },
    lookup: { id_from_arg: lookupArg },
    visible_columns: visibleColumns,
    evidence: "required",
    max_rows: 1,
  };
  const capabilities: Array<Record<string, unknown>> = [readCapability];
  if (mode !== "read_only" && (operation === "delete" || (spec.patch && Object.keys(spec.patch).length > 0))) {
    const proposalPatch = operation === "delete" ? {} : (spec.patch ?? {});
    const patchArgs = inferPatchArgs(proposalPatch, spec.patch_args, spec.numeric_bounds, spec.transition_guards);
    capabilities.push({
      name: proposalToolName,
      kind: "proposal",
      description: spec.proposal_description ?? `Create a review-required proposal to ${operation} one ${objectLabel}. The source database remains unchanged until approval and writeback.`,
      returns_hint: spec.proposal_returns_hint ?? "Returns a proposal id, exact before/after diff, evidence handle, approval status, and source_database_changed:false.",
      source: sourceName,
      context: "local_operator",
      ...(writeback.executor !== "sql_update" ? { executor: writeback.executorName } : {}),
      target: target(spec),
      args: {
        [lookupArg]: { type: "string", required: true, max_length: 128 },
        ...patchArgs,
      },
      lookup: { id_from_arg: lookupArg },
      visible_columns: visibleColumns,
      evidence: "required",
      max_rows: 1,
      patch: proposalPatch,
      allowed_columns: operation === "delete" ? [] : (spec.allowed_columns ?? Object.keys(proposalPatch)),
      ...(operation !== "update" || spec.deduplication || spec.version_advance ? {
        operation: {
          kind: operation,
          ...(spec.deduplication ? { deduplication: spec.deduplication } : {}),
          ...(spec.version_advance ? { version_advance: spec.version_advance } : {}),
        },
      } : {}),
      ...(spec.numeric_bounds ? { numeric_bounds: spec.numeric_bounds } : {}),
      ...(spec.transition_guards ? { transition_guards: spec.transition_guards } : {}),
      ...(spec.conflict_column ? { conflict_guard: { column: spec.conflict_column } } : {}),
      approval: { mode: "human", required_role: spec.approval?.required_role ?? "local_reviewer" },
    });
  }

  const config: Record<string, unknown> = {
    version: 1,
    mode,
    result_format: spec.result_format ?? DEFAULT_RESULT_FORMAT,
    storage: { sqlite_path: "./.synapsor/local.db" },
    sources: {
      [sourceName]: {
        engine: spec.engine,
        read_url_env: readUrlEnv,
        ...(mode === "review" && writeUrlEnv ? { write_url_env: writeUrlEnv } : {}),
        ...(mode === "review" && writeback.executor !== "sql_update" && !writeUrlEnv ? { read_only: true } : {}),
        statement_timeout_ms: spec.statement_timeout_ms ?? 3000,
        ...(mode === "review" && writeback.executor === "sql_update" && spec.receipts ? { receipts: spec.receipts } : {}),
      },
    },
    trusted_context: {
      provider: "environment",
      values: {
        tenant_id_env: tenantEnv,
        principal_env: principalEnv,
      },
    },
    contexts: {
      local_operator: {
        provider: "environment",
        values: {
          tenant_id_env: tenantEnv,
          principal_env: principalEnv,
        },
      },
    },
    ...(mode === "review" && writeback.executor !== "sql_update" ? { executors: writeback.executors } : {}),
    capabilities,
  };

  return {
    config,
    envExample: envExample({
      readUrlEnv,
      writeUrlEnv,
      tenantEnv,
      principalEnv,
      mode,
      engine: spec.engine,
      extraEnv: writeback.extraEnv,
    }),
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
              is_generated, is_identity, ordinal_position
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND ($1::text IS NULL OR table_schema = $1)
       ORDER BY table_schema, table_name, ordinal_position`,
      [options.schema ?? null],
    );
    const keyColumns = await client.query<RawKeyColumn>(
      `SELECT n.nspname AS schema, c.relname AS table_name, con.conname AS constraint_name,
              CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END AS constraint_type,
              a.attname AS column_name, key_column.ordinal_position
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_column(attnum, ordinal_position) ON TRUE
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = key_column.attnum
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND ($1::text IS NULL OR n.nspname = $1)
         AND con.contype IN ('p', 'u')
       ORDER BY n.nspname, c.relname, con.conname, key_column.ordinal_position`,
      [options.schema ?? null],
    );
    const foreignKeys = await client.query<RawForeignKey>(
      `SELECT source_ns.nspname AS schema, source.relname AS table_name,
              con.conname AS constraint_name, source_attr.attname AS column_name,
              target_ns.nspname AS referenced_schema, target.relname AS referenced_table,
              target_attr.attname AS referenced_column, key_column.ordinal_position,
              CASE con.confdeltype
                WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                WHEN 'd' THEN 'SET DEFAULT'
              END AS delete_rule
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class source ON source.oid = con.conrelid
       JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source.relnamespace
       JOIN pg_catalog.pg_class target ON target.oid = con.confrelid
       JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
       JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS key_column(source_attnum, target_attnum, ordinal_position) ON TRUE
       JOIN pg_catalog.pg_attribute source_attr ON source_attr.attrelid = source.oid AND source_attr.attnum = key_column.source_attnum
       JOIN pg_catalog.pg_attribute target_attr ON target_attr.attrelid = target.oid AND target_attr.attnum = key_column.target_attnum
       WHERE con.contype = 'f'
         AND source_ns.nspname NOT IN ('pg_catalog', 'information_schema')
         AND ($1::text IS NULL OR source_ns.nspname = $1 OR target_ns.nspname = $1)
       ORDER BY source_ns.nspname, source.relname, con.conname, key_column.ordinal_position`,
      [options.schema ?? null],
    );
    const triggers = await client.query<RawTrigger>(
      `SELECT n.nspname AS schema, c.relname AS table_name, t.tgname AS name,
              CASE WHEN (t.tgtype & 64) <> 0 THEN 'INSTEAD OF'
                   WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
              CASE WHEN (t.tgtype & 1) <> 0 THEN 'ROW' ELSE 'STATEMENT' END AS orientation,
              event.event
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN LATERAL (VALUES
         ('INSERT', 4), ('DELETE', 8), ('UPDATE', 16), ('TRUNCATE', 32)
       ) AS event(event, mask) ON (t.tgtype & event.mask) <> 0
       WHERE NOT t.tgisinternal
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND ($1::text IS NULL OR n.nspname = $1)
       ORDER BY n.nspname, c.relname, t.tgname, event.event`,
      [options.schema ?? null],
    );
    const rowSecurity = await client.query<RawRowSecurity>(
      `SELECT n.nspname AS schema, c.relname AS table_name, c.relrowsecurity AS enabled
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND ($1::text IS NULL OR n.nspname = $1)
       ORDER BY n.nspname, c.relname`,
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
      triggers: triggers.rows,
      rowSecurity: rowSecurity.rows,
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
              column_default, extra AS is_generated, extra AS is_identity, ordinal_position AS ordinal_position
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
              kcu.ordinal_position AS ordinal_position, rc.delete_rule AS delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_schema = kcu.constraint_schema
        AND tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_schema = tc.constraint_schema
        AND rc.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
         AND (? IS NULL OR tc.table_schema = ? OR kcu.referenced_table_schema = ?)
       ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position`,
      [schemaParam, schemaParam, schemaParam],
    );
    const [triggerRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT trigger_schema AS \`schema\`, event_object_table AS table_name,
              trigger_name AS name, action_timing AS timing,
              action_orientation AS orientation, event_manipulation AS event
       FROM information_schema.triggers
       WHERE trigger_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
         AND (? IS NULL OR trigger_schema = ?)
       ORDER BY trigger_schema, event_object_table, trigger_name, event_manipulation`,
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
      triggers: triggerRows as RawTrigger[],
      rowSecurity: [],
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
  is_identity?: string | null;
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
  delete_rule?: string;
};
type RawIndex = { schema: string; table_name: string; name: string; definition?: string; columns?: string[]; unique?: boolean };
type RawTrigger = { schema: string; table_name: string; name: string; timing: string; orientation: string; event: string };
type RawRowSecurity = { schema: string; table_name: string; enabled: boolean };

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
  triggers: RawTrigger[];
  rowSecurity: RawRowSecurity[];
}): SchemaInspection {
  const columnsByTable = groupBy(input.columns, (row) => tableKey(row.schema, row.table_name));
  const keysByTable = groupBy(input.keyColumns, (row) => tableKey(row.schema, row.table_name));
  const fksByTable = groupBy(input.foreignKeys, (row) => tableKey(row.schema, row.table_name));
  const incomingFksByTable = groupBy(input.foreignKeys, (row) => tableKey(row.referenced_schema, row.referenced_table));
  const indexesByTable = groupBy(input.indexes, (row) => tableKey(row.schema, row.table_name));
  const triggersByTable = groupBy(input.triggers, (row) => tableKey(row.schema, row.table_name));
  const rowSecurityByTable = new Map(input.rowSecurity.map((row) => [tableKey(row.schema, row.table_name), Boolean(row.enabled)]));
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
      referenced_by: normalizeReferencingForeignKeys(incomingFksByTable.get(key) ?? []),
      write_triggers: normalizeTriggers(triggersByTable.get(key) ?? []),
      row_level_security: input.engine === "postgres" ? (rowSecurityByTable.get(key) ?? false) : false,
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
    identity: /yes|identity|auto_increment/i.test(String(column.is_identity ?? "")),
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
      delete_rule: sorted[0]?.delete_rule ?? "NO ACTION",
    };
  });
}

function normalizeReferencingForeignKeys(rows: RawForeignKey[]): ReferencingForeignKeyInfo[] {
  const grouped = groupBy(rows, (row) => `${row.schema}.${row.table_name}.${row.constraint_name}`);
  return Array.from(grouped.values()).map((items) => {
    const sorted = items.sort((a, b) => Number(a.ordinal_position) - Number(b.ordinal_position));
    return {
      name: sorted[0]?.constraint_name ?? "",
      schema: sorted[0]?.schema ?? "",
      table: sorted[0]?.table_name ?? "",
      columns: sorted.map((item) => item.column_name),
      referenced_columns: sorted.map((item) => item.referenced_column),
      delete_rule: sorted[0]?.delete_rule ?? "NO ACTION",
    };
  });
}

function normalizeTriggers(rows: RawTrigger[]): TriggerInfo[] {
  const grouped = groupBy(rows, (row) => row.name);
  return Array.from(grouped.entries()).map(([name, items]) => ({
    name,
    timing: String(items[0]?.timing ?? "unknown").toUpperCase(),
    orientation: String(items[0]?.orientation ?? "unknown").toUpperCase(),
    events: unique(items.map((item) => String(item.event).toUpperCase())),
  }));
}

function target(spec: OnboardingSelectionSpec): Record<string, unknown> {
  return {
    schema: spec.schema,
    table: spec.table,
    primary_key: spec.primary_key,
    ...(spec.tenant_key ? { tenant_key: spec.tenant_key } : { single_tenant_dev: Boolean(spec.single_tenant_dev) }),
  };
}

function normalizedWriteback(spec: OnboardingSelectionSpec): {
  executor: "sql_update" | "http_handler" | "command_handler";
  executorName?: string;
  executors?: Record<string, unknown>;
  extraEnv: Array<{ name: string; value: string; comment?: string }>;
} {
  const executor = spec.writeback?.executor ?? "sql_update";
  if (executor === "sql_update") {
    return { executor, extraEnv: [] };
  }

  const executorName = spec.writeback?.executor_name ?? `${safeName(spec.namespace)}_${executor === "http_handler" ? "http_handler" : "command_handler"}`;
  if (executor === "http_handler") {
    const urlEnv = spec.writeback?.handler_url_env ?? "SYNAPSOR_APP_WRITEBACK_URL";
    const tokenEnv = spec.writeback?.handler_token_env;
    const signingSecretEnv = spec.writeback?.handler_signing_secret_env;
    return {
      executor,
      executorName,
      executors: {
        [executorName]: {
          type: "http_handler",
          url_env: urlEnv,
          method: "POST",
          ...(tokenEnv ? { auth: { type: "bearer_env", token_env: tokenEnv } } : {}),
          ...(signingSecretEnv ? { signing_secret_env: signingSecretEnv } : {}),
          timeout_ms: spec.writeback?.timeout_ms ?? 5000,
        },
      },
      extraEnv: [
        { name: urlEnv, value: "http://127.0.0.1:8787/synapsor/writeback", comment: "App-owned writeback handler endpoint." },
        ...(tokenEnv ? [{ name: tokenEnv, value: "<handler-bearer-token>", comment: "Optional handler bearer token." }] : []),
        ...(signingSecretEnv ? [{ name: signingSecretEnv, value: "<handler-hmac-signing-secret>", comment: "Optional HMAC signing secret for Runner-to-handler requests." }] : []),
      ],
    };
  }

  const commandEnv = spec.writeback?.handler_command_env ?? "SYNAPSOR_APP_WRITEBACK_COMMAND";
  return {
    executor,
    executorName,
    executors: {
      [executorName]: {
        type: "command_handler",
        command_env: commandEnv,
        timeout_ms: spec.writeback?.timeout_ms ?? 5000,
      },
    },
    extraEnv: [
      { name: commandEnv, value: "node ./examples/app-owned-writeback/command-handler.mjs", comment: "Command receives the structured handler proposal JSON on stdin." },
    ],
  };
}

function inferPatchArgs(
  patch: NonNullable<OnboardingSelectionSpec["patch"]>,
  explicit: OnboardingSelectionSpec["patch_args"],
  numericBounds?: OnboardingSelectionSpec["numeric_bounds"],
  transitionGuards?: OnboardingSelectionSpec["transition_guards"],
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [column, binding] of Object.entries(patch)) {
    if (binding.from_arg) {
      const numericBound = numericBounds?.[column];
      const transitionGuard = transitionGuards?.[column];
      const inferred = numericBound
        ? {
            type: "number",
            required: true,
            ...(numericBound.minimum !== undefined ? { minimum: numericBound.minimum } : {}),
            ...(numericBound.maximum !== undefined ? { maximum: numericBound.maximum } : {}),
          }
        : transitionGuard
          ? { type: "string", required: true, enum: unique(Object.values(transitionGuard.allowed).flat()), max_length: 128 }
          : { type: "string", required: true, max_length: 500 };
      const explicitArg = explicit?.[binding.from_arg];
      args[binding.from_arg] = explicitArg ? { ...explicitArg, ...inferred } : inferred;
    }
  }
  return args;
}

function envExample(input: {
  readUrlEnv: string;
  writeUrlEnv?: string;
  tenantEnv: string;
  principalEnv: string;
  mode: string;
  engine: SourceEngine;
  extraEnv?: Array<{ name: string; value: string; comment?: string }>;
}): string {
  const readExample = input.engine === "postgres" ? "<postgres-read-url>" : "<mysql-read-url>";
  const writeExample = input.engine === "postgres" ? "<postgres-write-url>" : "<mysql-write-url>";
  return [
    "# Synapsor Runner local environment.",
    "# Replace examples locally. Do not commit real credentials.",
    `${input.readUrlEnv}="${readExample}"`,
    ...(input.mode === "review" && input.writeUrlEnv ? [`${input.writeUrlEnv}="${writeExample}"`] : []),
    ...(input.extraEnv ?? []).flatMap((item) => [
      ...(item.comment ? [`# ${item.comment}`] : []),
      `${item.name}="${item.value}"`,
    ]),
    `${input.tenantEnv}="acme"`,
    `${input.principalEnv}="local_operator"`,
    "",
  ].join("\n");
}

function mcpSnippets(): Record<string, unknown> {
  const command = "synapsor-runner";
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
  if (spec.result_format !== undefined && spec.result_format !== 1 && spec.result_format !== 2) throw new Error("selection result_format must be 1 or 2.");
  const operation = spec.operation ?? "update";
  if (!["update", "insert", "delete"].includes(operation)) throw new Error("selection operation must be update, insert, or delete.");
  if (spec.writeback?.executor && !["sql_update", "http_handler", "command_handler"].includes(spec.writeback.executor)) {
    throw new Error("selection writeback.executor must be sql_update, http_handler, or command_handler.");
  }
  if (spec.mode !== "review" && spec.writeback?.executor && spec.writeback.executor !== "sql_update") {
    throw new Error("app-owned writeback executors are only valid in review mode.");
  }
  if (spec.writeback?.timeout_ms !== undefined && (!Number.isInteger(spec.writeback.timeout_ms) || spec.writeback.timeout_ms <= 0)) {
    throw new Error("selection writeback.timeout_ms must be a positive integer.");
  }
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
  if (spec.mode !== "read_only" && operation !== "delete" && (!spec.patch || Object.keys(spec.patch).length === 0)) {
    throw new Error("selection UPDATE/INSERT proposal requires at least one reviewed patch mapping.");
  }
  if (operation === "delete" && spec.patch && Object.keys(spec.patch).length > 0) throw new Error("selection DELETE proposal must not define patch mappings.");
  if (operation === "insert") {
    if (!spec.deduplication?.components?.length) throw new Error("selection INSERT requires source-enforced deduplication components.");
    if (!spec.deduplication.components.some((component) => component.source === "proposal_id")) throw new Error("selection INSERT deduplication requires proposal_id.");
    if (spec.tenant_key && !spec.deduplication.components.some((component) => component.source === "trusted_tenant" && component.column === spec.tenant_key)) throw new Error("selection INSERT deduplication requires trusted_tenant on tenant_key.");
  }
  if (spec.mode !== "read_only" && (operation === "update" || operation === "delete") && !spec.conflict_column) {
    throw new Error(`selection ${operation.toUpperCase()} requires an inspected exact conflict_column; onboarding never generates a weak row-hash guard silently.`);
  }
  if (spec.version_advance && operation !== "update") throw new Error("selection version_advance is valid only for UPDATE.");
  if (spec.version_advance && spec.version_advance.column !== spec.conflict_column) throw new Error("selection version_advance column must match conflict_column.");
  if (spec.receipts) {
    if (spec.receipts.authority !== "source_db" && spec.receipts.authority !== "runner_ledger") throw new Error("selection receipts.authority must be source_db or runner_ledger.");
    if (spec.receipts.authority === "source_db" && spec.receipts.provisioning !== "precreated" && spec.receipts.provisioning !== "auto_migrate") throw new Error("selection source_db receipts require precreated or auto_migrate provisioning.");
    if (spec.receipts.authority === "runner_ledger" && (spec.receipts.provisioning || spec.receipts.schema || spec.receipts.table)) throw new Error("selection runner_ledger receipts do not use source provisioning/schema/table.");
    if (spec.receipts.authority === "runner_ledger" && operation === "update" && !spec.version_advance) throw new Error("selection runner_ledger UPDATE requires version_advance.");
  }
  if (spec.mode !== "read_only" && spec.patch && Object.keys(spec.patch).length > 0) {
    const allowed = new Set(spec.allowed_columns ?? Object.keys(spec.patch));
    for (const column of Object.keys(spec.patch)) {
      if (!allowed.has(column)) throw new Error(`patch column ${column} is not in allowed_columns.`);
    }
    for (const column of Object.keys(spec.numeric_bounds ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(spec.patch, column)) throw new Error(`numeric bound column ${column} is not in patch.`);
      const bounds = spec.numeric_bounds?.[column] ?? {};
      if (bounds.minimum === undefined && bounds.maximum === undefined) throw new Error(`numeric bound for ${column} must define minimum, maximum, or both.`);
      if (bounds.minimum !== undefined && !Number.isFinite(bounds.minimum)) throw new Error(`numeric bound minimum for ${column} must be finite.`);
      if (bounds.maximum !== undefined && !Number.isFinite(bounds.maximum)) throw new Error(`numeric bound maximum for ${column} must be finite.`);
      if (bounds.minimum !== undefined && bounds.maximum !== undefined && bounds.minimum > bounds.maximum) throw new Error(`numeric bound minimum for ${column} must be <= maximum.`);
    }
    const readableColumns = new Set([spec.primary_key, spec.tenant_key, spec.conflict_column, ...spec.visible_columns].filter((value): value is string => Boolean(value)));
    for (const [column, guard] of Object.entries(spec.transition_guards ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(spec.patch, column)) throw new Error(`transition guard column ${column} is not in patch.`);
      const fromColumn = guard.from_column ?? column;
      if (!readableColumns.has(fromColumn)) throw new Error(`transition guard from_column ${fromColumn} must be visible or otherwise read.`);
      if (!guard.allowed || Object.keys(guard.allowed).length === 0) throw new Error(`transition guard for ${column} must define allowed transitions.`);
      for (const [from, toValues] of Object.entries(guard.allowed)) {
        if (!from.trim()) throw new Error(`transition guard source state for ${column} must not be empty.`);
        if (!Array.isArray(toValues) || toValues.length === 0 || toValues.some((value) => typeof value !== "string" || !value.trim())) {
          throw new Error(`transition guard target states for ${column} must be non-empty strings.`);
        }
      }
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
    spec.writeback?.executor_name,
    ...(spec.visible_columns ?? []),
    ...(spec.allowed_columns ?? []),
    ...Object.keys(spec.numeric_bounds ?? {}),
    ...Object.keys(spec.transition_guards ?? {}),
    ...Object.values(spec.transition_guards ?? {}).map((guard) => guard.from_column).filter(Boolean),
  ].filter(Boolean)) {
    assertSafeIdentifier(String(name));
  }
  for (const env of [
    spec.read_url_env,
    spec.database_url_env,
    spec.write_url_env,
    spec.writeback?.handler_url_env,
    spec.writeback?.handler_token_env,
    spec.writeback?.handler_signing_secret_env,
    spec.writeback?.handler_command_env,
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

function capitalize(value: string): string {
  if (!value) return value;
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
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

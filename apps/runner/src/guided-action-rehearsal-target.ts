import {
  configUsesHttpClaims,
  createMcpRuntimeSharedResources,
  loadRuntimeConfigFromFile,
  resolveTrustedContext,
  sessionAuthVerifier,
  verifySessionJwt,
  type DbRowReader,
  type RuntimeCapabilityConfig,
  type RuntimeConfig,
  type TrustedContext,
} from "@synapsor-runner/mcp-server";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import path from "node:path";
import { prepareGuidedActionPreview } from "./guided-action.js";

const DEFAULT_LOCAL_PICKER_LIMIT = 20;

export type GuidedActionRehearsalTargetCandidate = {
  label: string;
  value: unknown;
};

export type GuidedActionRehearsalTargetResolution =
  | {
      state: "resolved";
      mode: "trusted_scope_unique";
      lookup_argument: string;
      value: unknown;
      proof: string;
    }
  | {
      state: "selection_required";
      mode: "local_safe_picker";
      lookup_argument: string;
      candidates: GuidedActionRehearsalTargetCandidate[];
      truncated: boolean;
    }
  | {
      state: "unavailable";
      lookup_argument: string;
      reason: "no_scoped_rows" | "scope_not_unique" | "scope_cardinality_changed" | "scope_proof_missing";
      message: string;
    };

export async function resolveGuidedActionRehearsalTarget(input: {
  projectRoot: string;
  capabilityName: string;
  inspection: SchemaInspection;
  env?: NodeJS.ProcessEnv;
  baseConfigPath?: string;
  accessTokenEnv?: string;
  localPickerLimit?: number;
}): Promise<GuidedActionRehearsalTargetResolution> {
  const projectRoot = path.resolve(input.projectRoot);
  const env = input.env ?? process.env;
  const prepared = await prepareGuidedActionPreview({
    projectRoot,
    capabilityName: input.capabilityName,
    ...(input.baseConfigPath ? { configPath: input.baseConfigPath } : {}),
  });
  const configPath = path.resolve(projectRoot, prepared.config_path);
  const config = loadRuntimeConfigFromFile(configPath);
  const capability = config.capabilities?.find((candidate) => candidate.name === prepared.capability);
  if (!capability) {
    throw new Error("GUIDED_ACTION_CAPABILITY_MISSING: the preview runtime no longer contains its reviewed action.");
  }
  const context = configUsesHttpClaims(config)
    ? await verifiedTargetContext(config, env, path.dirname(configPath), input.accessTokenEnv ?? "SYNAPSOR_MCP_ACCESS_TOKEN")
    : resolveTrustedContext(config, env, capability);
  const resources = createMcpRuntimeSharedResources(config, env);
  try {
    return resolveGuidedActionRehearsalTargetWithRuntime({
      config,
      capability,
      inspection: input.inspection,
      context,
      readRow: resources.readRow,
      env,
      localPickerLimit: input.localPickerLimit ?? DEFAULT_LOCAL_PICKER_LIMIT,
    });
  } finally {
    await resources.close();
  }
}

export async function resolveGuidedActionRehearsalTargetWithRuntime(input: {
  config: RuntimeConfig;
  capability: RuntimeCapabilityConfig;
  inspection: SchemaInspection;
  context: TrustedContext;
  readRow: DbRowReader;
  env?: NodeJS.ProcessEnv;
  localPickerLimit?: number;
}): Promise<GuidedActionRehearsalTargetResolution> {
  const lookupArgument = input.capability.lookup?.id_from_arg;
  if (!lookupArgument) {
    throw new Error("GUIDED_ACTION_LOOKUP_ARGUMENT_MISSING: this rehearsal target has no reviewed identity argument.");
  }
  const table = input.inspection.tables.find((candidate) =>
    candidate.schema === input.capability.target.schema
    && candidate.name === input.capability.target.table);
  if (!table) {
    return unavailable(lookupArgument, "scope_proof_missing", "The inspected catalog no longer contains this action target.");
  }
  const source = input.config.sources?.[input.capability.source];
  if (!source) {
    throw new Error(`GUIDED_ACTION_SOURCE_CONFIG_MISSING: source ${input.capability.source} is not configured.`);
  }
  const scopeColumns = [
    input.capability.target.tenant_key,
    input.capability.target.principal_scope_key,
  ].filter((value): value is string => Boolean(value));
  if (!scopeColumns.length) {
    return unavailable(
      lookupArgument,
      "scope_proof_missing",
      "Trusted scope does not bind a physical target column, so Runner cannot select one row without an explicit local choice.",
    );
  }
  const proof = reviewedScopeUniqueness(table, scopeColumns);
  const pickerLimit = boundedPickerLimit(input.localPickerLimit ?? DEFAULT_LOCAL_PICKER_LIMIT);
  const labelColumns = localPickerLabelColumns(input.capability);
  const probe = scopedProbeCapability(input.capability, labelColumns, proof ? 2 : pickerLimit + 1);
  let result: Awaited<ReturnType<DbRowReader>>;
  try {
    result = await input.readRow({
      sourceName: input.capability.source,
      source,
      capability: probe,
      args: {},
      context: input.context,
      env: input.env ?? process.env,
      transaction_mode: "read_only",
    });
  } catch (error) {
    const driver = error !== null && typeof error === "object"
      ? error as { code?: unknown; errno?: unknown }
      : undefined;
    const invalidScopeType = source.engine === "postgres"
      ? driver?.code === "22P02"
      : source.engine === "mysql" && (
        driver?.code === "ER_TRUNCATED_WRONG_VALUE" && driver.errno === 1292
        || driver?.code === "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD" && driver.errno === 1366
      );
    if (invalidScopeType) {
      throw new Error(
        "GUIDED_ACTION_TRUSTED_SCOPE_VALUE_INVALID: the configured trusted tenant or principal value does not match the database type required by this action. Check the trusted-context environment variables; no rehearsal or source write ran.",
      );
    }
    throw error;
  }
  const rows = result.rows ?? (result.rowCount ? [result.row] : []);
  if (proof) {
    if (rows.length === 1) {
      const value = rows[0]?.[input.capability.target.primary_key];
      if (value === undefined || value === null) {
        throw new Error("GUIDED_ACTION_TARGET_IDENTITY_MISSING: the scoped source row did not return its reviewed identity.");
      }
      return {
        state: "resolved",
        mode: "trusted_scope_unique",
        lookup_argument: lookupArgument,
        value,
        proof,
      };
    }
    if (rows.length === 0) {
      return unavailable(
        lookupArgument,
        "no_scoped_rows",
        "No row exists for the current trusted tenant/principal scope. Create the row through an independently reviewed path or keep this action disabled.",
      );
    }
    return unavailable(
      lookupArgument,
      "scope_cardinality_changed",
      "Trusted scope was reviewed as unique, but the source returned more than one row. Runner refused the rehearsal; rescan and review the changed constraint before continuing.",
    );
  }
  if (rows.length === 0) {
    return unavailable(
      lookupArgument,
      "no_scoped_rows",
      "No authorized row is available for the current trusted tenant/principal scope.",
    );
  }
  const visible = rows.slice(0, pickerLimit);
  return {
    state: "selection_required",
    mode: "local_safe_picker",
    lookup_argument: lookupArgument,
    candidates: visible.map((row, index) => {
      const value = row[input.capability.target.primary_key];
      if (value === undefined || value === null) {
        throw new Error("GUIDED_ACTION_TARGET_IDENTITY_MISSING: an authorized source row did not return its reviewed identity.");
      }
      return {
        value,
        label: localCandidateLabel(row, labelColumns, index),
      };
    }),
    truncated: rows.length > pickerLimit,
  };
}

export function reviewedScopeUniqueness(table: TableInfo, scopeColumns: string[]): string | undefined {
  const covered = new Set(scopeColumns);
  const candidates = [
    ...(table.primary_key.length ? [{ kind: "primary key", name: "PRIMARY", columns: table.primary_key }] : []),
    ...table.unique_constraints.map((constraint) => ({
      kind: "unique constraint",
      name: constraint.name,
      columns: constraint.columns,
    })),
    ...table.indexes
      .filter((index) => index.unique === true && index.catalog_partial !== true && index.columns?.length)
      .map((index) => ({ kind: "unique index", name: index.name, columns: index.columns! })),
  ];
  const proof = candidates.find((candidate) =>
    candidate.columns.length > 0 && candidate.columns.every((column) => covered.has(column)));
  return proof
    ? `${proof.kind} ${proof.name} (${proof.columns.join(", ")})`
    : undefined;
}

function scopedProbeCapability(
  capability: RuntimeCapabilityConfig,
  labelColumns: string[],
  maximumRows: number,
): RuntimeCapabilityConfig {
  return {
    ...capability,
    kind: "proposal",
    args: {},
    visible_columns: [...new Set([
      capability.target.primary_key,
      ...labelColumns,
    ])],
    operation: {
      kind: "update",
      cardinality: "set",
      selection: { all: [] },
      max_rows: maximumRows,
    },
    max_rows: maximumRows,
  };
}

function localPickerLabelColumns(capability: RuntimeCapabilityConfig): string[] {
  const excluded = new Set([
    capability.target.primary_key,
    capability.target.tenant_key,
    capability.target.principal_scope_key,
    capability.conflict_guard?.column,
    ...(capability.kept_out_fields ?? []),
    ...(capability.model_withheld_fields ?? []),
  ].filter((value): value is string => Boolean(value)));
  return capability.visible_columns.filter((column) => !excluded.has(column)).slice(0, 3);
}

function localCandidateLabel(row: Record<string, unknown>, columns: string[], index: number): string {
  const facts = columns.flatMap((column) => {
    const value = row[column];
    if (value === undefined || value === null) return [];
    return [`${column}: ${safeLabelValue(value)}`];
  });
  return facts.length ? facts.join(" | ") : `Authorized row ${index + 1}`;
}

function safeLabelValue(value: unknown): string {
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return text.length <= 48 ? text : `${text.slice(0, 47)}...`;
}

function boundedPickerLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 49) {
    throw new Error("GUIDED_ACTION_PICKER_LIMIT_INVALID: local picker limit must be a whole number from 1 through 49.");
  }
  return value;
}

function unavailable(
  lookupArgument: string,
  reason: Extract<GuidedActionRehearsalTargetResolution, { state: "unavailable" }>["reason"],
  message: string,
): GuidedActionRehearsalTargetResolution {
  return { state: "unavailable", lookup_argument: lookupArgument, reason, message };
}

async function verifiedTargetContext(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  baseDir: string,
  accessTokenEnv: string,
): Promise<TrustedContext> {
  const token = env[accessTokenEnv]?.trim();
  if (!token) {
    throw new Error(
      `GUIDED_ACTION_PREVIEW_TOKEN_REQUIRED: ${accessTokenEnv} must contain a real signed access token for this production-shaped preview. The value is never persisted or displayed.`,
    );
  }
  const verifier = sessionAuthVerifier(config, env, baseDir);
  return verifySessionJwt(config, token, verifier);
}

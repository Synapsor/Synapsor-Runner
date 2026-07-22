import path from "node:path";
import { assertValidContract, type CapabilitySpec, type SynapsorContract } from "@synapsor/spec";
import type {
  GeneratedOnboardingFiles,
  OnboardingSelectionSpec,
  TableInfo,
} from "@synapsor-runner/schema-inspector";

type JsonRecord = Record<string, unknown>;

export type ProjectDetectionSummary = {
  root: string;
  package_manager?: "pnpm" | "npm" | "yarn" | "bun";
  frameworks: string[];
  schema_inputs: Array<{ kind: "prisma" | "drizzle" | "openapi" | "sql" | "synapsor"; path: string }>;
  database_env_names: string[];
};

export type OnboardingManifest = {
  schema_version: "synapsor.onboarding.v1";
  status: "read_only_active" | "shadow_active" | "review_active";
  generated_at: string;
  project: ProjectDetectionSummary;
  artifacts: {
    runner_config: string;
    canonical_contract: string;
    environment_template: string;
    cursor_project_config: string;
    local_store: string;
  };
  source: {
    engine: "postgres" | "mysql";
    database_url_env: string;
    schema: string;
    table: string;
  };
  trust_scope: {
    tenant_key?: string;
    single_tenant_dev: boolean;
    tenant_env: string;
    principal_env: string;
  };
  action: {
    mode: "read_only" | "shadow" | "review";
    read_capability: string;
    proposal_capability?: string;
    operation?: "update" | "insert" | "delete";
    visible_fields: string[];
    kept_out_fields: string[];
    conflict_guard?: string;
    approval_role?: string;
    writeback: "none" | "direct_sql" | "app_handler";
  };
  safety: {
    generated_from_read_only_inspection: true;
    developer_confirmed_activation: boolean;
    source_changed_during_onboarding: false;
    model_can_approve_or_apply: false;
    credentials_written_to_artifacts: false;
  };
  activation?: {
    own_data_started_at: string;
    own_data_ready_at: string;
    product_activation_ms: number;
    clock_boundary: string;
  };
};

export type CanonicalOnboardingArtifacts = GeneratedOnboardingFiles & {
  contract: SynapsorContract;
  manifest: OnboardingManifest;
};

export function buildCanonicalOnboardingArtifacts(input: {
  generated: GeneratedOnboardingFiles;
  selection: OnboardingSelectionSpec;
  table?: TableInfo;
  configPath: string;
  contractPath: string;
  project: ProjectDetectionSummary;
  activationConfirmed?: boolean;
  generatedAt?: string;
}): CanonicalOnboardingArtifacts {
  const { generated, selection } = input;
  const activationConfirmed = input.activationConfirmed === true;
  if (selection.mode === "review" && !activationConfirmed) {
    throw new Error("review writeback remains disabled until the developer explicitly confirms activation");
  }
  const embedded = generated.config.capabilities;
  if (!Array.isArray(embedded) || embedded.length === 0) {
    throw new Error("onboarding did not generate a reviewed capability");
  }

  const contextName = "local_operator";
  const resourceName = `${safeName(selection.namespace)}.${safeName(selection.object_name ?? singularize(selection.table))}`;
  const allColumns = input.table?.columns.map((column) => column.name)
    ?? unique([
      selection.primary_key,
      selection.tenant_key,
      selection.conflict_column,
      ...selection.visible_columns,
      ...Object.keys(selection.patch ?? {}),
    ].filter((value): value is string => Boolean(value)));
  const visible = new Set(selection.visible_columns);
  visible.add(selection.primary_key);
  if (selection.tenant_key) visible.add(selection.tenant_key);
  if (selection.conflict_column) visible.add(selection.conflict_column);
  const keptOutFields = allColumns.filter((column) => !visible.has(column));
  const sourceName = selection.source_name ?? (selection.engine === "postgres" ? "local_postgres" : "local_mysql");
  const readUrlEnv = selection.read_url_env ?? selection.database_url_env ?? "SYNAPSOR_DATABASE_READ_URL";
  const tenantEnv = selection.trusted_context?.tenant_id_env ?? "SYNAPSOR_TENANT_ID";
  const principalEnv = selection.trusted_context?.principal_env ?? "SYNAPSOR_PRINCIPAL";
  const capabilities = embedded.map((raw) => capabilityFromRuntime({
    raw: requireRecord(raw, "generated capability"),
    resourceName,
    contextName,
    keptOutFields,
    mode: selection.mode ?? "shadow",
  }));

  const contract: SynapsorContract = {
    spec_version: "0.1",
    kind: "SynapsorContract",
    metadata: {
      name: `${safeName(selection.namespace)}.${safeName(selection.object_name ?? singularize(selection.table))}`,
      description: `Reviewed semantic actions for ${selection.schema}.${selection.table}.`,
      version: "1",
      tags: ["generated", "reviewed-own-data"],
    },
    resources: [{
      name: resourceName,
      engine: selection.engine,
      schema: selection.schema,
      table: selection.table,
      type: input.table?.type === "view" ? "view" : "table",
      primary_key: selection.primary_key,
      ...(selection.tenant_key ? { tenant_key: selection.tenant_key } : { single_tenant_dev: true }),
      ...(selection.conflict_column ? { conflict_key: selection.conflict_column } : {}),
    }],
    contexts: [{
      name: contextName,
      description: "Trusted local operator context resolved outside model arguments.",
      bindings: [
        { name: "tenant_id", source: "environment", key: tenantEnv, required: true },
        { name: "principal", source: "environment", key: principalEnv, required: true },
      ],
      tenant_binding: "tenant_id",
      principal_binding: "principal",
    }],
    capabilities,
    workflows: [{
      name: `${safeName(selection.namespace)}.first_safe_action`,
      description: "Inspect scoped evidence, then create a reviewable proposal without model commit authority.",
      context: contextName,
      allowed_capabilities: capabilities.map((capability) => capability.name),
      required_evidence: true,
      approval: { required: capabilities.some((capability) => capability.kind === "proposal"), role: selection.approval?.required_role },
      replay: { checkpoint: "proposal_only" },
    }],
  };
  assertValidContract(contract);

  const configDirectory = path.dirname(path.resolve(input.configPath));
  const contractReference = normalizeRelativePath(path.relative(configDirectory, path.resolve(input.contractPath)) || path.basename(input.contractPath));
  const config: JsonRecord = structuredClone(generated.config) as JsonRecord;
  delete config.capabilities;
  delete config.contexts;
  delete config.trusted_context;
  config.contracts = [contractReference.startsWith(".") ? contractReference : `./${contractReference}`];

  const readCapability = capabilities.find((capability) => capability.kind === "read");
  const proposalCapability = capabilities.find((capability) => capability.kind === "proposal");
  if (!readCapability) throw new Error("onboarding canonical contract requires one reviewed read capability");
  const writeback = proposalCapability?.proposal?.writeback;
  const manifest: OnboardingManifest = {
    schema_version: "synapsor.onboarding.v1",
    status: selection.mode === "review"
      ? "review_active"
      : selection.mode === "shadow"
        ? "shadow_active"
        : "read_only_active",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    project: input.project,
    artifacts: {
      runner_config: path.resolve(input.configPath),
      canonical_contract: path.resolve(input.contractPath),
      environment_template: path.resolve(configDirectory, ".env.example"),
      cursor_project_config: path.resolve(configDirectory, ".cursor/mcp.json"),
      local_store: path.resolve(configDirectory, ".synapsor/local.db"),
    },
    source: {
      engine: selection.engine,
      database_url_env: readUrlEnv,
      schema: selection.schema,
      table: selection.table,
    },
    trust_scope: {
      ...(selection.tenant_key ? { tenant_key: selection.tenant_key } : {}),
      single_tenant_dev: Boolean(selection.single_tenant_dev),
      tenant_env: tenantEnv,
      principal_env: principalEnv,
    },
    action: {
      mode: selection.mode ?? "shadow",
      read_capability: readCapability.name,
      ...(proposalCapability ? {
        proposal_capability: proposalCapability.name,
        operation: proposalCapability.proposal?.operation?.kind ?? "update",
        approval_role: proposalCapability.proposal?.approval?.required_role,
      } : {}),
      visible_fields: [...readCapability.visible_fields],
      kept_out_fields: [...keptOutFields],
      ...(selection.conflict_column ? { conflict_guard: selection.conflict_column } : {}),
      writeback: writeback?.mode === "app_handler" ? "app_handler" : writeback?.mode === "direct_sql" ? "direct_sql" : "none",
    },
    safety: {
      generated_from_read_only_inspection: true,
      developer_confirmed_activation: activationConfirmed,
      source_changed_during_onboarding: false,
      model_can_approve_or_apply: false,
      credentials_written_to_artifacts: false,
    },
  };

  return { ...generated, config, contract, manifest };
}

function capabilityFromRuntime(input: {
  raw: JsonRecord;
  resourceName: string;
  contextName: string;
  keptOutFields: string[];
  mode: "read_only" | "shadow" | "review";
}): CapabilitySpec {
  const raw = input.raw;
  const kind = raw.kind === "proposal" ? "proposal" : "read";
  const capability: CapabilitySpec = {
    name: requiredString(raw.name, "capability.name"),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.returns_hint === "string" ? { returns_hint: raw.returns_hint } : {}),
    kind,
    context: input.contextName,
    source: requiredString(raw.source, "capability.source"),
    subject: {
      resource: input.resourceName,
      ...(typeof raw.target === "object" && raw.target !== null && !Array.isArray(raw.target)
        ? subjectScopeFromRuntimeTarget(raw.target as JsonRecord)
        : {}),
    },
    args: requireRecord(raw.args, "capability.args") as CapabilitySpec["args"],
    lookup: requireRecord(raw.lookup, "capability.lookup") as { id_from_arg: string },
    visible_fields: stringArray(raw.visible_columns, "capability.visible_columns"),
    ...(input.keptOutFields.length ? { kept_out_fields: input.keptOutFields } : {}),
    evidence: { required: raw.evidence !== "optional", query_audit: true },
    max_rows: typeof raw.max_rows === "number" ? raw.max_rows : 1,
  };
  if (kind !== "proposal") return capability;

  const operation = isRecord(raw.operation)
    ? raw.operation as NonNullable<NonNullable<CapabilitySpec["proposal"]>["operation"]>
    : { kind: "update" as const };
  const executor = typeof raw.executor === "string" ? raw.executor : undefined;
  const writeback = input.mode === "review"
    ? executor
      ? { mode: "app_handler" as const, executor }
      : { mode: "direct_sql" as const }
    : { mode: "none" as const };
  const conflictGuard = isRecord(raw.conflict_guard)
    ? raw.conflict_guard as { column?: string; weak_guard_ack?: boolean }
    : undefined;
  if (operation.kind !== "insert" && !conflictGuard) {
    throw new Error(`capability ${capability.name} ${operation.kind.toUpperCase()} requires an explicit conflict guard; onboarding does not infer weak row-hash protection`);
  }
  capability.proposal = {
    action: capability.name,
    operation,
    allowed_fields: stringArray(raw.allowed_columns, "capability.allowed_columns"),
    patch: requireRecord(raw.patch, "capability.patch") as NonNullable<CapabilitySpec["proposal"]>["patch"],
    ...(isRecord(raw.numeric_bounds) ? { numeric_bounds: raw.numeric_bounds as NonNullable<CapabilitySpec["proposal"]>["numeric_bounds"] } : {}),
    ...(isRecord(raw.transition_guards) ? { transition_guards: raw.transition_guards as NonNullable<CapabilitySpec["proposal"]>["transition_guards"] } : {}),
    ...(isRecord(raw.reversibility) ? { reversibility: raw.reversibility as { mode: "reviewed_inverse" } } : {}),
    ...(conflictGuard ? { conflict_guard: conflictGuard } : {}),
    approval: isRecord(raw.approval) ? raw.approval as NonNullable<NonNullable<CapabilitySpec["proposal"]>["approval"]> : { mode: "human" },
    writeback,
  };
  return capability;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function subjectScopeFromRuntimeTarget(target: JsonRecord): Pick<CapabilitySpec["subject"], "primary_key" | "tenant_key" | "principal_scope_key" | "single_tenant_dev"> {
  return {
    ...(typeof target.primary_key === "string" ? { primary_key: target.primary_key } : {}),
    ...(typeof target.tenant_key === "string" ? { tenant_key: target.tenant_key } : {}),
    ...(typeof target.principal_scope_key === "string" ? { principal_scope_key: target.principal_scope_key } : {}),
    ...(target.single_tenant_dev === true ? { single_tenant_dev: true } : {}),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value as string[];
}

function safeName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) return "action";
  return /^[a-z_]/.test(normalized) ? normalized : `_${normalized}`;
}

function singularize(value: string): string {
  const safe = safeName(value);
  if (safe.endsWith("ies") && safe.length > 3) return `${safe.slice(0, -3)}y`;
  if (safe.endsWith("ses") && safe.length > 3) return safe.slice(0, -2);
  if (safe.endsWith("s") && safe.length > 1) return safe.slice(0, -1);
  return safe;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

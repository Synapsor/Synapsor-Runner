import type {
  ProposalRuntimeStore,
} from "@synapsor-runner/proposal-store";
import type {
  CapabilityKind,
  RuntimeCapabilityConfig,
  RuntimeConfig,
  TrustedContext,
  DbRowReader,
  ResultEnvelopeV2,
  CloudAdapterClient,
} from "./runtime-types.js";
import type {
  preflightGeneratedCapabilityAuthority,
} from "./generated-authority.js";
import {
  evidenceHandle,
} from "./approval-policy.js";
import {
  localCapabilities,
} from "./capability-authority.js";
import {
  safeToolError,
} from "./runtime-errors.js";
import {
  isRecord,
} from "./safe-values.js";
import {
  callConfiguredTool,
} from "./tool-dispatch.js";

export async function callConfiguredToolV2(input: {
  config: RuntimeConfig;
  env: NodeJS.ProcessEnv;
  store: ProposalRuntimeStore;
  readRow: DbRowReader;
  cloudClient?: CloudAdapterClient;
  trustedContext?: TrustedContext;
  privacySessionId?: string;
  generatedAuthorityInspector?: Parameters<typeof preflightGeneratedCapabilityAuthority>[3];
  name: string;
  args: Record<string, unknown>;
}): Promise<ResultEnvelopeV2> {
  const capability = input.config.mode === "cloud"
    ? undefined
    : localCapabilities(input.config).find((item) => item.name === input.name);
  const legacy = await callConfiguredTool(input);
  return resultEnvelopeFromLegacy(legacy, capability, input.name);
}

export function resultEnvelopeFromLegacy(
  legacy: Record<string, unknown>,
  capability: RuntimeCapabilityConfig | undefined,
  canonicalName: string,
): ResultEnvelopeV2 {
  const action = typeof legacy.action === "string" ? legacy.action : canonicalName;
  const kind: CapabilityKind = capability?.kind ?? (typeof legacy.proposal_id === "string" ? "proposal" : "read");
  const evidenceBundleId = typeof legacy.evidence_bundle_id === "string" ? legacy.evidence_bundle_id : undefined;
  const sourceChanged = Boolean(legacy.source_database_changed ?? legacy.source_database_mutated ?? false);
  const context = isRecord(legacy.trusted_context) ? legacy.trusted_context : undefined;
  const target = isRecord(legacy.target) ? legacy.target : undefined;

  if (kind === "proposal") {
    const proposalId = typeof legacy.proposal_id === "string" ? legacy.proposal_id : "wrp_unknown";
    const targetType = typeof target?.type === "string" ? target.type : capability?.target.table ?? "object";
    const targetId = target?.id !== undefined ? String(target.id) : "unknown";
    const approval = isRecord(legacy.approval) ? legacy.approval : undefined;
    const state = typeof legacy.status === "string" ? legacy.status : "review_required";
    const approvalRequired = legacy.approval_required !== false;
    const executor = writebackExecutorName(legacy.writeback);
    const operation = capability?.operation?.kind ?? "update";
    const writebackMode = executor === "read_only" || executor === "none"
      ? "proposal_only"
      : executor && executor !== "sql_update" && executor !== "trusted_worker_required"
        ? "app_handler"
        : operation === "insert"
          ? "direct_insert"
          : operation === "delete"
            ? "direct_delete"
            : "direct_update";
    return {
      ok: true,
      summary: `Created proposal ${proposalId} for ${targetType} ${targetId}. Source database changed: no.`,
      action,
      kind,
      data: null,
      proposal: {
        id: proposalId,
        state,
        target: `${targetType}:${targetId}`,
        diff: isRecord(legacy.diff) ? legacy.diff : {},
        approval_required: approvalRequired,
        ...(approval ? { approval } : {}),
        writeback: {
          mode: writebackMode,
          operation,
          applied: false,
        },
        next: approvalRequired
          ? "A human must approve outside this model-facing tool surface; nothing is committed yet."
          : "The proposal is approved outside the model-facing tool surface; trusted writeback/apply is still separate.",
      },
      error: null,
      evidence: evidenceBundleId ? evidenceHandle(evidenceBundleId) : null,
      source_database_changed: sourceChanged,
      _meta: {
        tenant_id: typeof target?.tenant_id === "string" ? target.tenant_id : undefined,
        principal: typeof context?.principal === "string" ? context.principal : undefined,
        provenance: typeof context?.provenance === "string" ? context.provenance : undefined,
        canonical_capability: action,
      },
    };
  }

  const businessObject = isRecord(legacy.business_object) ? legacy.business_object : undefined;
  const objectType = typeof businessObject?.type === "string" ? businessObject.type : capability?.target.table ?? "record";
  const objectId = businessObject?.id !== undefined ? String(businessObject.id) : String(legacy.action ?? action);
  return {
    ok: true,
    summary: kind === "aggregate_read"
      ? `Read one reviewed aggregate through ${action}. Source member rows exposed: no. Source database changed: no.`
      : `Read ${objectType} ${objectId} through ${action}. Source database changed: no.`,
    action,
    kind,
    data: isRecord(legacy.data) ? legacy.data : {},
    proposal: null,
    error: null,
    evidence: evidenceBundleId ? evidenceHandle(evidenceBundleId) : null,
    source_database_changed: sourceChanged,
    _meta: {
      tenant_id: typeof context?.tenant_id === "string" ? context.tenant_id : undefined,
      principal: typeof context?.principal === "string" ? context.principal : undefined,
      provenance: typeof context?.provenance === "string" ? context.provenance : undefined,
      canonical_capability: action,
      ...(legacy.reporting_timezone === "UTC"
        ? { reporting_timezone: "UTC" as const }
        : {}),
    },
  };
}

export function writebackExecutorName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.executor === "string" ? value.executor : typeof value.mode === "string" ? value.mode : undefined;
}

export function errorEnvelopeFromError(
  error: unknown,
  capability: RuntimeCapabilityConfig | undefined,
  canonicalName: string,
): ResultEnvelopeV2 {
  const safe = safeToolError(error);
  const action = capability?.name ?? canonicalName;
  return {
    ok: false,
    summary: safe.message,
    action,
    kind: capability?.kind ?? "read",
    data: null,
    proposal: null,
    error: safe,
    evidence: null,
    source_database_changed: false,
    _meta: {
      canonical_capability: action,
    },
  };
}

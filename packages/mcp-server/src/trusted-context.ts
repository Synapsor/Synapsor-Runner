import {
  canonicalJsonDigest,
  principalScopeFingerprint,
  protocolVersions,
  type ChangeSetV2,
} from "@synapsor-runner/protocol";
import type {
  Scalar,
  RuntimeSourceConfig,
  RuntimeScalarArgConfig,
  RuntimeCapabilityConfig,
  RuntimeConfig,
  TrustedContext,
  TenantCredentialResolver,
} from "./runtime-types.js";
import {
  isSetCapability,
} from "./capability-authority.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  envValue,
  isRecord,
  scalar,
  valueFromEnvOrLiteral,
} from "./safe-values.js";

export async function resolveRuntimeSourceCredential(input: {
  sourceName: string;
  source: RuntimeSourceConfig;
  context: TrustedContext;
  env: NodeJS.ProcessEnv;
  resolver?: TenantCredentialResolver;
  access?: "read" | "write";
  now?: number;
}): Promise<{ connectionUrl: string; poolKey: string; expiresAt?: number }> {
  if (input.source.credential_scope?.mode !== "tenant_resolver") {
    const connectionUrl = envValue(input.env, input.source.read_url_env);
    if (!connectionUrl) throw new McpRuntimeError("SOURCE_CREDENTIAL_MISSING", `${input.source.read_url_env} is not set.`);
    return { connectionUrl, poolKey: input.sourceName };
  }
  const expectedResolver = input.source.credential_scope.resolver;
  if (!input.resolver || input.resolver.id !== expectedResolver) {
    throw new McpRuntimeError(
      "TENANT_CREDENTIAL_RESOLVER_MISSING",
      `Source ${input.sourceName} requires tenant credential resolver ${expectedResolver}.`,
    );
  }
  try {
    const resolved = await input.resolver.resolve({
      source_name: input.sourceName,
      engine: input.source.engine,
      access: input.access ?? "read",
      tenant_id: input.context.tenant_id,
      principal: input.context.principal,
    });
    const connectionUrl = resolved.connection_url.trim();
    const credentialId = resolved.credential_id.trim();
    if (!connectionUrl || !credentialId || credentialId.length > 128 || /[\u0000-\u001f\u007f]/.test(credentialId)) {
      throw new Error("resolver returned an invalid credential");
    }
    const expiresAt = resolved.expires_at === undefined ? undefined : Date.parse(resolved.expires_at);
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= (input.now ?? Date.now()))) {
      throw new Error("resolver returned an expired credential");
    }
    return {
      connectionUrl,
      poolKey: canonicalJsonDigest({
        source: input.sourceName,
        access: input.access ?? "read",
        tenant: input.context.tenant_id,
        principal: input.context.principal,
        credential_id: credentialId,
      }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  } catch (error) {
    if (error instanceof McpRuntimeError) throw error;
    throw new McpRuntimeError(
      "TENANT_CREDENTIAL_RESOLUTION_FAILED",
      `Tenant credential resolution failed closed for source ${input.sourceName}.`,
    );
  }
}

export const RESERVED_MODEL_ARGS = new Set([
  "tenant_id",
  "tenantId",
  "principal",
  "principal_id",
  "project_id",
  "source_id",
  "allowed_columns",
  "row_version",
  "expected_version",
  "approval_identity",
]);

export function configUsesHttpClaims(config: RuntimeConfig): boolean {
  if (config.trusted_context?.provider === "http_claims") return true;
  return Object.values(config.contexts ?? {}).some((context) => context.provider === "http_claims");
}

export function effectivePrincipalScope(
  config: RuntimeConfig,
  capability: RuntimeCapabilityConfig,
  context: TrustedContext,
): NonNullable<ChangeSetV2["guards"]["principal_scope"]> | undefined {
  const column = capability.target.principal_scope_key;
  if (!column) return undefined;
  const contextConfig = (capability.context ? config.contexts?.[capability.context] : undefined) ?? config.trusted_context;
  if (!contextConfig) throw new McpRuntimeError("TRUSTED_CONTEXT_MISSING", `Principal-scoped capability ${capability.name} has no trusted context.`);
  const binding = contextConfig.principal_binding ?? "principal";
  const value = scalar(context.principal);
  const material = { column, binding, provider: contextConfig.provider, value };
  return {
    schema_version: protocolVersions.principalScope,
    ...material,
    value_fingerprint: principalScopeFingerprint(material),
  };
}

export function resolveTrustedContext(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  capability?: RuntimeCapabilityConfig,
  sessionContext?: TrustedContext,
): TrustedContext {
  const namedContext = capability?.context ? config.contexts?.[capability.context] : undefined;
  const contextConfig = namedContext ?? config.trusted_context;
  if (!contextConfig) {
    throw new McpRuntimeError("TRUSTED_CONTEXT_MISSING", capability?.context
      ? `Capability ${capability.name} references missing trusted context ${capability.context}.`
      : "No trusted_context is configured for this capability.");
  }
  const provider = contextConfig.provider;
  const values = contextConfig.values ?? {};
  if (provider === "environment") {
    const tenantEnv = String(values.tenant_id_env ?? "SYNAPSOR_TENANT_ID");
    const principalEnv = String(values.principal_env ?? "SYNAPSOR_PRINCIPAL");
    const tenant = envValue(env, tenantEnv);
    const principal = envValue(env, principalEnv);
    if (!tenant || !principal) throw new McpRuntimeError("TRUSTED_BINDING_MISSING", `${tenantEnv} and ${principalEnv} must be set.`);
    return { tenant_id: tenant, principal, provenance: "environment" };
  }
  if (provider === "static_dev") {
    const tenant = valueFromEnvOrLiteral(values.tenant_id_env, values.tenant_id, env);
    const principal = valueFromEnvOrLiteral(values.principal_env, values.principal, env);
    if (!tenant || !principal) throw new McpRuntimeError("TRUSTED_BINDING_MISSING", "static_dev trusted_context requires tenant_id/principal values or env bindings.");
    return { tenant_id: tenant, principal, provenance: "static_dev" };
  }
  if (provider === "http_claims" || provider === "cloud_session") {
    if (!sessionContext || sessionContext.provenance !== provider) {
      throw new McpRuntimeError("TRUSTED_BINDING_MISSING", `${provider} trusted context requires a verified per-session binding.`);
    }
    return sessionContext;
  }
  throw new McpRuntimeError("TRUSTED_CONTEXT_UNSUPPORTED", `${provider} trusted context is not available in local stdio mode.`);
}

export function validateToolArgs(capability: RuntimeCapabilityConfig, args: Record<string, unknown>): void {
  for (const name of Object.keys(args)) {
    if (Object.prototype.hasOwnProperty.call(capability.args, name)) continue;
    if (isSetCapability(capability)) {
      throw new McpRuntimeError("MODEL_PREDICATE_REJECTED", `bounded-set argument ${name} is not reviewed; selection, ordering, columns, operators, and row caps are contract-fixed.`);
    }
    throw new McpRuntimeError("ARGUMENT_NOT_ALLOWED", `${name} is not a reviewed capability argument.`);
  }
  for (const [name, spec] of Object.entries(capability.args)) {
    const value = args[name];
    if (spec.required !== false && value === undefined) throw new McpRuntimeError("ARGUMENT_REQUIRED", `${name} is required.`);
    if (value === undefined) continue;
    if (spec.type === "object_array") {
      if (!Array.isArray(value)) throw new McpRuntimeError("ARGUMENT_TYPE_INVALID", `${name} must be an array of reviewed objects.`);
      if (value.length < 1 || value.length > spec.max_items) throw new McpRuntimeError("ARGUMENT_ITEM_COUNT_INVALID", `${name} must contain 1 through ${spec.max_items} items.`);
      for (const [index, item] of value.entries()) {
        if (!isRecord(item)) throw new McpRuntimeError("ARGUMENT_ITEM_TYPE_INVALID", `${name}[${index}] must be an object.`);
        for (const key of Object.keys(item)) if (!Object.prototype.hasOwnProperty.call(spec.fields, key)) throw new McpRuntimeError("ARGUMENT_ITEM_FIELD_NOT_ALLOWED", `${name}[${index}].${key} is not a reviewed item field.`);
        for (const [fieldName, fieldSpec] of Object.entries(spec.fields)) validateScalarArg(`${name}[${index}].${fieldName}`, fieldSpec, item[fieldName]);
      }
      continue;
    }
    validateScalarArg(name, spec, value);
  }
}

export function validateScalarArg(name: string, spec: RuntimeScalarArgConfig, value: unknown): void {
    if (spec.required !== false && value === undefined) throw new McpRuntimeError("ARGUMENT_REQUIRED", `${name} is required.`);
    if (value === undefined) return;
    if (spec.type === "string" && typeof value !== "string") throw new McpRuntimeError("ARGUMENT_TYPE_INVALID", `${name} must be a string.`);
    if (spec.type === "number" && typeof value !== "number") throw new McpRuntimeError("ARGUMENT_TYPE_INVALID", `${name} must be a number.`);
    if (spec.type === "boolean" && typeof value !== "boolean") throw new McpRuntimeError("ARGUMENT_TYPE_INVALID", `${name} must be a boolean.`);
    if (typeof value === "string" && spec.max_length && value.length > spec.max_length) throw new McpRuntimeError("ARGUMENT_TOO_LONG", `${name} is longer than ${spec.max_length}.`);
    if (typeof value === "number" && spec.minimum !== undefined && value < spec.minimum) throw new McpRuntimeError("ARGUMENT_BELOW_MINIMUM", `${name} must be at least ${spec.minimum}.`);
    if (typeof value === "number" && spec.maximum !== undefined && value > spec.maximum) throw new McpRuntimeError("ARGUMENT_ABOVE_MAXIMUM", `${name} must be at most ${spec.maximum}.`);
    if (spec.enum && !spec.enum.includes(value as Scalar)) throw new McpRuntimeError("ARGUMENT_NOT_ALLOWED", `${name} is not an allowed value.`);
}

export function rejectTrustedArgOverrides(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (RESERVED_MODEL_ARGS.has(key)) {
      throw new McpRuntimeError("MODEL_CANNOT_OVERRIDE_BINDING", `${key} is trusted context and cannot be supplied as a model argument.`);
    }
  }
}

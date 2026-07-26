import type {
  RuntimeCapabilityConfig,
  RuntimeConfig,
  TrustedContext,
} from "./runtime-types.js";
import {
  safeRuntimeErrorCode,
  safeToolError,
} from "./runtime-errors.js";
import {
  resolveTrustedContext,
} from "./trusted-context.js";

export function logToolRejection(
  error: unknown,
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  capability: RuntimeCapabilityConfig | undefined,
  canonicalName: string,
  trustedContext?: TrustedContext,
): void {
  const safe = safeToolError(error);
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: safe.retryable ? "warn" : "info",
    event: "tool_rejected",
    capability: capability?.name ?? canonicalName,
    tenant: trustedTenantForLog(config, env, capability, trustedContext),
    error_code: safe.code,
    runtime_code: safeRuntimeErrorCode(error),
    retry_after_ms: safe.retry_after_ms,
    retryable: safe.retryable,
    source_database_changed: false,
  })}\n`);
}

export function trustedTenantForLog(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  capability: RuntimeCapabilityConfig | undefined,
  trustedContext?: TrustedContext,
): string | undefined {
  try {
    const context = resolveTrustedContext(config, env, capability, trustedContext);
    return /^[A-Za-z0-9_.:@/-]{1,128}$/.test(context.tenant_id) ? context.tenant_id : "<redacted>";
  } catch {
    return undefined;
  }
}

import { type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { envValue } from "./cli-options.js";
import { RunnerCapabilityConfig } from "./cli-runtime.js";


export function trustedCliContext(config: RuntimeConfig, capability: RunnerCapabilityConfig, env: NodeJS.ProcessEnv): { tenant_id: string; principal: string } {
  const name = capability.context;
  // Generated rules name the built-in top-level context. Other missing names
  // must not inherit it, and an explicit named binding always takes precedence.
  const context = name && Object.hasOwn(config.contexts ?? {}, name)
    ? config.contexts![name]
    : !name || name === "trusted_context" ? config.trusted_context : undefined;
  if (!context) throw trustedContextError("TRUSTED_CONTEXT_MISSING", `capability ${capability.name} requires ${name ?? "trusted_context"}; restore that reviewed trusted context before local CLI execution`);
  const values = context.values ?? {};
  if (context.provider !== "environment" && context.provider !== "static_dev") throw trustedContextError("TRUSTED_CONTEXT_UNAVAILABLE", `${context.provider} requires a verified MCP/Cloud session and cannot authorize local CLI execution`);
  const tenantEnv = String(values.tenant_id_env ?? "SYNAPSOR_TENANT_ID");
  const principalEnv = String(values.principal_env ?? "SYNAPSOR_PRINCIPAL");
  const tenant = context.provider === "environment"
    ? envValue(env, tenantEnv)
    : envValue(env, tenantEnv) ?? (typeof values.tenant_id === "string" ? values.tenant_id.trim() : undefined);
  const principal = context.provider === "environment"
    ? envValue(env, principalEnv)
    : envValue(env, principalEnv) ?? (typeof values.principal === "string" ? values.principal.trim() : undefined);
  if (!tenant || !principal) throw trustedContextError("TRUSTED_BINDING_MISSING", `${tenantEnv} and ${principalEnv} must resolve in the local CLI environment before execution`);
  return { tenant_id: tenant, principal };
}


function trustedContextError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}


export type TrustedOperatorDecisionOverride = {
  actor?: string;
  identity?: string;
  privateKeyPath?: string;
  reason?: string;
  identityToken?: string;
};


export type TrustedOperatorInvocation = {
  decision?: TrustedOperatorDecisionOverride;
  freshnessProofDigest?: string;
  /** Binds a TUI/Workbench decision to the exact proposal the operator reviewed. */
  expectedProposalHash?: string;
  quiet?: boolean;
};

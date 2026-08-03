import type {
  ResultEnvelopeV2,
} from "./runtime-types.js";
import {
  isRecord,
} from "./safe-values.js";

export class McpRuntimeError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "McpRuntimeError";
  }
}

export function safeToolError(error: unknown): NonNullable<ResultEnvelopeV2["error"]> {
  const runtimeCode = error instanceof McpRuntimeError ? error.code : undefined;
  if (runtimeCode === "ROW_NOT_FOUND") {
    return { code: "NOT_FOUND_IN_TENANT", message: "No authorized row was found in the trusted tenant scope.", retryable: false };
  }
  if (runtimeCode === "MCP_TOOL_NOT_FOUND") {
    return { code: "CAPABILITY_NOT_FOUND", message: "The requested Synapsor capability is not available.", retryable: false };
  }
  if (runtimeCode === "PROPOSALS_DISABLED") {
    return { code: "APPROVAL_REQUIRED", message: "Proposal tools are disabled for this runner mode.", retryable: false };
  }
  if (runtimeCode === "PROPOSAL_ALREADY_EXISTS") {
    return { code: "PROPOSAL_ALREADY_EXISTS", message: error instanceof Error ? error.message : "An active proposal already exists.", retryable: false };
  }
  if (runtimeCode === "RATE_LIMITED") {
    const retryAfter = error instanceof McpRuntimeError && typeof error.details?.retry_after_ms === "number"
      ? Math.max(1, Math.round(error.details.retry_after_ms))
      : undefined;
    return { code: "RATE_LIMITED", message: "The trusted tenant request limit was reached. Retry after the current window.", retryable: true, ...(retryAfter ? { retry_after_ms: retryAfter } : {}) };
  }
  if (runtimeCode === "PROTECTED_QUERY_RATE_LIMITED") {
    return {
      code: "RATE_LIMITED",
      message: "The protected capability reached its reviewed request rate. Retry after the current window.",
      retryable: true,
      retry_after_ms: DEFAULT_INFRA_RETRY_AFTER_MS,
    };
  }
  if (runtimeCode && [
    "PROTECTED_QUERY_BUDGET_EXHAUSTED",
    "PROTECTED_EXTRACTION_BUDGET_EXHAUSTED",
    "PROTECTED_DIFFERENCING_BUDGET_EXHAUSTED",
    "PROTECTED_RESPONSE_TOO_LARGE",
    "PROTECTED_COHORT_INVALID",
  ].includes(runtimeCode)) {
    return {
      code: "POLICY_VIOLATION",
      message: "The protected read was refused by its reviewed privacy or response boundary.",
      retryable: false,
    };
  }
  if (runtimeCode && [
    "GENERATED_AUTHORITY_DRIFT",
    "GENERATION_LOCK_DIGEST_MISMATCH",
    "GENERATION_LOCK_SOURCE_MISMATCH",
    "GENERATION_LOCK_TIMEZONE_MISMATCH",
    "GENERATED_AUTHORITY_ROLE_UNSAFE",
  ].includes(runtimeCode)) {
    return {
      code: "POLICY_VIOLATION",
      message: "The protected read was refused because its reviewed schema or database posture changed. Rescan and review the affected table or view.",
      retryable: false,
    };
  }
  if (runtimeCode === "CLOUD_RATE_LIMITED") {
    const retryAfter = error instanceof McpRuntimeError && typeof error.details?.retry_after_ms === "number"
      ? Math.max(1, Math.round(error.details.retry_after_ms))
      : DEFAULT_INFRA_RETRY_AFTER_MS;
    return { code: "RATE_LIMITED", message: "Synapsor Cloud is rate limiting proposal submissions. Retry after the current window.", retryable: true, retry_after_ms: retryAfter };
  }
  if (runtimeCode === "CLOUD_TEMPORARILY_UNAVAILABLE") {
    return temporarilyUnavailableError("Synapsor Cloud is temporarily unavailable. Retry later or enable reviewed durable proposal queueing.", error);
  }
  if (runtimeCode && ["CLOUD_RUNNER_AUTHENTICATION_FAILED", "CLOUD_RUNNER_AUTHORIZATION_FAILED", "CLOUD_CONNECTION_CONFLICT"].includes(runtimeCode)) {
    return { code: "POLICY_VIOLATION", message: "The reviewed Synapsor Cloud authority rejected this Runner connection.", retryable: false };
  }
  if (runtimeCode && (
    runtimeCode.startsWith("ARGUMENT_")
    || runtimeCode === "LOOKUP_ARG_MISSING"
    || runtimeCode === "MODEL_PREDICATE_REJECTED"
    || runtimeCode === "MODEL_CANNOT_OVERRIDE_BINDING"
    || runtimeCode === "TRUSTED_BINDING_MISSING"
    || runtimeCode === "TRUSTED_CONTEXT_MISSING"
  )) {
    return { code: "INVALID_ARGUMENT", message: "The tool input or trusted context binding is invalid.", retryable: false };
  }
  if (runtimeCode && (
    runtimeCode.startsWith("PATCH_")
    || runtimeCode.startsWith("SET_")
    || runtimeCode.startsWith("BATCH_")
    || runtimeCode === "CONFLICT_GUARD_MISSING"
  )) {
    return { code: "POLICY_VIOLATION", message: "The requested change is outside the reviewed capability policy.", retryable: false };
  }
  if (runtimeCode === "LOCAL_STORE_UNAVAILABLE") {
    return temporarilyUnavailableError(
      "The local runner store is temporarily unavailable. Restart the runner or recreate the store before retrying.",
      error,
    );
  }
  if (runtimeCode === "SOURCE_CREDENTIAL_MISSING" || isTransientInfrastructureError(error)) {
    return temporarilyUnavailableError("The database is temporarily unavailable. Retry later.", error);
  }
  return { code: "INTERNAL", message: "The capability failed safely. Check the local runner logs for details.", retryable: false };
}

export const DEFAULT_INFRA_RETRY_AFTER_MS = 1000;
export const MAX_INFRA_RETRY_AFTER_MS = 60_000;
export const TRANSIENT_RUNTIME_CODES = new Set(["SOURCE_POOL_QUEUE_FULL", "SOURCE_POOL_TIMEOUT"]);
export const TRANSIENT_SYSTEM_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);
export const TRANSIENT_POSTGRES_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "55P03", // lock_not_available
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "57014", // query_canceled, including reviewed statement_timeout
]);
export const TRANSIENT_MYSQL_CODES = new Set([
  "ER_CON_COUNT_ERROR",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
  "ER_SERVER_SHUTDOWN",
  "ER_TOO_MANY_USER_CONNECTIONS",
  "ER_QUERY_TIMEOUT",
  "PROTOCOL_CONNECTION_LOST",
]);
export const TRANSIENT_MYSQL_ERRNOS = new Set([1040, 1053, 1203, 1205, 1213, 2002, 2003, 2006, 2013, 3024]);

export function temporarilyUnavailableError(
  message: string,
  error: unknown,
): NonNullable<ResultEnvelopeV2["error"]> {
  return {
    code: "TEMPORARILY_UNAVAILABLE",
    message,
    retryable: true,
    retry_after_ms: infrastructureRetryAfterMs(error),
  };
}

export function infrastructureRetryAfterMs(error: unknown): number {
  for (const candidate of errorChain(error)) {
    if (!(candidate instanceof McpRuntimeError)) continue;
    const configured = candidate.details?.retry_after_ms;
    if (typeof configured === "number" && Number.isFinite(configured)) {
      return Math.min(MAX_INFRA_RETRY_AFTER_MS, Math.max(1, Math.round(configured)));
    }
  }
  return DEFAULT_INFRA_RETRY_AFTER_MS;
}

export function isTransientInfrastructureError(error: unknown): boolean {
  for (const candidate of errorChain(error)) {
    if (candidate instanceof McpRuntimeError && TRANSIENT_RUNTIME_CODES.has(candidate.code)) return true;
    const code = errorStringProperty(candidate, "code");
    const sqlState = errorStringProperty(candidate, "sqlState") ?? errorStringProperty(candidate, "sqlstate");
    const errno = errorNumberProperty(candidate, "errno");
    if (code && (
      TRANSIENT_SYSTEM_CODES.has(code)
      || TRANSIENT_POSTGRES_CODES.has(code)
      || code.startsWith("08")
      || TRANSIENT_MYSQL_CODES.has(code)
    )) return true;
    if (sqlState && (TRANSIENT_POSTGRES_CODES.has(sqlState) || sqlState.startsWith("08"))) return true;
    if (errno !== undefined && TRANSIENT_MYSQL_ERRNOS.has(errno)) return true;
    const message = errorMessage(candidate);
    if (/\b(ECONNABORTED|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETDOWN|ENETUNREACH|ENOTFOUND|EPIPE|ETIMEDOUT)\b/i.test(message)) return true;
    if (/\b(connection (?:queue|pool) (?:is )?(?:full|exhausted|timed out)|pool (?:is )?(?:full|exhausted)|too many (?:clients|connections)|remaining connection slots|cannot connect now)\b/i.test(message)) return true;
    if (/\b(connection (?:closed|lost|refused|reset|terminated|timed out)|database (?:is )?(?:starting up|shutting down|temporarily unavailable)|operation timed out|server closed the connection|socket hang up|timeout expired)\b/i.test(message)) return true;
  }
  return false;
}

export function safeRuntimeErrorCode(error: unknown): string {
  if (error instanceof McpRuntimeError) return error.code;
  for (const candidate of errorChain(error)) {
    const code = errorStringProperty(candidate, "code");
    const sqlState = errorStringProperty(candidate, "sqlState") ?? errorStringProperty(candidate, "sqlstate");
    const errno = errorNumberProperty(candidate, "errno");
    if (code && TRANSIENT_SYSTEM_CODES.has(code)) return `NODE_${code}`;
    if (code && TRANSIENT_MYSQL_CODES.has(code)) return `MYSQL_${code}`;
    if (errno !== undefined && TRANSIENT_MYSQL_ERRNOS.has(errno)) return `MYSQL_${errno}`;
    if (code && (TRANSIENT_POSTGRES_CODES.has(code) || code.startsWith("08"))) return `POSTGRES_${code}`;
    if (sqlState && (TRANSIENT_POSTGRES_CODES.has(sqlState) || sqlState.startsWith("08"))) return `POSTGRES_${sqlState}`;
  }
  return "UNCLASSIFIED";
}

export function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 6 && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = isRecord(current) ? current.cause : undefined;
  }
  return chain;
}

export function errorStringProperty(error: unknown, property: string): string | undefined {
  if (!isRecord(error)) return undefined;
  const value = error[property];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim().toUpperCase();
  return normalized || undefined;
}

export function errorNumberProperty(error: unknown, property: string): number | undefined {
  if (!isRecord(error)) return undefined;
  const value = error[property];
  const normalized = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(normalized) ? normalized : undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "";
}

export function toolErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof McpRuntimeError) {
    if (error.code === "LOCAL_STORE_UNAVAILABLE") {
      return { ok: false, code: "TEMPORARILY_UNAVAILABLE", error: "The local runner store is temporarily unavailable. Restart the runner or recreate the store before retrying." };
    }
    const retryAfter = error.code === "RATE_LIMITED" && typeof error.details?.retry_after_ms === "number"
      ? Math.max(1, Math.round(error.details.retry_after_ms))
      : undefined;
    return {
      ok: false,
      code: error.code,
      error: error.message,
      ...(retryAfter ? { retry_after_ms: retryAfter } : {}),
    };
  }
  return { ok: false, code: "MCP_TOOL_FAILED", error: error instanceof Error ? error.message : String(error) };
}

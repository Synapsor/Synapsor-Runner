import {
  redact
} from "@synapsor-runner/worker-core";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { isRecord } from "./cli-format.js";
import { normalizeCliArgv } from "./cli-options.js";


export function operationalLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  const safeFields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") safeFields[key] = logIdentifier(value);
    else if (typeof value === "number" && Number.isFinite(value)) safeFields[key] = value;
    else if (typeof value === "boolean") safeFields[key] = value;
  }
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...safeFields,
  })}\n`);
}


export function logIdentifier(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > 200 || /[\r\n\u0000-\u001f]/.test(text)) return "<redacted>";
  return text;
}


export function safeOperationalErrorCode(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  return code && /^[A-Z][A-Z0-9_:-]{1,79}$/.test(code) ? code : "COMMAND_REJECTED";
}


export function requestsJsonOutput(argv: string[]): boolean {
  const normalized = normalizeCliArgv(argv);
  return normalized.includes("--json")
    || normalized.includes("--format=json")
    || normalized.some((arg, index) => arg === "--format" && normalized[index + 1] === "json");
}


export function redactCliErrorMessage(message: string): string {
  return redact(message)
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1<redacted>")
    .replace(/\b(?:sk|pk|ghp|gho|glpat|xox[baprs]|syn)_[A-Za-z0-9._~+/=-]{8,}\b/g, "<redacted>");
}


/** Outcome facts supplied by the operation that observed them. Diagnostic prose
 * is never an outcome record. Missing facts remain unverified. */
export type CliOperationalRecovery = {
  state_preserved?: string;
  source_database_changed?: boolean | null;
  next_action?: string;
};

function operationalRecovery(error: unknown): CliOperationalRecovery | undefined {
  if (!(error instanceof Error)) return undefined;
  const recovery = (error as Error & { recovery?: unknown }).recovery;
  if (!isRecord(recovery)) return undefined;
  return {
    ...(typeof recovery.state_preserved === "string" && recovery.state_preserved.trim()
      ? { state_preserved: redactCliErrorMessage(recovery.state_preserved) } : {}),
    ...(typeof recovery.source_database_changed === "boolean"
      ? { source_database_changed: recovery.source_database_changed } : {}),
    ...(typeof recovery.next_action === "string" && recovery.next_action.trim()
      ? { next_action: redactCliErrorMessage(recovery.next_action) } : {}),
  };
}

export function errorStatePreserved(error: unknown): string {
  return operationalRecovery(error)?.state_preserved
    ?? "Durable state was not verified; inspect it before retrying.";
}

export function errorSourceDatabaseChanged(error: unknown): boolean | null {
  return operationalRecovery(error)?.source_database_changed ?? null;
}

export function errorNextAction(error: unknown, argv: string[]): string {
  const explicit = operationalRecovery(error)?.next_action;
  if (explicit) return explicit;
  const normalized = normalizeCliArgv(argv);
  const command = normalized
    .slice(0, 2)
    .filter((part) => part && !part.startsWith("-"))
    .join(" ");
  return `Run ${cliCommandName()}${command ? ` ${command}` : ""} --help.`;
}


export function formatCliErrorHint(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (typeof code === "string" && [
    "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID",
  ].includes(code)) {
    return [
      "", "", "Hint:",
      "  TLS certificate verification failed.",
      "  Inspect the certificate chain, hostname and configured CA bundle; keep certificate verification enabled.",
    ].join("\n");
  }
  return "";
}

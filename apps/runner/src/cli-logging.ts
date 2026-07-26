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


export function errorStatePreserved(message: string): string {
  const match = message.match(/State preserved:\s*([^]*?)(?=\s+Next:|$)/i);
  if (match?.[1]?.trim()) return match[1].trim().replace(/\s+/g, " ");
  return "The command stopped without discarding existing durable state; inspect that state before retrying.";
}


export function errorSourceDatabaseChanged(message: string): false | null {
  return /(?:source database|database)(?:\s+were|\s+was|\s+is)?\s+(?:not changed|unchanged)|no source row was changed/i.test(message)
    ? false
    : null;
}


export function errorNextAction(message: string, argv: string[]): string {
  const explicit = message.match(/\bNext:\s*([^\n]+)/i)?.[1]?.trim();
  if (explicit) return explicit;
  const normalized = normalizeCliArgv(argv);
  const command = normalized
    .slice(0, 2)
    .filter((part) => part && !part.startsWith("-"))
    .join(" ");
  return `Run ${cliCommandName()}${command ? ` ${command}` : ""} --help.`;
}


export function formatCliErrorHint(message: string): string {
  if (/self-signed certificate|certificate.*chain|unable to verify/i.test(message)) {
    return [
      "",
      "",
      "Hint:",
      "  The database is reachable, but TLS certificate verification failed.",
      "  For disposable local/dev RDS tests, use sslmode=no-verify in the URL.",
      "  For real staging/production-like testing, install the database CA bundle and keep certificate verification enabled.",
    ].join("\n");
  }
  return "";
}

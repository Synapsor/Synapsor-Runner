import process from "node:process";

export const runtimeStoreBridgeFlag = "--runtime-store-bridge";


export function normalizeCliArgv(argv: string[]): string[] {
  const [first, ...rest] = argv;
  if (first === "synapsor-runner" || first === "synapsor") return rest;
  return argv;
}


export function positiveIntegerOption(args: string[], name: string): number | undefined {
  const raw = optionalArg(args, name);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}


export function listArg(args: string[], flag: string): string[] | undefined {
  const value = optionalArg(args, flag);
  if (!value) return undefined;
  return uniqueStrings(value.split(",").map((item) => item.trim()).filter(Boolean));
}


export function repeatedArgs(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) values.push(String(args[index + 1]));
  }
  return values;
}


export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}


export function requiredOption(args: string[], flag: string, command: string): string {
  const value = optionalArg(args, flag)?.trim();
  if (!value) throw new Error(`${command} requires ${flag} <value>`);
  return value;
}


export function positiveIntOption(args: string[], flag: string, fallback: number, minimum: number, maximum: number): number {
  const raw = optionalArg(args, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`);
  return value;
}


export async function waitFor(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}


export function assertKnownOptions(args: string[], allowed: Set<string>, commandName: string): void {
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const option = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (option === "--help" || option === "-h") continue;
    if (!allowed.has(option)) throw new Error(`Unknown option for ${commandName}: ${option}`);
  }
}


export function optionalPositiveIntegerArg(args: string[], flag: string): number | undefined {
  const value = optionalArg(args, flag);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}


export function optionalNonNegativeIntegerArg(args: string[], flag: string): number | undefined {
  return optionalPositiveIntegerArg(args, flag);
}


export function optionalNonNegativeIntegerEnv(name: string): number | undefined {
  const value = envValue(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}


export function envValue(name: string | undefined): string | undefined;

export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined;

export function envValue(first: NodeJS.ProcessEnv | string | undefined, second?: string): string | undefined {
  if (typeof first === "string" || first === undefined) {
    if (!first) return undefined;
    return trimmedEnvValue(process.env, first);
  }
  if (!second) return undefined;
  return trimmedEnvValue(first, second);
}


export function trimmedEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}


export function objectFilterFromArgs(args: string[]): { type?: string; id?: string } {
  const value = optionalArg(args, "--object");
  if (!value) return {};
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("--object must use type:id, for example invoice:INV-3001");
  }
  return { type: value.slice(0, separator), id: value.slice(separator + 1) };
}


export function limitFromArgs(args: string[]): number {
  const value = optionalArg(args, "--limit");
  if (!value) return 20;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--limit must be a positive integer");
  return Math.min(parsed, 200);
}


export function exportFormat(args: string[], supported = ["json", "markdown"]): "json" | "markdown" {
  const format = optionalArg(args, "--format") ?? "json";
  if (!supported.includes(format)) {
    throw new Error(`unsupported export format: ${format}. Supported formats: ${supported.join(", ")}`);
  }
  return format as "json" | "markdown";
}


export function optionalArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}


export function outputArg(args: string[]): string | undefined {
  return optionalArg(args, "--output") ?? optionalArg(args, "--out");
}


export function firstDatabaseUrlPositional(args: string[]): string | undefined {
  const positionalValue = firstPositional(args);
  return positionalValue && isDatabaseUrl(positionalValue) ? positionalValue : undefined;
}


export function isDatabaseUrl(value: string): boolean {
  return /^(postgres(?:ql)?:\/\/|mysql:\/\/)/i.test(value);
}


export function firstPositional(args: string[]): string | undefined {
  const flagsWithValues = new Set([
    "--allowed-columns",
    "--approval-role",
    "--api-url",
    "--actor",
    "--action",
    "--auth-token-env",
    "--client-access-token-env",
    "--previous-auth-token-env",
    "--audit",
    "--bearer-env",
    "--capability",
    "--config",
    "--contract",
    "--conflict-column",
    "--cors-origin",
    "--database-url-env",
    "--description",
    "--destination",
    "--engine",
    "--evidence",
    "--example",
    "--fail-on",
    "--format",
    "--from",
    "--from-env",
    "--url-env",
    "--host",
    "--idempotency-key",
    "--input",
    "--job",
    "--lease-seconds",
    "--limit",
    "--lookup-arg",
    "--mode",
    "--mcp-config",
    "--live-server",
    "--namespace",
    "--numeric-bound",
    "--now",
    "--object",
    "--object-id",
    "--object-type",
    "--tls-cert-env",
    "--tls-key-env",
    "--tls-ca-env",
    "--object-name",
    "--older-than",
    "--output",
    "--out",
    "--patch-fixed",
    "--patch-from-arg",
    "--port",
    "--primary-key",
    "--principal-env",
    "--principal",
    "--policy",
    "--proposal",
    "--public-key",
    "--project",
    "--query-fingerprint",
    "--reason",
    "--recipe",
    "--receipt",
    "--read-tool",
    "--inspect-tool-name",
    "--proposal-tool",
    "--proposal-tool-name",
    "--replay",
    "--runner",
    "--schema",
    "--signing-key",
    "--source-name",
    "--source",
    "--state",
    "--status",
    "--stdio",
    "--store",
    "--shared-ledger-schema",
    "--shared-ledger-lock-timeout-ms",
    "--shared-ledger-url-env",
    "--table",
    "--tenant",
    "--tenant-env",
    "--tenant-key",
    "--tests",
    "--timeout-ms",
    "--token",
    "--to",
    "--transition-guard",
    "--url",
    "--visible-columns",
    "--workspace",
    "--writeback-job",
    "--write-url-env",
    "--key-id",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      if (flagsWithValues.has(arg)) index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}


export function positional(args: string[], index: number): string | undefined {
  return args.filter((arg, argIndex) => {
    if (arg.startsWith("--")) return false;
    const previous = args[argIndex - 1];
    return previous === undefined || !previous.startsWith("--");
  })[index];
}


export function splitCommand(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "" = "";
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("unterminated quote in stdio command");
  if (current) parts.push(current);
  return parts;
}


export function parseJsonRpcResponse(stdout: string, id: number): unknown | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { id?: unknown };
      if (parsed.id === id) return parsed;
    } catch {
      // Ignore non-JSON log lines emitted by MCP servers.
    }
  }
  return undefined;
}

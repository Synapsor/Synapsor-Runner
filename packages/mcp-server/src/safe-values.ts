import crypto from "node:crypto";
import type {
  Scalar,
  RuntimeCapabilityConfig,
} from "./runtime-types.js";

export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function valueFromEnvOrLiteral(envName: unknown, literal: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof envName === "string") {
    const value = envValue(env, envName);
    if (value) return value;
  }
  if (typeof literal !== "string") return undefined;
  const value = literal.trim();
  return value.length > 0 ? value : undefined;
}

export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function scalarRecord(row: Record<string, unknown>): Record<string, Scalar> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, scalar(value)]));
}

export function visibleScalarRecord(capability: RuntimeCapabilityConfig, row: Record<string, unknown>): Record<string, Scalar> {
  const visible = new Set(capability.visible_columns);
  return Object.fromEntries(Object.entries(row).filter(([column]) => visible.has(column)).map(([key, value]) => [key, scalar(value)]));
}

export function withoutPrincipalScopeValue<T extends { value?: unknown }>(scope: T): Omit<T, "value"> {
  const { value: _value, ...metadata } = scope;
  return metadata;
}

export function scalar(value: unknown): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  return String(value);
}

export function conflictGuardScalar(value: Scalar): Scalar {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (/^-?(?:0|[1-9]\d*)$/.test(trimmed)) {
    const integer = Number(trimmed);
    if (Number.isSafeInteger(integer)) return integer;
  }
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i);
  if (!match) return value;
  const fraction = (match[3] ?? "").padEnd(6, "0").slice(0, 6);
  return `${match[1]} ${match[2]}.${fraction}${match[4] ?? ""}`;
}

export function stableId(prefix: string, input: unknown): string {
  return `${prefix}_${crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 20)}`;
}

export function hashJson(input: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

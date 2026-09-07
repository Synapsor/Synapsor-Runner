import { canonicalJsonStringify } from "@synapsor-runner/protocol";
import { ProposalStoreError } from "./errors.js";
import type { ControlPolicyKind, ControlPolicyScope } from "./control-policy-types.js";

export function scopeKey(scope: ControlPolicyScope): string {
  if (!scope || typeof scope !== "object") fail("POLICY_SCOPE_INVALID");
  const keys = Object.keys(scope).sort().join(",");
  if (scope.level === "operator" && keys === "level") return canonicalJsonStringify(scope);
  if (scope.level === "tenant" && keys === "level,tenant_id") {
    identifier(scope.tenant_id); return canonicalJsonStringify(scope);
  }
  if (scope.level === "principal" && keys === "level,principal,tenant_id") {
    identifier(scope.tenant_id); identifier(scope.principal); return canonicalJsonStringify(scope);
  }
  return fail("POLICY_SCOPE_INVALID");
}

export function policyKind(value: unknown): ControlPolicyKind {
  if (typeof value !== "string" || !["read", "action", "execution", "parent", "delegation", "management"].includes(value)) fail("POLICY_KIND_INVALID");
  return value as ControlPolicyKind;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail("POLICY_IDENTIFIER_INVALID");
  return value;
}
export function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail("POLICY_DIGEST_INVALID");
  return value;
}
export function epoch(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) fail("POLICY_EPOCH_INVALID");
  return number;
}
export function boundedJson(value: unknown, limit: number): string {
  const json = canonicalJsonStringify(value);
  if (Buffer.byteLength(json) > limit) fail("POLICY_CONTENT_TOO_LARGE");
  return json;
}
export function exactlyOne(rows: unknown[]): void { if (rows.length !== 1) fail("POLICY_REPOSITORY_UNAVAILABLE"); }
export function fail(code: string): never { throw new ProposalStoreError(code, code); }

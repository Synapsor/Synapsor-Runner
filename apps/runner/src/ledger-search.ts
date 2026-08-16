import type {
  EvidenceSearchFilters,
  QueryAuditSearchFilters,
} from "@synapsor-runner/proposal-store";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { optionalArg } from "./cli-options.js";
import {
  activeProjectResolutionState,
  optionalRuntimeConfig,
  runnerConfigPath,
} from "./cli-project.js";

type ExploreLedgerFilters = EvidenceSearchFilters | QueryAuditSearchFilters;

export type ResolvedLedgerFilters<T extends ExploreLedgerFilters> = {
  filters: T;
  notes: string[];
};

export async function resolveExploreLedgerFilters<T extends ExploreLedgerFilters>(
  args: string[],
  filters: T,
): Promise<ResolvedLedgerFilters<T>> {
  const tenant = ledgerOptionValue(args, "--tenant");
  const principal = ledgerOptionValue(args, "--principal");
  if (!tenant && !principal) return { filters, notes: [] };

  const keyResolution = await ledgerScopeHmacKeys(args);
  const keys = keyResolution.keys;
  const notes: string[] = [];
  const resolved = { ...filters };
  if (tenant) {
    resolved.tenants = scopeFilterCandidates("--tenant", tenant, keys);
    delete resolved.tenant;
  }
  if (principal) {
    resolved.principals = scopeFilterCandidates("--principal", principal, keys);
    delete resolved.principal;
    notes.push(
      "Principal lookup applies to Explore audit records created with keyed principal metadata. Older records that only recorded principal_bound cannot be attributed retroactively.",
    );
  }
  if (keys.length === 0
    && !keyResolution.productionKeyEnv
    && [tenant, principal].some((value) => value && !value.startsWith("keyed:"))) {
    notes.push(
      "No Explore audit HMAC key was available, so plaintext scope filters can match plaintext ledger records only. Set the configured HMAC environment value or use keyed:<fingerprint> for keyed Explore records.",
    );
  }
  if (keyResolution.productionKeyEnv
    && !keyResolution.productionKeyAvailable
    && [tenant, principal].some((value) => value && !value.startsWith("keyed:"))) {
    notes.push(
      `${keyResolution.productionKeyEnv} is not set, so plaintext scope lookup cannot derive current production Explore fingerprints. Set that configured environment variable or use keyed:<fingerprint>.`,
    );
  }
  return { filters: resolved as T, notes };
}

export function ledgerResourceFromArgs(args: string[]): string | undefined {
  const table = ledgerOptionValue(args, "--table");
  const resource = ledgerOptionValue(args, "--resource");
  if (table && resource && table !== resource) {
    throw new Error(`--table and --resource select different resources (${table} and ${resource})`);
  }
  return resource || table;
}

export function ledgerOutcomeFromArgs(args: string[]): "ok" | "refused" | "failed" | undefined {
  const outcome = ledgerOptionValue(args, "--outcome")?.toLowerCase();
  if (!outcome) return undefined;
  if (optionalArg(args, "--status")) throw new Error("Use either --outcome or --status, not both");
  if (outcome === "ok" || outcome === "success" || outcome === "released") return "ok";
  if (outcome === "refused" || outcome === "failed") return outcome;
  throw new Error("--outcome must be ok, refused, or failed");
}

export function ledgerTimeRangeFromArgs(args: string[], now = Date.now()): { from?: string; to?: string } {
  const explicitFrom = ledgerOptionValue(args, "--from");
  const since = ledgerOptionValue(args, "--since");
  const to = ledgerOptionValue(args, "--to");
  if (explicitFrom && since) throw new Error("Use either --from or --since, not both");
  const from = explicitFrom
    ? isoTimestamp(explicitFrom, "--from")
    : since
      ? relativeOrIsoTimestamp(since, "--since", now)
      : undefined;
  const range = {
    ...(from ? { from } : {}),
    ...(to ? { to: isoTimestamp(to, "--to") } : {}),
  };
  if (range.from && range.to && Date.parse(range.from) > Date.parse(range.to)) {
    throw new Error("The ledger time range is invalid: --from/--since must be earlier than or equal to --to");
  }
  return range;
}

export function ledgerBoundaryFromArgs(args: string[]): string | undefined {
  const boundary = ledgerOptionValue(args, "--boundary");
  if (!boundary) return undefined;
  if (!/^sha256:[a-f0-9]{64}$/i.test(boundary)) {
    throw new Error("--boundary must be an exact sha256:<64 hexadecimal characters> boundary digest");
  }
  return boundary.toLowerCase();
}

function relativeOrIsoTimestamp(value: string, flag: string, now: number): string {
  const duration = value.match(/^(\d+)([smhd])$/i);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2]!.toLowerCase();
    const multiplier = unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
    return new Date(now - amount * multiplier).toISOString();
  }
  return isoTimestamp(value, flag);
}

function isoTimestamp(value: string, flag: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${flag} must be an ISO timestamp${flag === "--since" ? " or a duration such as 24h, 30m, or 7d" : ""}`);
  }
  return new Date(value).toISOString();
}

function scopeFilterCandidates(flag: string, value: string, keys: Buffer[]): string[] {
  if (value.startsWith("keyed:")) {
    if (!/^keyed:[a-f0-9]{64}$/i.test(value)) {
      throw new Error(`${flag} keyed fingerprints must use keyed: followed by 64 hexadecimal characters`);
    }
    return [value.toLowerCase()];
  }
  return [
    value,
    ...keys.map((key) => `keyed:${crypto.createHmac("sha256", key).update(value).digest("hex")}`),
  ].filter((candidate, index, values) => values.indexOf(candidate) === index);
}

async function ledgerScopeHmacKeys(args: string[]): Promise<{
  keys: Buffer[];
  productionKeyEnv?: string;
  productionKeyAvailable: boolean;
}> {
  const configPath = path.resolve(runnerConfigPath(args));
  const config = await optionalRuntimeConfig(configPath);
  const roots = new Set<string>([
    process.cwd(),
    path.dirname(configPath),
    ...(activeProjectResolutionState.current?.project_root
      ? [activeProjectResolutionState.current.project_root]
      : []),
    ...(config?.production_explore?.project_root
      ? [config.production_explore.project_root]
      : []),
  ].map((root) => path.resolve(root)));
  const keys: Buffer[] = [];
  for (const root of roots) {
    try {
      const encoded = (await fs.readFile(path.join(root, ".synapsor/explore-audit.key"), "utf8")).trim();
      const key = Buffer.from(encoded, "base64url");
      if (key.byteLength === 32) keys.push(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const productionKeyEnv = config?.production_explore?.budget_hmac_key_env;
  const productionKey = productionKeyEnv ? process.env[productionKeyEnv]?.trim() : undefined;
  const productionKeyAvailable = Boolean(
    productionKey && Buffer.byteLength(productionKey, "utf8") >= 32,
  );
  if (productionKeyAvailable && productionKey) {
    keys.push(Buffer.from(productionKey, "utf8"));
  }
  return {
    keys: keys.filter((key, index) =>
      keys.findIndex((candidate) => candidate.equals(key)) === index),
    ...(productionKeyEnv ? { productionKeyEnv } : {}),
    productionKeyAvailable,
  };
}

function ledgerOptionValue(args: string[], flag: string): string | undefined {
  if (!args.includes(flag)) return undefined;
  const value = optionalArg(args, flag)?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

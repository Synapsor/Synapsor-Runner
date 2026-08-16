import crypto from "node:crypto";
import type { EvidenceSearchFilters } from "@synapsor-runner/proposal-store";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ledgerBoundaryFromArgs,
  ledgerOutcomeFromArgs,
  ledgerResourceFromArgs,
  ledgerTimeRangeFromArgs,
  resolveExploreLedgerFilters,
} from "./ledger-search.js";

describe("Explore ledger search", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("expands plaintext scope values to local keyed fingerprints without persisting the plaintext", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ledger-search-"));
    const key = crypto.randomBytes(32);
    await fs.mkdir(path.join(root, ".synapsor"), { recursive: true });
    await fs.writeFile(path.join(root, ".synapsor/explore-audit.key"), key.toString("base64url"));
    try {
      const resolved = await resolveExploreLedgerFilters<EvidenceSearchFilters>([
        "--config", path.join(root, "synapsor.runner.json"),
        "--tenant", "northgate",
        "--principal", "librarian@example.org",
      ], {
        tenant: "northgate",
        principal: "librarian@example.org",
      });
      expect(resolved.filters.tenants).toEqual([
        "northgate",
        `keyed:${crypto.createHmac("sha256", key).update("northgate").digest("hex")}`,
      ]);
      expect(resolved.filters.principals).toEqual([
        "librarian@example.org",
        `keyed:${crypto.createHmac("sha256", key).update("librarian@example.org").digest("hex")}`,
      ]);
      expect(resolved.notes).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed before applying plaintext production filters when the configured HMAC key is unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ledger-search-production-"));
    const configPath = path.join(root, "synapsor.runner.json");
    const keyedTenant = `keyed:${"a".repeat(64)}`;
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: {
        sqlite_path: "./.synapsor/local.db",
        shared_postgres: {
          mode: "runtime_store",
          url_env: "SYNAPSOR_CONTROL_DATABASE_URL",
        },
      },
      sources: {
        analytics: { engine: "postgres", read_url_env: "DATABASE_URL" },
      },
      trusted_context: { provider: "http_claims" },
      session_auth: {
        provider: "jwt_asymmetric",
        algorithms: ["RS256"],
        jwks_url_env: "SYNAPSOR_SESSION_JWKS_URL",
        issuer: "https://identity.example",
        audience: "https://runner.example/mcp",
        tenant_claim: "tenant_id",
        principal_claim: "sub",
      },
      http_security: {
        deployment: "shared",
        channel: "trusted_tls_proxy",
        oauth_resource: {
          resource: "https://runner.example/mcp",
          authorization_servers: ["https://identity.example"],
          scopes_supported: ["synapsor.explore"],
          required_scopes: ["synapsor.explore"],
        },
        allowed_hosts: ["runner.example"],
      },
      production_explore: {
        enabled: true,
        project_root: root,
        required_oauth_scope: "synapsor.explore",
        budget_hmac_key_env: "SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY",
        accounting_namespace: "test.production",
        tenant_limits: {
          max_queries_per_rolling_24_hours: 1_000,
          max_extracted_cells_per_rolling_24_hours: 100_000,
          max_differencing_queries_per_rolling_24_hours: 100,
          requests_per_minute: 120,
          max_response_cells_per_response: 500,
        },
      },
    }, null, 2));
    vi.stubEnv("SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY", "");
    try {
      await expect(resolveExploreLedgerFilters<EvidenceSearchFilters>([
        "--config", configPath,
        "--tenant", "northgate",
      ], { tenant: "northgate" })).rejects.toThrow(
        /Cannot apply.*--tenant.*SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY.*No ledger records were returned/,
      );

      const keyed = await resolveExploreLedgerFilters<EvidenceSearchFilters>([
        "--config", configPath,
        "--tenant", keyedTenant,
      ], { tenant: keyedTenant });
      expect(keyed.filters.tenants).toEqual([keyedTenant]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("validates outcome, resource aliases, boundary digests, and relative time", () => {
    const now = Date.parse("2026-08-15T12:00:00.000Z");
    expect(ledgerOutcomeFromArgs(["--outcome", "success"])).toBe("ok");
    expect(ledgerResourceFromArgs(["--resource", "librarydb.members"])).toBe("librarydb.members");
    expect(ledgerBoundaryFromArgs(["--boundary", `sha256:${"a".repeat(64)}`])).toBe(`sha256:${"a".repeat(64)}`);
    expect(ledgerTimeRangeFromArgs(["--since", "24h"], now)).toEqual({
      from: "2026-08-14T12:00:00.000Z",
    });
    expect(() => ledgerResourceFromArgs(["--table", "public.a", "--resource", "public.b"])).toThrow(/different resources/);
    expect(() => ledgerOutcomeFromArgs(["--outcome", "maybe"])).toThrow(/ok, refused, or failed/);
    expect(() => ledgerBoundaryFromArgs(["--boundary", "old-boundary"])).toThrow(/exact sha256/);
    expect(() => ledgerTimeRangeFromArgs(["--since", "24h", "--from", "2026-08-01T00:00:00Z"], now)).toThrow(/either --from or --since/);
    expect(() => ledgerTimeRangeFromArgs([
      "--from", "2026-08-15T00:00:00Z",
      "--to", "2026-08-14T00:00:00Z",
    ], now)).toThrow(/must be earlier than or equal/);
  });
});

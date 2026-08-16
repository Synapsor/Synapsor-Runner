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
  afterEach(() => vi.restoreAllMocks());

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
      expect(resolved.notes.join(" ")).toMatch(/Older records/);
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

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, protocolVersions, type ChangeSetV1 } from "@synapsor-runner/protocol";
import {
  buildLocalActivationReport,
  formatLocalActivationReport,
  recordOwnDataActivationTiming,
} from "./activation-report.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("local activation report", () => {
  it("combines owned local evidence without exporting project or business identifiers", async () => {
    const root = await temporaryDirectory();
    await fs.mkdir(path.join(root, ".synapsor/try"), { recursive: true });
    await fs.writeFile(path.join(root, ".synapsor/try/activation.json"), JSON.stringify({
      schema_version: "synapsor.try-activation.v1",
      completed_at: "2026-07-20T10:00:01.000Z",
      product_activation_ms: 900,
    }));
    await fs.mkdir(path.join(root, ".synapsor"), { recursive: true });
    await fs.writeFile(path.join(root, ".synapsor/onboarding.json"), JSON.stringify({
      schema_version: "synapsor.onboarding.v1",
      generated_at: "2026-07-20T10:01:00.000Z",
      source: { table: "secret_customers" },
      activation: {
        own_data_started_at: "2026-07-20T10:00:30.000Z",
        own_data_ready_at: "2026-07-20T10:01:00.000Z",
        product_activation_ms: 30_000,
      },
    }));
    await fs.writeFile(path.join(root, ".synapsor/cursor-project.json"), JSON.stringify({
      schema_version: "synapsor.cursor-project.v1",
      installed_at: "2026-07-20T10:01:10.000Z",
      config_path: "/private/project/synapsor.runner.json",
    }));

    const storePath = path.join(root, ".synapsor/local.db");
    const store = new ProposalStore(storePath);
    try {
      store.recordQueryAudit({
        source_id: "private_source",
        query_fingerprint: canonicalJsonDigest({ query: "private" }),
        table_name: "public.secret_customers",
        row_count: 1,
        payload: { tenant_id: "private_tenant", capability: "private.inspect_customer" },
      });
      store.createProposal(proposal("2026-07-20T10:01:20.000Z"));
    } finally {
      store.close();
    }

    const report = await buildLocalActivationReport({
      projectRoot: root,
      storePath: ".synapsor/local.db",
      now: "2026-07-20T10:02:00.000Z",
    });
    expect(report).toMatchObject({ local_only: true, telemetry_transmitted: false, completed: 6, pending: 0 });
    expect(report.milestones.find((item) => item.name === "try_proof")?.elapsed_ms).toBe(900);
    expect(report.milestones.find((item) => item.name === "own_data_ready")?.elapsed_ms).toBe(30_000);
    expect(report.milestones.find((item) => item.name === "cursor_configured")?.elapsed_ms).toBe(40_000);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/secret_customers|private_source|private_tenant|\/private\/project/);
    expect(formatLocalActivationReport(report)).toContain("6 complete; 0 pending");
  });

  it("records only timing metadata in the existing onboarding manifest", async () => {
    const root = await temporaryDirectory();
    const manifestPath = path.join(root, ".synapsor/onboarding.json");
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, `${JSON.stringify({ schema_version: "synapsor.onboarding.v1", source: { table: "invoices" } })}\n`);
    await recordOwnDataActivationTiming({
      manifestPath,
      startedAt: "2026-07-20T10:00:00.000Z",
      completedAt: "2026-07-20T10:00:02.500Z",
    });
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    expect(parsed.activation).toMatchObject({ product_activation_ms: 2500 });
    expect(parsed.source.table).toBe("invoices");
  });

  it("keeps absent milestones pending without creating a ledger", async () => {
    const root = await temporaryDirectory();
    const report = await buildLocalActivationReport({ projectRoot: root, storePath: ".synapsor/local.db" });
    expect(report).toMatchObject({ completed: 0, pending: 6 });
    await expect(fs.access(path.join(root, ".synapsor/local.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function proposal(createdAt: string): ChangeSetV1 {
  const base = {
    schema_version: protocolVersions.changeSet,
    proposal_id: "wrp_activation_fixture",
    proposal_version: 1,
    action: "billing.propose_waiver",
    mode: "review_required" as const,
    principal: { id: "fixture", source: "trusted_session" as const },
    scope: { tenant_id: "fixture", business_object: "invoice", object_id: "INV-1" },
    source: {
      kind: "external_postgres" as const,
      source_id: "fixture",
      schema: "public",
      table: "invoices",
      primary_key: { column: "id", value: "INV-1" },
    },
    before: { id: "INV-1", amount: 10, version: 1 },
    patch: { amount: 0 },
    after: { id: "INV-1", amount: 0, version: 1 },
    guards: {
      tenant: { column: "tenant_id", value: "fixture" },
      allowed_columns: ["amount"],
      expected_version: { column: "version", value: 1 },
    },
    evidence: { bundle_id: "ev_fixture", query_fingerprint: `sha256:${crypto.createHash("sha256").update("fixture").digest("hex")}` as const, items: [] },
    approval: { status: "pending" as const, required_role: "reviewer" },
    writeback: { status: "not_applied" as const, mode: "trusted_worker_required" as const },
    source_database_mutated: false,
    created_at: createdAt,
  };
  return { ...base, integrity: { proposal_hash: canonicalJsonDigest(base) } };
}

async function temporaryDirectory(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-activation-report-"));
  temporaryDirectories.push(value);
  return value;
}

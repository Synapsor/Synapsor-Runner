import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import {
  READ_WORKLOAD_ANALYSIS_VERSION,
  type ReadWorkloadAnalysis,
} from "./read-workload-assist.js";
import {
  listReadWorkloadAnalyses,
  readReadWorkloadAnalysis,
  recordReadWorkloadReview,
  storeReadWorkloadAnalysis,
} from "./read-workloads.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("stored read workload analyses", () => {
  it("stores immutable sanitized analysis metadata without granting authority", async () => {
    const projectRoot = await temporaryProject();
    const boundary = generatedBoundary("a");
    const first = await storeReadWorkloadAnalysis({
      projectRoot,
      generatedBoundary: boundary,
      source: { kind: "operator_exact_plan" },
      analysis: analysis(),
      now: "2026-08-27T00:00:00.000Z",
    });
    const second = await storeReadWorkloadAnalysis({
      projectRoot,
      generatedBoundary: boundary,
      source: { kind: "operator_exact_plan" },
      analysis: analysis(),
      now: "2026-08-27T00:01:00.000Z",
    });

    expect(first.state).toBe("ready");
    expect(second.analysis_id).toBe(first.analysis_id);
    expect(first).toMatchObject({
      authority_granted: false,
      source_query_executed: false,
      explore_budget_consumed: false,
      source_database_changed: false,
    });
    const stored = await fs.readFile(
      path.join(projectRoot, ".synapsor/read-workloads", `${first.analysis_id}.json`),
      "utf8",
    );
    expect(stored).toContain('"redacted": true');
    expect(stored).not.toContain("customer-private-value");
    await expect(listReadWorkloadAnalyses({ projectRoot, generatedBoundary: boundary }))
      .resolves.toHaveLength(1);
  });

  it("marks records stale when generated authority changes", async () => {
    const projectRoot = await temporaryProject();
    const stored = await storeReadWorkloadAnalysis({
      projectRoot,
      generatedBoundary: generatedBoundary("a"),
      source: { kind: "operator_exact_plan" },
      analysis: analysis(),
    });
    const current = await readReadWorkloadAnalysis({
      projectRoot,
      analysisId: stored.analysis_id,
      generatedBoundary: generatedBoundary("b"),
    });
    expect(current.state).toBe("stale");
    expect(current.stale_reason).toContain("generated boundary changed");
  });

  it("records only a disabled review result bound to the exact candidate digest", async () => {
    const projectRoot = await temporaryProject();
    const stored = await storeReadWorkloadAnalysis({
      projectRoot,
      generatedBoundary: generatedBoundary("a"),
      source: { kind: "operator_exact_plan" },
      analysis: analysis(),
    });
    const review = await recordReadWorkloadReview({
      projectRoot,
      workload: stored,
      candidateDigest: analysis().candidate_digest!,
      reviewRevision: 2,
      now: "2026-08-27T00:02:00.000Z",
    });
    expect(review).toMatchObject({ authority_activated: false, source_database_changed: false });
    const reread = await readReadWorkloadAnalysis({
      projectRoot,
      analysisId: stored.analysis_id,
      generatedBoundary: generatedBoundary("a"),
    });
    expect(reread.state).toBe("reviewed");
  });
});

async function temporaryProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-read-workloads-"));
  roots.push(root);
  return root;
}

function analysis(): ReadWorkloadAnalysis {
  return {
    schema_version: READ_WORKLOAD_ANALYSIS_VERSION,
    workload_digest: `sha256:${"1".repeat(64)}`,
    workload_name: "support",
    status: "ready",
    allowed: [{
      id: "ticket_status",
      description: "Read ticket status",
      status: "supported",
      normalized_plan_digest: `sha256:${"2".repeat(64)}`,
      plan_shape: {
        kind: "rows",
        resource: "public.tickets",
        where: [{ field: "id", op: "eq", value: { redacted: true, kind: "scalar", type: "string" } }],
      },
      authority_atoms: [],
    }],
    forbidden: [],
    authority_atoms: [],
    candidate_digest: `sha256:${"3".repeat(64)}`,
    coverage: { allowed_supported: 1, allowed_total: 1, forbidden_denied: 0, forbidden_total: 0 },
    exposure: {
      generated_resources: 1,
      candidate_resources: 1,
      generated_fields: 2,
      candidate_return_fields: 1,
      candidate_operation_fields: 1,
      candidate_relationships: 0,
    },
    blockers: [],
    authority_granted: false,
    source_query_executed: false,
    explore_budget_consumed: false,
    source_database_changed: false,
  };
}
function generatedBoundary(seed: string): ExplorationBoundaryDraft {
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "staging",
    source: "local_postgres",
    compiler_version: "1.7.0",
    spec_version: "1.9.0",
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL_ID",
    },
    generation_lock_fingerprint: `sha256:${seed.repeat(64).slice(0, 64)}`,
    role_posture_fingerprint: `sha256:${"9".repeat(64)}`,
    pack: { name: "reviewed_staging", resources: [] },
    budgets: {} as never,
    unresolved_decisions: [],
  };
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { describe, expect, it } from "vitest";
import type { AutoBoundaryBuild } from "./auto-boundary.js";
import {
  initializeGuidedProject,
  preflightGuidedProjectInitialization,
  readGuidedOnboardingState,
  updateGuidedOnboardingState,
} from "./guided-project.js";

function buildFixture(): Pick<AutoBoundaryBuild, "graph" | "lock" | "exploration_boundary" | "review"> {
  const digest = `sha256:${"1".repeat(64)}` as const;
  return {
    graph: {
      schema_version: "synapsor.auto-boundary.v1",
      engine: "postgres",
      database_role: {
        name: "fitflow_reader",
        verified: true,
        read_only: true,
        superuser: false,
        bypass_rls: false,
        fingerprint: digest,
      },
      project: { frameworks: ["nextjs", "prisma"], schema_inputs: [] },
      resources: [],
      structured_actions: [],
      warnings: [],
    },
    lock: {
      schema_version: "synapsor.generation-lock.v1",
      compiler_version: "1.6.3",
      spec_version: "1.6.0",
      engine: "postgres",
      source_env: "DATABASE_URL",
      schema_fingerprint: digest,
      role_posture_fingerprint: digest,
      evidence_fingerprint: digest,
      generated_contract_digest: digest,
      reviewed_overrides_digest: digest,
      protected_authority: ["public.members"],
    },
    exploration_boundary: {
      schema_version: "synapsor.exploration-boundary.v1",
      activation: "disabled_unreviewed",
      deployment_profile: "staging",
      source: "local_postgres",
      compiler_version: "1.6.3",
      spec_version: "1.6.0",
      trusted_context: {
        provider: "environment",
        tenant_env: "SYNAPSOR_TENANT_ID",
        principal_env: "SYNAPSOR_PRINCIPAL",
      },
      generation_lock_fingerprint: digest,
      role_posture_fingerprint: digest,
      pack: { name: "fitflow", resources: [] },
      budgets: {
        max_rows: 50,
        max_groups: 50,
        max_top_n: 25,
        max_measures: 3,
        max_dimensions: 3,
        max_time_ranges: 2,
        max_relationship_hops: 1,
        max_response_cells: 500,
        max_response_bytes: 65536,
        statement_timeout_ms: 3000,
        max_complexity: 24,
        max_queries_per_session: 40,
        max_extracted_cells_per_session: 4000,
        max_differencing_queries: 6,
        rate_limit_per_minute: 20,
      },
      unresolved_decisions: ["confirm scope"],
    },
    review: {
      schema_version: "synapsor.auto-boundary.v1",
      activation: "blocked_unreviewed",
      engine: "postgres",
      database_role: {
        name: "fitflow_reader",
        verified: true,
        read_only: true,
        superuser: false,
        bypass_rls: false,
        fingerprint: digest,
      },
      warnings: [],
      summary: {
        objects: 1,
        draft_reads: 1,
        blocked_objects: 0,
        sensitive_fields_kept_out: 2,
        rls_policies: 1,
        structured_write_candidates: 0,
      },
      unresolved_decisions: ["confirm scope"],
      resources: [],
      structured_actions: [],
    },
  };
}

describe("guided onboarding project", () => {
  it("creates a valid zero-authority project and resumes without rewriting it", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-guided-project-"));
    try {
      await fs.mkdir(path.join(projectRoot, ".synapsor"), { recursive: true });
      await fs.writeFile(path.join(projectRoot, ".synapsor/generation-lock.json"), "{}\n");
      const first = await initializeGuidedProject({
        projectRoot,
        build: buildFixture(),
        runnerVersion: "1.6.3",
        now: "2026-07-24T17:00:00.000Z",
      });
      expect(first.created).toBe(true);
      const config = JSON.parse(await fs.readFile(first.config_path, "utf8"));
      const validation = validateRunnerCapabilityConfig(config);
      expect(validation.ok).toBe(true);
      expect(validation.warnings.map((issue) => issue.code)).toContain("AUTHORING_PROJECT_HAS_NO_ACTIVE_CAPABILITIES");
      expect(config.capabilities).toEqual([]);
      expect(config.sources.local_postgres.read_url_env).toBe("DATABASE_URL");
      expect(JSON.stringify(config)).not.toContain("postgres://");
      expect(await fs.stat(first.store_path)).toBeTruthy();
      const configStat = await fs.stat(first.config_path);
      const storeStat = await fs.stat(first.store_path);

      const resumed = await initializeGuidedProject({
        projectRoot,
        build: buildFixture(),
        runnerVersion: "1.6.3",
        force: true,
        now: "2026-07-24T18:00:00.000Z",
      });
      expect(resumed.created).toBe(false);
      expect((await fs.stat(resumed.config_path)).mtimeMs).toBe(configStat.mtimeMs);
      expect((await fs.stat(resumed.store_path)).mtimeMs).toBe(storeStat.mtimeMs);
      expect(resumed.state.updated_at).toBe("2026-07-24T17:00:00.000Z");
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("tracks only non-secret journey state and preserves completed steps", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-guided-state-"));
    try {
      await fs.mkdir(path.join(projectRoot, ".synapsor"), { recursive: true });
      await fs.writeFile(path.join(projectRoot, ".synapsor/generation-lock.json"), "{}\n");
      await initializeGuidedProject({
        projectRoot,
        build: buildFixture(),
        runnerVersion: "1.6.3",
        now: "2026-07-24T17:00:00.000Z",
      });
      const active = await updateGuidedOnboardingState({
        projectRoot,
        status: "boundary_active",
        completedStep: "boundary_active",
        authorityActive: true,
        recommendedNextAction: "Try your first safe read.",
        now: "2026-07-24T17:01:00.000Z",
      });
      expect(active.completed_steps).toContain("boundary_active");
      expect(active.source_database_changed).toBe(false);
      expect((await readGuidedOnboardingState(projectRoot))?.recommended_next_action).toBe("Try your first safe read.");
      const serialized = await fs.readFile(path.join(projectRoot, ".synapsor/guided-onboarding.json"), "utf8");
      expect(serialized).not.toContain("tenant_acme");
      expect(serialized).not.toContain("postgres://");
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("preserves an existing environment example and appends only missing variable names", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-guided-env-"));
    try {
      await fs.mkdir(path.join(projectRoot, ".synapsor"), { recursive: true });
      await fs.writeFile(path.join(projectRoot, ".synapsor/generation-lock.json"), "{}\n");
      await fs.writeFile(
        path.join(projectRoot, ".env.example"),
        [
          "# Existing application settings",
          "APP_ORIGIN=http://localhost:3000",
          "DATABASE_URL=postgres://placeholder-only",
          "",
        ].join("\n"),
      );

      await initializeGuidedProject({
        projectRoot,
        build: buildFixture(),
        runnerVersion: "1.6.3",
      });

      const environment = await fs.readFile(path.join(projectRoot, ".env.example"), "utf8");
      expect(environment).toContain("# Existing application settings");
      expect(environment).toContain("APP_ORIGIN=http://localhost:3000");
      expect(environment).toContain("DATABASE_URL=postgres://placeholder-only");
      expect(environment.match(/^DATABASE_URL=/gm)).toHaveLength(1);
      expect(environment).toContain("SYNAPSOR_TENANT_ID=");
      expect(environment).toContain("SYNAPSOR_PRINCIPAL=");
      expect(environment).toContain("SYNAPSOR_OPERATOR_ID=");
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("fails preflight before creating any managed project file when a target conflicts", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-guided-conflict-"));
    try {
      const conflicting = path.join(projectRoot, ".synapsor/mcp/cursor.json");
      await fs.mkdir(path.dirname(conflicting), { recursive: true });
      await fs.writeFile(conflicting, "{\"owned_by\":\"application\"}\n");

      await expect(preflightGuidedProjectInitialization(projectRoot))
        .rejects.toThrow(/will not overwrite existing file/i);
      await expect(initializeGuidedProject({
        projectRoot,
        build: buildFixture(),
        runnerVersion: "1.6.3",
      })).rejects.toThrow(/will not overwrite existing file/i);

      await expect(fs.readFile(conflicting, "utf8")).resolves.toContain("owned_by");
      await expect(fs.stat(path.join(projectRoot, "synapsor.runner.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(projectRoot, ".synapsor/guided-onboarding.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(projectRoot, ".synapsor/local.db"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

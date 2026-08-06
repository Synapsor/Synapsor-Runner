import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import {
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  loadActivatedExplorationBoundaries,
  reviewExplorationBoundaryCandidate,
  writeAutoBoundaryArtifacts,
} from "./auto-boundary.js";
import {
  boundaryActivateCommand,
  boundaryReviewCommand,
  main,
} from "./cli.js";
import {
  boundaryActivateCommand as boundaryActivateCommandInternal,
  boundaryReviewCommand as boundaryReviewCommandInternal,
  loadBoundaryReviewContext,
} from "./boundary-commands.js";
import {
  createSavedBoundary,
  switchSavedBoundary,
  synchronizeBoundaryLibrary,
} from "./boundary-library.js";
import type {
  BoundaryFieldTier,
  BoundaryReviewInteractiveSession,
} from "./boundary-cli-picker.js";
import {
  createBoundaryReviewProgress,
  readBoundaryReviewProgress,
  saveBoundaryReviewProgress,
} from "./boundary-review-domain.js";
import {
  commitBoundaryResourceReviewMutation,
  listBoundaryResourceReviews,
  prepareBoundaryResourceReviewMutation,
} from "./boundary-review-mutation.js";
import { boundaryCommand } from "./guided-start.js";
import { initializeGuidedProject, readGuidedOnboardingState } from "./guided-project.js";
import { prepareScopedExplore } from "./scoped-explore.js";

describe("boundary operator-plane CLI", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exports an exact review bundle and requires a replay-safe signed decision for headless activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-cli-"));
    const inspection = boundaryInspection();
    const project = {
      root,
      package_manager: "npm" as const,
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    };
    const build = buildAutoBoundary({
      inspection,
      project,
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const guided = await initializeGuidedProject({
        projectRoot: root,
        build,
        runnerVersion: "1.6.4",
      });
      const progress = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: build.exploration_boundary,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        actor: "alice",
        revision: 1,
        now: "2026-07-25T12:00:00.000Z",
      });
      await saveBoundaryReviewProgress(root, progress);

      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const configDir = path.dirname(guided.config_path);
      const publicPath = path.join(configDir, "operator.pub.pem");
      const privatePath = path.join(root, "operator.private.pem");
      await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
      await fs.writeFile(
        privatePath,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        { encoding: "utf8", mode: 0o600 },
      );
      const config = JSON.parse(await fs.readFile(guided.config_path, "utf8"));
      config.operator_identity = {
        provider: "signed_key",
        operators: {
          alice: {
            public_key_path: "./operator.pub.pem",
            roles: ["boundary_reviewer"],
          },
        },
      };
      await fs.writeFile(guided.config_path, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      const bundlePath = path.join(root, "boundary-review.json");
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await expect(boundaryReviewCommand([
        "--project-root", root,
        "--output", bundlePath,
      ])).resolves.toBe(0);
      const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
      expect(bundle).toMatchObject({
        schema_version: "synapsor.boundary-review-bundle.v1",
        candidate_digest: explorationBoundaryCandidateDigest(build.exploration_boundary),
        outstanding_decision_ids: [],
      });
      expect(bundle.decisions.every((decision: { confirmed: boolean }) => decision.confirmed)).toBe(true);

      const fixedNow = new Date("2026-07-25T12:05:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      const digest = bundle.candidate_digest as string;
      const activationArgs = [
        "--project-root", root,
        "--config", guided.config_path,
        "--review-bundle", bundlePath,
        "--headless",
        "--confirm", `ACTIVATE ${digest}`,
        "--identity", "alice",
        "--identity-key", privatePath,
        "--required-role", "boundary_reviewer",
        "--reason", "Reviewed exact staging exploration authority.",
        "--environment", "staging",
        "--nonce", "fixed-review-nonce-0001",
        "--expires-at", "2026-07-25T12:10:00.000Z",
        "--json",
      ];

      await expect(boundaryActivateCommand(
        [...activationArgs.slice(0, activationArgs.indexOf("--required-role") + 1), "finance_reviewer", ...activationArgs.slice(activationArgs.indexOf("--required-role") + 2)],
        async () => inspection,
      )).rejects.toThrow(/lacks required role finance_reviewer/i);
      await expect(boundaryActivateCommand(activationArgs, async () => inspection)).resolves.toBe(0);
      const active = JSON.parse(
        await fs.readFile(path.join(root, ".synapsor/exploration-boundary.active.json"), "utf8"),
      );
      expect(active).toMatchObject({
        activation: {
          state: "active",
          digest,
          actor: "alice",
        },
      });
      await expect(readGuidedOnboardingState(root)).resolves.toMatchObject({
        status: "boundary_active",
        authority_active: true,
        recommended_next_action: expect.stringMatching(/model or MCP client/i),
      });
      stdout.mockClear();
      await expect(boundaryCommand([
        "status",
        "--project-root", root,
        "--json",
      ])).resolves.toBe(0);
      const status = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""));
      expect(status).toMatchObject({
        ok: true,
        project: root,
        database_source: {
          engine: "postgres",
          environment_reference: "DATABASE_URL",
          connection_value_returned: false,
        },
        config: { state: "valid" },
        activation: "active",
        candidate_boundary_name: build.exploration_boundary.pack.name,
        candidate_tables: ["public.service_visits"],
        active_boundary_name: build.exploration_boundary.pack.name,
        active_tables: ["public.service_visits"],
        outstanding_decision_ids: [],
        explore_budget_state: {
          queries_used: 0,
          queries_limit: 40,
          extracted_cells_used: 0,
          extracted_cells_limit: 4000,
          state_persists_across_tabs_processes_and_provider_sessions: true,
        },
        recent_analysis_references: [],
        source_database_changed: false,
      });
      expect(status.active_named_tools).toEqual([]);
      expect(status.production_readiness).toMatchObject({
        ready: false,
        blockers: [expect.stringMatching(/no activated named capability/i)],
      });
      expect(status.next_action).toMatch(/first bounded question/i);
      await expect(boundaryActivateCommand(activationArgs, async () => inspection))
        .rejects.toThrow(/already consumed/i);

      const store = new ProposalStore(guided.store_path);
      try {
        expect(store.listAttentionEvents({ limit: 20 })).toEqual(expect.arrayContaining([
          expect.objectContaining({
            event_type: "capability.activated",
            contract_digest: digest,
          }),
        ]));
      } finally {
        store.close();
      }

      const tampered = { ...bundle, candidate_digest: `sha256:${"0".repeat(64)}` };
      const tamperedPath = path.join(root, "tampered-review.json");
      await fs.writeFile(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
      await expect(boundaryActivateCommand([
        ...activationArgs.slice(0, activationArgs.indexOf("--review-bundle") + 1),
        tamperedPath,
        ...activationArgs.slice(activationArgs.indexOf("--review-bundle") + 2),
      ], async () => inspection)).rejects.toThrow(/digest does not match/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("resolves a blocked tenant scope through the CLI without activating authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-cli-resource-"));
    const inspection = boundaryInspection();
    const table = inspection.tables[0]!;
    table.row_level_security = false;
    table.row_level_security_policies = [];
    table.role_posture!.row_security_effective_for_current_role = false;
    table.suggestions.tenant_columns = [];
    const project = {
      root,
      package_manager: "npm" as const,
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    };
    const build = buildAutoBoundary({
      inspection,
      project,
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    expect(build.exploration_boundary.pack.resources).toEqual([]);
    expect(build.review.resources[0]).toMatchObject({
      id: "public.service_visits",
      status: "blocked_scope",
      tenant_key: {
        candidates: ["tenant_id"],
      },
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const guided = await initializeGuidedProject({
        projectRoot: root,
        build,
        runnerVersion: "1.6.5",
      });
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const publicPath = path.join(path.dirname(guided.config_path), "reviewer.pub.pem");
      const privatePath = path.join(root, "reviewer.private.pem");
      await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
      await fs.writeFile(
        privatePath,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        { encoding: "utf8", mode: 0o600 },
      );
      const config = JSON.parse(await fs.readFile(guided.config_path, "utf8"));
      config.operator_identity = {
        provider: "signed_key",
        operators: {
          alice: {
            public_key_path: "./reviewer.pub.pem",
            roles: ["boundary_reviewer"],
          },
        },
      };
      await fs.writeFile(guided.config_path, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      await expect(boundaryReviewCommand([
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        status: "blocked_scope",
        included: false,
        tenant_key: { candidates: ["tenant_id"] },
        source_database_changed: false,
      });

      output = "";
      const mutationArgs = [
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--include",
        "--tenant-key", "tenant_id",
        "--no-principal",
        "--visible-fields", "id,status,scheduled_at",
        "--withhold-from-model", "status",
        "--max-ranked-groups", "200",
        "--actor", "alice",
        "--reason", "Service visits are isolated by the reviewed tenant column.",
        "--json",
      ];
      await expect(boundaryReviewCommand(mutationArgs, async () => inspection)).resolves.toBe(0);
      const preview = JSON.parse(output);
      expect(preview).toMatchObject({
        ok: true,
        semantic_diff: {
          resource_id: "public.service_visits",
          before_included: false,
          after_included: true,
          selected_tenant_key: "tenant_id",
          max_ranked_groups_before: 500,
          max_ranked_groups_after: 200,
        },
        authority_activated: false,
        source_database_changed: false,
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      output = "";
      await expect(boundaryReviewCommand([
        ...mutationArgs,
        "--apply",
        "--confirm", `APPLY REVIEW ${preview.decision_digest}`,
        "--config", guided.config_path,
        "--identity", "alice",
        "--identity-key", privatePath,
        "--required-role", "boundary_reviewer",
        "--nonce", "resource-review-nonce-0001",
      ], async () => inspection)).resolves.toBe(0);
      const applied = JSON.parse(output);
      expect(applied).toMatchObject({
        ok: true,
        decision_digest: preview.decision_digest,
        review_revision: 1,
        source_database_changed: false,
      });
      const regenerated = JSON.parse(await fs.readFile(
        path.join(root, "synapsor/generated/exploration-boundary.draft.json"),
        "utf8",
      ));
      expect(regenerated.pack.resources).toEqual([
        expect.objectContaining({
          id: "public.service_visits",
          tenant_key: "tenant_id",
        }),
      ]);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress).toMatchObject({
        revision: 1,
        candidate: {
          pack: {
            resources: [{
              id: "public.service_visits",
              selectable_fields: ["id", "status", "scheduled_at"],
              model_withheld_fields: ["status"],
            }],
          },
        },
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("previews an explicit owner cohort override with its threshold-one consequence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-cli-cohort-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommand([
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--minimum-cohort", "0",
        "--actor", "owner@example.test",
        "--reason", "Invalid lower bound.",
      ], async () => inspection)).rejects.toThrow(/integer from 1 through 5/i);

      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      await expect(boundaryReviewCommand([
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--minimum-cohort", "1",
        "--actor", "owner@example.test",
        "--reason", "This owner-controlled staging analysis may return groups of one.",
      ], async () => inspection)).resolves.toBe(0);
      expect(output).toContain("Minimum group size: 5 -> 1 (explicit owner override)");
      expect(output).toContain(
        "Warning: 1 disables small-group suppression; groups of one identify individuals.",
      );
      expect(output).toContain("Authority activated: no");

      const persisted = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/review-overrides.json"),
        "utf8",
      ));
      expect(persisted.resources["public.service_visits"]).toBeUndefined();
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("keeps the boundary draft front door in the CLI register and offers Workbench second", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-draft-front-door-"));
    const inspection = boundaryInspection();
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await expect(main([
        "boundary",
        "draft",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(output).toContain("State: disabled draft. Active Runner tools are unchanged.");
      expect(output).toContain(
        "Prepared the local Runner config, ledger, and MCP snippets automatically.",
      );
      expect(output).toContain("Next: review it in this terminal:");
      expect(output).toContain(`synapsor-runner boundary review --project-root '${root}'`);
      expect(output).toContain("Visual alternative:");
      expect(output).toContain(
        `synapsor-runner ui --boundary-root '${path.join(root, "synapsor/generated")}' ` +
        `--config '${path.join(root, "synapsor.runner.json")}' ` +
        `--store '${path.join(root, ".synapsor/local.db")}' --open`,
      );
      await expect(fs.access(path.join(root, "synapsor.runner.json"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, ".synapsor/local.db"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, ".synapsor/guided-onboarding.json")))
        .resolves.toBeUndefined();
      expect(output).not.toContain(
        "Review it in the local Workbench; active Runner tools are unchanged.",
      );

      output = "";
      await expect(main([
        "boundary",
        "draft",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
        "--force",
        "--json",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        activation: "disabled_unreviewed",
        guided_project_created: false,
        config_path: path.join(root, "synapsor.runner.json"),
        store_path: path.join(root, ".synapsor/local.db"),
        next_action: `synapsor-runner boundary review --project-root '${root}'`,
        visual_alternative:
          `synapsor-runner ui --boundary-root '${path.join(root, "synapsor/generated")}' ` +
          `--config '${path.join(root, "synapsor.runner.json")}' ` +
          `--store '${path.join(root, ".synapsor/local.db")}' --open`,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("points a production boundary draft directly to the secured runtime config generator", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-production-boundary-config-handoff-"));
    const inspection = boundaryInspection();
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await expect(main([
        "boundary",
        "draft",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
        "--profile", "production",
        "--tenant-claim", "tenant_id",
        "--principal-claim", "sub",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);

      expect(output).toContain("Then generate the secured production runtime config:");
      expect(output).toContain("synapsor-runner config init --production-explore");
      expect(output).toContain(`--project-root '${root}'`);
      expect(output).toContain("--issuer https://identity.example");
      expect(output).toContain("--audience https://runner.example/mcp");
      expect(output).toContain("--accounting-namespace your_org.analytics.production");
      expect(output).toContain("reuses the reviewed source and JWT claim names");
      await expect(fs.access(path.join(root, "synapsor.runner.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("records a model-withheld field through the top-level CLI and rejects unknown fields", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-front-door-"));
    const inspection = boundaryInspection();
    const setup = await initializeSignedReviewProject(root, inspection);
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const baseArgs = [
      "boundary",
      "review",
      "resource",
      "public.service_visits",
      "--project-root", root,
      "--withhold-from-model", "status",
      "--actor", "alice",
      "--reason", "Keep reviewed status labels available locally without model egress.",
    ];
    try {
      await expect(main(baseArgs, {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(output).toContain("Preview of one pending review decision. Nothing is saved or active yet.");
      expect(output).toContain(
        "Withhold from model: status - text column of public.service_visits",
      );
      expect(output).toContain("database-declared values: scheduled, completed");
      expect(output).toContain("Model-withheld fields added: status");
      expect(output).toContain("Everything else: unchanged.");
      expect(output).toContain("--withhold-from-model status");
      expect(output).toContain("--apply");
      await expect(fs.access(path.join(root, ".synapsor/boundary-review-progress.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      output = "";
      await expect(main([
        ...baseArgs,
        "--json",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      const preview = JSON.parse(output);

      output = "";
      await expect(main([
        ...baseArgs,
        "--apply",
        "--confirm", `APPLY REVIEW ${preview.decision_digest}`,
        "--config", setup.configPath,
        "--identity", "alice",
        "--identity-key", setup.privateKeyPath,
        "--required-role", "boundary_reviewer",
        "--nonce", "front-door-review-nonce-0001",
        "--json",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        review_revision: 1,
        source_database_changed: false,
      });
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress.candidate.pack.resources).toEqual([
        expect.objectContaining({
          id: "public.service_visits",
          model_withheld_fields: ["status"],
        }),
      ]);
      const overrides = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/review-overrides.json"),
        "utf8",
      ));
      expect(overrides.resources["public.service_visits"].fields.status).toMatchObject({
        exposure: "withhold_from_model",
        actor: "alice",
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      output = "";
      await expect(main([
        "boundary", "review", "resource", "public.service_visits",
        "--project-root", root,
        "--withhold-from-model", "tenant_id",
        "--actor", "alice",
        "--reason", "Show the fixed tenant only in Runner's local verified output.",
        "--json",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        semantic_diff: {
          resource_id: "public.service_visits",
          selected_tenant_key: "tenant_id",
          added_visible_fields: ["tenant_id"],
          removed_kept_out_fields: ["tenant_id"],
          added_model_withheld_fields: ["tenant_id"],
          authority_changed: true,
        },
        authority_activated: false,
        source_database_changed: false,
      });

      output = "";
      await expect(main([
        "boundary", "review", "resource", "public.service_visits",
        "--project-root", root,
        "--allow-reviewed-field", "tenant_id",
        "--actor", "alice",
        "--reason", "The owner reviewed this fixed tenant value for model output.",
        "--json",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        semantic_diff: {
          resource_id: "public.service_visits",
          selected_tenant_key: "tenant_id",
          added_visible_fields: ["tenant_id"],
          removed_kept_out_fields: ["tenant_id"],
          authority_changed: true,
        },
        authority_activated: false,
        source_database_changed: false,
      });

      await expect(main([
        ...baseArgs.slice(0, baseArgs.indexOf("--withhold-from-model") + 1),
        "banana",
        ...baseArgs.slice(baseArgs.indexOf("--withhold-from-model") + 2),
      ], {
        boundarySchemaInspector: async () => inspection,
      })).rejects.toThrow(
        /unknown field "banana".*available columns: id, scheduled_at, status, tenant_id/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("never prompts for a resource decision on a non-TTY without decision flags", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-nontty-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    let stderr = "";
    let stdout = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(main([
        "boundary",
        "review",
        "--project-root", root,
        "--map",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(stdout).toContain("BOUNDARY OVERVIEW");
      expect(stdout).toContain(
        'Boundary "reviewed_staging" is one boundary containing 1 table.',
      );
      expect(stdout).toContain('NEXT BOUNDARY "reviewed_staging" (DISABLED DRAFT)');
      expect(stdout).toContain("Show the complete catalog:");

      stdout = "";
      await expect(main([
        "boundary",
        "review",
        "--project-root", root,
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(stdout).toContain("BOUNDARY OVERVIEW");
      expect(stdout).toContain('NEXT BOUNDARY "reviewed_staging" (DISABLED DRAFT)');
      expect(stdout).not.toContain("Usage:");

      stdout = "";
      await expect(main([
        "boundary",
        "review",
        "--project-root", root,
        "--map",
        "--all",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(stdout).toContain("WHOLE BOUNDARY MAP (ALL TABLES)");
      expect(stdout).toContain('Next boundary "reviewed_staging": 1/1 tables | active 0');

      await expect(main([
        "boundary",
        "review",
        "--project-root", root,
        "--all",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).rejects.toThrow(/--all is available only with --map/i);

      stdout = "";
      await expect(main([
        "boundary",
        "review",
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--map",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(0);
      expect(stdout).toContain("TABLE ACCESS MAP - public.service_visits");
      expect(stdout).toContain("Model + Runner fields");
      expect(stdout).toContain("status: return, filter(eq/neq/in), sort");
      expect(stdout).toContain("Trusted tenant scope: tenant_id (bound outside model arguments)");
      expect(stdout).not.toContain("\u001b[");
      await expect(main([
        "boundary",
        "review",
        "resource",
        "public.service_visits",
        "--project-root", root,
        "--map",
        "--withhold-from-model", "status",
        "--actor", "alice",
        "--reason", "This combination must not silently ignore either request.",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).rejects.toThrow(/--map is inspection-only/i);

      stdout = "";
      await expect(main([
        "boundary",
        "review",
        "resource",
        "public.service_visits",
        "--project-root", root,
      ], {
        boundarySchemaInspector: async () => inspection,
      })).resolves.toBe(2);
      expect(stderr).toContain("No boundary decision was supplied");
      expect(stderr).toContain("--withhold-from-model");
      expect(stdout).toContain("Resource decision flags:");
      await expect(fs.access(path.join(root, ".synapsor/boundary-review-progress.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a hand-authored Runner config while drafting a boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-preserve-config-"));
    const configPath = path.join(root, "synapsor.runner.json");
    const config = `${JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: "./custom-ledger.db" },
      sources: {
        warehouse_reader: {
          engine: "postgres",
          read_url_env: "WAREHOUSE_READ_URL",
          read_only: true,
          statement_timeout_ms: 2500,
        },
      },
      trusted_context: {
        provider: "environment",
        values: { tenant_id_env: "WAREHOUSE_TENANT" },
        tenant_binding: "tenant_id",
      },
      capabilities: [],
      strict: true,
      result_format: 2,
    }, null, 2)}\n`;
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await fs.writeFile(configPath, config, "utf8");
      await expect(boundaryCommand([
        "draft",
        "--from-env", "DATABASE_URL",
        "--project-root", root,
      ], async () => boundaryInspection())).resolves.toBe(0);

      await expect(fs.readFile(configPath, "utf8")).resolves.toBe(config);
      expect(output).toContain("Generated disabled Auto Boundary draft");
      expect(output).not.toContain("Prepared the local Runner config");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("gives boundary diff a copy-paste regeneration command for the reviewed source env", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-stale-diff-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: [],
        schema_inputs: [],
        database_env_names: ["WAREHOUSE_DATABASE_URL"],
      },
      sourceEnv: "WAREHOUSE_DATABASE_URL",
    });
    const drifted = structuredClone(inspection);
    drifted.tables[0]!.role_posture!.owner = "replacement_owner";
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryCommand([
        "diff",
        "--project-root", root,
      ], async () => drifted)).resolves.toBe(1);

      expect(output).toContain("Generation lock is stale:");
      expect(output).toContain(
        "synapsor-runner boundary draft --from-env WAREHOUSE_DATABASE_URL --force && synapsor-runner boundary review",
      );
      expect(output).toContain("Review and activation are still required");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("renames the one disabled multi-table boundary without activating authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-name-"));
    const inspection = boundaryInspection();
    const secondTable = structuredClone(inspection.tables[0]!);
    secondTable.name = "service_routes";
    secondTable.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    secondTable.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(secondTable);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const answers = [
      "Service_Operations",
      "alice",
      "This boundary covers reviewed service operations analytics.",
    ];
    const choices = [
      { action: "rename" as const },
      undefined,
    ];
    let chooseCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => {
        chooseCalls += 1;
        return choices.shift();
      },
      editFieldTiers: async () => undefined,
      promptText: async () => answers.shift() ?? "",
      confirm: async () => true,
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress.candidate.pack.name).toBe("service_operations");
      expect(progress.candidate.pack.resources.length).toBeGreaterThan(1);
      const nextReview = await listBoundaryResourceReviews(root);
      expect(nextReview.length).toBeGreaterThan(1);
      expect(nextReview.every((resource) =>
        resource.candidate_boundary_name === "service_operations")).toBe(true);
      expect(output).toContain("DISABLED BOUNDARY NAME CHANGE");
      expect(output).toContain('Using lower-case boundary name "service_operations".');
      expect(output).toContain('Saved boundary name "service_operations"');
      expect(output).toContain("Active authority changed: no");
      expect(output).toContain("Boundary review paused. No new decision or authority was recorded.");
      expect(output).toContain("start --from-env DATABASE_URL --cli");
      expect(chooseCalls).toBe(2);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("disables active Explore without deleting its named draft, review state, or protected artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-disable-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const digest = explorationBoundaryCandidateDigest(build.exploration_boundary);
    const {
      activation: _disabledActivation,
      unresolved_decisions: _unresolvedDecisions,
      ...authority
    } = build.exploration_boundary;
    const active = {
      ...authority,
      activation: {
        state: "active",
        digest,
        actor: "alice",
        activated_at: "2026-07-30T12:00:00.000Z",
        generation_lock_fingerprint: build.exploration_boundary.generation_lock_fingerprint,
        reviewed_decisions: build.exploration_boundary.unresolved_decisions.map((decision) => ({
          decision,
          confirmed: true,
        })),
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await fs.mkdir(path.join(root, ".synapsor/protected"), { recursive: true });
      await fs.writeFile(
        path.join(root, ".synapsor/exploration-boundary.active.json"),
        `${JSON.stringify(active, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(path.join(root, ".synapsor/protected/readme.txt"), "preserve\n", "utf8");

      await expect(boundaryCommand([
        "disable",
        "--project-root", root,
        "--actor", "alice",
        "--confirm", `DISABLE ${digest}`,
        "--json",
      ])).resolves.toBe(0);

      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        disabled: true,
        activation: "disabled",
        boundary_name: build.exploration_boundary.pack.name,
        disabled_digest: digest,
        actor: "alice",
        protected_capabilities_changed: false,
        review_state_changed: false,
        source_database_changed: false,
      });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(
        path.join(root, "synapsor/generated/exploration-boundary.draft.json"),
        "utf8",
      )).resolves.toContain(build.exploration_boundary.pack.name);
      await expect(fs.readFile(path.join(root, ".synapsor/protected/readme.txt"), "utf8"))
        .resolves.toBe("preserve\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns from column review to the table list without saving", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-picker-back-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { resource_id: "public.service_visits", action: "review" as const },
      undefined,
    ];
    let chooseCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => {
        chooseCalls += 1;
        return choices.shift();
      },
      editFieldTiers: async () => "back",
      promptText: async () => {
        throw new Error("Back navigation must not request reviewer details.");
      },
      confirm: async () => {
        throw new Error("Back navigation must not request confirmation.");
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      expect(chooseCalls).toBe(2);
      expect(output).toContain("Boundary review paused. No new decision or authority was recorded.");
      expect(output).toContain("Resume: synapsor-runner start --from-env DATABASE_URL --cli");
      await expect(fs.access(path.join(root, ".synapsor/boundary-review-progress.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns from boundary naming and final review prompts without saving or activating", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-prompt-back-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { action: "create" as const },
      { action: "confirm" as const },
    ];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => choices.shift(),
      editFieldTiers: async () => undefined,
      promptText: async () => undefined,
      confirm: async () => {
        throw new Error("Escape at reviewer input must return before confirmation.");
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      expect(output).toContain("New boundary cancelled. Nothing was saved or activated.");
      expect(output).toContain("Returned to boundary review. No sign-offs were recorded.");
      await expect(fs.access(path.join(root, ".synapsor/boundary-review-progress.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("turns an unchanged column inspection into one explicit table sign-off", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-table-signoff-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { resource_id: "public.service_visits", action: "review" as const },
      undefined,
    ];
    let confirmations = 0;
    const confirmationDefaults: Array<boolean | undefined> = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => choices.shift(),
      editFieldTiers: async (view) => Object.fromEntries(view.fields.map((field) => [
        field.name,
        view.candidate?.kept_out_fields.includes(field.name)
          ? "kept_out"
          : view.candidate?.model_withheld_fields?.includes(field.name)
            ? "withheld_from_model"
            : "visible",
      ])),
      promptText: async () => "alice",
      confirm: async (_prompt, options) => {
        confirmations += 1;
        confirmationDefaults.push(options?.defaultValue);
        return true;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      const tableDecisions = build.exploration_boundary.unresolved_decisions.filter(
        (decision) => decision.startsWith("public.service_visits:"),
      );
      expect(confirmations).toBe(1);
      expect(confirmationDefaults).toEqual([true]);
      expect(progress.confirmed_decisions).toEqual(tableDecisions);
      expect(output).toContain("TABLE SIGN-OFF - public.service_visits");
      expect(output).toContain("ACCESS");
      expect(output).toContain("REVIEWED VALUE");
      expect(output).toContain(`Signed off public.service_visits.`);
      expect(output).toContain(
        `${tableDecisions.length} digest-bound decisions are now recorded under one table sign-off.`,
      );
      expect(output).not.toContain("Type CONFIRM");
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("groups final review into one boundary sign-off and one sign-off per table", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-grouped-review-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
      deploymentProfile: "production",
      httpClaims: { tenantClaim: "tenant_id", principalClaim: "sub" },
    });
    let confirmations = 0;
    const confirmationDefaults: Array<boolean | undefined> = [];
    const confirmationPrompts: string[] = [];
    const activationHandoff = vi.fn(async () => 0);
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => ({ action: "confirm" }),
      editFieldTiers: async () => undefined,
      promptText: async () => "alice",
      confirm: async (prompt, options) => {
        confirmations += 1;
        confirmationPrompts.push(prompt);
        confirmationDefaults.push(options?.defaultValue);
        return true;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session, activationHandoff)).resolves.toBe(0);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(confirmations).toBe(3);
      expect(confirmationDefaults).toEqual([true, true, true]);
      expect(confirmationPrompts[0]).toBe(
        "Confirm these boundary-wide production HTTP and trusted JWT scope settings?",
      );
      expect(confirmationPrompts.at(-1)).toBe(
        `Activate "${build.exploration_boundary.pack.name}" now?`,
      );
      expect(progress.confirmed_decisions).toEqual(
        build.exploration_boundary.unresolved_decisions,
      );
      expect(output).toContain("FINAL REVIEW");
      expect(output).toContain("Boundary settings");
      expect(output).toContain("production HTTP + JWT");
      expect(output).toContain("production over secured Streamable HTTP");
      expect(output).not.toContain("local authoring + trusted scope");
      expect(output).toContain("TABLE SIGN-OFF - public.service_visits");
      expect(output).toContain("REVIEWED - NOT ACTIVE");
      expect(output).toContain("REVIEW");
      expect(output).toContain("Complete");
      expect(output).toContain("Exact reviewed fingerprint:");
      expect(output).toContain(
        `Reviewed boundary "${build.exploration_boundary.pack.name}" is active`,
      );
      expect(output).toContain("active for secured production HTTP Explore");
      expect(output).toContain("initialize its shared accounting ledger, and run doctor");
      expect(output).not.toContain("active for local read-only Explore");
      expect(output).not.toContain("Next: synapsor-runner try ask");
      expect(activationHandoff).not.toHaveBeenCalled();
      expect(output).not.toContain("Stable ID:");
      expect(output).not.toContain("Type CONFIRM");
      const active = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      ));
      expect(active.activation.digest).toBe(
        explorationBoundaryCandidateDigest(build.exploration_boundary),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("stages focused access edits and activates the exact replacement with one confirmation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-focused-access-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { resource_id: "public.service_visits", action: "review" as const },
      { action: "confirm" as const },
    ];
    const confirmationPrompts: string[] = [];
    const activationHandoff = vi.fn(async () => 0);
    let previousActive = "";
    let resourceSelections = 0;
    const previousUser = process.env.USER;
    process.env.USER = "focused-reviewer";
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (_resources, _overview, options) => {
        resourceSelections += 1;
        expect(options?.initialView).toBe("access");
        expect(options?.startAtBoundaryList).toBe(
          resourceSelections === 1 ? undefined : false,
        );
        if (resourceSelections === 2) {
          await expect(fs.readFile(
            path.join(root, ".synapsor/exploration-boundary.active.json"),
            "utf8",
          )).resolves.toBe(previousActive);
          await expect(prepareScopedExplore({
            projectRoot: root,
            transport: "stdio",
            env: {
              DATABASE_URL: "postgresql://unused.example.test/synapsor",
              SYNAPSOR_TENANT_ID: "tenant-acme",
            },
            inspectDatabaseFn: async () => inspection,
          })).resolves.toMatchObject({
            boundary: {
              activation: { actor: "initial-reviewer" },
            },
          });
        }
        return choices.shift();
      },
      editFieldTiers: async (view, options) => {
        expect(options).toEqual({ focusedAccess: true });
        return Object.fromEntries(view.fields.map((field) => [
          field.name,
          field.name === "status"
            ? "withheld_from_model"
            : view.candidate?.kept_out_fields.includes(field.name)
              ? "kept_out"
              : "visible",
        ]));
      },
      promptText: async () => {
        throw new Error("Routine focused edits must not ask for repeated actor or reason input.");
      },
      confirm: async (prompt, options) => {
        confirmationPrompts.push(prompt);
        expect(options?.defaultValue).toBe(true);
        return true;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const initialDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: build.exploration_boundary,
        expectedDigest: initialDigest,
        actor: "initial-reviewer",
        confirmation: `ACTIVATE ${initialDigest}`,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        currentInspection: inspection,
      });
      previousActive = await fs.readFile(
        path.join(root, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      );
      await fs.rm(path.join(root, ".synapsor/exploration-locks"), {
        recursive: true,
        force: true,
      });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session, activationHandoff, {
        activationReviewNotice: ({ boundaryName, boundaryDigest }) => [
          "MODEL CONTINUATION TEST",
          `Boundary: ${boundaryName}`,
          `Digest: ${boundaryDigest}`,
          "The activation confirmation renews this Ask session.",
          "",
        ].join("\n"),
      })).resolves.toBe(0);

      expect(confirmationPrompts).toEqual([
        `Activate "${build.exploration_boundary.pack.name}" exactly as shown and continue to Ask?`,
      ]);
      expect(output).toContain("Draft updated: public.service_visits");
      expect(output).toContain("REVIEW EXACT BOUNDARY");
      expect(output).toContain("Runner only");
      expect(output).toContain("Principal scope");
      expect(output).toContain("Not required for this boundary");
      expect(output).toContain("MODEL CONTINUATION TEST");
      expect(output).toContain("The activation confirmation renews this Ask session.");
      expect(output.indexOf("MODEL CONTINUATION TEST")).toBeLessThan(
        output.indexOf(`Reviewed boundary "${build.exploration_boundary.pack.name}" is active`),
      );
      expect(output).not.toContain("TABLE SIGN-OFF");
      const active = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      )) as {
        pack: { resources: Array<{ id: string; model_withheld_fields?: string[] }> };
      };
      expect(active.pack.resources.find((resource) =>
        resource.id === "public.service_visits")?.model_withheld_fields).toContain("status");
      expect(activationHandoff).toHaveBeenCalledOnce();
    } finally {
      if (previousUser === undefined) delete process.env.USER;
      else process.env.USER = previousUser;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("reports deterministic outcomes when focused access widens a sensitive field", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-sensitive-outcome-"));
    const inspection = boundaryInspection();
    const table = inspection.tables[0]!;
    const contactName = structuredClone(table.columns.find((field) => field.name === "status")!);
    contactName.name = "contact_name";
    contactName.suggestions.sensitive = true;
    contactName.suggestions.sensitivity = {
      state: "high_confidence_sensitive",
      reason_codes: ["person_name"],
      reasons: ["The field name indicates a person's name."],
      evidence_source: "database",
    };
    table.columns.push(contactName);
    table.suggestions.sensitive_columns.push("contact_name");
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    expect(build.exploration_boundary.pack.resources[0]?.kept_out_fields)
      .toContain("contact_name");

    const previousUser = process.env.USER;
    process.env.USER = "sensitive-reviewer";
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const selectedTiers = (
      view: Parameters<BoundaryReviewInteractiveSession["editFieldTiers"]>[0],
      contactTier: BoundaryFieldTier,
    ) => Object.fromEntries(view.fields.map((field) => [
      field.name,
      field.name === "contact_name"
        ? contactTier
        : view.candidate?.kept_out_fields.includes(field.name)
          ? "kept_out"
          : view.candidate?.model_withheld_fields?.includes(field.name)
            ? "withheld_from_model"
            : "visible",
    ])) as Record<string, BoundaryFieldTier>;

    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });

      const firstChoices = [
        { resource_id: "public.service_visits", action: "review" as const },
        undefined,
      ];
      const reasonPrompts: string[] = [];
      let reasonAttempt = 0;
      const firstSession: BoundaryReviewInteractiveSession = {
        chooseResource: async () => firstChoices.shift(),
        editFieldTiers: async (view) => selectedTiers(view, "withheld_from_model"),
        promptText: async (prompt) => {
          reasonPrompts.push(prompt);
          reasonAttempt += 1;
          if (reasonAttempt === 1) return "";
          expect(await readBoundaryReviewProgress(root, build.exploration_boundary))
            .toBeUndefined();
          return "Support analytics needs local unique counts.";
        },
        confirm: async () => {
          throw new Error("A focused visibility edit must not activate authority implicitly.");
        },
      };
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, firstSession)).resolves.toBe(0);

      expect(reasonPrompts).toEqual([
        "Required reason for this sensitive-field access change: ",
        "Required reason for this sensitive-field access change: ",
      ]);
      expect(output).toContain(
        "This widens sensitive-field access:\n  public.service_visits.contact_name -> Runner only (withheld from model)",
      );
      expect(output).toContain("Reviewer: sensitive-reviewer");
      expect(output).toContain("A concrete reason is required before Runner can save this change.");
      expect(output).toContain("Rejected: a concrete reason is required; no change was made.");
      expect(output).toContain(
        "Recorded: public.service_visits.contact_name -> Runner only (withheld from model); " +
        "actor=sensitive-reviewer; reason=\"Support analytics needs local unique counts.\"",
      );
      expect(output).toContain(
        "Runner only controls where raw values can appear; it does not grant Group, Total/Average, or Count unique.",
      );
      expect(output).toContain("--group-fields, --measure-fields, or --count-distinct-fields");

      const progressPath = path.join(root, ".synapsor/boundary-review-progress.json");
      const applied = JSON.parse(await fs.readFile(progressPath, "utf8")) as {
        revision: number;
        candidate: { pack: { resources: Array<{ id: string; model_withheld_fields?: string[] }> } };
      };
      expect(applied.candidate.pack.resources.find((resource) =>
        resource.id === "public.service_visits")?.model_withheld_fields).toContain("contact_name");
      const appliedRevision = applied.revision;

      output = "";
      const repeatChoices = [
        { resource_id: "public.service_visits", action: "review" as const },
        undefined,
      ];
      const repeatSession: BoundaryReviewInteractiveSession = {
        chooseResource: async () => repeatChoices.shift(),
        editFieldTiers: async (view) => selectedTiers(view, "withheld_from_model"),
        promptText: async () => {
          throw new Error("An idempotent repeat must not ask for another reason.");
        },
        confirm: async () => {
          throw new Error("An idempotent repeat must not activate authority.");
        },
      };
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, repeatSession)).resolves.toBe(0);
      expect(output).toContain(
        "Unchanged: public.service_visits already has the access levels shown; no change was made.",
      );
      expect(JSON.parse(await fs.readFile(progressPath, "utf8")).revision).toBe(appliedRevision);

      output = "";
      const cancelChoices = [
        { resource_id: "public.service_visits", action: "review" as const },
        undefined,
      ];
      const cancelSession: BoundaryReviewInteractiveSession = {
        chooseResource: async () => cancelChoices.shift(),
        editFieldTiers: async (view) => selectedTiers(view, "visible"),
        promptText: async () => undefined,
        confirm: async () => {
          throw new Error("Cancelling a sensitive-field edit must not activate authority.");
        },
      };
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, cancelSession)).resolves.toBe(0);
      expect(output).toContain("Cancelled - no sensitive-field access change was made.");
      const cancelled = JSON.parse(await fs.readFile(progressPath, "utf8"));
      expect(cancelled.revision).toBe(appliedRevision);
      expect(cancelled.candidate.pack.resources.find((resource: { id: string }) =>
        resource.id === "public.service_visits").model_withheld_fields).toContain("contact_name");
    } finally {
      if (previousUser === undefined) delete process.env.USER;
      else process.env.USER = previousUser;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("returns from a focused column editor to the selected boundary's table list", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-column-back-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const starts: Array<boolean | undefined> = [];
    let chooseCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (_resources, _overview, options) => {
        starts.push(options?.startAtBoundaryList);
        chooseCalls += 1;
        return chooseCalls === 1
          ? { resource_id: "public.service_visits", action: "review" }
          : undefined;
      },
      editFieldTiers: async () => "back",
      promptText: async () => {
        throw new Error("Back from columns must not open a prompt.");
      },
      confirm: async () => {
        throw new Error("Back from columns must not confirm authority.");
      },
    };
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access"],
        async () => inspection,
        session,
        undefined,
        { startAtBoundaryList: true },
      )).resolves.toBe(0);
      expect(starts).toEqual([true, false]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("keeps a completed review inactive when the operator declines the default-yes activation handoff", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-activation-decline-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const prompts: string[] = [];
    const defaults: Array<boolean | undefined> = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => undefined,
      editFieldTiers: async () => undefined,
      promptText: async () => "alice",
      confirm: async (prompt, options) => {
        prompts.push(prompt);
        defaults.push(options?.defaultValue);
        return false;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await saveBoundaryReviewProgress(root, createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: build.exploration_boundary,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        actor: "alice",
        revision: 1,
      }));

      await expect(boundaryActivateCommandInternal(
        ["--project-root", root, "--actor", "alice"],
        async () => inspection,
        session,
      )).resolves.toBe(0);

      expect(prompts).toEqual([
        `Activate "${build.exploration_boundary.pack.name}" now?`,
      ]);
      expect(defaults).toEqual([true]);
      expect(output).toContain("Boundary remains reviewed and inactive.");
      expect(output).toContain("No agent authority or source data changed.");
      expect(output).not.toContain("Type ACTIVATE");
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("records the same disabled candidate through the picker and flag paths", async () => {
    const flagRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-flag-equivalence-"));
    const pickerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-picker-equivalence-"));
    const inspection = boundaryInspection();
    const flagSetup = await initializeSignedReviewProject(flagRoot, inspection);
    await initializeSignedReviewProject(pickerRoot, inspection);
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      const flagArgs = [
        "boundary", "review", "resource", "public.service_visits",
        "--project-root", flagRoot,
        "--withhold-from-model", "status",
        "--actor", "alice",
        "--reason", "Equivalent reviewed egress decision.",
        "--json",
      ];
      await main(flagArgs, { boundarySchemaInspector: async () => inspection });
      const preview = JSON.parse(output);
      output = "";
      await main([
        ...flagArgs,
        "--apply",
        "--confirm", `APPLY REVIEW ${preview.decision_digest}`,
        "--config", flagSetup.configPath,
        "--identity", "alice",
        "--identity-key", flagSetup.privateKeyPath,
        "--required-role", "boundary_reviewer",
        "--nonce", "equivalent-flag-nonce-0001",
      ], { boundarySchemaInspector: async () => inspection });

      const answers = ["alice", "Equivalent reviewed egress decision."];
      const session: BoundaryReviewInteractiveSession = {
        chooseResource: async () => ({
          resource_id: "public.service_visits",
          action: "review",
        }),
        editFieldTiers: async (view) => Object.fromEntries(view.fields.map((field) => {
          const tier: BoundaryFieldTier = field.name === "status"
            ? "withheld_from_model"
            : view.candidate?.kept_out_fields.includes(field.name)
              ? "kept_out"
              : view.candidate?.model_withheld_fields?.includes(field.name)
                ? "withheld_from_model"
                : "visible";
          return [field.name, tier];
        })),
        promptText: async () => answers.shift() ?? "",
        confirm: async () => true,
      };
      output = "";
      await expect(boundaryReviewCommandInternal([
        "resource",
        "public.service_visits",
        "--project-root", pickerRoot,
      ], async () => inspection, session)).resolves.toBe(0);
      expect(output).toContain("Saved disabled boundary review revision 1.");
      expect(output).toContain("Authority activated: no");

      const flagProgress = JSON.parse(await fs.readFile(
        path.join(flagRoot, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      const pickerProgress = JSON.parse(await fs.readFile(
        path.join(pickerRoot, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(pickerProgress.candidate).toEqual(flagProgress.candidate);
      expect(pickerProgress.candidate_digest).toBe(flagProgress.candidate_digest);
      await expect(fs.access(path.join(pickerRoot, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(flagRoot, { recursive: true, force: true });
      await fs.rm(pickerRoot, { recursive: true, force: true });
    }
  }, 25_000);

  it("opens an excluded reviewable table in the picker and includes it only after confirmation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-picker-excluded-"));
    const inspection = boundaryInspection();
    const secondTable = structuredClone(inspection.tables[0]!);
    secondTable.name = "service_routes";
    secondTable.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    secondTable.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(secondTable);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const excluded = structuredClone(build.exploration_boundary);
    excluded.pack.resources = excluded.pack.resources.filter(
      (resource) => resource.id !== "public.service_visits",
    );
    const progress = createBoundaryReviewProgress({
      draft: build.exploration_boundary,
      candidate: excluded,
      confirmedDecisions: [],
      actor: "alice",
      revision: 1,
    });
    const answers = ["alice", "Include this reviewed table through the interactive picker."];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => ({
        resource_id: "public.service_visits",
        action: "review",
      }),
      editFieldTiers: async (view) => {
        expect(view.candidate).toBeNull();
        expect(view.generated_candidate?.id).toBe("public.service_visits");
        return Object.fromEntries(view.fields.map((field) => [
          field.name,
          view.generated_candidate?.kept_out_fields.includes(field.name)
            ? "kept_out"
            : "visible",
        ]));
      },
      promptText: async () => answers.shift() ?? "",
      confirm: async () => true,
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await saveBoundaryReviewProgress(root, progress);
      await expect(boundaryReviewCommandInternal([
        "resource",
        "public.service_visits",
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      expect(output).toContain("Include public.service_visits in the disabled candidate.");
      expect(output).toContain("Table access: not included -> included");
      const saved = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(saved.candidate.pack.resources.map((resource: { id: string }) => resource.id))
        .toEqual(["public.service_routes", "public.service_visits"]);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("resolves a blocked table inline and returns to review instead of terminating the CLI", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-inline-scope-"));
    const inspection = batchBoundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    expect(build.exploration_boundary.pack.resources).toEqual([]);
    const choices = [
      { resource_id: "public.service_visits", action: "add" as const },
      undefined,
    ];
    let resolverCalls = 0;
    let pickerCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => {
        pickerCalls += 1;
        return choices.shift();
      },
      resolveBlockedResource: async (view) => {
        resolverCalls += 1;
        expect(view.generated_candidate).toBeNull();
        expect(view.row_identity.candidates).toContain("id");
        expect(view.tenant_key.candidates).toContain("tenant_id");
        return { row_identity: "id", tenant_key: "tenant_id" };
      },
      editFieldTiers: async (view) => {
        expect(view.generated_candidate?.id).toBe("public.service_visits");
        return "back";
      },
      promptText: async () => {
        throw new Error("Inline scope resolution must not require a signed-key prompt.");
      },
      confirm: async () => {
        throw new Error("Inline scope resolution must not activate authority.");
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
      ], async () => inspection, session)).resolves.toBe(0);
      expect(resolverCalls).toBe(1);
      expect(pickerCalls).toBe(2);
      expect(output).toContain("Saved structural review for public.service_visits");
      expect(output).toContain("Record ID: id");
      expect(output).toContain("Tenant isolation: tenant_id");
      expect(output).toContain("Agent authority activated: no");
      expect(output).toContain("Boundary review paused");
      const reviews = await listBoundaryResourceReviews(root);
      expect(reviews.find((resource) => resource.resource_id === "public.service_visits"))
        .toMatchObject({ included: true, status: "draft_read" });
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("adds a table before column review and stages removal without exiting the access editor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-add-remove-loop-"));
    const inspection = boundaryInspection();
    const visits = inspection.tables[0]!;
    const relationColumn = structuredClone(visits.columns[0]!);
    relationColumn.name = "route_id";
    relationColumn.suggestions.immutable = true;
    const unrelatedRelationColumn = structuredClone(relationColumn);
    unrelatedRelationColumn.name = "region_id";
    visits.columns.push(relationColumn, unrelatedRelationColumn);
    visits.suggestions.default_visible_columns.push("route_id", "region_id");
    visits.foreign_keys = [{
      name: "service_visits_route_id_fkey",
      columns: ["route_id"],
      referenced_schema: "public",
      referenced_table: "service_routes",
      referenced_columns: ["id"],
      delete_rule: "RESTRICT",
    }, {
      name: "service_visits_region_id_fkey",
      columns: ["region_id"],
      referenced_schema: "public",
      referenced_table: "service_regions",
      referenced_columns: ["id"],
      delete_rule: "RESTRICT",
    }];
    const routeTable = structuredClone(visits);
    routeTable.name = "service_routes";
    routeTable.foreign_keys = [];
    routeTable.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    routeTable.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    const regionTable = structuredClone(routeTable);
    regionTable.name = "service_regions";
    regionTable.unique_constraints = [{ name: "service_regions_pkey", columns: ["id"] }];
    regionTable.indexes = [{ name: "service_regions_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(routeTable, regionTable);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.resources = candidate.pack.resources.filter(
      (resource) => resource.id === "public.service_visits",
    );
    candidate.pack.resources[0]!.relationships = [];
    const progress = createBoundaryReviewProgress({
      draft: build.exploration_boundary,
      candidate,
      confirmedDecisions: [],
      actor: "alice",
      revision: 1,
    });
    const actions = [
      { resource_id: "public.service_routes", action: "add" as const },
      { resource_id: "public.service_routes", action: "remove" as const },
      undefined,
    ];
    let chooseCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => {
        chooseCalls += 1;
        if (chooseCalls === 2) {
          const saved = JSON.parse(await fs.readFile(
            path.join(root, ".synapsor/boundary-review-progress.json"),
            "utf8",
          ));
          expect(saved.candidate.pack.resources.map((resource: { id: string }) => resource.id))
            .toEqual(["public.service_routes", "public.service_visits"]);
          expect(saved.candidate.pack.resources
            .find((resource: { id: string }) => resource.id === "public.service_visits")
            .relationships.map((relationship: { target_resource: string }) => relationship.target_resource))
            .toEqual(["public.service_routes"]);
        }
        if (chooseCalls === 3) {
          const saved = JSON.parse(await fs.readFile(
            path.join(root, ".synapsor/boundary-review-progress.json"),
            "utf8",
          ));
          expect(saved.candidate.pack.resources.map((resource: { id: string }) => resource.id))
            .toEqual(["public.service_visits"]);
          expect(saved.candidate.pack.resources[0].relationships).toEqual([]);
        }
        return actions.shift();
      },
      editFieldTiers: async (view) => {
        expect(view.candidate?.id).toBe("public.service_routes");
        return "back";
      },
      promptText: async () => {
        throw new Error("Focused add/remove must not request repeated reviewer text.");
      },
      confirm: async () => {
        throw new Error("Explicit Add and Remove keys stage only a disabled draft and need no extra prompt.");
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await saveBoundaryReviewProgress(root, progress);
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      const saved = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(saved.candidate.pack.resources.map((resource: { id: string }) => resource.id))
        .toEqual(["public.service_visits"]);
      expect(chooseCalls).toBe(3);
      expect(output).toContain("Draft added: public.service_routes");
      expect(output).toContain("Draft removed: public.service_routes");
      expect(output).toContain("Access editor closed. Reviewed authority is unchanged.");
      expect(output).toContain("Returning to Ask.");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("changes one table's minimum group size with default-Yes save and activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-group-size-one-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [
      { resource_id: "public.service_visits", action: "privacy" as const },
      undefined,
    ];
    const text = ["1", "Owner-reviewed local analysis may show groups of one."];
    const confirmationPrompts: string[] = [];
    const confirmationDefaults: Array<boolean | undefined> = [];
    let chooseCalls = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (_resources, _overview, options) => {
        chooseCalls += 1;
        if (chooseCalls === 2) {
          expect(options?.initialResourceId).toBe("public.service_visits");
        }
        return choices.shift();
      },
      editFieldTiers: async () => {
        throw new Error("Table privacy must not open the column editor.");
      },
      promptText: async () => text.shift(),
      confirm: async (prompt, options) => {
        confirmationPrompts.push(prompt);
        confirmationDefaults.push(options?.defaultValue);
        return confirmationDefaults.length === 1;
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress.candidate.pack.resources[0].minimum_cohort_size).toBe(1);
      expect(output).toContain("PRIVACY - public.service_visits");
      expect(output).toContain("Current minimum group size: 5");
      expect(output).toContain("press C (Review + activate)");
      expect(confirmationPrompts).toEqual([
        "Save this privacy change for public.service_visits?",
        "Review and activate this boundary change now?",
      ]);
      expect(confirmationDefaults).toEqual([true, true]);
      expect(chooseCalls).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("sets one cohort threshold across the boundary and makes pending activation explicit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-cohort-all-"));
    const inspection = boundaryInspection();
    const second = structuredClone(inspection.tables[0]!);
    second.name = "service_routes";
    second.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    second.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(second);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const choices = [{ action: "privacy_all" as const }, undefined];
    const text = ["1", "Local owner review for this non-production demonstration."];
    const confirmations = [true, false];
    const prompts: string[] = [];
    const confirmationPrompts: string[] = [];
    const confirmationDefaults: Array<boolean | undefined> = [];
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async () => choices.shift(),
      editFieldTiers: async () => {
        throw new Error("Boundary-wide privacy must not open one table's column editor.");
      },
      promptText: async (prompt) => {
        prompts.push(prompt);
        return text.shift();
      },
      confirm: async (prompt, options) => {
        confirmationPrompts.push(prompt);
        confirmationDefaults.push(options?.defaultValue);
        return confirmations.shift();
      },
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress.candidate.pack.resources).toHaveLength(2);
      expect(progress.candidate.pack.resources.every((resource: { minimum_cohort_size: number }) =>
        resource.minimum_cohort_size === 1)).toBe(true);
      expect(output).toContain("PRIVACY - ALL 2 TABLES IN THIS BOUNDARY");
      expect(output).toContain("Enter a whole number from 1 through 5");
      expect(output).toContain("Consequence: aggregate output may contain groups with one person or record");
      expect(output).toContain("Saved minimum group size 1 (small-group suppression off) for 2 tables");
      expect(output).toContain("1 pending boundary change is not active");
      expect(output).toContain("press C (Review + activate)");
      expect(prompts).toEqual([
        "New minimum group size for all tables [current 5]: ",
        "Reason for setting 2 tables to minimum group size 1 (recorded with this decision): ",
      ]);
      expect(confirmationPrompts).toEqual([
        "Save this privacy change for 2 tables?",
        "Review and activate this boundary change now?",
      ]);
      expect(confirmationDefaults).toEqual([true, true]);
      expect(confirmations).toHaveLength(0);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses a requested relationship when its target table is not in the boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-missing-target-"));
    const inspection = boundaryInspection();
    const visits = inspection.tables[0]!;
    const routeId = structuredClone(visits.columns[0]!);
    routeId.name = "route_id";
    visits.columns.push(routeId);
    visits.suggestions.default_visible_columns.push("route_id");
    visits.foreign_keys = [{
      name: "service_visits_route_id_fkey",
      columns: ["route_id"],
      referenced_schema: "public",
      referenced_table: "service_routes",
      referenced_columns: ["id"],
      delete_rule: "RESTRICT",
    }];
    const routes = structuredClone(visits);
    routes.name = "service_routes";
    routes.foreign_keys = [];
    routes.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    routes.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(routes);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.resources = candidate.pack.resources.filter(
      (resource) => resource.id === "public.service_visits",
    );
    candidate.pack.resources[0]!.relationships = [];
    const progress = createBoundaryReviewProgress({
      draft: build.exploration_boundary,
      candidate,
      confirmedDecisions: [],
      actor: "alice",
      revision: 1,
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await saveBoundaryReviewProgress(root, progress);
      await expect(main([
        "boundary", "review", "resource", "public.service_visits",
        "--project-root", root,
        "--relationships", "service_visits_route_id_fkey",
        "--actor", "alice",
        "--reason", "Review only a complete proven relationship path.",
      ], {
        boundarySchemaInspector: async () => inspection,
      })).rejects.toThrow(
        /service_visits_route_id_fkey requires public\.service_routes.*include that table first/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("creates, switches, and deletes named disabled boundaries without changing active authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-library-cli-"));
    const inspection = boundaryInspection();
    const routes = structuredClone(inspection.tables[0]!);
    routes.name = "service_routes";
    routes.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
    routes.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
    inspection.tables.push(routes);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const originalName = build.exploration_boundary.pack.name;
    let call = 0;
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (resources, overview, options) => {
        if (options?.startingBoundaryName) {
          expect(options.startingBoundaryName).toBe("support_analytics");
          expect(resources.every((resource) => !resource.included)).toBe(true);
          expect(resources.map((resource) => resource.resource_id))
            .toEqual(["public.service_routes", "public.service_visits"]);
          return { resource_id: "public.service_routes", action: "add" };
        }
        call += 1;
        if (call === 1) return { action: "create" };
        if (call === 2) {
          const stored = JSON.parse(await fs.readFile(
            path.join(root, ".synapsor/boundary-library.json"),
            "utf8",
          ));
          expect(stored.boundaries.support_analytics.candidate.pack.resources)
            .toMatchObject([{ id: "public.service_routes", relationships: [] }]);
          expect(overview?.boundaries).toHaveLength(2);
          expect(overview?.boundaries?.find((entry) => entry.name === "support_analytics")?.selected)
            .toBe(true);
          return { action: "switch", boundary_name: originalName };
        }
        if (call === 3) {
          expect(overview?.boundaries?.find((entry) => entry.name === originalName)?.selected)
            .toBe(true);
          return { action: "delete", boundary_name: "support_analytics" };
        }
        return undefined;
      },
      editFieldTiers: async () => undefined,
      promptText: async () => "support_analytics",
      confirm: async () => true,
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      const library = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-library.json"),
        "utf8",
      ));
      expect(library.selected_name).toBe(originalName);
      expect(Object.keys(library.boundaries)).toEqual([originalName]);
      expect(output).toContain('Created disabled boundary "support_analytics"');
      expect(output).toContain("with public.service_routes");
      expect(output).toContain(`Opened saved boundary "${originalName}"`);
      expect(output).toContain('Deleted saved disabled boundary "support_analytics"');
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps invalid interactive boundary names inside review and normalizes ordinary capitalization", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-name-cli-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const names = ["hotel/analytics", "Test_hotel"];
    let chooseCalls = 0;
    const activationHandoff = vi.fn(async () => 0);
    const session: BoundaryReviewInteractiveSession = {
      chooseResource: async (resources, overview, options) => {
        if (options?.startingBoundaryName) {
          expect(options.startingBoundaryName).toBe("test_hotel");
          expect(resources.map((resource) => resource.resource_id))
            .toContain("public.service_visits");
          return { resource_id: "public.service_visits", action: "add" };
        }
        chooseCalls += 1;
        if (chooseCalls <= 2) return { action: "create" };
        expect(overview?.boundaries?.some((entry) => entry.name === "test_hotel"))
          .toBe(true);
        return undefined;
      },
      editFieldTiers: async () => undefined,
      promptText: async () => names.shift() ?? "",
      confirm: async () => true,
    };
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session, activationHandoff)).resolves.toBe(0);
      const library = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-library.json"),
        "utf8",
      ));
      expect(library.selected_name).toBe("test_hotel");
      expect(output).toContain("Boundary was not created.");
      expect(output).toContain("You are still in boundary review.");
      expect(output).toContain('Using lower-case boundary name "test_hotel".');
      expect(output).toContain('Created disabled boundary "test_hotel"');
      expect(output).not.toContain("Ask did not start");
      expect(activationHandoff).not.toHaveBeenCalled();
      expect(chooseCalls).toBe(3);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("conservatively rebases another saved draft after reviewed generation inputs change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-library-rebase-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      let context = await loadBoundaryReviewContext(root);
      await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
      });
      await createSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        name: "support_analytics",
        resourceId: "public.service_visits",
        actor: "alice",
      });
      context = await loadBoundaryReviewContext(root);
      await switchSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
        name: build.exploration_boundary.pack.name,
      });

      const preview = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        keep_out_fields: ["status"],
        actor: "alice",
        reason: "Keep status unavailable in this reviewed analytics boundary.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, preview);

      context = await loadBoundaryReviewContext(root);
      const snapshot = await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
      });
      expect(snapshot.entries).toHaveLength(2);
      const restored = await switchSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        currentProgress: context.progress,
        name: "support_analytics",
      });
      expect(restored.candidate).toMatchObject({
        generation_lock_fingerprint: context.draft.generation_lock_fingerprint,
        pack: {
          name: "support_analytics",
          resources: [{
            id: "public.service_visits",
            kept_out_fields: expect.arrayContaining(["status"]),
          }],
        },
      });
      expect(restored.confirmed_decisions).not.toEqual(
        restored.candidate.unresolved_decisions,
      );
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("records a narrow schema-enum allowlist and disables value operations when none remain", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-enum-review-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      expect(build.exploration_boundary.pack.resources[0]!.field_enums.status)
        .toEqual(["scheduled", "completed"]);

      const narrowed = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        field_enum: { field: "status", values: ["completed"] },
        actor: "alice",
        reason: "Keep the agent on completed service visits only.",
      }, async () => inspection);
      expect(narrowed.semantic_diff.reviewed_enum_changes).toEqual([{
        field: "status",
        before: ["scheduled", "completed"],
        after: ["completed"],
      }]);
      await commitBoundaryResourceReviewMutation(root, narrowed);
      let context = await loadBoundaryReviewContext(root);
      expect(context.candidate.pack.resources[0]!.field_enums.status).toEqual(["completed"]);

      await expect(prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        field_enum: { field: "status", values: ["completed", "invented"] },
        actor: "alice",
        reason: "This must not widen the database-declared set.",
      }, async () => inspection)).rejects.toThrow(/may only remove schema-declared values.*invented/i);

      const disabled = await prepareBoundaryResourceReviewMutation(root, {
        resource_id: "public.service_visits",
        field_enum: { field: "status", values: [] },
        actor: "alice",
        reason: "Do not let this boundary filter or group by service status.",
      }, async () => inspection);
      await commitBoundaryResourceReviewMutation(root, disabled);
      context = await loadBoundaryReviewContext(root);
      const resource = context.candidate.pack.resources[0]!;
      expect(resource.field_enums).not.toHaveProperty("status");
      expect(resource.filterable_fields).not.toHaveProperty("status");
      expect(resource.groupable_fields).not.toContain("status");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("renames and deletes disabled saved boundaries through the CLI front door", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-library-cli-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const context = await loadBoundaryReviewContext(root);
      await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
      });
      await createSavedBoundary({
        projectRoot: root,
        draft: context.draft,
        currentCandidate: context.candidate,
        name: "support_analytics",
        resourceId: "public.service_visits",
        actor: "alice",
      });

      await expect(boundaryCommand([
        "rename", "support_analytics",
        "--to", "support_team",
        "--actor", "alice",
        "--reason", "Use the team-facing boundary name.",
        "--project-root", root,
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      let library = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-library.json"),
        "utf8",
      ));
      expect(library.selected_name).toBe("support_team");
      expect(library.boundaries).toHaveProperty("support_team");
      expect(library.boundaries).not.toHaveProperty("support_analytics");

      await expect(boundaryCommand([
        "delete", "support_team",
        "--yes",
        "--project-root", root,
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      library = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-library.json"),
        "utf8",
      ));
      expect(library.boundaries).not.toHaveProperty("support_team");
      expect(Object.keys(library.boundaries)).toHaveLength(1);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("creates and activates an additional boundary in the active development profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-profile-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const development = reviewExplorationBoundaryCandidate(
        build.exploration_boundary,
        {
          ...structuredClone(build.exploration_boundary),
          deployment_profile: "development",
        },
      ).candidate;
      const firstDigest = explorationBoundaryCandidateDigest(development);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: development,
        expectedDigest: firstDigest,
        actor: "first-reviewer",
        confirmation: `ACTIVATE ${firstDigest}`,
        confirmedDecisions: development.unresolved_decisions,
        currentInspection: inspection,
      });

      const progress = await createSavedBoundary({
        projectRoot: root,
        draft: build.exploration_boundary,
        currentCandidate: build.exploration_boundary,
        name: "products",
        resourceId: build.exploration_boundary.pack.resources[0]!.id,
        actor: "second-reviewer",
      });
      expect(progress.candidate.deployment_profile).toBe("development");

      const secondDigest = explorationBoundaryCandidateDigest(progress.candidate);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: progress.candidate,
        expectedDigest: secondDigest,
        actor: "second-reviewer",
        confirmation: `ACTIVATE ${secondDigest}`,
        confirmedDecisions: progress.candidate.unresolved_decisions,
        currentInspection: inspection,
        activeSetMode: "add",
      });
      const active = await loadActivatedExplorationBoundaries(root);
      expect(active).toHaveLength(2);
      expect(active.map((boundary) => boundary.deployment_profile)).toEqual([
        "development",
        "development",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("invalidates stale profile review when restoring an existing disabled boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-profile-rebase-"));
    const inspection = boundaryInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const development = reviewExplorationBoundaryCandidate(
        build.exploration_boundary,
        {
          ...structuredClone(build.exploration_boundary),
          deployment_profile: "development",
        },
      ).candidate;
      const activeDigest = explorationBoundaryCandidateDigest(development);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: development,
        expectedDigest: activeDigest,
        actor: "first-reviewer",
        confirmation: `ACTIVATE ${activeDigest}`,
        confirmedDecisions: development.unresolved_decisions,
        currentInspection: inspection,
      });

      const staleCandidate = structuredClone(build.exploration_boundary);
      staleCandidate.pack.name = "products";
      staleCandidate.pack.resources = [{
        ...structuredClone(staleCandidate.pack.resources[0]!),
        relationships: [],
      }];
      const reviewedStale = reviewExplorationBoundaryCandidate(
        build.exploration_boundary,
        staleCandidate,
      ).candidate;
      const staleProgress = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: reviewedStale,
        confirmedDecisions: reviewedStale.unresolved_decisions,
        actor: "stale-reviewer",
        revision: 1,
      });
      await saveBoundaryReviewProgress(root, staleProgress);

      let observedOutstanding: number | undefined;
      let observedEntryOutstanding: number | undefined;
      const session: BoundaryReviewInteractiveSession = {
        chooseResource: async (_resources, overview) => {
          observedOutstanding = overview?.outstanding_decisions;
          observedEntryOutstanding = overview?.boundaries?.find(
            (entry) => entry.name === "products",
          )?.outstanding_decisions;
          return undefined;
        },
        editFieldTiers: async () => undefined,
        promptText: async () => undefined,
        confirm: async () => undefined,
      };
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await expect(boundaryReviewCommandInternal([
        "--project-root", root,
        "--access",
      ], async () => inspection, session)).resolves.toBe(0);
      expect(observedOutstanding).toBe(1);
      expect(observedEntryOutstanding).toBe(1);
      const aligned = await readBoundaryReviewProgress(root, build.exploration_boundary);
      expect(aligned?.candidate.deployment_profile).toBe("development");
      expect(aligned?.confirmations).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "global.deployment_profile" }),
      ]));
      expect(aligned?.invalidated_decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "global.deployment_profile",
          reason: "reviewed_input_changed",
        }),
      ]));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("applies a versioned multi-resource decision file atomically without activating authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-cli-batch-"));
    const inspection = batchBoundaryInspection();
    const project = {
      root,
      package_manager: "npm" as const,
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    };
    const build = buildAutoBoundary({
      inspection,
      project,
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    expect(build.exploration_boundary.pack.resources).toEqual([]);
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const guided = await initializeGuidedProject({
        projectRoot: root,
        build,
        runnerVersion: "1.6.5",
      });
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const publicPath = path.join(path.dirname(guided.config_path), "batch-reviewer.pub.pem");
      const privatePath = path.join(root, "batch-reviewer.private.pem");
      await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
      await fs.writeFile(
        privatePath,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        { encoding: "utf8", mode: 0o600 },
      );
      const config = JSON.parse(await fs.readFile(guided.config_path, "utf8"));
      config.operator_identity = {
        provider: "signed_key",
        operators: {
          alice: {
            public_key_path: "./batch-reviewer.pub.pem",
            roles: ["boundary_reviewer"],
          },
        },
      };
      await fs.writeFile(guided.config_path, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      const bundlePath = path.join(root, "boundary-review.json");
      await boundaryReviewCommand([
        "--project-root", root,
        "--output", bundlePath,
      ], async () => inspection);
      const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
      expect(bundle.mutation_bindings).toMatchObject({
        candidate_digest: bundle.candidate_digest,
        review_revision: 0,
      });

      const resources = [
        {
          resource_id: "public.service_routes",
          include: true,
          tenant_key: "tenant_id",
          principal_key: null,
          selectable_fields: ["id", "status"],
        },
        {
          resource_id: "public.service_visits",
          include: true,
          tenant_key: "tenant_id",
          principal_key: null,
          selectable_fields: ["id", "scheduled_at", "status"],
        },
      ];
      const decision = {
        schema_version: "synapsor.boundary-review-decisions.v1",
        review_bundle_digest: bundle.bundle_digest,
        bindings: bundle.mutation_bindings,
        actor: "alice",
        reason: "Both service resources use the reviewed tenant column and need no principal restriction.",
        resources,
      };
      const decisionPath = path.join(root, "boundary-decisions.json");
      await fs.writeFile(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");

      const duplicatePath = path.join(root, "duplicate-decisions.json");
      await fs.writeFile(
        duplicatePath,
        `${JSON.stringify({ ...decision, resources: [resources[0], resources[0]] }, null, 2)}\n`,
        "utf8",
      );
      await expect(boundaryReviewCommand([
        "--project-root", root,
        "--apply-decisions", duplicatePath,
        "--json",
      ], async () => inspection)).rejects.toThrow(/repeats resource/i);
      await expect(fs.access(path.join(root, ".synapsor/boundary-review-progress.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const unknownPath = path.join(root, "unknown-decisions.json");
      await fs.writeFile(
        unknownPath,
        `${JSON.stringify({
          ...decision,
          resources: [{ ...resources[0], resource_id: "public.not_inspected" }],
        }, null, 2)}\n`,
        "utf8",
      );
      await expect(boundaryReviewCommand([
        "--project-root", root,
        "--apply-decisions", unknownPath,
        "--json",
      ], async () => inspection)).rejects.toThrow(/unknown resource/i);

      output = "";
      await expect(boundaryReviewCommand([
        "--project-root", root,
        "--apply-decisions", decisionPath,
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      const preview = JSON.parse(output);
      expect(preview).toMatchObject({
        ok: true,
        schema_version: "synapsor.boundary-review-mutation-batch-preview.v1",
        authority_activated: false,
        source_database_changed: false,
      });
      expect(preview.semantic_diff).toHaveLength(2);

      output = "";
      await expect(boundaryReviewCommand([
        "--project-root", root,
        "--apply-decisions", decisionPath,
        "--apply",
        "--confirm", `APPLY REVIEW ${preview.decision_digest}`,
        "--config", guided.config_path,
        "--identity", "alice",
        "--identity-key", privatePath,
        "--required-role", "boundary_reviewer",
        "--nonce", "batch-resource-review-nonce-0001",
        "--json",
      ], async () => inspection)).resolves.toBe(0);
      const applied = JSON.parse(output);
      expect(applied).toMatchObject({
        ok: true,
        review_revision: 1,
        source_database_changed: false,
      });
      const progress = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(progress.candidate.pack.resources.map((resource: { id: string }) => resource.id))
        .toEqual(["public.service_routes", "public.service_visits"]);
      await expect(fs.access(path.join(root, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      await expect(boundaryReviewCommand([
        "--project-root", root,
        "--apply-decisions", decisionPath,
        "--json",
      ], async () => inspection)).rejects.toThrow(/stale|another review bundle/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function boundaryInspection(): SchemaInspection {
  const column = (name: string, dataType: string, tenant = false) => ({
    name,
    data_type: dataType,
    nullable: false,
    generated: false,
    ordinal_position: 1,
    suggestions: {
      tenant,
      conflict: false,
      sensitive: false,
      immutable: name === "id" || tenant,
      large_or_binary: false,
    },
  });
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16",
    current_user: "app_reader",
    inspected_at: "2026-07-25T12:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    tables: [{
      schema: "public",
      name: "service_visits",
      type: "table",
      writable: true,
      columns: [
        column("id", "uuid"),
        column("tenant_id", "uuid", true),
        { ...column("status", "text"), enum_values: ["scheduled", "completed"] },
        column("scheduled_at", "timestamp"),
      ],
      primary_key: ["id"],
      unique_constraints: [{ name: "service_visits_pkey", columns: ["id"] }],
      foreign_keys: [],
      indexes: [{ name: "service_visits_pkey", columns: ["id"], unique: true }],
      row_level_security: true,
      row_level_security_policies: [{
        name: "tenant_read",
        command: "SELECT",
        permissive: true,
        roles: ["app_reader"],
        using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
      }],
      role_posture: {
        owner: "app_owner",
        current_role_is_owner: false,
        current_role_can_assume_owner: false,
        privileges: {
          select: true,
          insert: false,
          update: false,
          delete: false,
          truncate: false,
          references: false,
          trigger: false,
        },
        row_security_forced: false,
        row_security_effective_for_current_role: true,
      },
      suggestions: {
        tenant_columns: ["tenant_id"],
        conflict_columns: [],
        sensitive_columns: [],
        default_visible_columns: ["id", "tenant_id", "status", "scheduled_at"],
      },
    }],
  };
}

function batchBoundaryInspection(): SchemaInspection {
  const inspection = boundaryInspection();
  const visits = inspection.tables[0]!;
  const routes = structuredClone(visits);
  routes.name = "service_routes";
  routes.primary_key = ["id"];
  routes.unique_constraints = [{ name: "service_routes_pkey", columns: ["id"] }];
  routes.indexes = [{ name: "service_routes_pkey", columns: ["id"], unique: true }];
  for (const table of [visits, routes]) {
    table.row_level_security = false;
    table.row_level_security_policies = [];
    table.role_posture!.row_security_effective_for_current_role = false;
    table.suggestions.tenant_columns = [];
  }
  inspection.tables.push(routes);
  return inspection;
}

async function initializeSignedReviewProject(
  root: string,
  inspection: SchemaInspection,
): Promise<{ configPath: string; privateKeyPath: string }> {
  const build = buildAutoBoundary({
    inspection,
    project: {
      root,
      package_manager: "npm",
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    },
    sourceEnv: "DATABASE_URL",
    inspectedSchema: "public",
  });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  const guided = await initializeGuidedProject({
    projectRoot: root,
    build,
    runnerVersion: "1.6.6",
  });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyPath = path.join(path.dirname(guided.config_path), "reviewer.pub.pem");
  const privateKeyPath = path.join(root, "reviewer.private.pem");
  await fs.writeFile(
    publicKeyPath,
    publicKey.export({ type: "spki", format: "pem" }).toString(),
    "utf8",
  );
  await fs.writeFile(
    privateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    { encoding: "utf8", mode: 0o600 },
  );
  const config = JSON.parse(await fs.readFile(guided.config_path, "utf8"));
  config.operator_identity = {
    provider: "signed_key",
    operators: {
      alice: {
        public_key_path: "./reviewer.pub.pem",
        roles: ["boundary_reviewer"],
      },
    },
  };
  await fs.writeFile(guided.config_path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return {
    configPath: guided.config_path,
    privateKeyPath,
  };
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary, explorationBoundaryCandidateDigest, writeAutoBoundaryArtifacts } from "./auto-boundary.js";
import {
  boundaryActivateCommand,
  boundaryReviewCommand,
} from "./cli.js";
import {
  createBoundaryReviewProgress,
  saveBoundaryReviewProgress,
} from "./local-ui.js";
import { initializeGuidedProject } from "./guided-project.js";

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
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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
        column("status", "text"),
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

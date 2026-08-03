import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivatedExplorationBoundary, ExplorationBoundaryDraft } from "./auto-boundary.js";
import {
  proveActiveExploreBoundaries,
  writeBoundaryProofArtifact,
} from "./boundary-proof.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("active boundary proof", () => {
  it("drives deterministic attacks through app.explore_data and stores only a redacted proof", async () => {
    let suppressedGroupingReleased = false;
    const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      const plan = args.plan as Record<string, unknown>;
      if (Array.isArray(plan.dimensions) && plan.dimensions.length > 0) {
        suppressedGroupingReleased = true;
        return {
          ok: true,
          value: {
            ok: true,
            data: [{ status: "private-value-not-persisted", count: 7 }],
            privacy: { suppressed_groups: 1 },
            source_database_changed: false,
          },
        };
      }
      if (suppressedGroupingReleased && plan.kind === "aggregate") {
        return {
          ok: false,
          value: {
            ok: false,
            error_code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
            details: {
              reason: "complementary_aggregate_release",
              source_query_executed: true,
            },
            source_database_changed: false,
          },
          error_code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
        };
      }
      const code = Object.hasOwn(args, "sql")
        || Object.hasOwn(plan, "tenant")
        || Object.hasOwn(plan, "principal")
        || Object.hasOwn(plan, "minimum_cohort_size")
        ? "MCP_TOOL_REFUSED"
        : Array.isArray(plan.select) && plan.select.includes("secret_note")
          ? "EXPLORE_FIELD_FORBIDDEN"
          : plan.relationship === "orders_customer_fkey"
            ? "EXPLORE_RELATIONSHIP_FORBIDDEN"
            : plan.top_n === 11
              ? "EXPLORE_PLAN_INVALID"
              : "UNEXPECTED_SUCCESS";
      return {
        ok: false,
        value: { ok: false, error_code: code, source_database_changed: false },
        error_code: code,
      };
    });
    const proof = await proveActiveExploreBoundaries({
      gateway: { callTool },
      boundaries: [activeBoundary()],
      draft: draftBoundary(),
      now: () => Date.parse("2026-08-01T12:00:00.000Z"),
    });

    expect(callTool).toHaveBeenCalledTimes(9);
    expect(callTool.mock.calls.every(([name]) => name === "app.explore_data")).toBe(true);
    expect(proof).toMatchObject({
      schema_version: "synapsor.boundary-proof.v1",
      passed: true,
      source_rows_returned: 0,
      source_database_changed: false,
      attacks: expect.arrayContaining([
        expect.objectContaining({ id: "raw_sql", passed: true, source_query_executed: false }),
        expect.objectContaining({ id: "tenant_override", passed: true }),
        expect.objectContaining({ id: "kept_out_field", passed: true }),
        expect.objectContaining({ id: "unreviewed_relationship", passed: true }),
        expect.objectContaining({ id: "result_budget", passed: true }),
        expect.objectContaining({ id: "suppression_override", passed: true }),
        expect.objectContaining({
          id: "suppressed_total_subtraction",
          passed: true,
          source_query_executed: true,
        }),
      ]),
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-proof-"));
    roots.push(root);
    const artifactPath = await writeBoundaryProofArtifact({ projectRoot: root, proof });
    const artifact = await fs.readFile(artifactPath, "utf8");
    expect(artifact).toContain(proof.proof_digest);
    expect(artifact).not.toContain("SELECT 1");
    expect(artifact).not.toContain("another-tenant");
    expect(artifact).not.toContain("secret_note");
    expect(artifact).not.toContain("private-value-not-persisted");
  });

  it("does not call an unexpected success a passing proof", async () => {
    const proof = await proveActiveExploreBoundaries({
      gateway: {
        callTool: async (_name, args) => {
          const plan = args.plan as Record<string, unknown>;
          return {
            ok: true,
            value: {
              ok: true,
              ...(Array.isArray(plan.dimensions) && plan.dimensions.length > 0
                ? { privacy: { suppressed_groups: 1 } }
                : {}),
            },
          };
        },
      },
      boundaries: [activeBoundary()],
      now: () => Date.parse("2026-08-01T12:00:00.000Z"),
    });
    expect(proof.passed).toBe(false);
    expect(proof.attacks.every((attack) => attack.passed === false)).toBe(true);
  });

  it("does not treat a generic MCP refusal as proof of field, relationship, or budget enforcement", async () => {
    const proof = await proveActiveExploreBoundaries({
      gateway: {
        callTool: async () => ({
          ok: false,
          value: { ok: false },
          error_code: "MCP_TOOL_REFUSED",
        }),
      },
      boundaries: [activeBoundary()],
      draft: draftBoundary(),
      now: () => Date.parse("2026-08-01T12:00:00.000Z"),
    });
    expect(proof.passed).toBe(false);
    expect(proof.attacks.find((attack) => attack.id === "raw_sql")?.passed).toBe(true);
    expect(proof.attacks.find((attack) => attack.id === "kept_out_field")?.passed).toBe(false);
    expect(proof.attacks.find((attack) => attack.id === "unreviewed_relationship")?.passed).toBe(false);
    expect(proof.attacks.find((attack) => attack.id === "result_budget")?.passed).toBe(false);
  });
});

function activeBoundary(): ActivatedExplorationBoundary {
  return {
    pack: {
      name: "reviewed_staging",
      resources: [{
        id: "public.orders",
        table: "orders",
        primary_key: "id",
        selectable_fields: ["id", "status"],
        kept_out_fields: ["secret_note"],
        model_withheld_fields: [],
        groupable_fields: ["status"],
        minimum_cohort_size: 5,
        relationships: [],
      }],
    },
    budgets: { max_top_n: 10 },
    activation: { digest: `sha256:${"a".repeat(64)}` },
  } as unknown as ActivatedExplorationBoundary;
}

function draftBoundary(): ExplorationBoundaryDraft {
  const active = activeBoundary();
  return {
    ...active,
    pack: {
      ...active.pack,
      resources: [{
        ...active.pack.resources[0]!,
        relationships: [{
          id: "orders_customer_fkey",
          target_resource: "public.customers",
        }],
      }],
    },
  } as unknown as ExplorationBoundaryDraft;
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivatedExplorationBoundary } from "./auto-boundary.js";
import type { ScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";
import { formatTryExploreRefusal, tryCommand } from "./try-commands.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

describe("Try command recovery", () => {
  it("renders exact operator recovery for a direct Explore refusal", () => {
    const rendered = formatTryExploreRefusal({
      code: "EXPLORE_FIELD_FORBIDDEN",
      message: "public.support_tickets.account_id is not reviewed for group.",
    }, {
      kind: "reviewed_view_required",
      title: "public.support_tickets.account_id is not available as a grouped output",
      message: "Reference identifiers are not generated as group labels.",
      review_boundary: "reviewed_staging",
      review_resource: "public.support_tickets",
      review_field: "account_id",
      next_action: "Ask to group Support tickets by Company name through the reviewed relationship.",
    });

    expect(rendered).toContain("Runner refused this analysis");
    expect(rendered).toContain("EXPLORE_FIELD_FORBIDDEN");
    expect(rendered).toContain("Source query executed: no");
    expect(rendered).toContain("Next: Ask to group Support tickets by Company name");
  });

  it("states when a complementary direct Explore result was executed and discarded", () => {
    const rendered = formatTryExploreRefusal({
      code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
      message: "The complementary aggregate was refused.",
    }, {
      kind: "review_candidate",
      title: "A complementary total was blocked to protect a withheld group",
      message: "Returning the total could reconstruct the hidden count by subtraction.",
      review_boundary: "reviewed_staging",
      review_resource: "public.accounts",
      review_focus: "privacy",
      source_query_executed: true,
      next_action: "/access -> boundary reviewed_staging -> table public.accounts -> Privacy (P)",
    });

    expect(rendered).toContain("Source query executed: yes; Runner discarded the result before release");
    expect(rendered).toContain("Privacy (P)");
  });

  it("reports one path-free recovery action when Explore has no active boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-try-no-boundary-"));
    roots.push(root);

    const error = await tryCommand([
      "explore",
      "--project-root", root,
    ]).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "EXPLORE_DISABLED",
      message: "No reviewed analytics access is active. Run `synapsor-runner start` and complete the local data-access review.",
    });
    expect(String(error)).not.toContain(root);
    expect(String(error)).not.toContain("ENOENT");
  });

  it("canonicalizes one reviewed resource label before building a friendly Explore plan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-try-resource-alias-"));
    roots.push(root);
    const boundary = friendlyBoundary("subscription_boundary", "public.subscriptions");
    const explore = vi.fn(async () => ({
      ok: true,
      outcome: { type: "success" },
      data: [],
      source_database_changed: false,
    }));
    const close = vi.fn(async () => undefined);
    const runtime = {
      boundary,
      boundaries: [boundary],
      active_boundary_set_digest: `sha256:${"2".repeat(64)}`,
      session_fingerprint: `sha256:${"3".repeat(64)}`,
      describe: vi.fn(),
      explore,
      projectResultForModel: vi.fn(),
      close,
    } as unknown as ScopedExploreBoundarySetRuntime;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(tryCommand([
      "explore",
      "--project-root", root,
      "--boundary", "subscription_boundary",
      "--resource", "Subscriptions",
      "--count",
      "--group-by", "plan",
      "--json",
    ], {
      createScopedExploreBoundarySetRuntimeFn: async () => runtime,
    })).resolves.toBe(0);

    expect(explore).toHaveBeenCalledWith(expect.objectContaining({
      kind: "aggregate",
      resource: "public.subscriptions",
      dimensions: [{ field: "plan" }],
    }), "subscription_boundary");
    expect(close).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalled();
  });

  it("reports the same path-free recovery for explicit and latest Protect selection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-protect-no-boundary-"));
    roots.push(root);

    for (const selection of [["--last"], ["--from", "A1"]]) {
      const error = await tryCommand([
        "protect",
        "--project-root", root,
        ...selection,
        "--name", "analytics.test_analysis",
      ]).catch((failure: unknown) => failure);

      expect(error).toMatchObject({
        code: "EXPLORE_DISABLED",
        message: "No reviewed analytics access is active. Run `synapsor-runner start` and complete the local data-access review.",
      });
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toContain("ENOENT");
      expect(String(error)).not.toContain("exploration-boundary.active.json");
    }
  });
});

function friendlyBoundary(
  name: string,
  resourceId: string,
): ActivatedExplorationBoundary {
  const [schema, table] = resourceId.split(".");
  return {
    pack: {
      name,
      resources: [{
        id: resourceId,
        schema,
        table,
        groupable_fields: ["plan"],
        count_distinct_fields: ["id"],
        aggregate_measures: [],
        time_bucket_fields: {},
      }],
    },
    budgets: { max_top_n: 25 },
    activation: {
      state: "active",
      digest: `sha256:${"1".repeat(64)}`,
    },
  } as unknown as ActivatedExplorationBoundary;
}

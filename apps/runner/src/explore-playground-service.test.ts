import { describe, expect, it, vi } from "vitest";
import {
  describeExplorePlaygroundScope,
  normalizeExplorePlaygroundRequest,
  runExplorePlaygroundRequest,
  validateExplorePlaygroundRequest,
} from "./explore-playground-service.js";
import { ScopedExploreError } from "./scoped-explore.js";

describe("Explore Plan Playground service", () => {
  it("accepts a raw plan or exact MCP envelope and refuses conflicting or expanded envelopes", () => {
    const plan = { kind: "aggregate", resource: "public.orders", measures: [{ function: "count" }] };
    expect(normalizeExplorePlaygroundRequest(plan, "finance")).toEqual({
      plan,
      boundary: "finance",
    });
    expect(normalizeExplorePlaygroundRequest({ plan, boundary: "finance" })).toEqual({
      plan,
      boundary: "finance",
    });
    expect(() => normalizeExplorePlaygroundRequest({
      plan,
      boundary: "finance",
      tenant: "attacker-selected",
    })).toThrowError(expect.objectContaining({
      code: "EXPLORE_PLAN_INVALID",
      message: expect.stringContaining("unsupported key(s): tenant"),
    }));
    expect(() => normalizeExplorePlaygroundRequest(
      { plan, boundary: "finance" },
      "support",
    )).toThrowError(expect.objectContaining({
      code: "EXPLORE_BOUNDARY_REQUIRED",
    }));
  });

  it("routes validate and run through one exact boundary-set runtime", async () => {
    const validate = vi.fn(async () => ({ ok: true }));
    const explore = vi.fn(async () => ({ ok: true, data: [] }));
    const runtime = {
      active_boundary_set_digest: `sha256:${"1".repeat(64)}`,
      validate,
      explore,
    } as never;
    const request = {
      boundary: "finance",
      plan: { kind: "aggregate", resource: "public.orders" },
    };

    await validateExplorePlaygroundRequest(runtime, request);
    await runExplorePlaygroundRequest(runtime, request);

    expect(validate).toHaveBeenCalledWith(request.plan, "finance");
    expect(explore).toHaveBeenCalledWith(request.plan, "finance");
  });

  it("describes only trusted binding sources and never scope values", () => {
    const runtime = {
      trusted_scope: {
        tenant: { source: "verified_http_claim", binding: "tenant_id" },
        principal: { source: "verified_http_claim", binding: "sub" },
      },
    } as never;
    expect(describeExplorePlaygroundScope(runtime)).toEqual({
      tenant: { source: "verified_http_claim", binding: "tenant_id" },
      principal: { source: "verified_http_claim", binding: "sub" },
      raw_values_exposed: false,
    });
    expect(JSON.stringify(describeExplorePlaygroundScope(runtime))).not.toContain("acme");
  });

  it("uses actionable reviewed-plan errors", () => {
    expect(() => normalizeExplorePlaygroundRequest([])).toThrow(ScopedExploreError);
  });
});

import { describe, expect, it } from "vitest";
import {
  actionBoundaryAuthorityDigestV1,
  actionBoundaryReadDependencyDigestV1,
  normalizeActionBoundaryAuthorityV1,
  type ActionBoundaryAuthorityV1,
} from "./action-boundary.js";

function authorityFixture(): ActionBoundaryAuthorityV1 {
  const readDependency = {
    name: "reviewed_staging",
    source: "app_postgres",
    digest: `sha256:${"1".repeat(64)}` as const,
    generation_lock_fingerprint: `sha256:${"2".repeat(64)}` as const,
    trusted_context_fingerprint: `sha256:${"3".repeat(64)}` as const,
  };
  return {
    read_dependencies: [readDependency],
    capabilities: [{
      capability: "support.propose_refund",
      resource: "public.refunds",
      operation: "update",
      contract_digest: `sha256:${"4".repeat(64)}`,
      contract_path: "./synapsor/actions/refund/synapsor.contract.json",
      read_dependency_digest: actionBoundaryReadDependencyDigestV1(readDependency),
    }],
    approval_policies: [{
      capability: "support.propose_refund",
      mode: "policy",
      digest: `sha256:${"5".repeat(64)}`,
    }],
    execution_profiles: [{
      capability: "support.propose_refund",
      authority_posture: "proposal_only",
      writeback_mode: "none",
      digest: `sha256:${"6".repeat(64)}`,
    }],
    shared_limits: [{
      id: "daily_refund_total",
      kind: "total",
      scope: "tenant_principal",
      maximum: 5000,
      window_seconds: 86400,
      capability: "support.propose_refund",
      field: "refund_cents",
    }],
  };
}

describe("Action Boundary protocol", () => {
  it("normalizes complete authority and produces a stable digest", () => {
    const authority = authorityFixture();
    const reordered = {
      ...authority,
      capabilities: [...authority.capabilities].reverse(),
      shared_limits: [...authority.shared_limits].reverse(),
    };
    expect(normalizeActionBoundaryAuthorityV1(reordered)).toEqual(authority);
    expect(actionBoundaryAuthorityDigestV1(reordered)).toBe(actionBoundaryAuthorityDigestV1(authority));
  });

  it("rejects incomplete profiles, unknown keys, and missing read dependencies", () => {
    const authority = authorityFixture();
    expect(() => normalizeActionBoundaryAuthorityV1({
      ...authority,
      execution_profiles: [{ capability: "support.propose_refund" }],
    })).toThrow(/missing field authority_posture/);
    expect(() => normalizeActionBoundaryAuthorityV1({
      ...authority,
      shared_limits: [{ ...authority.shared_limits[0], runtime_override: true }],
    })).toThrow(/unknown field runtime_override/);
    expect(() => normalizeActionBoundaryAuthorityV1({
      ...authority,
      capabilities: [{
        ...authority.capabilities[0],
        read_dependency_digest: `sha256:${"f".repeat(64)}`,
      }],
    })).toThrow(/READ_DEPENDENCY_MISSING/);
  });

  it("requires approval and execution authority for the exact capability set", () => {
    const authority = authorityFixture();
    expect(() => normalizeActionBoundaryAuthorityV1({
      ...authority,
      approval_policies: [],
    })).toThrow(/APPROVAL_POLICY_MISSING/);
    expect(() => normalizeActionBoundaryAuthorityV1({
      ...authority,
      execution_profiles: [{
        ...authority.execution_profiles[0],
        capability: "support.propose_other",
      }],
    })).toThrow(/EXECUTION_PROFILE_MISSING/);
  });
});

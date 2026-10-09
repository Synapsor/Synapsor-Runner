import { describe, expect, it, vi } from "vitest";
vi.mock("@synapsor-runner/worker-core", () => import("../../../packages/worker-core/src/mcp-audit.js"));
import { buildAuditCandidateBundle } from "./audit-candidates.js";

// Prospective post-coordinator-finding controls only: NOT RUN, no guard changed.
// Main subsequently required actual canonical typed diagnostic refusal, superseding c48 alias draft.
// External field roles remain untrusted. These tests cannot establish runtime safety or activation.
const bundle = (field: string, role: string, lookup = true) => buildAuditCandidateBundle({ tools: [{
  name: "fixture.operation", description: "Display only.",
  "x-synapsor-audit": { version: 1, operation: "write", boundary: "proposal" },
  inputSchema: { type: "object", properties: {
    ...(lookup ? { fixture_lookup: { type: "string", maxLength: 48, "x-synapsor-audit-role": "lookup" } } : {}),
    [field]: { type: "string", maxLength: 48, "x-synapsor-audit-role": role },
  }, required: [...(lookup ? ["fixture_lookup"] : []), field] },
}] }, "fixture");
const shapes = (value: ReturnType<typeof bundle>) => Object.values(value.contract.capabilities[0]!.args);
const assertBlocked = (value: ReturnType<typeof bundle>) => {
  expect(value.config).toMatchObject({ mode: "shadow", sources: {}, capabilities: [] });
  expect(value.contract.capabilities[0]).toMatchObject({ "x-runner-review-status": "blocked_unreviewed", proposal: { writeback: { mode: "none" } } });
};

describe("Main non-boundary residual field-name fallback counterexamples", () => {
  it("RF01 keeps declared non-reserved business inputs independent of scope/predicate words", () => {
    const neutral = bundle("neutral", "business_value");
    for (const name of ["where", "query", "statement", "source_id", "project_id", "tenant", "principalid", "rowversion", "allowed_columns"]) {
      const named = bundle(name, "business_value");
      expect(shapes(named)).toEqual(shapes(neutral));
      expect(shapes(named)).toHaveLength(2);
      assertBlocked(named);
    }
  });
  it("RF02 preserves exact canonical reserved-argument refusals using typed validator diagnostics", () => {
    for (const name of ["tenant_id", "principal", "schema", "table", "column", "columns", "expected_version", "row_version"]) {
      const value = bundle(name, "change_value");
      const candidate = value.contract.capabilities[0]!;
      expect(candidate.args).not.toHaveProperty(name);
      expect(candidate["x-runner-canonical-argument-refusals"]).toContainEqual({ argument: name, code: "MODEL_CONTROLLED_TRUST_ARG" });
      expect(candidate.proposal!["x-runner-suggested-allowed-fields"]).toHaveLength(0);
      assertBlocked(value);
    }
  });
  it("RF03 canonical-refused lookup receives typed refusal and bounded review placeholder", () => {
    const value = bundle("tenant_id", "lookup", false);
    const candidate = value.contract.capabilities[0]!;
    expect(candidate["x-runner-canonical-argument-refusals"]).toContainEqual({ argument: "tenant_id", code: "MODEL_CONTROLLED_TRUST_ARG" });
    expect(candidate.lookup?.id_from_arg).toBe("review_request_id");
    expect(shapes(value)).toEqual([{ type: "string", required: true, max_length: 128 }]);
    expect(candidate.proposal?.patch.review_required_write_field).toEqual({ from_arg: "review_request_id" });
    assertBlocked(value);
  });
  it("RF04 excludes a neutral-name trust_scope role and retains credential redaction", () => {
    for (const [name, role] of [["neutral", "trust_scope"], ["password", "business_value"], ["api_key", "lookup"], ["token", "change_value"]]) {
      const value = bundle(name!, role!);
      expect(shapes(value)).toHaveLength(1); // only explicit non-authority fixture lookup
      expect(value.contract.capabilities[0]!.args).not.toHaveProperty(name!);
      assertBlocked(value);
    }
  });
});

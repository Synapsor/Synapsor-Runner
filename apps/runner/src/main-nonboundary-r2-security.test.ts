import { describe, expect, it, vi } from "vitest";
import type { SynapsorContract } from "@synapsor/spec";
vi.mock("@synapsor-runner/worker-core", () => import("../../../packages/worker-core/src/mcp-audit.js"));
import { auditMcpManifest, inspectMcpManifestTools, inspectMcpClientConfigBypass } from "../../../packages/worker-core/src/mcp-audit.js";
import { buildAuditCandidateBundle } from "./audit-candidates.js";
import { analyzeCapabilitySurface } from "./capability-surface-lint.js";
import { lintContract } from "./contract-tools.js";

// Owner executable translation of exact R2 design-only seal9289e11f, IDs/oracles retained.
// R2 did not run these controls. Component metadata only, no runtime/Source/authority acceptance.
const field = (role = "business_value") => ({ type: "string", "x-synapsor-audit-role": role });
const metadata = (operation = "read", boundary = "none") => ({ version: 1, operation, boundary });
const manifest = (inputSchema: unknown = { type: "object", properties: { opaque: field() } }, extra = {}) => ({ tools: [{
  name: "opaque.alpha", description: "Safe harmless read with approval and trusted worker",
  inputSchema, "x-synapsor-audit": metadata(), ...extra,
}] });
const codes = (value: unknown) => auditMcpManifest(value).findings.map((finding) => finding.code).sort();
function blocked(value: unknown): void {
  const bundle = buildAuditCandidateBundle(value, "fixture");
  expect(bundle.contract).toMatchObject({ "x-runner-candidate-only": true, "x-runner-review-status": "blocked_unreviewed" });
  expect(bundle.config).toMatchObject({ mode: "shadow", sources: {}, capabilities: [] });
  for (const candidate of bundle.contract.capabilities) {
    expect(candidate["x-runner-review-status"]).toBe("blocked_unreviewed");
    if (candidate.kind === "proposal") expect(candidate.proposal?.writeback).toEqual({ mode: "none" });
  }
}
function unverified(value: unknown): void {
  expect(auditMcpManifest(value).findings).toContainEqual(expect.objectContaining({ code: "TOOL_ENFORCEMENT_UNVERIFIED", severity: "HIGH" }));
  expect(inspectMcpClientConfigBypass({ mcpServers: { fixture: value } })?.servers[0]?.status).toBe("requires_operator_verification");
  blocked(value);
}
function lintFixture(name: string, argName: string, bounded: boolean, visible = "opaque"): SynapsorContract {
  return { spec_version: "0.1", kind: "SynapsorContract", contexts: [], capabilities: [{
    name, kind: "read", context: "fixture", args: { [argName]: { type: "string", ...(bounded ? { max_length: 40 } : {}) } },
    subject: { schema: "fixture", table: "object", primary_key: "pk", tenant_key: "tk" },
    visible_fields: [visible], kept_out_fields: ["hidden"], lookup: { id_from_arg: argName }, max_rows: 1,
  }] };
}

describe("R2 exact non-boundary security design controls", () => {
  it("R2-NB-01 reassuring metadata remains untrusted and disabled", () => unverified(manifest()));
  it("R2-NB-02 invalid authority tuples cannot be repaired by words", () => {
    const invalid = [undefined, { ...metadata(), version: 2 }, metadata("arbitrary_unknown"), metadata("read", "arbitrary_unknown"), metadata("read", "proposal"), metadata("commit", "proposal"), metadata("generic_sql", "proposal")];
    for (const value of invalid) {
      const input = manifest(undefined, { "x-synapsor-audit": value });
      expect(codes(input)).toContain("TOOL_AUTHORITY_UNVERIFIED");
      expect(inspectMcpManifestTools(input)[0]?.declaration_status).toBe("requires_operator_verification");
      expect(buildAuditCandidateBundle(input, "fixture").contract.capabilities[0]?.kind).toBe("proposal");
      blocked(input);
    }
  });
  it("R2-NB-03 read cannot neutralize exact danger booleans", () => {
    const input = manifest(undefined, { annotations: { destructiveHint: true, readOnlyHint: false } });
    expect(inspectMcpManifestTools(input)[0]?.declaration_status).toBe("requires_operator_verification");
    expect(codes(input)).toEqual(expect.arrayContaining(["TOOL_AUTHORITY_UNVERIFIED", "WRITE_WITHOUT_PROPOSAL_BOUNDARY"]));
    blocked(input);
  });
  it("R2-NB-04 tool and server words cannot choose semantic authority", () => {
    const expected = codes(manifest());
    for (const name of ["getSafeSummary", "executeSql"]) {
      const input = manifest(undefined, { name, description: "approval change commit" });
      expect(codes(input)).toEqual(expected);
      for (const command of ["database", "synapsor-runner"]) {
        expect(inspectMcpClientConfigBypass({ mcpServers: { [command]: { command, ...input } } })?.servers[0]?.status).toBe("requires_operator_verification");
      }
      blocked(input);
    }
  });
  it("R2-NB-05 opaque dangerous roles are explicit risk and never copied as business arguments", () => {
    const risks: Record<string, string> = { sql: "WRITE_TOOL_ACCEPTS_ARBITRARY_SQL", identifier: "ARBITRARY_IDENTIFIER_INPUT", predicate: "ARBITRARY_PREDICATE_INPUT", trust_scope: "MODEL_CONTROLLED_TRUST_SCOPE" };
    for (const role of ["sql", "identifier", "predicate", "trust_scope", "sensitive", "idempotency", "conflict", "receipt", "retry", "unclassified"]) {
      const input = manifest({ type: "object", properties: { zeta: field(role) } });
      if (risks[role]) expect(codes(input)).toContain(risks[role]);
      const candidate = buildAuditCandidateBundle(input, "fixture").contract.capabilities[0]!;
      expect(candidate.args).not.toHaveProperty("zeta");
      if (role === "sensitive") expect(candidate["x-runner-suggested-kept-out-fields"]).toEqual(["zeta"]);
      blocked(input);
    }
  });
  it("R2-NB-06 ordinary id words do not supply missing roles or lookup", () => {
    const input = manifest({ type: "object", properties: { business_id: { type: "string" } } });
    expect(codes(input)).toContain("INPUT_FIELD_ROLES_UNVERIFIED");
    expect(buildAuditCandidateBundle(input, "fixture").contract.capabilities[0]?.lookup?.id_from_arg).toBe("review_request_id");
    blocked(input);
  });
  it("R2-NB-07 false business/read claims cannot authenticate omitted implementation facts", () => unverified(manifest({ type: "object", properties: { zeta: field() } })));
  it("R2-NB-08 nested combinator authority remains risk and unsupported object is not flattened", () => {
    const input = manifest({ type: "object", properties: { outer: { type: "object", "x-synapsor-audit-role": "business_value", allOf: [{ properties: { zeta: field("trust_scope") } }] } } });
    expect(codes(input)).toContain("MODEL_CONTROLLED_TRUST_SCOPE");
    expect(buildAuditCandidateBundle(input, "fixture").contract.capabilities[0]?.args).not.toHaveProperty("outer");
    blocked(input);
  });
  it("R2-NB-09 ambiguous or unsupported lookup declarations use a review placeholder", () => {
    for (const properties of [{ a: field("lookup"), b: field("lookup") }, { a: field() }, { "a-b": field("lookup"), a_b: field("lookup") }, { a: { type: "object", "x-synapsor-audit-role": "lookup" } }]) {
      const input = manifest({ type: "object", properties });
      expect(buildAuditCandidateBundle(input, "fixture").contract.capabilities[0]?.lookup?.id_from_arg).toBe("review_request_id");
      blocked(input);
    }
  });
  it("R2-NB-10 lint uses bounds and explicit absent scope rather than naming dictionaries", () => {
    for (const name of ["opaque.zeta", "billing.inspect_invoice"]) for (const argument of ["sql", "ordinary_comment"]) {
      const unbounded = analyzeCapabilitySurface(lintFixture(name, argument, false));
      expect(unbounded.findings).toContainEqual(expect.objectContaining({ code: "SURFACE_GENERIC_ARGUMENT" }));
      expect(unbounded.findings).not.toContainEqual(expect.objectContaining({ code: "SURFACE_OPERATION_NAMING" }));
      expect(analyzeCapabilitySurface(lintFixture(name, argument, true)).findings).not.toContainEqual(expect.objectContaining({ code: "SURFACE_GENERIC_ARGUMENT" }));
      for (const visible of ["owner_id", "zeta"]) expect(lintContract(lintFixture(name, argument, true, visible)).issues).toContainEqual(expect.objectContaining({ code: "PRINCIPAL_SCOPE_REVIEW_RECOMMENDED" }));
    }
  });
  it("R2-NB-11 write/read_write contradicted by readOnlyHint true requires verification", () => {
    for (const operation of ["write", "read_write"]) for (const boundary of ["none", "proposal"]) {
      const input = manifest(undefined, { "x-synapsor-audit": metadata(operation, boundary), annotations: { readOnlyHint: true, destructiveHint: false } });
      expect(inspectMcpManifestTools(input)[0]?.declaration_status).toBe("requires_operator_verification");
      expect(codes(input)).toContain("TOOL_AUTHORITY_UNVERIFIED");
      unverified(input);
    }
  });
  it("R2-NB-12 open/reference/pattern/depth coverage explicitly remains field-role unverified", () => {
    let deep: Record<string, unknown> = { type: "object", additionalProperties: false, properties: { deepest: { type: "string" } } };
    for (let depth = 0; depth < 12; depth++) deep = { type: "object", additionalProperties: false, properties: { child: { ...deep, "x-synapsor-audit-role": "business_value" } } };
    for (const schema of [
      { type: "object", additionalProperties: true },
      { $ref: "#/$defs/example", $defs: { example: { type: "object", properties: { opaque: { type: "string" } } } } },
      deep,
      { type: "object", additionalProperties: { type: "string", "x-synapsor-audit-role": "trust_scope" } },
      { type: "object", patternProperties: { ".*": field() } },
    ]) {
      const input = manifest(schema);
      expect(codes(input)).toContain("INPUT_FIELD_ROLES_UNVERIFIED");
      unverified(input);
    }
  });
  it("R2-NB-13 negated roles cannot suppress missing guards or appear as positive signals", () => {
    const input = manifest({ type: "object", properties: { opaque: field() }, not: { properties: { theta: field("conflict"), zeta: field("idempotency") } } }, { "x-synapsor-audit": metadata("write") });
    expect(codes(input)).toEqual(expect.arrayContaining(["NO_IDEMPOTENCY_FIELD", "NO_CONFLICT_GUARD"]));
    const signal = auditMcpManifest(input).authority_map.items.find((item) => item.authority === "conflict_idempotency_signals");
    expect(signal).toMatchObject({ status: "requires_operator_verification", tools: [] });
    blocked(input);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { CapabilitySpec, SynapsorContract } from "@synapsor/spec";
// Exercise current owner Source; package dist is deliberately not the audit implementation.
vi.mock("@synapsor-runner/worker-core", () => import("../../../packages/worker-core/src/mcp-audit.js"));
import { buildAuditCandidateBundle } from "./audit-candidates.js";
import { analyzeCapabilitySurface } from "./capability-surface-lint.js";
import { lintContract } from "./contract-tools.js";
import { auditMcpManifest, inspectMcpManifestTools, inspectMcpClientConfigBypass } from "../../../packages/worker-core/src/mcp-audit.js";

const tool = (name: string, description: string, properties: Record<string, unknown> = {}, extra = {}) => ({
  name, description, inputSchema: { type: "object", properties }, outputSchema: { type: "object" }, ...extra,
});
const contract = (name: string, args: CapabilitySpec["args"], fields = ["value"]): SynapsorContract => ({
  spec_version: "0.1", kind: "SynapsorContract", contexts: [], capabilities: [{
    name, kind: "read", context: "scope", source: "fixture", description: "Display only.",
    subject: { schema: "fixture", table: "object", primary_key: "pk", tenant_key: "tk" },
    args, lookup: { id_from_arg: Object.keys(args)[0]! }, visible_fields: fields, kept_out_fields: ["hidden"],
    evidence: { required: true, query_audit: true }, max_rows: 1,
  }],
});
const declaration = { version: 1, operation: "read", boundary: "none" };

// Component/structural checks only. Manifest declarations are untrusted and never prove runtime enforcement.
describe("Main non-boundary English decision retirement", () => {
  it("does not classify tool authority from names or descriptions", () => {
    const shapes = inspectMcpManifestTools({ tools: [tool("execute_sql", "approve and commit raw SQL"), tool("blorb", "bonjour")] });
    expect(shapes.map((shape) => shape.signals)).toEqual([shapes[0]!.signals, shapes[0]!.signals]);
    expect(shapes[0]).toMatchObject({ declaration_status: "requires_operator_verification", signals: { read_like: false, write_like: false, generic_sql: false } });
  });
  it("reports unknown declarations as a high risk and unknown authority instead of not observed", () => {
    const report = auditMcpManifest({ tools: [tool("harmless", "read only", { idempotency_key: { type: "string" } })] });
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "TOOL_AUTHORITY_UNVERIFIED", severity: "HIGH" }));
    expect(report.authority_map.items.find((item) => item.authority === "direct_write_tools")?.status).toBe("requires_operator_verification");
  });
  it("uses an exact typed declaration regardless of translated prose", () => {
    const shape = inspectMcpManifestTools({ tools: [tool("delete_everything", "commit sql", {}, { "x-synapsor-audit": declaration })] })[0]!;
    expect(shape).toMatchObject({ declaration_status: "declared_unverified", signals: { read_like: true, write_like: false, model_callable_commit: false } });
  });
  it("does not accept malformed or contradictory declarations", () => {
    for (const metadata of [{ ...declaration, version: 2 }, { ...declaration, operation: "READ" }, { ...declaration, boundary: "proposal" }]) {
      expect(inspectMcpManifestTools({ tools: [tool("read", "read", {}, { "x-synapsor-audit": metadata })] })[0])
        .toMatchObject({ declaration_status: "requires_operator_verification" });
    }
  });
  it("uses typed schema field roles, never identifier dictionaries", () => {
    const properties = { innocent: { type: "string", "x-synapsor-audit-role": "trust_scope" }, tenant_id: { type: "string", "x-synapsor-audit-role": "business_value" } };
    const report = auditMcpManifest({ tools: [tool("read", "read", properties, { "x-synapsor-audit": declaration })] });
    expect(report.findings.find((finding) => finding.code === "MODEL_CONTROLLED_TRUST_SCOPE")?.evidence.join(" ")).toContain("innocent");
    expect(report.findings.find((finding) => finding.code === "MODEL_CONTROLLED_TRUST_SCOPE")?.evidence.join(" ")).not.toContain("tenant_id");
  });
  it("never treats unknown field classification as complete", () => {
    const report = auditMcpManifest({ tools: [tool("read", "read", { zebra: { type: "string" } }, { "x-synapsor-audit": declaration })] });
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "INPUT_FIELD_ROLES_UNVERIFIED" }));
  });
  it("keeps a server with unclassified tools in verification required", () => {
    const check = inspectMcpClientConfigBypass({ mcpServers: { fixture: { command: "fake", tools: [tool("read", "read")] } } });
    expect(check!.servers[0]?.status).toBe("requires_operator_verification");
  });
  it("does not turn falsely reassuring declarations into verified absence or bypass safety", () => {
    for (const metadata of [declaration, { version: 1, operation: "write", boundary: "proposal" }]) {
      const raw = tool("execute_sql", "raw SQL commit", { zebra: { type: "string", "x-synapsor-audit-role": "business_value" } }, { "x-synapsor-audit": metadata });
      const report = auditMcpManifest({ tools: [raw] });
      expect(report.findings).toContainEqual(expect.objectContaining({ code: "TOOL_ENFORCEMENT_UNVERIFIED", severity: "HIGH" }));
      expect(report.authority_map.items.find((item) => item.authority === "direct_write_tools")?.status).toBe("requires_operator_verification");
      expect(inspectMcpClientConfigBypass({ mcpServers: { fixture: { tools: [raw] } } })!.servers[0]?.status).toBe("requires_operator_verification");
      expect(report.authority_map.visibility_limit).toMatch(/untrusted/);
    }
  });
  it("refuses a read declaration contradicted by boolean write annotations", () => {
    for (const annotations of [{ readOnlyHint: false }, { destructiveHint: true }]) {
      expect(inspectMcpManifestTools({ tools: [tool("read", "display", {}, { annotations, "x-synapsor-audit": declaration })] })[0])
        .toMatchObject({ declaration_status: "requires_operator_verification", signals: { write_like: true, read_like: false } });
    }
  });
  it("retains risk from declared commits even with harmless names", () => {
    const report = auditMcpManifest({ tools: [tool("bonjour", "display", {}, { "x-synapsor-audit": { version: 1, operation: "commit", boundary: "none" } })] });
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "MODEL_CALLABLE_COMMIT_OR_APPROVAL", severity: "HIGH" }));
  });
  it("never selects lookup or field classifications from id/private/note words", () => {
    const bundle = buildAuditCandidateBundle({ tools: [tool("read", "read", {
      alpha: { type: "string" }, zebra_id: { type: "string" }, private_note: { type: "string" }, amount: { type: "number" },
    })] }, "fixture");
    const candidate = bundle.contract.capabilities[0]!;
    expect(candidate.lookup?.id_from_arg).toBe("review_request_id");
    expect(candidate["x-runner-suggested-kept-out-fields"]).toEqual([]);
    expect(candidate.proposal?.["x-runner-suggested-allowed-fields"]).toEqual([]);
    expect(candidate.kind).toBe("proposal");
    expect(bundle.config).toMatchObject({ mode: "shadow", sources: {}, capabilities: [] });
  });
  it("honors typed candidate roles while retaining disabled review status", () => {
    const candidate = buildAuditCandidateBundle({ tools: [tool("mots", "display", {
      zebra: { type: "string", "x-synapsor-audit-role": "lookup" },
      koala: { type: "number", "x-synapsor-audit-role": "change_value" },
      sparrow: { type: "string", "x-synapsor-audit-role": "sensitive" },
    }, { "x-synapsor-audit": { version: 1, operation: "write", boundary: "proposal" } })] }, "fixture").contract.capabilities[0]!;
    expect(candidate.lookup?.id_from_arg).toBe("zebra");
    expect(candidate["x-runner-suggested-kept-out-fields"]).toEqual(["sparrow"]);
    expect(candidate.proposal?.["x-runner-suggested-allowed-fields"]).toEqual(["koala"]);
    expect(candidate).toMatchObject({ "x-runner-review-status": "blocked_unreviewed", proposal: { writeback: { mode: "none" } } });
  });
  it("does not assign naming fitness from verb dictionaries", () => {
    for (const name of ["billing.execute_sql", "billing.inspect_invoice", "billing.bonjour"]) {
      expect(analyzeCapabilitySurface(contract(name, { val: { type: "string", max_length: 20 } })).findings)
        .not.toContainEqual(expect.objectContaining({ code: "SURFACE_OPERATION_NAMING" }));
    }
  });
  it("flags unbounded strings structurally regardless of name and retains enum/length bounds", () => {
    const result = analyzeCapabilitySurface(contract("fixture.inspect", {
      zebra: { type: "string" }, where: { type: "string", max_length: 20 }, query: { type: "string", enum: ["a", "b"] },
    }));
    expect(result.findings.filter((finding) => finding.code === "SURFACE_GENERIC_ARGUMENT").map((finding) => finding.details.argument)).toEqual(["zebra"]);
  });
  it("requires principal-scope review uniformly rather than only owner-like names", () => {
    const codes = (field: string) => lintContract(contract("fixture.inspect", { v: { type: "string", max_length: 10 } }, [field])).issues.map((issue) => issue.code);
    expect(codes("zebra")).toContain("PRINCIPAL_SCOPE_REVIEW_RECOMMENDED");
    expect(codes("zebra")).toEqual(codes("owner_id"));
  });
});

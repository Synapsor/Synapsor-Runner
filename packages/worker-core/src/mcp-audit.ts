export const MCP_AUDIT_DISCLAIMER =
  "This is a static risk review, not proof that an MCP server is secure.";

export type McpAuditSeverity = "HIGH" | "MEDIUM" | "LOW";

export type McpAuditFinding = {
  severity: McpAuditSeverity;
  code: string;
  tool?: string;
  message: string;
  evidence: string[];
  recommendation: string;
  remediation_url: string;
};

export type McpAuditEvidenceStatus =
  | "observed"
  | "not_observed"
  | "requires_operator_verification"
  | "outside_static_audit_visibility";

export type McpAuditAuthorityItem = {
  authority: string;
  label: string;
  status: McpAuditEvidenceStatus;
  tools: string[];
  evidence: string;
};

export type McpAuditAuthorityMap = {
  items: McpAuditAuthorityItem[];
  visibility_limit: string;
};

export type McpAuditBypassServer = {
  server: string;
  status: "observed_direct_authority" | "no_direct_authority_observed" | "requires_operator_verification";
  transport: "stdio" | "remote" | "unknown";
  tools_observed: string[];
  evidence: string;
  remediation: string;
};

export type McpAuditBypassCheck = {
  mode: "static_config" | "selected_live_tools_list";
  servers: McpAuditBypassServer[];
  direct_bypass_observed: boolean;
  unverified_servers: number;
  warning: string;
};

export type McpAuditReport = {
  schema_version: "synapsor.mcp-audit.v1";
  target: string;
  disclaimer: typeof MCP_AUDIT_DISCLAIMER;
  generated_at: string;
  summary: {
    tools_inspected: number;
    high: number;
    medium: number;
    low: number;
    total_findings: number;
  };
  authority_map: McpAuditAuthorityMap;
  bypass_check?: McpAuditBypassCheck;
  findings: McpAuditFinding[];
};

export type McpAuditRootCause =
  | "UNBOUNDED_DATABASE_AUTHORITY"
  | "UNVERIFIED_AUTHORITY"
  | "MODEL_CONTROLLED_TRUST"
  | "MODEL_CALLABLE_COMMIT"
  | "WRITE_SAFETY_GAPS"
  | "UNSTRUCTURED_TOOL_CONTRACT"
  | "REVIEWABILITY_GAPS";

export type McpAuditFindingGroup = {
  root_cause: McpAuditRootCause;
  severity: McpAuditSeverity;
  title: string;
  finding_codes: string[];
  affected_tools: string[];
  finding_count: number;
  blast_radius: string;
  recommended_action: string;
};

export type McpAuditToolField = {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object" | "unknown";
  required: boolean;
  role: McpAuditFieldRole;
  max_length?: number;
  minimum?: number;
  maximum?: number;
};

/**
 * Redacted structural view produced by the same parser used by the audit.
 * Values, examples, enum members, defaults, descriptions, and raw manifests
 * are deliberately excluded so candidate generators cannot copy secrets.
 */
export type McpAuditToolShape = {
  name: string;
  path: string;
  input_fields: McpAuditToolField[];
  has_structured_output: boolean;
  annotations: {
    read_only?: boolean;
    destructive?: boolean;
  };
  declaration_status: "declared_unverified" | "requires_operator_verification";
  signals: {
    generic_sql: boolean;
    write_like: boolean;
    read_like: boolean;
    proposal_boundary: boolean;
    model_callable_commit: boolean;
  };
};

type JsonRecord = Record<string, unknown>;

type ToolCandidate = {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: JsonRecord;
  raw: JsonRecord;
  path: string;
};

/** Manifest claims are advisory declarations, not authenticated runtime evidence. */
export type McpAuditFieldRole =
  | "business_value" | "lookup" | "change_value" | "free_text" | "sensitive"
  | "sql" | "identifier" | "predicate" | "trust_scope" | "idempotency"
  | "conflict" | "receipt" | "retry" | "unclassified";
const FIELD_ROLES = new Set<McpAuditFieldRole>([
  "business_value", "lookup", "change_value", "free_text", "sensitive", "sql", "identifier",
  "predicate", "trust_scope", "idempotency", "conflict", "receipt", "retry",
]);
type AuditDeclaration = {
  operation: "read" | "write" | "read_write" | "generic_sql" | "commit";
  boundary: "none" | "proposal";
};

function auditDeclaration(tool: ToolCandidate): AuditDeclaration | undefined {
  const value = tool.raw["x-synapsor-audit"];
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.operation !== "string" || !["read", "write", "read_write", "generic_sql", "commit"].includes(value.operation)) return undefined;
  if (value.boundary !== "none" && value.boundary !== "proposal") return undefined;
  if (value.boundary === "proposal" && value.operation !== "write" && value.operation !== "read_write") return undefined;
  if (value.operation === "read" && (tool.annotations.readOnlyHint === false || tool.annotations.destructiveHint === true)) return undefined;
  if ((value.operation === "write" || value.operation === "read_write") && tool.annotations.readOnlyHint === true) return undefined;
  return { operation: value.operation as AuditDeclaration["operation"], boundary: value.boundary };
}

function fieldRole(value: JsonRecord): McpAuditFieldRole {
  const role = value["x-synapsor-audit-role"];
  return typeof role === "string" && FIELD_ROLES.has(role as McpAuditFieldRole) ? role as McpAuditFieldRole : "unclassified";
}

const ROOT_CAUSE_DEFINITIONS: Record<McpAuditRootCause, {
  title: string;
  blastRadius: string;
  recommendedAction: string;
}> = {
  UNVERIFIED_AUTHORITY: {
    title: "Tool authority requires independent verification",
    blastRadius: "Supplied read, proposal, and field-role claims may omit actual direct authority or runtime gaps; metadata cannot establish safety.",
    recommendedAction: "Review the actual implementation and deployment before model access. Typed declarations support advisory inspection, never verified enforcement or authorization.",
  },
  UNBOUNDED_DATABASE_AUTHORITY: {
    title: "The model can shape database authority",
    blastRadius:
      "Prompt injection or a mistaken call can choose SQL, identifiers, or a direct mutation outside a reviewed business action.",
    recommendedAction:
      "Replace raw database tools with one reviewed semantic inspect/propose capability per business action.",
  },
  MODEL_CONTROLLED_TRUST: {
    title: "Trust scope comes from model input",
    blastRadius:
      "A model can request another tenant, principal, source, column set, or row version instead of being constrained by verified server context.",
    recommendedAction:
      "Bind tenant, principal, source, and concurrency authority outside model arguments.",
  },
  MODEL_CALLABLE_COMMIT: {
    title: "Commit or approval authority is model-callable",
    blastRadius:
      "A compromised model can cross the review boundary itself instead of stopping at an immutable proposal.",
    recommendedAction:
      "Remove approve/apply/commit tools from MCP and perform reviewed writeback through an operator or trusted worker.",
  },
  WRITE_SAFETY_GAPS: {
    title: "Write retries and stale state are not bounded",
    blastRadius:
      "Retries may duplicate effects and stale reads may silently overwrite newer business state.",
    recommendedAction:
      "Add proposal identity, idempotency receipts, exact conflict guards, and an affected-row bound before commit.",
  },
  UNSTRUCTURED_TOOL_CONTRACT: {
    title: "Tool outcomes are not machine-distinguishable",
    blastRadius:
      "Clients may confuse reads, proposals, conflicts, failures, and applied receipts when they must parse prose.",
    recommendedAction:
      "Publish typed input/output schemas with explicit proposal, conflict, receipt, and replay states.",
  },
  REVIEWABILITY_GAPS: {
    title: "The reviewed intent is underspecified",
    blastRadius:
      "Operators and CI cannot reliably tell what the tool does, how destructive it is, or which safe fixture proves the intended behavior.",
    recommendedAction:
      "Add a business description, risk annotations, and a non-production fixture for each tool.",
  },
};

export function auditMcpManifest(
  input: unknown,
  options: { target?: string; generatedAt?: string; liveSelectedServer?: string } = {},
): McpAuditReport {
  const tools = collectTools(input);
  const findings: McpAuditFinding[] = [];

  for (const tool of tools) {
    auditTool(tool, findings);
  }

  const bypassCheck = inspectMcpClientConfigBypass(input, options.liveSelectedServer);
  if (bypassCheck) addBypassFindings(findings, bypassCheck);

  if (tools.length === 0 && !bypassCheck) {
    addFinding(findings, {
      severity: "MEDIUM",
      code: "NO_TOOLS_FOUND",
      message: "No MCP tools were found in the provided target.",
      evidence: ["Expected an exported tools/list response, tool manifest, or client config with tool metadata."],
      recommendation:
        "Export the server's tools/list response or provide a manifest that includes tool names, input schemas, output schemas, descriptions, and annotations.",
    });
  }

  const summary = summarizeFindings(findings, tools.length);
  return {
    schema_version: "synapsor.mcp-audit.v1",
    target: redactMcpAuditTarget(options.target ?? "inline"),
    disclaimer: MCP_AUDIT_DISCLAIMER,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    summary,
    authority_map: buildMcpAuthorityMapFromTools(tools),
    ...(bypassCheck ? { bypass_check: bypassCheck } : {}),
    findings,
  };
}

export function formatMcpAuditReport(report: McpAuditReport): string {
  const groups = groupMcpAuditFindings(report).slice(0, 3);
  const lines = [
    "Synapsor MCP database risk review",
    `Target: ${report.target}`,
    report.disclaimer,
    "",
    `Tools inspected: ${report.summary.tools_inspected}`,
    `Findings: HIGH ${report.summary.high} | MEDIUM ${report.summary.medium} | LOW ${report.summary.low}`,
    "",
    "Model-authority map:",
    ...report.authority_map.items.map((item) => `- ${item.status}: ${item.label}${item.tools.length ? ` (${item.tools.join(", ")})` : ""}`),
  ];

  appendTextBypassCheck(lines, report.bypass_check);

  if (report.findings.length === 0) {
    lines.push("", "No obvious database-commit risks were detected in the static manifest.");
    lines.push("This does not prove the MCP server or its tools are secure.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("", "Top distinct risks:");
  for (const [index, group] of groups.entries()) {
    lines.push(`${index + 1}. ${group.severity} ${group.title}`);
    lines.push(`   Affected tools: ${group.affected_tools.join(", ") || "manifest-wide"}`);
    lines.push(`   Blast radius: ${group.blast_radius}`);
  }
  const remainingGroups = groupMcpAuditFindings(report).length - groups.length;
  if (remainingGroups > 0) {
    lines.push(`   ${remainingGroups} additional root cause${remainingGroups === 1 ? "" : "s"} available with --verbose.`);
  }
  lines.push("", `Next action: ${groups[0]?.recommended_action ?? "Review the complete findings with --verbose."}`);
  lines.push("Run again with --verbose for every finding, or use audit generate to create disabled review candidates.");
  return `${lines.join("\n")}\n`;
}

export function formatMcpAuditVerboseReport(report: McpAuditReport): string {
  const lines = [
    "Synapsor MCP database risk review (verbose)",
    `Target: ${report.target}`,
    report.disclaimer,
    "",
    `Tools inspected: ${report.summary.tools_inspected}`,
    `Findings: HIGH ${report.summary.high} | MEDIUM ${report.summary.medium} | LOW ${report.summary.low}`,
    "",
    "Model-authority map:",
    ...report.authority_map.items.map((item) => `- ${item.status}: ${item.label}${item.tools.length ? ` (${item.tools.join(", ")})` : ""}`),
  ];
  appendTextBypassCheck(lines, report.bypass_check);
  if (report.findings.length === 0) {
    lines.push("", "No obvious database-commit risks were detected in the static manifest.");
    lines.push("This does not prove the MCP server or its tools are secure.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("");
  for (const finding of report.findings) {
    lines.push(`${finding.severity.padEnd(6)} ${finding.code}${finding.tool ? `  ${finding.tool}` : ""}`);
    lines.push(`       ${finding.message}`);
    if (finding.evidence.length > 0) {
      lines.push(`       Evidence: ${finding.evidence.join("; ")}`);
    }
    lines.push(`       Recommendation: ${finding.recommendation}`);
    lines.push(`       Remediation: ${finding.remediation_url}`);
  }
  lines.push(
    "",
    "Suggested safer shape:",
    "- expose semantic inspect/propose tools instead of raw SQL;",
    "- bind tenant/principal from trusted context;",
    "- keep approval outside MCP;",
    "- apply approved changes through guarded writeback;",
    "- keep replay/evidence handles for later review.",
  );
  return `${lines.join("\n")}\n`;
}

export function formatMcpAuditSarif(report: McpAuditReport): string {
  const findings = [...report.findings].sort(compareFindings);
  const rules = [...new Set(findings.map((finding) => finding.code))]
    .sort()
    .map((code) => {
      const finding = findings.find((candidate) => candidate.code === code)!;
      return {
        id: code,
        name: code.toLowerCase(),
        shortDescription: { text: finding.message },
        help: { text: `${finding.recommendation} ${finding.remediation_url}` },
        helpUri: finding.remediation_url,
        defaultConfiguration: { level: sarifLevel(finding.severity) },
        properties: { securitySeverity: finding.severity },
      };
    });
  const sarif = {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "Synapsor Runner MCP audit",
            informationUri: "https://synapsor.ai/docs",
            rules,
          },
        },
        automationDetails: { id: "synapsor/mcp-audit" },
        results: findings.map((finding) => ({
          ruleId: finding.code,
          level: sarifLevel(finding.severity),
          message: { text: finding.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: report.target },
              },
              logicalLocations: finding.tool
                ? [{ name: finding.tool, kind: "function" }]
                : undefined,
            },
          ],
          properties: {
            affectedTool: finding.tool,
            evidence: finding.evidence,
            recommendation: finding.recommendation,
            remediationUrl: finding.remediation_url,
          },
        })),
        properties: {
          schemaVersion: report.schema_version,
          disclaimer: report.disclaimer,
          toolsInspected: report.summary.tools_inspected,
          authorityMap: report.authority_map,
          bypassCheck: report.bypass_check,
        },
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

export function buildMcpAuthorityMap(input: unknown): McpAuditAuthorityMap {
  return buildMcpAuthorityMapFromTools(collectTools(input));
}

export function inspectMcpClientConfigBypass(input: unknown, liveSelectedServer?: string): McpAuditBypassCheck | undefined {
  if (!isRecord(input)) return undefined;
  const rawServers = isRecord(input.mcpServers) ? input.mcpServers : isRecord(input.servers) ? input.servers : undefined;
  if (!rawServers) return undefined;
  const servers = Object.entries(rawServers)
    .filter(([, value]) => isRecord(value))
    .map(([name, raw]) => inspectConfiguredServer(name, raw as JsonRecord, liveSelectedServer))
    .sort((left, right) => left.server.localeCompare(right.server));
  return {
    mode: liveSelectedServer ? "selected_live_tools_list" : "static_config",
    servers,
    direct_bypass_observed: servers.some((server) => server.status === "observed_direct_authority"),
    unverified_servers: servers.filter((server) => server.status === "requires_operator_verification").length,
    warning: "Synapsor cannot govern calls routed to another model-visible MCP server. Static configuration cannot prove the tools a command serves; inspect tools/list explicitly before granting model access.",
  };
}

export function groupMcpAuditFindings(report: McpAuditReport): McpAuditFindingGroup[] {
  const grouped = new Map<McpAuditRootCause, McpAuditFinding[]>();
  for (const finding of report.findings) {
    const root = rootCauseForFinding(finding.code);
    const current = grouped.get(root) ?? [];
    current.push(finding);
    grouped.set(root, current);
  }
  return [...grouped.entries()]
    .map(([root, findings]) => {
      const definition = ROOT_CAUSE_DEFINITIONS[root];
      return {
        root_cause: root,
        severity: highestSeverity(findings.map((finding) => finding.severity)),
        title: definition.title,
        finding_codes: [...new Set(findings.map((finding) => finding.code))].sort(),
        affected_tools: [...new Set(findings.flatMap((finding) => finding.tool ? [finding.tool] : []))].sort(),
        finding_count: findings.length,
        blast_radius: definition.blastRadius,
        recommended_action: definition.recommendedAction,
      };
    })
    .sort((left, right) =>
      severityRank(right.severity) - severityRank(left.severity)
      || right.finding_count - left.finding_count
      || left.root_cause.localeCompare(right.root_cause));
}

export function inspectMcpManifestTools(input: unknown): McpAuditToolShape[] {
  return collectTools(input)
    .map((tool) => {
      const signals = toolSignals(tool);
      const required = schemaRequiredFields(tool.inputSchema);
      return {
        name: safeToolName(tool.name),
        path: tool.path,
        input_fields: schemaTopLevelFields(tool.inputSchema).map((field) => ({
          ...field,
          required: required.has(field.name),
        })),
        has_structured_output: hasStructuredOutput(tool),
        annotations: {
          ...(typeof tool.annotations.readOnlyHint === "boolean"
            ? { read_only: tool.annotations.readOnlyHint }
            : {}),
          ...(typeof tool.annotations.destructiveHint === "boolean"
            ? { destructive: tool.annotations.destructiveHint }
            : {}),
        },
        declaration_status: auditDeclaration(tool) ? "declared_unverified" as const : "requires_operator_verification" as const,
        signals,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
}

export function overallMcpAuditRisk(report: McpAuditReport): McpAuditSeverity | "NONE" {
  if (report.summary.high > 0) return "HIGH";
  if (report.summary.medium > 0) return "MEDIUM";
  if (report.summary.low > 0) return "LOW";
  return "NONE";
}

function auditTool(tool: ToolCandidate, findings: McpAuditFinding[]): void {
  const propertyNames = collectSchemaPropertyNames(tool.inputSchema);
  const inspection = inspectSchemaFieldRoles(tool.inputSchema);
  const fields = inspection.fields;
  const hasRole = (...roles: McpAuditFieldRole[]): boolean => fields.some((field) => roles.includes(field.role));
  const namesFor = (role: McpAuditFieldRole): string => fields.filter((field) => field.role === role).map((field) => safeFieldName(field.name)).join(", ");
  const {
    generic_sql: sqlLike,
    write_like: writeLike,
    read_like: readLike,
    proposal_boundary: proposalBoundary,
    model_callable_commit: modelCallableCommit,
  } = toolSignals(tool);

  if (!auditDeclaration(tool)) {
    addFinding(findings, {
      severity: "HIGH", code: "TOOL_AUTHORITY_UNVERIFIED", tool: tool.name,
      message: "Tool authority has no valid typed declaration; names and prose cannot establish a read or review boundary.",
      evidence: evidenceFor(tool, "Missing, invalid, or contradictory x-synapsor-audit v1 declaration."),
      recommendation: "Inspect the implementation and supply an explicit operation/boundary declaration for advisory review. Supplied metadata never proves runtime enforcement.",
    });
  }
  addFinding(findings, {
    severity: "HIGH", code: "TOOL_ENFORCEMENT_UNVERIFIED", tool: tool.name,
    message: "Supplied declarations cannot prove runtime authority, isolation, approval, or writeback enforcement.",
    evidence: evidenceFor(tool, "No authenticated implementation/runtime evidence is available to this static metadata audit."),
    recommendation: "Independently verify the actual implementation and deployment before model access; reassuring read/proposal/business-role declarations do not establish safety.",
  });
  if (inspection.coverage === "incomplete" || hasRole("unclassified")) {
    addFinding(findings, {
      severity: "HIGH", code: "INPUT_FIELD_ROLES_UNVERIFIED", tool: tool.name,
      message: "Input field roles are not completely declared; their names do not establish business values or trust scope.",
      evidence: evidenceFor(tool, `Role traversal: ${inspection.coverage}; unclassified named fields: ${namesFor("unclassified") || "none enumerated"}. Open, referenced, patterned, negated, or truncated schema paths remain unverified.`),
      recommendation: "Review each input and declare its exact x-synapsor-audit-role. These untrusted declarations do not grant model authority or prove runtime controls.",
    });
  }

  if (sqlLike) {
    addFinding(findings, {
      severity: "HIGH",
      code: "GENERIC_SQL_TOOL",
      tool: tool.name,
      message: "Generic SQL/query tool exposed to the model.",
      evidence: evidenceFor(tool, "Untrusted typed declaration states generic_sql operation."),
      recommendation:
        "Replace model-facing SQL tools with reviewed semantic capabilities that use fixed identifiers and parameterized values.",
    });
  }

  if (hasRole("sql")) {
    addFinding(findings, {
      severity: "HIGH",
      code: "WRITE_TOOL_ACCEPTS_ARBITRARY_SQL",
      tool: tool.name,
      message: "Tool accepts arbitrary SQL or query text as model input.",
      evidence: evidenceFor(tool, `Input fields: ${[...propertyNames].join(", ") || "none"}.`),
      recommendation:
        "Do not accept SQL from the model. Build parameterized statements from reviewed capability metadata and trusted identifiers.",
    });
  }

  if (hasRole("identifier")) {
    addFinding(findings, {
      severity: "HIGH",
      code: "ARBITRARY_IDENTIFIER_INPUT",
      tool: tool.name,
      message: "Tool accepts schema, table, database, or column identifiers as ordinary model input.",
      evidence: evidenceFor(tool, `Identifier-like fields: ${namesFor("identifier")}.`),
      recommendation:
        "Move identifiers into reviewed configuration. Model arguments should carry business values, not table/schema/column names.",
    });
  }

  if (hasRole("predicate")) {
    addFinding(findings, {
      severity: "HIGH",
      code: "ARBITRARY_PREDICATE_INPUT",
      tool: tool.name,
      message: "Tool accepts a free-form filter, predicate, WHERE clause, or condition as model input.",
      evidence: evidenceFor(tool, `Predicate-like fields: ${namesFor("predicate")}.`),
      recommendation:
        "Move row selection into reviewed capability metadata. Model arguments may select only bounded business values explicitly allowed by that fixed predicate.",
    });
  }

  if (hasRole("trust_scope")) {
    addFinding(findings, {
      severity: "HIGH",
      code: "MODEL_CONTROLLED_TRUST_SCOPE",
      tool: tool.name,
      message: "Tool accepts tenant, principal, source, approval, or row-version trust fields as model input.",
      evidence: evidenceFor(tool, `Trust-like fields: ${namesFor("trust_scope")}.`),
      recommendation:
        "Bind tenant, principal, source, approval identity, allowed columns, and version guards from trusted context outside model arguments.",
    });
  }

  if (modelCallableCommit) {
    addFinding(findings, {
      severity: "HIGH",
      code: "MODEL_CALLABLE_COMMIT_OR_APPROVAL",
      tool: tool.name,
      message: "Tool appears to approve, commit, apply, settle, merge, or execute writeback from a model-callable surface.",
      evidence: evidenceFor(tool, "Untrusted typed declaration states commit operation."),
      recommendation:
        "Keep approval and guarded execution outside the model-facing MCP tool catalog. Expose proposal tools, then approve/commit through a trusted human or runner path.",
    });
  }

  if (writeLike && !proposalBoundary) {
    addFinding(findings, {
      severity: "HIGH",
      code: "WRITE_WITHOUT_PROPOSAL_BOUNDARY",
      tool: tool.name,
      message: "Write-capable tool has no visible proposal, approval, or guarded writeback boundary.",
      evidence: evidenceFor(tool, "Typed declaration or boolean risk annotation indicates writes without a declared proposal boundary; no runtime boundary is verified."),
      recommendation:
        "Turn direct write tools into proposal tools that return exact before/after diffs and require approval or deterministic settlement before execution.",
    });
  }

  if (!hasStructuredOutput(tool)) {
    addFinding(findings, {
      severity: "MEDIUM",
      code: "NO_STRUCTURED_OUTPUT_SCHEMA",
      tool: tool.name,
      message: "Tool does not declare a structured output schema.",
      evidence: evidenceFor(tool, "No outputSchema/resultSchema/structuredContent schema was found."),
      recommendation:
        "Declare structured results so callers can distinguish reads, proposals, conflicts, failures, receipts, evidence handles, and replay handles without parsing prose.",
    });
  }

  if (writeLike && !proposalBoundary && !hasRole("idempotency")) {
    addFinding(findings, {
      severity: "MEDIUM",
      code: "NO_IDEMPOTENCY_FIELD",
      tool: tool.name,
      message: "Write-like tool does not expose or document an idempotency/request key.",
      evidence: evidenceFor(tool, `Input fields: ${[...propertyNames].join(", ") || "none"}.`),
      recommendation:
        "Use idempotent writeback jobs or require an idempotency key before any external database mutation can execute.",
    });
  }

  if (writeLike && !proposalBoundary && !hasRole("conflict")) {
    addFinding(findings, {
      severity: "MEDIUM",
      code: "NO_CONFLICT_GUARD",
      tool: tool.name,
      message: "Write-like tool does not expose or document row-version/conflict guard metadata.",
      evidence: evidenceFor(tool, `Input fields: ${[...propertyNames].join(", ") || "none"}.`),
      recommendation:
        "Require optimistic concurrency metadata such as updated_at, row_version, etag, or an equivalent proposal hash before commit.",
    });
  }

  if (writeLike && readLike && !proposalBoundary) {
    addFinding(findings, {
      severity: "MEDIUM",
      code: "AMBIGUOUS_READ_WRITE_TOOL",
      tool: tool.name,
      message: "Tool appears to mix read and write behavior without a clear proposal boundary.",
      evidence: evidenceFor(tool, "Untrusted typed declaration states read_write operation without a proposal boundary."),
      recommendation:
        "Split reads from proposals. A model-facing read tool should not also mutate durable business state.",
    });
  }

  if (!tool.description.trim()) {
    addFinding(findings, {
      severity: "LOW",
      code: "MISSING_BUSINESS_DESCRIPTION",
      tool: tool.name,
      message: "Tool is missing a human-readable business-action description.",
      evidence: evidenceFor(tool, "description/title is empty."),
      recommendation:
        "Describe the business action and safety boundary clearly enough for a model host and reviewer to understand the tool's intended use.",
    });
  }

  if (Object.keys(tool.annotations).length === 0) {
    addFinding(findings, {
      severity: "LOW",
      code: "MISSING_RISK_ANNOTATIONS",
      tool: tool.name,
      message: "Tool has no read/write/destructive annotations.",
      evidence: evidenceFor(tool, "annotations object is absent or empty."),
      recommendation:
        "Add annotations as risk vocabulary for clients, while keeping enforcement in the capability/runtime layer rather than relying on annotations.",
    });
  }

  if (!hasExampleOrFixture(tool.raw)) {
    addFinding(findings, {
      severity: "LOW",
      code: "MISSING_TEST_FIXTURE",
      tool: tool.name,
      message: "Tool manifest does not include examples or a test fixture reference.",
      evidence: evidenceFor(tool, "No examples, input_examples, test_fixture, or x_synapsor_test_fixture field was found."),
      recommendation:
        "Attach a safe fixture or example input/output pair so audits and tests can verify intended behavior without calling business tools.",
    });
  }
}

function toolSignals(tool: ToolCandidate): McpAuditToolShape["signals"] {
  const declaration = auditDeclaration(tool);
  const writeHint = tool.annotations.destructiveHint === true || tool.annotations.readOnlyHint === false;
  return {
    generic_sql: declaration?.operation === "generic_sql",
    write_like: writeHint || (declaration !== undefined && declaration.operation !== "read"),
    read_like: declaration?.operation === "read" || declaration?.operation === "read_write",
    proposal_boundary: declaration?.boundary === "proposal",
    model_callable_commit: declaration?.operation === "commit",
  };
}

function collectTools(input: unknown): ToolCandidate[] {
  const tools: ToolCandidate[] = [];
  const seen = new Set<string>();

  function addTool(value: unknown, path: string): void {
    if (!isRecord(value)) return;
    const rawName = optionalString(value.name) ?? optionalString(value.tool_name) ?? optionalString(value.toolName);
    if (!rawName) return;
    const name = safeToolName(rawName);
    const description =
      optionalString(value.description) ?? optionalString(value.title) ?? optionalString(value.summary) ?? "";
    const inputSchema =
      value.inputSchema ?? value.input_schema ?? value.parameters ?? value.schema ?? value.args_schema;
    const outputSchema =
      value.outputSchema ?? value.output_schema ?? value.resultSchema ?? value.result_schema ?? value.output;
    const annotations = isRecord(value.annotations) ? value.annotations : {};
    const key = `${path}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    tools.push({ name, description, inputSchema, outputSchema, annotations, raw: value, path });
  }

  function visit(value: unknown, path: string, depth: number): void {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      if (value.every((item) => isRecord(item) && typeof item.name === "string")) {
        value.forEach((item, index) => addTool(item, `${path}[${index}]`));
      } else {
        value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      }
      return;
    }
    if (!isRecord(value)) return;
    addTool(value, path);
    for (const [key, child] of Object.entries(value)) {
      if (key === "tools" && Array.isArray(child)) {
        child.forEach((tool, index) => addTool(tool, `${path}.${key}[${index}]`));
        continue;
      }
      if (["mcpServers", "servers"].includes(key) && isRecord(child)) {
        for (const [serverName, server] of Object.entries(child)) {
          visit(server, `${path}.${key}.${safeFieldName(serverName)}`, depth + 1);
        }
        continue;
      }
      if (["result", "data", "adapter", "mcpServers", "servers", "server", "manifest"].includes(key)) {
        visit(child, `${path}.${key}`, depth + 1);
      }
    }
  }

  visit(input, "$", 0);
  return tools;
}

function schemaTopLevelFields(schema: unknown): Omit<McpAuditToolField, "required">[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  return Object.entries(schema.properties)
    .filter(([, value]) => isRecord(value))
    .map(([name, raw]) => {
      const field = raw as JsonRecord;
      const type = schemaFieldType(field);
      return {
        name: safeFieldName(name),
        role: fieldRole(field),
        type,
        ...(type === "string" && positiveInteger(field.maxLength)
          ? { max_length: Math.min(Number(field.maxLength), 1_000_000) }
          : {}),
        ...(type === "number" && finiteNumber(field.minimum)
          ? { minimum: Number(field.minimum) }
          : {}),
        ...(type === "number" && finiteNumber(field.maximum)
          ? { maximum: Number(field.maximum) }
          : {}),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function schemaRequiredFields(schema: unknown): Set<string> {
  if (!isRecord(schema) || !Array.isArray(schema.required)) return new Set();
  return new Set(
    schema.required
      .filter((value): value is string => typeof value === "string")
      .map(safeFieldName),
  );
}

function schemaFieldType(schema: JsonRecord): McpAuditToolField["type"] {
  const type = schema.type;
  if (type === "integer" || type === "number") return "number";
  if (type === "string" || type === "boolean" || type === "array" || type === "object") return type;
  return "unknown";
}

type SchemaRoleInspection = {
  fields: Array<{ name: string; role: McpAuditFieldRole }>;
  coverage: "complete" | "incomplete";
};

/** Bounded advisory projection only. Unknown schema paths are never resolved or certified. */
function inspectSchemaFieldRoles(schema: unknown): SchemaRoleInspection {
  const fields: SchemaRoleInspection["fields"] = [];
  let incomplete = false;
  let visited = 0;
  function visit(value: unknown, depth: number): void {
    if (depth > 10 || ++visited > 1024) { incomplete = true; return; }
    if (value === false) return;
    if (!isRecord(value)) { incomplete = true; return; }
    if (typeof value.type !== "string") incomplete = true;
    if (depth === 0 && value.type !== "object") incomplete = true;
    if (value.$ref !== undefined || value.$dynamicRef !== undefined || value.$recursiveRef !== undefined
      || value.patternProperties !== undefined || value.not !== undefined
      || value.if !== undefined || value.then !== undefined || value.else !== undefined
      || value.dependentSchemas !== undefined || value.dependencies !== undefined
      || value.unevaluatedProperties !== undefined || value.unevaluatedItems !== undefined
      || value.contains !== undefined || value.prefixItems !== undefined || value.propertyNames !== undefined) incomplete = true;
    const objectShape = value.type === "object" || value.properties !== undefined || value.additionalProperties !== undefined || value.patternProperties !== undefined;
    if (objectShape && value.additionalProperties !== false) incomplete = true;
    if (value.type === "array" && value.items === undefined) incomplete = true;
    if (value.properties !== undefined && !isRecord(value.properties)) incomplete = true;
    if (isRecord(value.properties)) {
      for (const [name, child] of Object.entries(value.properties)) {
        if (visited >= 1024) { incomplete = true; break; }
        fields.push({ name, role: isRecord(child) ? fieldRole(child) : "unclassified" });
        visit(child, depth + 1);
      }
    }
    // `not` is a negated schema. Its role labels cannot be positive input/guard evidence.
    if (value.items !== undefined) visit(value.items, depth + 1);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const children = value[key];
      if (children !== undefined && !Array.isArray(children)) incomplete = true;
      if (Array.isArray(children)) {
        for (const child of children) {
          if (visited >= 1024) { incomplete = true; break; }
          visit(child, depth + 1);
        }
      }
    }
  }
  visit(schema, 0);
  return { fields, coverage: incomplete ? "incomplete" : "complete" };
}

function collectSchemaFieldRoles(schema: unknown): SchemaRoleInspection["fields"] {
  return inspectSchemaFieldRoles(schema).fields;
}

function collectSchemaPropertyNames(schema: unknown): Set<string> {
  return new Set(collectSchemaFieldRoles(schema).map((field) => field.name));
}

function buildMcpAuthorityMapFromTools(tools: ToolCandidate[]): McpAuditAuthorityMap {
  const select = (predicate: (tool: ToolCandidate) => boolean): string[] => [...new Set(tools.filter(predicate).map((tool) => tool.name))].sort();
  const status = (matches: string[]): McpAuditEvidenceStatus => matches.length > 0 ? "observed" : "requires_operator_verification";
  const declaredRole = (tool: ToolCandidate, ...roles: McpAuditFieldRole[]): boolean => collectSchemaFieldRoles(tool.inputSchema).some((field) => roles.includes(field.role));
  const semanticReads = select((tool) => {
    const signals = toolSignals(tool);
    return signals.read_like && !signals.write_like;
  });
  const proposals = select((tool) => {
    const signals = toolSignals(tool);
    return signals.proposal_boundary && signals.write_like;
  });
  const directWrites = select((tool) => {
    const signals = toolSignals(tool);
    return signals.write_like && !signals.proposal_boundary;
  });
  const rawQuery = select((tool) => toolSignals(tool).generic_sql);
  const identifiers = select((tool) => declaredRole(tool, "identifier"));
  const predicates = select((tool) => declaredRole(tool, "predicate"));
  const modelTrust = select((tool) => declaredRole(tool, "trust_scope"));
  const modelCommit = select((tool) => toolSignals(tool).model_callable_commit);
  const structured = select(hasStructuredOutput);
  const conflictOrIdempotency = select((tool) => [...collectSchemaFieldRoles(tool.inputSchema), ...collectSchemaFieldRoles(tool.outputSchema)]
    .some((field) => ["idempotency", "conflict", "receipt", "retry"].includes(field.role)));
  return {
    items: [
      authorityItem("semantic_read_tools", "Semantic read tools", status(semanticReads), semanticReads, `${semanticReads.length} tool(s) declare read operations in untrusted typed metadata; runtime enforcement is unverified.`),
      authorityItem("semantic_proposal_tools", "Semantic proposal tools", status(proposals), proposals, `${proposals.length} tool(s) declare a proposal boundary; runtime enforcement is unverified.`),
      authorityItem("direct_write_tools", "Direct model-callable write tools", status(directWrites), directWrites, `${directWrites.length} tool(s) declare or annotate writes without a typed proposal boundary; runtime enforcement is unverified.`),
      authorityItem("raw_query_tools", "Raw SQL or arbitrary-query tools", status(rawQuery), rawQuery, `${rawQuery.length} tool(s) declare generic SQL operations in untrusted metadata.`),
      authorityItem("arbitrary_identifier_inputs", "Model-controlled table, column, schema, or database inputs", status(identifiers), identifiers, `${identifiers.length} tool(s) expose typed identifier input roles.`),
      authorityItem("arbitrary_predicate_inputs", "Model-controlled filters, predicates, WHERE clauses, or conditions", status(predicates), predicates, `${predicates.length} tool(s) expose typed predicate input roles.`),
      authorityItem("model_controlled_trust", "Model-controlled tenant, principal, source, approval, or version inputs", status(modelTrust), modelTrust, `${modelTrust.length} tool(s) expose typed trust-scope input roles.`),
      authorityItem("model_visible_commit", "Model-visible approval, apply, commit, settle, merge, or revert authority", status(modelCommit), modelCommit, `${modelCommit.length} tool(s) declare commit operations in untrusted metadata.`),
      authorityItem("structured_output", "Structured output schema", structured.length > 0 ? "observed" : "not_observed", structured, `${structured.length}/${tools.length} inspected tool(s) declare structured output.`),
      authorityItem("conflict_idempotency_signals", "Declared conflict, retry, idempotency, or receipt signals", status(conflictOrIdempotency), conflictOrIdempotency, `${conflictOrIdempotency.length}/${tools.length} inspected tool(s) expose one or more machine-readable signals.`),
      authorityItem("sensitive_field_completeness", "Completeness of sensitive-field classification", "requires_operator_verification", [], "Tool metadata cannot establish that every sensitive field was identified or kept out."),
      authorityItem("database_enforcement", "Database roles, views, RLS, grants, and pooled-session scope reset", "outside_static_audit_visibility", [], "tools/list does not reveal database-enforced isolation or connection-pool behavior."),
      authorityItem("operator_and_writeback_enforcement", "Operator identity, approval integrity, guarded writeback, atomicity, and receipt durability", "outside_static_audit_visibility", [], "These controls execute outside the model-facing MCP catalog and require runtime/configuration evidence."),
    ],
    visibility_limit: "This map records untrusted typed declarations and structural schemas visible in the supplied manifest or tools/list; observed means declared, not verified. It does not execute business tools or prove runtime, database, identity, network, or operational enforcement.",
  };
}

function authorityItem(
  authority: string,
  label: string,
  status: McpAuditEvidenceStatus,
  tools: string[],
  evidence: string,
): McpAuditAuthorityItem {
  return { authority, label, status, tools, evidence };
}

function inspectConfiguredServer(name: string, raw: JsonRecord, liveSelectedServer?: string): McpAuditBypassServer {
  const tools = collectTools(raw);
  const direct = tools.filter((tool) => {
    const signals = toolSignals(tool);
    return signals.generic_sql || signals.model_callable_commit || (signals.write_like && !signals.proposal_boundary);
  });
  const transport: McpAuditBypassServer["transport"] = typeof raw.command === "string"
    ? "stdio"
    : typeof raw.url === "string"
      ? "remote"
      : "unknown";
  const safeName = safeToolName(name);
  if (direct.length > 0) {
    return {
      server: safeName,
      status: "observed_direct_authority",
      transport,
      tools_observed: [...new Set(tools.map((tool) => tool.name))].sort(),
      evidence: `Untrusted declarations or boolean risk annotations indicate direct/raw/commit tools in ${liveSelectedServer === name ? "the explicitly requested live tools/list" : "supplied tool metadata"}: ${direct.map((tool) => tool.name).sort().join(", ")}.`,
      remediation: "Disable or remove this model-visible server, constrain it to a separately reviewed read-only surface, or route the business action through Synapsor. Synapsor cannot govern calls that bypass Runner.",
    };
  }
  if (tools.some((tool) => !auditDeclaration(tool))) {
    return {
      server: safeName, status: "requires_operator_verification", transport,
      tools_observed: [...new Set(tools.map((tool) => tool.name))].sort(),
      evidence: "One or more tools have no valid typed authority declaration. Tool names and descriptions cannot establish absence of direct authority.",
      remediation: "Inspect this server's implementation and review typed declarations and runtime controls before model access.",
    };
  }
  return {
    server: safeName,
    status: "requires_operator_verification",
    transport,
    tools_observed: [...new Set(tools.map((tool) => tool.name))].sort(),
    evidence: "Supplied config or tool declarations cannot establish absence of direct authority or verify runtime enforcement; inspect the implementation before model access.",
    remediation: `Review this server's tools/list explicitly before enabling it for a model. Use --live-server ${safeName} --yes only after reviewing the configured command, or audit an exported tools/list file.`,
  };
}

function addBypassFindings(findings: McpAuditFinding[], bypass: McpAuditBypassCheck): void {
  for (const server of bypass.servers) {
    if (server.status === "observed_direct_authority") {
      addFinding(findings, {
        severity: "HIGH",
        code: "MCP_BYPASS_DIRECT_AUTHORITY",
        tool: server.server,
        message: "Another configured MCP server exposes direct write, raw query, or model-callable commit authority that can bypass Synapsor.",
        evidence: [server.evidence],
        recommendation: server.remediation,
      });
    } else if (server.status === "requires_operator_verification") {
      addFinding(findings, {
        severity: "LOW",
        code: "MCP_SERVER_TOOL_SURFACE_UNVERIFIED",
        tool: server.server,
        message: "Configured MCP server authority remains unverified by this static metadata audit.",
        evidence: [server.evidence],
        recommendation: server.remediation,
      });
    }
  }
}

function appendTextBypassCheck(lines: string[], bypass: McpAuditBypassCheck | undefined): void {
  if (!bypass) return;
  lines.push("", "Configured-server bypass check:");
  for (const server of bypass.servers) {
    lines.push(`- ${server.status}: ${server.server} (${server.transport})${server.tools_observed.length > 0 ? `; tools ${server.tools_observed.join(", ")}` : ""}`);
  }
  lines.push(bypass.warning);
}

function summarizeFindings(findings: McpAuditFinding[], toolsInspected: number): McpAuditReport["summary"] {
  return {
    tools_inspected: toolsInspected,
    high: findings.filter((finding) => finding.severity === "HIGH").length,
    medium: findings.filter((finding) => finding.severity === "MEDIUM").length,
    low: findings.filter((finding) => finding.severity === "LOW").length,
    total_findings: findings.length,
  };
}

function rootCauseForFinding(code: string): McpAuditRootCause {
  if (["TOOL_AUTHORITY_UNVERIFIED", "TOOL_ENFORCEMENT_UNVERIFIED", "INPUT_FIELD_ROLES_UNVERIFIED", "MCP_SERVER_TOOL_SURFACE_UNVERIFIED"].includes(code)) return "UNVERIFIED_AUTHORITY";
  if (code === "MODEL_CONTROLLED_TRUST_SCOPE") return "MODEL_CONTROLLED_TRUST";
  if (code === "MODEL_CALLABLE_COMMIT_OR_APPROVAL") return "MODEL_CALLABLE_COMMIT";
  if (["NO_IDEMPOTENCY_FIELD", "NO_CONFLICT_GUARD", "AMBIGUOUS_READ_WRITE_TOOL"].includes(code)) {
    return "WRITE_SAFETY_GAPS";
  }
  if (code === "NO_STRUCTURED_OUTPUT_SCHEMA") return "UNSTRUCTURED_TOOL_CONTRACT";
  if (["GENERIC_SQL_TOOL", "WRITE_TOOL_ACCEPTS_ARBITRARY_SQL", "ARBITRARY_IDENTIFIER_INPUT", "ARBITRARY_PREDICATE_INPUT", "WRITE_WITHOUT_PROPOSAL_BOUNDARY", "MCP_BYPASS_DIRECT_AUTHORITY"].includes(code)) {
    return "UNBOUNDED_DATABASE_AUTHORITY";
  }
  return "REVIEWABILITY_GAPS";
}

function highestSeverity(values: McpAuditSeverity[]): McpAuditSeverity {
  return [...values].sort((left, right) => severityRank(right) - severityRank(left))[0] ?? "LOW";
}

function severityRank(value: McpAuditSeverity): number {
  return value === "HIGH" ? 3 : value === "MEDIUM" ? 2 : 1;
}

function compareFindings(left: McpAuditFinding, right: McpAuditFinding): number {
  return severityRank(right.severity) - severityRank(left.severity)
    || left.code.localeCompare(right.code)
    || (left.tool ?? "").localeCompare(right.tool ?? "");
}

function sarifLevel(severity: McpAuditSeverity): "error" | "warning" | "note" {
  return severity === "HIGH" ? "error" : severity === "MEDIUM" ? "warning" : "note";
}

export function redactMcpAuditTarget(target: string): string {
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "remote-mcp-target";
    }
  }
  if (target.startsWith("stdio:")) {
    const executable = target.slice("stdio:".length).trim().split(/\s+/, 1)[0] ?? "command";
    return `stdio:${safeToolName(executable)}`;
  }
  return redactPotentialSecretText(target)
    .replace(/^\/home\/[^/]+\//, "~/")
    .replace(/^\/Users\/[^/]+\//, "~/")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+\\/i, "~\\")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 512);
}

function addFinding(
  findings: McpAuditFinding[],
  finding: Omit<McpAuditFinding, "remediation_url"> & { remediation_url?: string },
): void {
  const key = `${finding.severity}:${finding.code}:${finding.tool ?? ""}`;
  if (findings.some((existing) => `${existing.severity}:${existing.code}:${existing.tool ?? ""}` === key)) {
    return;
  }
  findings.push({
    ...finding,
    remediation_url: finding.remediation_url ?? remediationUrlForFinding(finding.code),
  });
}

function remediationUrlForFinding(code: string): string {
  const anchor = code.toLowerCase().replace(/_/g, "-");
  return `https://github.com/Synapsor/Synapsor-Runner/blob/main/docs/mcp-audit.md#finding-${anchor}`;
}

function hasStructuredOutput(tool: ToolCandidate): boolean {
  if (tool.outputSchema !== undefined) return true;
  if (tool.raw.structuredContent !== undefined) return true;
  if (tool.raw.structured_content !== undefined) return true;
  return false;
}

function hasExampleOrFixture(raw: JsonRecord): boolean {
  return ["examples", "example", "input_examples", "test_fixture", "x_synapsor_test_fixture"].some(
    (key) => raw[key] !== undefined,
  );
}

function evidenceFor(tool: ToolCandidate, detail: string): string[] {
  return [`path ${tool.path}`, detail];
}

function safeToolName(value: string): string {
  const trimmed = redactPotentialSecretText(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 160);
  return trimmed || "unnamed_tool";
}

function redactPotentialSecretText(value: string): string {
  return value
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|pk|ghp|gho|glpat|xox[baprs]|syn)_[A-Za-z0-9._-]{8,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

function safeFieldName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 96);
  return normalized || "unnamed_field";
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

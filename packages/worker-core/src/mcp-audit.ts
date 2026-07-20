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
  findings: McpAuditFinding[];
};

export type McpAuditRootCause =
  | "UNBOUNDED_DATABASE_AUTHORITY"
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

const GENERIC_SQL_TOOL_NAMES = [
  "executesql",
  "runsql",
  "runquery",
  "querydatabase",
  "databasequery",
  "sqlquery",
  "rawsql",
  "executequery",
];

const MODEL_CONTROLLED_SCOPE_FIELDS = [
  "tenantid",
  "principal",
  "principalid",
  "userid",
  "projectid",
  "sourceid",
  "databaseid",
  "allowedcolumns",
  "rowversion",
  "currentversion",
  "expectedversion",
  "approvalidentity",
];

const ARBITRARY_IDENTIFIER_FIELDS = [
  "table",
  "tablename",
  "schema",
  "schemaname",
  "column",
  "columns",
  "columnname",
  "database",
  "databasename",
];

const IDEMPOTENCY_FIELDS = ["idempotencykey", "requestid", "requestkey", "dedupekey"];
const CONFLICT_FIELDS = [
  "expectedversion",
  "rowversion",
  "updatedat",
  "etag",
  "conflictguard",
  "previousversion",
];

const ROOT_CAUSE_DEFINITIONS: Record<McpAuditRootCause, {
  title: string;
  blastRadius: string;
  recommendedAction: string;
}> = {
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
  options: { target?: string; generatedAt?: string } = {},
): McpAuditReport {
  const tools = collectTools(input);
  const findings: McpAuditFinding[] = [];

  for (const tool of tools) {
    auditTool(tool, findings);
  }

  if (tools.length === 0) {
    findings.push({
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
    `Overall risk: ${overallMcpAuditRisk(report).toLowerCase()}`,
  ];

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
    `Overall risk: ${overallMcpAuditRisk(report).toLowerCase()}`,
  ];
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
        help: { text: finding.recommendation },
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
          },
        })),
        properties: {
          schemaVersion: report.schema_version,
          disclaimer: report.disclaimer,
          toolsInspected: report.summary.tools_inspected,
        },
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
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
  const normalizedProperties = new Set([...propertyNames].map(normalizeToken));
  const {
    generic_sql: sqlLike,
    write_like: writeLike,
    read_like: readLike,
    proposal_boundary: proposalBoundary,
    model_callable_commit: modelCallableCommit,
  } = toolSignals(tool);

  if (sqlLike) {
    addFinding(findings, {
      severity: "HIGH",
      code: "GENERIC_SQL_TOOL",
      tool: tool.name,
      message: "Generic SQL/query tool exposed to the model.",
      evidence: evidenceFor(tool, "Tool name or description matches execute_sql/run_query/raw SQL patterns."),
      recommendation:
        "Replace model-facing SQL tools with reviewed semantic capabilities that use fixed identifiers and parameterized values.",
    });
  }

  if (sqlLike && hasAny(normalizedProperties, ["sql", "query", "statement", "rawsql"])) {
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

  if (hasAny(normalizedProperties, ARBITRARY_IDENTIFIER_FIELDS)) {
    addFinding(findings, {
      severity: "HIGH",
      code: "ARBITRARY_IDENTIFIER_INPUT",
      tool: tool.name,
      message: "Tool accepts schema, table, database, or column identifiers as ordinary model input.",
      evidence: evidenceFor(tool, `Identifier-like fields: ${matchingFields(propertyNames, ARBITRARY_IDENTIFIER_FIELDS).join(", ")}.`),
      recommendation:
        "Move identifiers into reviewed configuration. Model arguments should carry business values, not table/schema/column names.",
    });
  }

  if (hasAny(normalizedProperties, MODEL_CONTROLLED_SCOPE_FIELDS)) {
    addFinding(findings, {
      severity: "HIGH",
      code: "MODEL_CONTROLLED_TRUST_SCOPE",
      tool: tool.name,
      message: "Tool accepts tenant, principal, source, approval, or row-version trust fields as model input.",
      evidence: evidenceFor(tool, `Trust-like fields: ${matchingFields(propertyNames, MODEL_CONTROLLED_SCOPE_FIELDS).join(", ")}.`),
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
      evidence: evidenceFor(tool, "Tool name or description contains approval/commit/apply/settlement/writeback language."),
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
      evidence: evidenceFor(tool, "Tool looks write-capable but the manifest does not describe proposal/review/approval semantics."),
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

  if (writeLike && !proposalBoundary && !hasAny(normalizedProperties, IDEMPOTENCY_FIELDS)) {
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

  if (writeLike && !proposalBoundary && !hasAny(normalizedProperties, CONFLICT_FIELDS)) {
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
      evidence: evidenceFor(tool, "Tool name or description contains both read/query and write/update language."),
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
  const text = `${tool.name} ${tool.description} ${safeStringify(tool.annotations)}`.toLowerCase();
  const normalizedToolName = normalizeToken(tool.name);
  const lowerToolName = tool.name.toLowerCase();
  const genericSql =
    GENERIC_SQL_TOOL_NAMES.includes(normalizedToolName) ||
    /\b(execute|run|raw)\s*(sql|query)\b/.test(text) ||
    /\b(sql|query)\s*(executor|database)\b/.test(text);
  const writeLike = isWriteLike(text, tool.annotations);
  const readLike = /\b(read|get|list|search|inspect|select|query)\b/.test(text);
  const proposalBoundary =
    /\b(proposal|propose|change[- ]?set|review[- ]?required|approval|approve[- ]?required|guarded writeback|trusted worker)\b/.test(text);
  const modelCallableCommit =
    /(^|[._-])(approve|commit|apply|settle|merge)[._-]?(proposal|write|change|writeback)([._-]|$)/.test(lowerToolName) ||
    /(^|[._-])(proposal|write|change|writeback)[._-]?(approve|commit|apply|settle|merge)([._-]|$)/.test(lowerToolName) ||
    (/\b(approve|commit|apply|settle|merge)\b/.test(text) &&
      !/\b(propose|proposal|review[- ]?required|approval[- ]?required)\b/.test(text));
  return {
    generic_sql: genericSql,
    write_like: writeLike,
    read_like: readLike,
    proposal_boundary: proposalBoundary,
    model_callable_commit: modelCallableCommit,
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

function collectSchemaPropertyNames(schema: unknown): Set<string> {
  const names = new Set<string>();

  function visit(value: unknown, depth: number): void {
    if (depth > 10 || !isRecord(value)) return;
    const properties = value.properties;
    if (isRecord(properties)) {
      for (const [name, propertySchema] of Object.entries(properties)) {
        names.add(name);
        visit(propertySchema, depth + 1);
      }
    }
    for (const key of ["items", "additionalProperties", "not"]) {
      visit(value[key], depth + 1);
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const list = value[key];
      if (Array.isArray(list)) {
        for (const item of list) visit(item, depth + 1);
      }
    }
  }

  visit(schema, 0);
  return names;
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
  if (code === "MODEL_CONTROLLED_TRUST_SCOPE") return "MODEL_CONTROLLED_TRUST";
  if (code === "MODEL_CALLABLE_COMMIT_OR_APPROVAL") return "MODEL_CALLABLE_COMMIT";
  if (["NO_IDEMPOTENCY_FIELD", "NO_CONFLICT_GUARD", "AMBIGUOUS_READ_WRITE_TOOL"].includes(code)) {
    return "WRITE_SAFETY_GAPS";
  }
  if (code === "NO_STRUCTURED_OUTPUT_SCHEMA") return "UNSTRUCTURED_TOOL_CONTRACT";
  if (["GENERIC_SQL_TOOL", "WRITE_TOOL_ACCEPTS_ARBITRARY_SQL", "ARBITRARY_IDENTIFIER_INPUT", "WRITE_WITHOUT_PROPOSAL_BOUNDARY"].includes(code)) {
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
  return redactPotentialSecretText(target).slice(0, 512);
}

function addFinding(findings: McpAuditFinding[], finding: McpAuditFinding): void {
  const key = `${finding.severity}:${finding.code}:${finding.tool ?? ""}`;
  if (findings.some((existing) => `${existing.severity}:${existing.code}:${existing.tool ?? ""}` === key)) {
    return;
  }
  findings.push(finding);
}

function isWriteLike(text: string, annotations: JsonRecord): boolean {
  if (annotations.destructiveHint === true || annotations.readOnlyHint === false) {
    return true;
  }
  return /\b(update|insert|delete|upsert|write|mutate|refund|waive|charge|cancel|commit|approve|settle|apply|merge|resolve|close|create|drop|alter)\b/.test(
    text,
  );
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

function matchingFields(fields: Set<string>, normalizedCandidates: string[]): string[] {
  const candidates = new Set(normalizedCandidates);
  return [...fields].filter((field) => candidates.has(normalizeToken(field)));
}

function hasAny(fields: Set<string>, normalizedCandidates: string[]): boolean {
  const candidates = new Set(normalizedCandidates);
  for (const field of fields) {
    if (candidates.has(field)) return true;
  }
  return false;
}

function evidenceFor(tool: ToolCandidate, detail: string): string[] {
  return [`path ${tool.path}`, detail];
}

function normalizeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
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

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

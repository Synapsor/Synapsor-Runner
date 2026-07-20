import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateContract, type ArgumentSpec, type CapabilitySpec, type SynapsorContract } from "@synapsor/spec";
import {
  auditMcpManifest,
  groupMcpAuditFindings,
  inspectMcpManifestTools,
  overallMcpAuditRisk,
  redactMcpAuditTarget,
  type McpAuditReport,
  type McpAuditToolField,
  type McpAuditToolShape,
} from "@synapsor-runner/worker-core";

export const AUDIT_CANDIDATE_SCHEMA_VERSION = "synapsor.audit-candidates.v1";
export const AUDIT_CANDIDATE_MARKER = ".synapsor-audit-candidates.json";

const CONTRACT_FILE = "synapsor.candidate.contract.json";
const CONFIG_FILE = "synapsor.candidate.runner.json";
const TEST_FILE = "synapsor.candidate.contract-tests.json";
const BEFORE_FILE = "tool-surface.before.json";
const AFTER_FILE = "tool-surface.after.json";
const REVIEW_FILE = "REVIEW.md";

const MODEL_AUTHORITY_FIELDS = new Set([
  "sql",
  "query",
  "statement",
  "rawsql",
  "where",
  "predicate",
  "tenantid",
  "tenant",
  "principal",
  "principalid",
  "userid",
  "projectid",
  "sourceid",
  "databaseid",
  "schema",
  "schemaname",
  "table",
  "tablename",
  "column",
  "columns",
  "columnname",
  "database",
  "databasename",
  "approvalidentity",
  "expectedversion",
  "rowversion",
  "allowedcolumns",
  "databaseurl",
  "password",
  "token",
  "apikey",
  "secret",
]);

const WRITE_PREFIXES = new Set([
  "add",
  "apply",
  "approve",
  "cancel",
  "charge",
  "close",
  "commit",
  "create",
  "delete",
  "drop",
  "insert",
  "issue",
  "merge",
  "mutate",
  "refund",
  "remove",
  "resolve",
  "run",
  "settle",
  "update",
  "upsert",
  "waive",
  "write",
]);

const READ_PREFIXES = new Set(["find", "get", "inspect", "list", "lookup", "query", "read", "search", "select"]);

export type AuditCandidateOutput = {
  output_dir: string;
  overwritten: boolean;
  source_digest: `sha256:${string}`;
  overall_risk: ReturnType<typeof overallMcpAuditRisk>;
  candidates: Array<{
    source_tool: string;
    capability: string;
    kind: "read" | "proposal";
    activation: "blocked_unreviewed";
  }>;
  files: string[];
};

type CandidateBundle = {
  report: McpAuditReport;
  sourceDigest: `sha256:${string}`;
  contract: SynapsorContract;
  config: Record<string, unknown>;
  tests: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  review: string;
  marker: Record<string, unknown>;
  candidates: AuditCandidateOutput["candidates"];
};

export async function generateAuditCandidateDirectory(input: {
  manifest: unknown;
  target: string;
  outputDir: string;
  force?: boolean;
}): Promise<AuditCandidateOutput> {
  const outputDir = path.resolve(input.outputDir);
  const parent = path.dirname(outputDir);
  const existed = await pathExists(outputDir);
  if (existed) {
    if (!input.force) {
      throw new Error(`audit candidate output already exists: ${outputDir}. Choose another directory or pass --force.`);
    }
    await assertOwnedCandidateDirectory(outputDir);
  }

  const bundle = buildAuditCandidateBundle(input.manifest, input.target);
  await fs.mkdir(parent, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(parent, `.${path.basename(outputDir)}.tmp-`));
  try {
    await fs.writeFile(path.join(temporary, CONTRACT_FILE), json(bundle.contract), "utf8");
    await fs.writeFile(path.join(temporary, CONFIG_FILE), json(bundle.config), "utf8");
    await fs.writeFile(path.join(temporary, TEST_FILE), json(bundle.tests), "utf8");
    await fs.writeFile(path.join(temporary, BEFORE_FILE), json(bundle.before), "utf8");
    await fs.writeFile(path.join(temporary, AFTER_FILE), json(bundle.after), "utf8");
    await fs.writeFile(path.join(temporary, REVIEW_FILE), bundle.review, "utf8");
    await fs.writeFile(path.join(temporary, AUDIT_CANDIDATE_MARKER), json(bundle.marker), "utf8");
    if (existed) await fs.rm(outputDir, { recursive: true, force: true });
    await fs.rename(temporary, outputDir);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }

  return {
    output_dir: outputDir,
    overwritten: existed,
    source_digest: bundle.sourceDigest,
    overall_risk: overallMcpAuditRisk(bundle.report),
    candidates: bundle.candidates,
    files: [
      AUDIT_CANDIDATE_MARKER,
      CONTRACT_FILE,
      CONFIG_FILE,
      TEST_FILE,
      BEFORE_FILE,
      AFTER_FILE,
      REVIEW_FILE,
    ],
  };
}

export function buildAuditCandidateBundle(manifest: unknown, target: string): CandidateBundle {
  const tools = inspectMcpManifestTools(manifest);
  if (tools.length === 0) throw new Error("audit candidate generation requires at least one MCP tool");
  const safeTarget = redactMcpAuditTarget(target);
  const report = auditMcpManifest(manifest, {
    target: safeTarget,
    generatedAt: "1970-01-01T00:00:00.000Z",
  });
  const sourceDigest = digest({
    schema_version: "synapsor.audit-source.v1",
    target: safeTarget,
    tools,
    findings: report.findings.map(({ severity, code, tool }) => ({ severity, code, tool })),
  });
  const usedNames = new Set<string>();
  const capabilities = tools.map((tool, index) => capabilityCandidate(tool, index, usedNames));
  const contract: SynapsorContract = {
    spec_version: "0.1",
    kind: "SynapsorContract",
    metadata: {
      name: "MCP audit review candidates",
      description: "Disabled candidates generated from MCP tool structure. Every authority-bearing placeholder requires human review.",
      version: "0.0.0-candidate",
      tags: ["audit-candidate", "not-active"],
      "x-runner-source-digest": sourceDigest,
    },
    contexts: [
      {
        name: "review_candidate_context",
        description: "TODO: replace these placeholders with a verified trusted-context provider.",
        bindings: [
          {
            name: "tenant_id",
            source: "environment",
            key: "SYNAPSOR_REVIEW_TENANT_ID",
            required: true,
            "x-runner-todo": "Choose and verify the authoritative tenant binding.",
          },
          {
            name: "principal",
            source: "environment",
            key: "SYNAPSOR_REVIEW_PRINCIPAL",
            required: true,
            "x-runner-todo": "Choose and verify the authoritative principal binding.",
          },
        ],
        tenant_binding: "tenant_id",
        principal_binding: "principal",
        "x-runner-review-status": "blocked_unreviewed",
      },
    ],
    capabilities,
    "x-runner-candidate-only": true,
    "x-runner-review-status": "blocked_unreviewed",
    "x-runner-source-digest": sourceDigest,
  };
  const validation = validateContract(contract);
  if (!validation.ok) {
    throw new Error(`internal audit candidate contract error: ${validation.errors.map((issue) => `${issue.code}@${issue.path}`).join(", ")}`);
  }

  const candidates = capabilities.map((capability, index) => ({
    source_tool: tools[index]!.name,
    capability: capability.name,
    kind: capability.kind as "read" | "proposal",
    activation: "blocked_unreviewed" as const,
  }));
  const files = [CONTRACT_FILE, CONFIG_FILE, TEST_FILE, BEFORE_FILE, AFTER_FILE, REVIEW_FILE];
  const config = candidateRunnerConfig();
  const tests = candidateContractTests(capabilities);
  const before = {
    schema_version: "synapsor.audit-tool-surface.v1",
    state: "observed",
    source_digest: sourceDigest,
    tools: tools.map((tool) => ({
      name: safeDisplayName(tool.name),
      signals: tool.signals,
      finding_codes: report.findings
        .filter((finding) => finding.tool === tool.name)
        .map((finding) => finding.code)
        .sort(),
    })),
  };
  const after = {
    schema_version: "synapsor.audit-tool-surface.v1",
    state: "candidate_disabled",
    source_digest: sourceDigest,
    tools: capabilities.map((capability) => ({
      name: capability.name,
      kind: capability.kind,
      trusted_context: capability.context,
      raw_sql_argument: false,
      model_controlled_tenant_or_principal: false,
      model_callable_approval_or_apply: false,
      writeback: capability.kind === "proposal" ? "none" : "not_applicable",
      activation: "blocked_unreviewed",
    })),
  };
  const marker = {
    schema_version: AUDIT_CANDIDATE_SCHEMA_VERSION,
    owner: "@synapsor/runner",
    source_digest: sourceDigest,
    activation: "blocked_unreviewed",
    deterministic: true,
    files,
  };
  return {
    report,
    sourceDigest,
    contract,
    config,
    tests,
    before,
    after,
    review: candidateReviewMarkdown(safeTarget, report, sourceDigest, capabilities, tools),
    marker,
    candidates,
  };
}

function capabilityCandidate(
  tool: McpAuditToolShape,
  index: number,
  usedNames: Set<string>,
): CapabilitySpec {
  const proposal = tool.signals.write_like || tool.signals.generic_sql || tool.signals.model_callable_commit;
  const name = uniqueCapabilityName(candidateCapabilityName(tool, proposal), usedNames);
  const { args, todos, excludedFields } = candidateArgs(tool.input_fields);
  const lookupArg = Object.keys(args).find((arg) => /(?:^|_)id$/.test(arg)) ?? Object.keys(args)[0]!;
  const sensitiveSuggestions = tool.input_fields
    .map((field) => safeIdentifier(field.name))
    .filter((field) => /(password|secret|token|key|ssn|social_security|card|credential|private|internal)/i.test(field))
    .sort();
  const common = {
    name,
    description: proposal
      ? "TODO: name and review this business change. This candidate can create shadow proposals only and has no writeback authority."
      : "TODO: name and review this tenant-scoped business read before activation.",
    kind: proposal ? "proposal" as const : "read" as const,
    context: "review_candidate_context",
    source: "review_required_source",
    subject: {
      schema: "review_required_schema",
      table: `review_required_object_${index + 1}`,
      primary_key: "review_required_id",
      tenant_key: "review_required_tenant",
      conflict_key: "review_required_version",
      "x-runner-todo": "Replace every subject identifier after schema and tenant-boundary review.",
    },
    args,
    lookup: { id_from_arg: lookupArg },
    visible_fields: [
      "review_required_id",
      "review_required_tenant",
      "review_required_version",
      "review_required_visible_field",
    ],
    kept_out_fields: [...new Set(["review_required_sensitive_field", ...sensitiveSuggestions])],
    evidence: { required: true, query_audit: true },
    max_rows: 1,
    "x-runner-source-tool": safeDisplayName(tool.name),
    "x-runner-review-status": "blocked_unreviewed",
    "x-runner-todos": [
      "Confirm the business object, source, schema, table, primary key, and tenant key.",
      "Replace visible-field placeholders with a minimum reviewed allowlist.",
      "Confirm every kept-out field using the real source schema and data classification.",
      "Replace environment placeholders with verified deployment-specific trusted context.",
      ...todos,
      ...(excludedFields.length
        ? [`Do not restore excluded authority-bearing model fields without review: ${excludedFields.join(", ")}.`]
        : []),
    ],
    "x-runner-suggested-kept-out-fields": sensitiveSuggestions,
  };
  if (!proposal) return common;

  const suggestedAllowedFields = tool.input_fields
    .map((field) => safeIdentifier(field.name))
    .filter((field) => !isAuthorityField(field))
    .filter((field) => !/(?:^|_)id$/.test(field))
    .filter((field) => !/(reason|note|comment|message|request)/i.test(field))
    .sort();
  return {
    ...common,
    proposal: {
      action: `${name.replace(".propose_", ".")}_reviewed_action`,
      allowed_fields: ["review_required_write_field"],
      patch: {
        review_required_write_field: { from_arg: lookupArg },
      },
      conflict_guard: { column: "review_required_version" },
      approval: {
        mode: "human",
        required_role: "review_required_reviewer",
      },
      writeback: { mode: "none" },
      "x-runner-suggested-allowed-fields": suggestedAllowedFields,
      "x-runner-todo": "Replace the placeholder patch with exact reviewed fields, bounds, conflict semantics, and writeback only after shadow evaluation.",
    },
  };
}

function candidateArgs(fields: McpAuditToolField[]): {
  args: Record<string, ArgumentSpec>;
  todos: string[];
  excludedFields: string[];
} {
  const args: Record<string, ArgumentSpec> = {};
  const todos: string[] = [];
  const excludedFields: string[] = [];
  for (const field of fields) {
    const name = safeIdentifier(field.name);
    if (isAuthorityField(name)) {
      excludedFields.push(name);
      continue;
    }
    if (field.type === "array" || field.type === "object" || field.type === "unknown") {
      todos.push(`Model field ${name} uses unsupported or ambiguous type ${field.type}; define a bounded business argument manually.`);
      continue;
    }
    if (field.type === "string") {
      args[name] = {
        type: "string",
        required: field.required,
        max_length: Math.max(1, Math.min(field.max_length ?? 256, 4096)),
      };
    } else if (field.type === "number") {
      args[name] = {
        type: "number",
        required: field.required,
        ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
        ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
      };
    } else {
      args[name] = { type: "boolean", required: field.required };
    }
  }
  if (Object.keys(args).length === 0) {
    args.review_request_id = {
      type: "string",
      required: true,
      max_length: 128,
      description: "TODO: replace with the reviewed business-object lookup argument.",
    };
    todos.push("No safe business argument could be inferred; replace review_request_id.");
  }
  return {
    args: Object.fromEntries(Object.entries(args).sort(([left], [right]) => left.localeCompare(right))),
    todos,
    excludedFields: excludedFields.sort(),
  };
}

function candidateCapabilityName(tool: McpAuditToolShape, proposal: boolean): string {
  const parts = tool.name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(safeIdentifier);
  const namespace = tool.name.includes(".") && parts.length > 1 ? parts.shift()! : "review";
  while (parts.length > 1 && (proposal ? WRITE_PREFIXES : READ_PREFIXES).has(parts[0]!)) parts.shift();
  const object = parts.join("_") || "business_action";
  const verb = proposal ? "propose" : "inspect";
  return `${namespace}.${verb}_${object}`;
}

function uniqueCapabilityName(candidate: string, used: Set<string>): string {
  let value = candidate;
  let suffix = 2;
  while (used.has(value)) {
    value = `${candidate}_${suffix}`;
    suffix += 1;
  }
  used.add(value);
  return value;
}

function candidateRunnerConfig(): Record<string, unknown> {
  return {
    version: 1,
    mode: "shadow",
    storage: {
      sqlite_path: "./.synapsor/candidate-shadow.db",
    },
    sources: {},
    trusted_context: {
      provider: "environment",
      values: {
        tenant_id_env: "SYNAPSOR_REVIEW_TENANT_ID",
        principal_env: "SYNAPSOR_REVIEW_PRINCIPAL",
      },
    },
    contexts: {
      review_candidate_context: {
        provider: "environment",
        values: {
          tenant_id_env: "SYNAPSOR_REVIEW_TENANT_ID",
          principal_env: "SYNAPSOR_REVIEW_PRINCIPAL",
        },
      },
    },
    contracts: [`./${CONTRACT_FILE}`],
    capabilities: [],
  };
}

function candidateContractTests(capabilities: CapabilitySpec[]): Record<string, unknown> {
  return {
    version: 1,
    name: "Generated deny and redaction checks - review all placeholders first",
    tests: capabilities.flatMap((capability, index) => {
      const lookup = capability.lookup?.id_from_arg ?? Object.keys(capability.args)[0]!;
      const common = {
        capability: capability.name,
      };
      return [
        {
          id: `candidate_${index + 1}_operator_boundary`,
          kind: "operator_boundary",
          ...common,
        },
        {
          id: `candidate_${index + 1}_hide_fields`,
          kind: "hide_fields",
          ...common,
          fields: capability.kept_out_fields,
        },
        {
          id: `candidate_${index + 1}_cross_tenant_deny`,
          kind: "tool_deny",
          ...common,
          args: { [lookup]: "REVIEW_OTHER_TENANT_OBJECT" },
          trusted_context: {
            tenant_id: "REVIEW_TENANT_A",
            principal: "REVIEW_PRINCIPAL_A",
            provenance: "static_dev",
          },
          expected_code: "NOT_FOUND_IN_TENANT",
        },
      ];
    }),
  };
}

function candidateReviewMarkdown(
  target: string,
  report: McpAuditReport,
  sourceDigest: string,
  capabilities: CapabilitySpec[],
  tools: McpAuditToolShape[],
): string {
  const groups = groupMcpAuditFindings(report);
  const rows = capabilities.map((capability, index) =>
    `| \`${safeDisplayName(tools[index]!.name)}\` | \`${capability.name}\` | ${capability.kind} | blocked |`,
  );
  return `# Review generated MCP candidates

These files are **not active configuration**. The contract uses placeholder
identifiers, every proposal has \`writeback.mode: none\`, and the companion
Runner config is strict \`shadow\` mode with no source definition.

- Audited target: \`${target}\`
- Source digest: \`${sourceDigest}\`
- Overall static risk: ${overallMcpAuditRisk(report)}
- Static-review disclaimer: ${report.disclaimer}

## Candidate surface

| Existing tool | Candidate capability | Kind | Activation |
| --- | --- | --- | --- |
${rows.join("\n")}

## Distinct root causes

${groups.map((group) => `- **${group.title}** (${group.severity}): ${group.blast_radius}`).join("\n")}

## Required human decisions

1. Confirm the business object and replace every \`review_required_*\` identifier.
2. Choose the authoritative tenant and principal bindings for the deployment.
3. Inspect the real schema; set a minimum visible-field allowlist and explicit
   kept-out fields.
4. Replace each placeholder input/patch with typed business arguments, bounds,
   fixed identifiers, and an exact conflict guard.
5. Keep proposal writeback disabled while running the generated deny/redaction
   checks and a strict Shadow study.
6. Only after review, copy the contract to a deliberate production path, define
   the source separately, choose a writeback executor, and activate it through
   normal code review. Do not edit this generated directory into production.

## Files

- \`${CONTRACT_FILE}\`: canonical \`@synapsor/spec\` candidate contract.
- \`${CONFIG_FILE}\`: non-runnable shadow-only scaffold with no source.
- \`${TEST_FILE}\`: deny, hidden-field, and operator-boundary test scaffold.
- \`${BEFORE_FILE}\` / \`${AFTER_FILE}\`: model tool-surface comparison.

Generated candidate metadata never contains source credentials, bearer-token
values, examples, defaults, enum values, or raw tool descriptions.
`;
}

async function assertOwnedCandidateDirectory(directory: string): Promise<void> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(directory, AUDIT_CANDIDATE_MARKER), "utf8")) as Record<string, unknown>;
    if (marker.schema_version !== AUDIT_CANDIDATE_SCHEMA_VERSION || marker.owner !== "@synapsor/runner") {
      throw new Error("marker mismatch");
    }
  } catch {
    throw new Error(`refusing to overwrite non-generated directory: ${directory}`);
  }
}

function isAuthorityField(value: string): boolean {
  return MODEL_AUTHORITY_FIELDS.has(normalize(value));
}

function normalize(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function safeIdentifier(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  const prefixed = /^[a-z_]/.test(normalized) ? normalized : `field_${normalized}`;
  return prefixed || "review_field";
}

function safeDisplayName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) || "unnamed_tool";
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

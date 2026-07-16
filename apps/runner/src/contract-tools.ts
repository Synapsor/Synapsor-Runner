import fs from "node:fs/promises";
import path from "node:path";
import { compileAgentDslWithWarnings } from "@synapsor/dsl";
import {
  normalizeContract,
  type AgentContextSpec,
  type ArgumentSpec,
  type CapabilitySpec,
  type JsonScalar,
  type SynapsorContract,
} from "@synapsor/spec";

export type ReviewedContractSource = "dsl" | "json";

export type LoadedReviewedContract = {
  contract: SynapsorContract;
  source: ReviewedContractSource;
  sourcePath: string;
  dslWarnings: Array<{ line: number; column: number; code: string; message: string }>;
};

export type ContractLintSeverity = "error" | "warning" | "info";

export type ContractLintIssue = {
  code: string;
  severity: ContractLintSeverity;
  path: string;
  message: string;
};

export type ContractLintResult = {
  ok: boolean;
  issues: ContractLintIssue[];
  summary: { errors: number; warnings: number; info: number };
};

export type ContractExplanation = {
  contract: {
    name: string;
    description?: string;
    version?: string;
    spec_version: string;
  };
  contexts: Array<{
    name: string;
    tenant_binding?: string;
    principal_binding?: string;
    bindings: Array<{ name: string; source: string; key: string; required: boolean }>;
  }>;
  capabilities: Array<{
    name: string;
    description?: string;
    returns_hint?: string;
    kind: string;
    context: string;
    source?: string;
    target: string;
    trusted_scope: string[];
    row_scope?: {
      tenant_column?: string;
      tenant_binding?: string;
      principal_column?: string;
      principal_binding?: string;
      principal_provider?: string;
      principal_required?: boolean;
      effective_predicate: string;
    };
    arguments: Array<Record<string, unknown>>;
    lookup?: string;
    fixed_selection?: string[];
    visible_fields: string[];
    kept_out_fields: string[];
    evidence: string;
    aggregate?: Record<string, unknown>;
    proposal?: Record<string, unknown>;
  }>;
  workflows: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  boundaries: string[];
};

export async function loadReviewedContract(sourcePath: string): Promise<LoadedReviewedContract> {
  const absolute = path.resolve(sourcePath);
  const sourceText = await fs.readFile(absolute, "utf8");
  if (isDslPath(absolute)) {
    const compiled = compileAgentDslWithWarnings(sourceText);
    return {
      contract: normalizeContract(compiled.contract),
      source: "dsl",
      sourcePath: absolute,
      dslWarnings: compiled.warnings,
    };
  }
  return {
    contract: normalizeContract(JSON.parse(sourceText)),
    source: "json",
    sourcePath: absolute,
    dslWarnings: [],
  };
}

export function explainContract(contract: SynapsorContract): ContractExplanation {
  const contexts = new Map(contract.contexts.map((context) => [context.name, context]));
  return {
    contract: {
      name: contract.metadata?.name ?? "unnamed contract",
      ...(contract.metadata?.description ? { description: contract.metadata.description } : {}),
      ...(contract.metadata?.version ? { version: contract.metadata.version } : {}),
      spec_version: contract.spec_version,
    },
    contexts: contract.contexts.map(explainContext),
    capabilities: contract.capabilities.map((capability) => explainCapability(capability, contexts.get(capability.context))),
    workflows: (contract.workflows ?? []).map((workflow) => ({
      name: workflow.name,
      context: workflow.context,
      allowed_capabilities: workflow.allowed_capabilities,
      required_evidence: workflow.required_evidence === true,
      approval: workflow.approval ?? { required: false },
      replay: workflow.replay ?? { checkpoint: "none" },
    })),
    policies: (contract.policies ?? []).map((policy) => ({
      name: policy.name,
      kind: policy.kind,
      ...(policy.mode ? { mode: policy.mode } : {}),
      rules: policy.rules?.length ?? 0,
      limits: policy.limits ?? [],
    })),
    boundaries: [
      "The model receives reviewed semantic capabilities, never raw SQL or database credentials.",
      "Tenant and principal authority come from trusted context bindings, not model arguments.",
      "Proposal capabilities save intent; approval and writeback stay outside MCP/model authority.",
      "This explanation summarizes the reviewed contract. It does not replace schema classification, database permissions, or human review.",
    ],
  };
}

export function formatContractExplanation(explanation: ContractExplanation, format: "text" | "markdown" | "json"): string {
  if (format === "json") return `${JSON.stringify(explanation, null, 2)}\n`;
  const markdown = formatExplanationMarkdown(explanation);
  if (format === "markdown") return markdown;
  return markdown
    .replace(/^#{1,4}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-*]\s+/gm, "- ");
}

export function lintContract(
  contract: SynapsorContract,
  options: { runnerConfig?: Record<string, unknown>; dslWarnings?: LoadedReviewedContract["dslWarnings"] } = {},
): ContractLintResult {
  const issues: ContractLintIssue[] = [];
  const add = (issue: ContractLintIssue): void => { issues.push(issue); };
  if (!contract.metadata?.description) add({ code: "CONTRACT_DESCRIPTION_MISSING", severity: "warning", path: "$.metadata.description", message: "Add a plain-language contract description for reviewers." });

  for (const warning of options.dslWarnings ?? []) {
    add({ code: `DSL_${warning.code}`, severity: "warning", path: `line:${warning.line}:${warning.column}`, message: warning.message });
  }

  const configSources = recordKeys(options.runnerConfig?.sources);
  const configExecutors = recordKeys(options.runnerConfig?.executors);
  for (const [index, capability] of contract.capabilities.entries()) {
    const base = `$.capabilities[${index}]`;
    if (!capability.description) add({ code: "CAPABILITY_DESCRIPTION_MISSING", severity: "warning", path: `${base}.description`, message: `${capability.name} needs a reviewer-facing description.` });
    if (!capability.returns_hint) add({ code: "RETURNS_HINT_MISSING", severity: "info", path: `${base}.returns_hint`, message: `${capability.name} should describe its model-facing result.` });
    if ((capability.visible_fields?.length ?? 0) > 0 && (capability.kept_out_fields?.length ?? 0) === 0) {
      add({ code: "KEPT_OUT_REVIEW_NOT_RECORDED", severity: "warning", path: `${base}.kept_out_fields`, message: `${capability.name} does not record an explicit kept-out field review; lint cannot infer which columns are sensitive.` });
    }
    if (capability.evidence?.required !== true) add({ code: "EVIDENCE_NOT_REQUIRED", severity: "warning", path: `${base}.evidence.required`, message: `${capability.name} does not require evidence.` });
    if (!capability.subject.principal_scope_key) {
      const possibleOwnerFields = [...new Set([...capability.visible_fields, ...(capability.kept_out_fields ?? [])])]
        .filter((field) => /^(?:assigned_to|assignee_id|owner_id|principal_id|user_id|case_manager_id)$/i.test(field));
      if (possibleOwnerFields.length > 0) {
        add({
          code: "PRINCIPAL_SCOPE_REVIEW_RECOMMENDED",
          severity: "info",
          path: `${base}.subject.principal_scope_key`,
          message: `${capability.name} includes ${possibleOwnerFields.join(", ")}, which may represent row ownership. Review whether PRINCIPAL SCOPE KEY is appropriate; this is only a naming heuristic and is not data classification.`,
        });
      }
    }
    for (const [argName, arg] of Object.entries(capability.args)) lintArgument(add, `${base}.args.${argName}`, argName, arg);

    if (options.runnerConfig && capability.source && !configSources.has(capability.source)) {
      add({ code: "RUNNER_SOURCE_UNRESOLVED", severity: "error", path: `${base}.source`, message: `${capability.name} references source ${capability.source}, which is absent from runner config.` });
    }
    const writeback = capability.proposal?.writeback;
    if (writeback?.mode === "app_handler" && (!writeback.executor || (options.runnerConfig && !configExecutors.has(writeback.executor)))) {
      add({ code: "APP_HANDLER_EXECUTOR_UNRESOLVED", severity: "error", path: `${base}.proposal.writeback.executor`, message: `${capability.name} requires a configured app-handler executor.` });
    }
    if (capability.proposal?.operation?.kind === "delete" && !capability.proposal.reversibility) {
      add({ code: "IRREVERSIBLE_DELETE_REVIEW", severity: "warning", path: `${base}.proposal.reversibility`, message: `${capability.name} performs a hard delete without reviewed inverse compensation.` });
    }
  }

  issues.sort((left, right) => severityRank(left.severity) - severityRank(right.severity) || left.code.localeCompare(right.code) || left.path.localeCompare(right.path));
  const summary = {
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    info: issues.filter((issue) => issue.severity === "info").length,
  };
  return { ok: summary.errors === 0, issues, summary };
}

export function formatContractLint(result: ContractLintResult, format: "text" | "json" | "sarif"): string {
  if (format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  if (format === "sarif") {
    return `${JSON.stringify({
      version: "2.1.0",
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      runs: [{
        tool: { driver: { name: "synapsor-runner contract lint", rules: uniqueRules(result.issues) } },
        results: result.issues.map((issue) => ({
          ruleId: issue.code,
          level: issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "note",
          message: { text: issue.message },
          locations: [{ physicalLocation: { artifactLocation: { uri: issue.path } } }],
        })),
      }],
    }, null, 2)}\n`;
  }
  const lines = result.issues.map((issue) => `${issue.severity.toUpperCase()} ${issue.code} ${issue.path}: ${issue.message}`);
  lines.push(`Summary: ${result.summary.errors} error / ${result.summary.warnings} warning / ${result.summary.info} info`);
  return `${lines.join("\n")}\n`;
}

export function lintFails(result: ContractLintResult, failOn: "error" | "warning"): boolean {
  return result.summary.errors > 0 || (failOn === "warning" && result.summary.warnings > 0);
}

function explainContext(context: AgentContextSpec): ContractExplanation["contexts"][number] {
  return {
    name: context.name,
    ...(context.tenant_binding ? { tenant_binding: context.tenant_binding } : {}),
    ...(context.principal_binding ? { principal_binding: context.principal_binding } : {}),
    bindings: context.bindings.map((binding) => ({ name: binding.name, source: binding.source, key: binding.key, required: binding.required === true })),
  };
}

function explainCapability(capability: CapabilitySpec, context?: AgentContextSpec): ContractExplanation["capabilities"][number] {
  const proposal = capability.proposal;
  const selection = (proposal?.operation?.selection ?? capability.aggregate?.selection)?.all.map((term) => `${term.column} = ${scalarText(term.value)}`);
  const principalBinding = context?.bindings.find((binding) => binding.name === context.principal_binding);
  const tenantColumn = capability.subject.tenant_key;
  const principalColumn = capability.subject.principal_scope_key;
  const effectivePredicate = [
    ...(tenantColumn ? [`${tenantColumn} = <trusted tenant>`] : []),
    ...(principalColumn ? [`${principalColumn} = <trusted principal>`] : []),
    ...((proposal?.operation?.selection ?? capability.aggregate?.selection)?.all.map((term) => `${term.column} ${term.operator} <reviewed value>`) ?? []),
  ].join(" AND ") || "no row predicate declared";
  return {
    name: capability.name,
    ...(capability.description ? { description: capability.description } : {}),
    ...(capability.returns_hint ? { returns_hint: capability.returns_hint } : {}),
    kind: capability.kind,
    context: capability.context,
    ...(capability.source ? { source: capability.source } : {}),
    target: capability.subject.resource ?? ([capability.subject.schema, capability.subject.table].filter(Boolean).join(".") || "unresolved target"),
    trusted_scope: [
      ...(context?.tenant_binding ? [`tenant from context binding ${context.tenant_binding}`] : capability.subject.single_tenant_dev ? ["single-tenant development scope"] : ["no tenant binding declared"]),
      ...(principalColumn && context?.principal_binding
        ? [`principal row lock ${principalColumn} from required ${principalBinding?.source ?? "trusted"} binding ${context.principal_binding}`]
        : context?.principal_binding ? [`principal identity from context binding ${context.principal_binding}; no principal row lock declared`] : ["no principal binding declared"]),
    ],
    ...((tenantColumn || principalColumn) ? { row_scope: {
      ...(tenantColumn ? { tenant_column: tenantColumn } : {}),
      ...(context?.tenant_binding ? { tenant_binding: context.tenant_binding } : {}),
      ...(principalColumn ? { principal_column: principalColumn } : {}),
      ...(context?.principal_binding ? { principal_binding: context.principal_binding } : {}),
      ...(principalBinding ? { principal_provider: principalBinding.source, principal_required: principalBinding.required === true } : {}),
      effective_predicate: effectivePredicate,
    } } : {}),
    arguments: Object.entries(capability.args).map(([name, arg]) => explainArgument(name, arg)),
    ...(capability.lookup ? { lookup: `${capability.subject.primary_key ?? "primary key"} from argument ${capability.lookup.id_from_arg}` } : {}),
    ...(selection?.length ? { fixed_selection: selection } : {}),
    visible_fields: capability.visible_fields,
    kept_out_fields: capability.kept_out_fields ?? [],
    evidence: capability.evidence?.required ? "required" : "not required",
    ...(capability.aggregate ? { aggregate: {
      function: capability.aggregate.function,
      ...(capability.aggregate.count_mode ? { count_mode: capability.aggregate.count_mode } : {}),
      ...(capability.aggregate.column ? { column: capability.aggregate.column } : {}),
      minimum_group_size: capability.aggregate.minimum_group_size,
      result: "one scalar or a suppressed result; no member rows or identities",
    } } : {}),
    ...(proposal ? { proposal: {
      action: proposal.action,
      operation: proposal.operation?.kind ?? "update",
      cardinality: proposal.operation?.cardinality ?? "single",
      allowed_fields: proposal.allowed_fields,
      patch: Object.fromEntries(Object.entries(proposal.patch).map(([field, binding]) => [field, binding.from_arg ? `from argument ${binding.from_arg}` : binding.from_item ? `from reviewed item ${binding.from_item}` : `fixed ${scalarText(binding.fixed ?? null)}`])),
      numeric_bounds: proposal.numeric_bounds ?? {},
      transition_guards: proposal.transition_guards ?? {},
      row_cap: proposal.operation?.max_rows ?? 1,
      aggregate_bounds: proposal.operation?.aggregate_bounds ?? [],
      conflict_guard: proposal.conflict_guard ?? {},
      approval: proposal.approval ?? { mode: "human" },
      writeback: proposal.writeback ?? { mode: "none" },
      reversibility: proposal.reversibility?.mode ?? "not declared",
    } } : {}),
  };
}

function explainArgument(name: string, arg: ArgumentSpec): Record<string, unknown> {
  if (arg.type === "object_array") return { name, type: arg.type, required: arg.required === true, max_items: arg.max_items, fields: Object.keys(arg.fields) };
  return {
    name,
    type: arg.type,
    required: arg.required === true,
    ...(arg.max_length !== undefined ? { max_length: arg.max_length } : {}),
    ...(arg.minimum !== undefined ? { minimum: arg.minimum } : {}),
    ...(arg.maximum !== undefined ? { maximum: arg.maximum } : {}),
    ...(arg.enum ? { enum: arg.enum } : {}),
  };
}

function lintArgument(add: (issue: ContractLintIssue) => void, argPath: string, argName: string, arg: ArgumentSpec): void {
  if (arg.type === "object_array") {
    for (const [fieldName, field] of Object.entries(arg.fields)) lintArgument(add, `${argPath}.fields.${fieldName}`, `${argName}.${fieldName}`, field);
    return;
  }
  if (arg.type === "string" && arg.max_length === undefined && !arg.enum?.length) {
    add({ code: "STRING_ARGUMENT_UNBOUNDED", severity: "warning", path: argPath, message: `${argName} is a free string without MAX LENGTH or ENUM.` });
  }
  if (!arg.description) add({ code: "ARGUMENT_DESCRIPTION_MISSING", severity: "info", path: `${argPath}.description`, message: `${argName} should explain its reviewed purpose.` });
}

function formatExplanationMarkdown(explanation: ContractExplanation): string {
  const lines = [
    `# ${explanation.contract.name}`,
    "",
    explanation.contract.description ?? "No contract description was provided.",
    "",
    `Spec version: \`${explanation.contract.spec_version}\`${explanation.contract.version ? `; contract version: \`${explanation.contract.version}\`` : ""}`,
    "",
    "## Trusted Context",
    "",
    ...explanation.contexts.flatMap((context) => [
      `### ${context.name}`,
      "",
      `- Tenant authority: ${context.tenant_binding ? `binding \`${context.tenant_binding}\`` : "not declared"}`,
      `- Principal authority: ${context.principal_binding ? `binding \`${context.principal_binding}\`` : "not declared"}`,
      ...context.bindings.map((binding) => `- \`${binding.name}\`: ${binding.source} key \`${binding.key}\`${binding.required ? " (required)" : ""}`),
      "",
    ]),
    "## Capabilities",
    "",
  ];
  for (const capability of explanation.capabilities) {
    lines.push(`### ${capability.name}`, "", capability.description ?? "No capability description was provided.", "");
    lines.push(`- Kind: ${capability.kind}`, `- Target: \`${capability.target}\``, `- Context: \`${capability.context}\``);
    for (const scope of capability.trusted_scope) lines.push(`- Trusted scope: ${scope}`);
    if (capability.row_scope) {
      if (capability.row_scope.tenant_column) lines.push(`- Tenant row lock: \`${capability.row_scope.tenant_column}\` from binding \`${capability.row_scope.tenant_binding ?? "not declared"}\``);
      if (capability.row_scope.principal_column) lines.push(`- Principal row lock: \`${capability.row_scope.principal_column}\` from ${capability.row_scope.principal_required ? "required " : ""}${capability.row_scope.principal_provider ?? "trusted"} binding \`${capability.row_scope.principal_binding ?? "not declared"}\``);
      lines.push(`- Effective row predicate: \`${capability.row_scope.effective_predicate}\``);
    }
    lines.push(`- Visible fields: ${capability.visible_fields.map((field) => `\`${field}\``).join(", ") || "none"}`);
    lines.push(`- Kept out: ${capability.kept_out_fields.map((field) => `\`${field}\``).join(", ") || "no explicit list"}`);
    lines.push(`- Evidence: ${capability.evidence}`);
    if (capability.lookup) lines.push(`- Lookup: ${capability.lookup}`);
    if (capability.fixed_selection?.length) lines.push(`- Fixed selection: ${capability.fixed_selection.join(" AND ")}`);
    if (capability.arguments.length) lines.push(`- Arguments: ${capability.arguments.map((arg) => `\`${String(arg.name)}\``).join(", ")}`);
    if (capability.aggregate) {
      const operation = [capability.aggregate.function, capability.aggregate.count_mode, capability.aggregate.column].filter(Boolean).join(" ");
      lines.push(`- Aggregate: \`${operation}\``);
      lines.push(`- Minimum group size: ${String(capability.aggregate.minimum_group_size)}`);
      lines.push(`- Aggregate result: ${String(capability.aggregate.result)}`);
    }
    if (capability.proposal) {
      lines.push(`- Proposal: ${String(capability.proposal.operation)} ${String(capability.proposal.cardinality)} action \`${String(capability.proposal.action)}\``);
      lines.push(`- Approval: \`${JSON.stringify(capability.proposal.approval)}\``);
      lines.push(`- Writeback: \`${JSON.stringify(capability.proposal.writeback)}\``);
      lines.push(`- Reversibility: ${String(capability.proposal.reversibility)}`);
    }
    lines.push("");
  }
  if (explanation.workflows.length) lines.push("## Declared Workflows", "", ...explanation.workflows.map((workflow) => `- \`${String(workflow.name)}\`: ${JSON.stringify(workflow)}`), "");
  if (explanation.policies.length) lines.push("## Reviewed Policies", "", ...explanation.policies.map((policy) => `- \`${String(policy.name)}\`: ${JSON.stringify(policy)}`), "");
  lines.push("## Boundaries", "", ...explanation.boundaries.map((boundary) => `- ${boundary}`), "");
  return `${lines.join("\n")}\n`;
}

function scalarText(value: JsonScalar): string {
  return typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : JSON.stringify(value);
}

function isDslPath(filePath: string): boolean {
  return filePath.endsWith(".synapsor") || filePath.endsWith(".synapsor.sql");
}

function recordKeys(value: unknown): Set<string> {
  return new Set(value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>) : []);
}

function severityRank(severity: ContractLintSeverity): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

function uniqueRules(issues: ContractLintIssue[]): Array<{ id: string; shortDescription: { text: string } }> {
  const seen = new Map<string, string>();
  for (const issue of issues) if (!seen.has(issue.code)) seen.set(issue.code, issue.message);
  return [...seen.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, text]) => ({ id, shortDescription: { text } }));
}

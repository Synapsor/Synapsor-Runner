import { assertValidContract, normalizeContract, type AgentContextSpec, type ArgumentSpec, type CapabilitySpec, type PolicySpec, type SynapsorContract, type WorkflowSpec } from "@synapsor/spec";

export type AgentDslAst = {
  contexts: AgentDslContextAst[];
  capabilities: AgentDslCapabilityAst[];
  workflows: AgentDslWorkflowAst[];
};

export type AgentDslContextAst = {
  name: string;
  bindings: Array<{ name: string; source: "session" | "environment" | "cloud_session" | "static_dev" | "http_claim"; key: string; required?: boolean }>;
  tenantBinding?: string;
  principalBinding?: string;
};

export type AgentDslCapabilityAst = {
  name: string;
  line?: number;
  kind: "read" | "proposal";
  description?: string;
  returnsHint?: string;
  context: string;
  source?: string;
  schema: string;
  table: string;
  primaryKey: string;
  tenantKey?: string;
  conflictKey?: string;
  lookup?: { arg: string; column: string; line?: number };
  args: Record<string, { type: "string" | "number" | "boolean"; required?: boolean; max_length?: number; minimum?: number; maximum?: number; description?: string; line?: number }>;
  visibleFields: string[];
  keptOutFields: string[];
  evidenceRequired?: boolean;
  maxRows?: number;
  proposal?: {
    action: string;
    allowedFields: string[];
    patch: Record<string, { fixed?: string | number | boolean | null; from_arg?: string }>;
    numericBounds?: Record<string, { minimum?: number; maximum?: number }>;
    transitionGuards?: Record<string, { from_column?: string; allowed: Record<string, string[]> }>;
    approvalRole?: string;
    autoApprovalRules?: Array<{ field: string; max: number; line: number }>;
    autoApprovalLimits?: Array<{
      kind: "count" | "total";
      max: number;
      period: "day";
      field?: string;
      scope: "tenant_policy" | "tenant_policy_object";
      line: number;
    }>;
    writebackMode?: "direct_sql" | "app_handler" | "cloud_worker" | "none";
    executor?: string;
  };
};

export type AgentDslWorkflowAst = {
  name: string;
  context: string;
  allowedCapabilities: string[];
  requiredEvidence?: boolean;
  approvalRole?: string;
  checkpoint?: "none" | "every_step" | "proposal_only";
};

export type ValidationResult = {
  ok: boolean;
  errors: Array<{ line: number; column: number; code: string; message: string }>;
  warnings: Array<{ line: number; column: number; code: string; message: string }>;
};

export type AgentDslCompileResult = {
  contract: SynapsorContract;
  warnings: ValidationResult["warnings"];
};

type Block = {
  kind: "context" | "capability" | "workflow";
  name: string;
  line: number;
  body: Array<{ text: string; line: number }>;
};

export class AgentDslError extends Error {
  constructor(
    public readonly line: number,
    public readonly column: number,
    public readonly code: string,
    message: string,
  ) {
    super(`${line}:${column} ${code}: ${message}`);
    this.name = "AgentDslError";
  }
}

export function parseAgentDsl(source: string): AgentDslAst {
  const blocks = parseBlocks(source);
  const contexts: AgentDslContextAst[] = [];
  const capabilities: AgentDslCapabilityAst[] = [];
  const workflows: AgentDslWorkflowAst[] = [];
  for (const block of blocks) {
    if (block.kind === "context") contexts.push(parseContextBlock(block));
    if (block.kind === "capability") capabilities.push(parseCapabilityBlock(block));
    if (block.kind === "workflow") workflows.push(parseWorkflowBlock(block));
  }
  return { contexts, capabilities, workflows };
}

export function compileAgentDsl(source: string): SynapsorContract {
  return compileAgentDslWithWarnings(source).contract;
}

export function compileAgentDslWithWarnings(source: string): AgentDslCompileResult {
  const ast = parseAgentDsl(source);
  const contexts: AgentContextSpec[] = ast.contexts.map((context) => ({
    name: context.name,
    bindings: context.bindings,
    ...(context.tenantBinding ? { tenant_binding: context.tenantBinding } : {}),
    ...(context.principalBinding ? { principal_binding: context.principalBinding } : {}),
  }));
  const policies: PolicySpec[] = [];
  const capabilities: CapabilitySpec[] = ast.capabilities.map((capability) => {
    const spec: CapabilitySpec = {
      name: capability.name,
      kind: capability.kind,
      ...(capability.description ? { description: capability.description } : {}),
      ...(capability.returnsHint ? { returns_hint: capability.returnsHint } : {}),
      context: capability.context,
      ...(capability.source ? { source: capability.source } : {}),
      subject: {
        schema: capability.schema,
        table: capability.table,
        primary_key: capability.primaryKey,
        ...(capability.tenantKey ? { tenant_key: capability.tenantKey } : {}),
        ...(capability.conflictKey ? { conflict_key: capability.conflictKey } : {}),
      },
      args: specArgsFromDsl(capability.args),
      ...(capability.lookup ? { lookup: { id_from_arg: capability.lookup.arg } } : {}),
      visible_fields: capability.visibleFields,
      ...(capability.keptOutFields.length ? { kept_out_fields: capability.keptOutFields } : {}),
      ...(capability.evidenceRequired !== undefined ? { evidence: { required: capability.evidenceRequired, query_audit: true } } : {}),
      ...(capability.maxRows ? { max_rows: capability.maxRows } : {}),
    };
    if (capability.kind === "proposal" && capability.proposal) {
      const autoApprovalPolicyName = capability.proposal.autoApprovalRules?.length ? autoApprovalPolicyNameForCapability(capability.name) : undefined;
      if (autoApprovalPolicyName) {
        policies.push({
          name: autoApprovalPolicyName,
          kind: "approval",
          mode: "green",
          rules: capability.proposal.autoApprovalRules?.map((rule) => ({ field: rule.field, max: rule.max })),
          ...(capability.proposal.autoApprovalLimits?.length ? {
            limits: capability.proposal.autoApprovalLimits.map(({ line: _line, ...limit }) => limit),
          } : {}),
        });
      }
      spec.proposal = {
        action: capability.proposal.action,
        allowed_fields: capability.proposal.allowedFields,
        patch: capability.proposal.patch,
        ...(capability.proposal.numericBounds ? { numeric_bounds: capability.proposal.numericBounds } : {}),
        ...(capability.proposal.transitionGuards ? { transition_guards: capability.proposal.transitionGuards } : {}),
        conflict_guard: capability.conflictKey ? { column: capability.conflictKey } : { weak_guard_ack: true },
        approval: autoApprovalPolicyName
          ? { mode: "policy", required_role: capability.proposal.approvalRole ?? "local_reviewer", policy: autoApprovalPolicyName }
          : { mode: "human", required_role: capability.proposal.approvalRole ?? "local_reviewer" },
        writeback: {
          mode: capability.proposal.writebackMode ?? "direct_sql",
          ...(capability.proposal.executor ? { executor: capability.proposal.executor } : {}),
        },
      };
    }
    return spec;
  });
  const workflows: WorkflowSpec[] = ast.workflows.map((workflow) => ({
    name: workflow.name,
    context: workflow.context,
    allowed_capabilities: workflow.allowedCapabilities,
    ...(workflow.requiredEvidence !== undefined ? { required_evidence: workflow.requiredEvidence } : {}),
    ...(workflow.approvalRole ? { approval: { required: true, role: workflow.approvalRole } } : {}),
    ...(workflow.checkpoint ? { replay: { checkpoint: workflow.checkpoint } } : {}),
  }));
  const contract: SynapsorContract = {
    spec_version: "0.1",
    kind: "SynapsorContract",
    contexts,
    capabilities,
    ...(workflows.length ? { workflows } : {}),
    ...(policies.length ? { policies } : {}),
  };
  assertValidContract(contract);
  return { contract: normalizeContract(contract), warnings: collectDslWarnings(ast) };
}

export function validateAgentDsl(source: string): ValidationResult {
  try {
    const result = compileAgentDslWithWarnings(source);
    return { ok: true, errors: [], warnings: result.warnings };
  } catch (error) {
    if (error instanceof AgentDslError) {
      return {
        ok: false,
        errors: [{ line: error.line, column: error.column, code: error.code, message: error.message.replace(/^\d+:\d+ [A-Z_]+: /, "") }],
        warnings: [],
      };
    }
    return {
      ok: false,
      errors: [{ line: 1, column: 1, code: "DSL_VALIDATION_FAILED", message: error instanceof Error ? error.message : String(error) }],
      warnings: [],
    };
  }
}

export function formatAgentDsl(source: string): string {
  return source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("--")).join("\n");
}

function parseBlocks(source: string): Block[] {
  const lines = source.split(/\r?\n/);
  const blocks: Block[] = [];
  let current: Block | undefined;
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const stripped = rawLine.replace(/--.*$/, "").trim();
    if (!stripped) return;
    const contextMatch = stripped.match(/^CREATE\s+AGENT\s+CONTEXT\s+([A-Za-z_][A-Za-z0-9_.]*)$/i);
    const capabilityMatch = stripped.match(/^CREATE\s+(?:AGENT\s+)?CAPABILITY\s+([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)$/i);
    const workflowMatch = stripped.match(/^CREATE\s+AGENT\s+WORKFLOW\s+([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)$/i);
    if (contextMatch || capabilityMatch || workflowMatch) {
      if (current) throw dslError(lineNumber, 1, "BLOCK_NOT_CLOSED", "previous CREATE block must end with END before starting another block");
      if (contextMatch?.[1]) current = { kind: "context", name: contextMatch[1], line: lineNumber, body: [] };
      else if (capabilityMatch?.[1]) current = { kind: "capability", name: capabilityMatch[1], line: lineNumber, body: [] };
      else if (workflowMatch?.[1]) current = { kind: "workflow", name: workflowMatch[1], line: lineNumber, body: [] };
      return;
    }
    if (/^END;?$/i.test(stripped)) {
      if (!current) throw dslError(lineNumber, 1, "END_WITHOUT_BLOCK", "END appeared without an open CREATE block");
      blocks.push(current);
      current = undefined;
      return;
    }
    if (!current) throw dslError(lineNumber, 1, "EXPECTED_CREATE", "expected CREATE AGENT CONTEXT, CREATE CAPABILITY, or CREATE AGENT WORKFLOW");
    current.body.push({ text: stripped.replace(/;$/, ""), line: lineNumber });
  });
  if (current) throw dslError(current.line, 1, "BLOCK_NOT_CLOSED", `${current.name} must end with END`);
  return blocks;
}

function parseContextBlock(block: Block): AgentDslContextAst {
  const context: AgentDslContextAst = { name: block.name, bindings: [] };
  for (const item of block.body) {
    const bind = item.text.match(/^BIND\s+([A-Za-z_][A-Za-z0-9_]*)\s+FROM\s+(SESSION|ENV|ENVIRONMENT|CLOUD_SESSION|STATIC_DEV|HTTP_CLAIM)\s+([A-Za-z0-9_.-]+)(?:\s+REQUIRED)?$/i);
    if (bind?.[1] && bind[2] && bind[3]) {
      const name = bind[1];
      const source = normalizeBindingSource(bind[2]);
      context.bindings.push({ name, source, key: bind[3], ...(item.text.match(/\sREQUIRED$/i) ? { required: true } : {}) });
      continue;
    }
    const tenant = item.text.match(/^TENANT\s+BINDING\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (tenant?.[1]) {
      context.tenantBinding = tenant[1];
      continue;
    }
    const principal = item.text.match(/^PRINCIPAL\s+BINDING\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (principal?.[1]) {
      context.principalBinding = principal[1];
      continue;
    }
    unsupported(item, "context");
  }
  if (context.bindings.length === 0) throw dslError(block.line, 1, "CONTEXT_BINDINGS_REQUIRED", "CREATE AGENT CONTEXT requires at least one BIND line");
  context.tenantBinding ??= context.bindings.find((binding) => binding.name === "tenant_id")?.name;
  context.principalBinding ??= context.bindings.find((binding) => binding.name === "principal")?.name;
  return context;
}

function parseCapabilityBlock(block: Block): AgentDslCapabilityAst {
  const capability: AgentDslCapabilityAst = {
    name: block.name,
    line: block.line,
    kind: "read",
    context: "",
    schema: "",
    table: "",
    primaryKey: "id",
    args: {},
    visibleFields: [],
    keptOutFields: [],
  };
  for (const item of block.body) {
    const description = item.text.match(/^DESCRIPTION\s+'(.*)'$/i);
    if (description) {
      capability.description = description[1] ?? "";
      continue;
    }
    const returnsHint = item.text.match(/^RETURNS\s+HINT\s+'(.*)'$/i);
    if (returnsHint) {
      capability.returnsHint = returnsHint[1] ?? "";
      continue;
    }
    const context = item.text.match(/^USING\s+CONTEXT\s+([A-Za-z_][A-Za-z0-9_.]*)$/i);
    if (context?.[1]) {
      capability.context = context[1];
      continue;
    }
    const source = item.text.match(/^SOURCE\s+([A-Za-z_][A-Za-z0-9_.-]*)$/i);
    if (source?.[1]) {
      capability.source = source[1];
      continue;
    }
    const on = item.text.match(/^ON\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (on?.[1] && on[2]) {
      capability.schema = on[1];
      capability.table = on[2];
      continue;
    }
    const primary = item.text.match(/^PRIMARY\s+KEY\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (primary?.[1]) {
      capability.primaryKey = primary[1];
      continue;
    }
    const tenant = item.text.match(/^TENANT\s+KEY\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (tenant?.[1]) {
      capability.tenantKey = tenant[1];
      continue;
    }
    const conflict = item.text.match(/^CONFLICT\s+GUARD\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (conflict?.[1]) {
      capability.conflictKey = conflict[1];
      continue;
    }
    const arg = item.text.match(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)\s+(STRING|TEXT|NUMBER|BOOLEAN|BOOL)\b(.*)$/i);
    if (arg?.[1] && arg[2]) {
      capability.args[arg[1]] = parseArgSpec(arg[1], arg[2], arg[3] ?? "", item.line);
      continue;
    }
    const lookup = item.text.match(/^LOOKUP\s+([A-Za-z_][A-Za-z0-9_]*)\s+BY\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (lookup?.[1] && lookup[2]) {
      capability.lookup = { arg: lookup[1], column: lookup[2], line: item.line };
      if (!capability.args[lookup[1]]) capability.args[lookup[1]] = { type: "string", required: true, max_length: 128 };
      continue;
    }
    const read = item.text.match(/^ALLOW\s+READ\s+(.+)$/i);
    if (read?.[1]) {
      capability.visibleFields = parseList(read[1]);
      continue;
    }
    const keptOut = item.text.match(/^KEEP\s+OUT\s+(.+)$/i);
    if (keptOut?.[1]) {
      capability.keptOutFields = parseList(keptOut[1]);
      continue;
    }
    if (/^REQUIRE\s+EVIDENCE$/i.test(item.text)) {
      capability.evidenceRequired = true;
      continue;
    }
    const maxRows = item.text.match(/^MAX\s+ROWS\s+(\d+)$/i);
    if (maxRows?.[1]) {
      capability.maxRows = Number(maxRows[1]);
      continue;
    }
    const propose = item.text.match(/^PROPOSE\s+ACTION\s+([A-Za-z_][A-Za-z0-9_.]*)$/i);
    if (propose?.[1]) {
      capability.kind = "proposal";
      capability.proposal = { action: propose[1], allowedFields: [], patch: {} };
      continue;
    }
    const allowWrite = item.text.match(/^ALLOW\s+WRITE\s+(.+)$/i);
    if (allowWrite?.[1]) {
      ensureProposal(capability, item);
      capability.proposal.allowedFields = parseList(allowWrite[1]);
      continue;
    }
    const patch = item.text.match(/^PATCH\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/i);
    if (patch?.[1] && patch[2]) {
      ensureProposal(capability, item);
      capability.proposal.patch[patch[1]] = parsePatchBinding(patch[2]);
      if (!capability.proposal.allowedFields.includes(patch[1])) capability.proposal.allowedFields.push(patch[1]);
      continue;
    }
    const bound = item.text.match(/^BOUND\s+([A-Za-z_][A-Za-z0-9_]*)\s+(-?\d+(?:\.\d+)?)?\s*\.\.\s*(-?\d+(?:\.\d+)?)?$/i);
    if (bound?.[1]) {
      ensureProposal(capability, item);
      const minimum = bound[2] !== undefined ? Number(bound[2]) : undefined;
      const maximum = bound[3] !== undefined ? Number(bound[3]) : undefined;
      if (minimum === undefined && maximum === undefined) throw dslError(item.line, 1, "BOUND_RANGE_REQUIRED", "BOUND requires minimum, maximum, or both, such as 1..2500");
      capability.proposal.numericBounds ??= {};
      capability.proposal.numericBounds[bound[1]] = {
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
      };
      continue;
    }
    const transition = item.text.match(/^TRANSITION\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*))?\s+ALLOW\s+(.+)$/i);
    if (transition?.[1] && transition[3]) {
      ensureProposal(capability, item);
      capability.proposal.transitionGuards ??= {};
      capability.proposal.transitionGuards[transition[1]] = {
        ...(transition[2] ? { from_column: transition[2] } : {}),
        allowed: parseTransitionAllowed(transition[3], item.line),
      };
      continue;
    }
    const approval = item.text.match(/^APPROVAL\s+ROLE\s+([A-Za-z_][A-Za-z0-9_.-]*)$/i);
    if (approval?.[1]) {
      ensureProposal(capability, item);
      capability.proposal.approvalRole = approval[1];
      continue;
    }
    const autoApproval = item.text.match(/^AUTO\s+APPROVE\s+WHEN\s+(.+)$/i);
    if (autoApproval?.[1]) {
      ensureProposal(capability, item);
      parseAutoApprovalClause(capability, autoApproval[1], item.line);
      continue;
    }
    const approvalLimit = item.text.match(/^LIMIT\s+(.+)$/i);
    if (approvalLimit?.[1]) {
      ensureProposal(capability, item);
      parseAutoApprovalLimitClause(capability, approvalLimit[1], item.line);
      continue;
    }
    const writeback = item.text.match(/^WRITEBACK\s+(DIRECT\s+SQL|APP\s+HANDLER|CLOUD\s+WORKER|NONE)(?:\s+EXECUTOR\s+([A-Za-z_][A-Za-z0-9_.-]*))?$/i);
    if (writeback?.[1]) {
      ensureProposal(capability, item);
      capability.proposal.writebackMode = normalizeWritebackMode(writeback[1]);
      if (writeback[2]) capability.proposal.executor = writeback[2];
      continue;
    }
    unsupported(item, "capability");
  }
  if (!capability.context) throw dslError(block.line, 1, "CAPABILITY_CONTEXT_REQUIRED", `${block.name} requires USING CONTEXT`);
  if (!capability.schema || !capability.table) throw dslError(block.line, 1, "CAPABILITY_SUBJECT_REQUIRED", `${block.name} requires ON schema.table`);
  if (!capability.tenantKey) throw dslError(block.line, 1, "CAPABILITY_TENANT_REQUIRED", `${block.name} requires TENANT KEY for 0.1 DSL`);
  if (capability.lookup && capability.lookup.column !== capability.primaryKey) {
    throw dslError(
      capability.lookup.line ?? block.line,
      1,
      "LOOKUP_COLUMN_UNSUPPORTED",
      `${block.name} LOOKUP BY ${capability.lookup.column} cannot be represented by spec 0.1; use declared PRIMARY KEY ${capability.primaryKey}`,
    );
  }
  if (capability.visibleFields.length === 0) throw dslError(block.line, 1, "CAPABILITY_VISIBLE_FIELDS_REQUIRED", `${block.name} requires ALLOW READ`);
  if (Object.keys(capability.args).length === 0 && capability.lookup) capability.args[capability.lookup.arg] = { type: "string", required: true, max_length: 128 };
  if (Object.keys(capability.args).length === 0) throw dslError(block.line, 1, "CAPABILITY_ARGS_REQUIRED", `${block.name} requires ARG or LOOKUP`);
  if (capability.kind === "proposal" && (!capability.proposal || Object.keys(capability.proposal.patch).length === 0)) throw dslError(block.line, 1, "PROPOSAL_PATCH_REQUIRED", `${block.name} proposal requires at least one PATCH line`);
  return capability;
}

function specArgsFromDsl(args: AgentDslCapabilityAst["args"]): Record<string, ArgumentSpec> {
  return Object.fromEntries(Object.entries(args).map(([name, arg]) => {
    const { line: _line, ...spec } = arg;
    return [name, spec];
  }));
}

function collectDslWarnings(ast: AgentDslAst): ValidationResult["warnings"] {
  const warnings: ValidationResult["warnings"] = [];
  for (const capability of ast.capabilities) {
    if (capability.kind !== "proposal" || !capability.proposal) continue;
    const line = capability.line ?? 1;
    if (!capability.description) {
      warnings.push({ line, column: 1, code: "DESCRIPTION_RECOMMENDED", message: `${capability.name} is a proposal capability without DESCRIPTION.` });
    }
    if (!capability.returnsHint) {
      warnings.push({ line, column: 1, code: "RETURNS_HINT_RECOMMENDED", message: `${capability.name} is a proposal capability without RETURNS HINT.` });
    }
    for (const [column, binding] of Object.entries(capability.proposal.patch)) {
      if (!binding.from_arg) continue;
      const arg = capability.args[binding.from_arg];
      if (arg?.type === "number" && arg.minimum === undefined && arg.maximum === undefined && capability.proposal.numericBounds?.[column] === undefined) {
        warnings.push({
          line: arg.line ?? line,
          column: 1,
          code: "NUMERIC_PATCH_BOUND_RECOMMENDED",
          message: `${capability.name} patches ${column} from numeric arg ${binding.from_arg} without ARG MIN/MAX or BOUND ${column}.`,
        });
      }
    }
  }
  return warnings;
}

function parseAutoApprovalClause(capability: AgentDslCapabilityAst & { proposal: NonNullable<AgentDslCapabilityAst["proposal"]> }, rawCondition: string, line: number): void {
  if (!capability.proposal.approvalRole) {
    throw dslError(line, 1, "AUTO_APPROVE_APPROVAL_ROLE_REQUIRED", "AUTO APPROVE WHEN requires an explicit APPROVAL ROLE before it");
  }
  const condition = rawCondition.trim();
  const match = condition.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(<=)\s*(.+)$/);
  if (!match?.[1] || !match[3]) {
    throw dslError(line, 1, "AUTO_APPROVE_UNSUPPORTED", "AUTO APPROVE WHEN supports only: <field> <= <integer>");
  }
  const field = match[1];
  const rawMax = match[3].trim();
  if (!/^\d+$/.test(rawMax)) {
    throw dslError(line, 1, "AUTO_APPROVE_MAX_INVALID", "AUTO APPROVE WHEN max must be a non-negative integer");
  }
  const max = Number(rawMax);
  if (!Number.isSafeInteger(max)) {
    throw dslError(line, 1, "AUTO_APPROVE_MAX_INVALID", "AUTO APPROVE WHEN max must be a safe non-negative integer");
  }
  if (!Object.prototype.hasOwnProperty.call(capability.proposal.patch, field)) {
    throw dslError(line, 1, "AUTO_APPROVE_FIELD_NOT_PATCHED", `AUTO APPROVE WHEN field ${field} must be in the PATCH list`);
  }
  if (!isNumericDslProposalField(capability, field)) {
    throw dslError(line, 1, "AUTO_APPROVE_FIELD_NOT_NUMERIC", `AUTO APPROVE WHEN field ${field} must be numeric by BOUND, NUMBER arg patch, or integer literal patch`);
  }
  const boundMax = capability.proposal.numericBounds?.[field]?.maximum;
  if (boundMax !== undefined && max > boundMax) {
    throw dslError(line, 1, "AUTO_APPROVE_MAX_EXCEEDS_BOUND", `AUTO APPROVE WHEN max for ${field} must be <= BOUND maximum ${boundMax}`);
  }
  capability.proposal.autoApprovalRules ??= [];
  if (capability.proposal.autoApprovalRules.some((rule) => rule.field === field)) {
    throw dslError(line, 1, "AUTO_APPROVE_DUPLICATE_FIELD", `AUTO APPROVE WHEN already defines a rule for ${field}`);
  }
  capability.proposal.autoApprovalRules.push({ field, max, line });
}

function parseAutoApprovalLimitClause(
  capability: AgentDslCapabilityAst & { proposal: NonNullable<AgentDslCapabilityAst["proposal"]> },
  rawLimit: string,
  line: number,
): void {
  const rules = capability.proposal.autoApprovalRules ?? [];
  if (rules.length === 0) {
    throw dslError(line, 1, "AUTO_APPROVAL_LIMIT_POLICY_REQUIRED", "LIMIT must follow AUTO APPROVE WHEN in the same capability");
  }
  const value = rawLimit.trim();
  const count = value.match(/^(\d+)\s+PER\s+(?:(OBJECT)\s+)?DAY$/i);
  const total = value.match(/^TOTAL\s+(\d+)\s+PER\s+(?:(OBJECT)\s+)?DAY$/i);
  if (!count && !total) {
    throw dslError(line, 1, "AUTO_APPROVAL_LIMIT_UNSUPPORTED", "LIMIT supports: LIMIT <count> PER DAY or LIMIT TOTAL <amount> PER DAY");
  }
  const rawMax = count?.[1] ?? total?.[1] ?? "";
  const max = Number(rawMax);
  if (!Number.isSafeInteger(max)) {
    throw dslError(line, 1, "AUTO_APPROVAL_LIMIT_MAX_INVALID", "LIMIT max must be a safe non-negative integer");
  }
  let field: string | undefined;
  if (total) {
    const fields = [...new Set(rules.map((rule) => rule.field))];
    if (fields.length !== 1) {
      throw dslError(line, 1, "AUTO_APPROVAL_TOTAL_FIELD_AMBIGUOUS", "LIMIT TOTAL requires exactly one AUTO APPROVE WHEN numeric field");
    }
    field = fields[0];
  }
  const kind = total ? "total" : "count";
  capability.proposal.autoApprovalLimits ??= [];
  if (capability.proposal.autoApprovalLimits.some((limit) => limit.kind === kind && limit.scope === ((count?.[2] ?? total?.[2]) ? "tenant_policy_object" : "tenant_policy"))) {
    throw dslError(line, 1, "AUTO_APPROVAL_LIMIT_DUPLICATE", `duplicate ${kind} auto-approval limit for the same scope`);
  }
  capability.proposal.autoApprovalLimits.push({
    kind,
    max,
    period: "day",
    ...(field ? { field } : {}),
    scope: (count?.[2] ?? total?.[2]) ? "tenant_policy_object" : "tenant_policy",
    line,
  });
}

function isNumericDslProposalField(capability: AgentDslCapabilityAst & { proposal: NonNullable<AgentDslCapabilityAst["proposal"]> }, field: string): boolean {
  if (capability.proposal.numericBounds?.[field] !== undefined) return true;
  const patch = capability.proposal.patch[field];
  if (!patch) return false;
  if (typeof patch.fixed === "number" && Number.isInteger(patch.fixed)) return true;
  if (patch.from_arg && capability.args[patch.from_arg]?.type === "number") return true;
  return false;
}

function parseWorkflowBlock(block: Block): AgentDslWorkflowAst {
  const workflow: AgentDslWorkflowAst = { name: block.name, context: "", allowedCapabilities: [] };
  for (const item of block.body) {
    const context = item.text.match(/^USING\s+CONTEXT\s+([A-Za-z_][A-Za-z0-9_.]*)$/i);
    if (context?.[1]) {
      workflow.context = context[1];
      continue;
    }
    const capability = item.text.match(/^ALLOW\s+CAPABILITY\s+([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)$/i);
    if (capability?.[1]) {
      workflow.allowedCapabilities.push(capability[1]);
      continue;
    }
    if (/^REQUIRE\s+EVIDENCE$/i.test(item.text)) {
      workflow.requiredEvidence = true;
      continue;
    }
    const approval = item.text.match(/^APPROVAL\s+REQUIRED\s+ROLE\s+([A-Za-z_][A-Za-z0-9_.-]*)$/i);
    if (approval?.[1]) {
      workflow.approvalRole = approval[1];
      continue;
    }
    const checkpoint = item.text.match(/^CHECKPOINT\s+(NONE|EVERY\s+STEP|PROPOSAL\s+ONLY)$/i);
    if (checkpoint?.[1]) {
      workflow.checkpoint = checkpoint[1].toLowerCase().replace(/\s+/g, "_") as AgentDslWorkflowAst["checkpoint"];
      continue;
    }
    unsupported(item, "workflow");
  }
  if (!workflow.context) throw dslError(block.line, 1, "WORKFLOW_CONTEXT_REQUIRED", `${block.name} requires USING CONTEXT`);
  if (workflow.allowedCapabilities.length === 0) throw dslError(block.line, 1, "WORKFLOW_CAPABILITIES_REQUIRED", `${block.name} requires ALLOW CAPABILITY`);
  return workflow;
}

function ensureProposal(capability: AgentDslCapabilityAst, item: { line: number }): asserts capability is AgentDslCapabilityAst & { proposal: NonNullable<AgentDslCapabilityAst["proposal"]> } {
  if (!capability.proposal) throw dslError(item.line, 1, "PROPOSAL_ACTION_REQUIRED", "proposal clauses require PROPOSE ACTION first");
}

function parsePatchBinding(raw: string): { fixed?: string | number | boolean | null; from_arg?: string } {
  const trimmed = raw.trim();
  const arg = trimmed.match(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (arg?.[1]) return { from_arg: arg[1] };
  if (/^NULL$/i.test(trimmed)) return { fixed: null };
  if (/^TRUE$/i.test(trimmed)) return { fixed: true };
  if (/^FALSE$/i.test(trimmed)) return { fixed: false };
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return { fixed: Number(trimmed) };
  const quoted = trimmed.match(/^'(.*)'$/);
  if (quoted) return { fixed: quoted[1] ?? "" };
  return { fixed: trimmed };
}

function parseArgSpec(
  name: string,
  rawType: string,
  rawOptions: string,
  line: number,
): AgentDslCapabilityAst["args"][string] {
  const type = normalizeArgType(rawType);
  let rest = rawOptions.trim();
  let description: string | undefined;
  const descriptionMatch = rest.match(/\bDESCRIPTION\s+'([^']*)'/i);
  if (descriptionMatch) {
    description = descriptionMatch[1] ?? "";
    rest = `${rest.slice(0, descriptionMatch.index)} ${rest.slice((descriptionMatch.index ?? 0) + descriptionMatch[0].length)}`.trim();
  }
  const required = /\bREQUIRED\b/i.test(rest);
  rest = rest.replace(/\bREQUIRED\b/ig, " ").trim();

  const maxLengthMatch = rest.match(/\bMAX\s+LENGTH\s+(\d+)\b/i);
  const maxLength = maxLengthMatch?.[1] ? Number(maxLengthMatch[1]) : undefined;
  if (maxLengthMatch) rest = `${rest.slice(0, maxLengthMatch.index)} ${rest.slice((maxLengthMatch.index ?? 0) + maxLengthMatch[0].length)}`.trim();

  const minMatch = rest.match(/\bMIN\s+(-?\d+(?:\.\d+)?)\b/i);
  const minimum = minMatch?.[1] ? Number(minMatch[1]) : undefined;
  if (minMatch) rest = `${rest.slice(0, minMatch.index)} ${rest.slice((minMatch.index ?? 0) + minMatch[0].length)}`.trim();

  const maxMatch = rest.match(/\bMAX\s+(-?\d+(?:\.\d+)?)\b/i);
  const maximumOrLegacyLength = maxMatch?.[1] ? Number(maxMatch[1]) : undefined;
  if (maxMatch) rest = `${rest.slice(0, maxMatch.index)} ${rest.slice((maxMatch.index ?? 0) + maxMatch[0].length)}`.trim();

  if (rest.trim().length > 0) {
    throw dslError(line, 1, "ARG_OPTIONS_UNSUPPORTED", `unsupported ARG options for ${name}: ${rest.trim()}`);
  }
  if (type !== "number" && minimum !== undefined) {
    throw dslError(line, 1, "ARG_MIN_REQUIRES_NUMBER", `ARG ${name} uses MIN, but MIN is only valid for NUMBER args`);
  }
  if (type === "boolean" && (maxLength !== undefined || maximumOrLegacyLength !== undefined)) {
    throw dslError(line, 1, "ARG_MAX_INVALID_FOR_BOOLEAN", `ARG ${name} cannot use MAX or MAX LENGTH because BOOLEAN has no numeric or length bound`);
  }
  if (type === "number" && maxLength !== undefined) {
    throw dslError(line, 1, "ARG_MAX_LENGTH_REQUIRES_TEXT", `ARG ${name} uses MAX LENGTH, but MAX LENGTH is only valid for STRING/TEXT args`);
  }

  return {
    type,
    line,
    ...(required ? { required: true } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(type === "number" && minimum !== undefined ? { minimum } : {}),
    ...(type === "number" && maximumOrLegacyLength !== undefined ? { maximum: maximumOrLegacyLength } : {}),
    ...(type !== "number" && maxLength !== undefined ? { max_length: maxLength } : {}),
    ...(type !== "number" && maxLength === undefined && maximumOrLegacyLength !== undefined ? { max_length: maximumOrLegacyLength } : {}),
  };
}

function parseTransitionAllowed(raw: string, line: number): Record<string, string[]> {
  const allowed: Record<string, string[]> = {};
  for (const item of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    const match = item.match(/^(.+?)\s*->\s*(.+)$/);
    if (!match?.[1] || !match[2]) {
      throw dslError(line, 1, "TRANSITION_RULE_INVALID", `transition rule must use from -> to syntax: ${item}`);
    }
    const from = parseStateValue(match[1]);
    const toValues = match[2].split("|").map(parseStateValue).filter(Boolean);
    if (!from || toValues.length === 0) {
      throw dslError(line, 1, "TRANSITION_RULE_INVALID", `transition rule must name non-empty states: ${item}`);
    }
    allowed[from] = toValues;
  }
  if (Object.keys(allowed).length === 0) {
    throw dslError(line, 1, "TRANSITION_ALLOWED_REQUIRED", "TRANSITION requires at least one from -> to rule");
  }
  return allowed;
}

function parseStateValue(raw: string): string {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^'(.*)'$/);
  return (quoted?.[1] ?? trimmed).trim();
}

function normalizeBindingSource(source: string): AgentDslContextAst["bindings"][number]["source"] {
  const normalized = source.toUpperCase();
  if (normalized === "ENV") return "environment";
  if (normalized === "ENVIRONMENT") return "environment";
  if (normalized === "SESSION") return "session";
  if (normalized === "CLOUD_SESSION") return "cloud_session";
  if (normalized === "STATIC_DEV") return "static_dev";
  return "http_claim";
}

function normalizeArgType(type: string): "string" | "number" | "boolean" {
  const normalized = type.toUpperCase();
  if (normalized === "NUMBER") return "number";
  if (normalized === "BOOLEAN" || normalized === "BOOL") return "boolean";
  return "string";
}

function normalizeWritebackMode(mode: string): "direct_sql" | "app_handler" | "cloud_worker" | "none" {
  const normalized = mode.toUpperCase().replace(/\s+/g, "_");
  if (normalized === "DIRECT_SQL") return "direct_sql";
  if (normalized === "APP_HANDLER") return "app_handler";
  if (normalized === "CLOUD_WORKER") return "cloud_worker";
  return "none";
}

function autoApprovalPolicyNameForCapability(name: string): string {
  return `${name.replace(/[^A-Za-z0-9_]/g, "_")}_auto_approval`;
}

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function unsupported(item: { text: string; line: number }, blockKind: string): never {
  if (/ROOT\s+EXTERNAL|JOIN\s+EXTERNAL|RETURN\s+ANSWER|AUTO\s+BRANCH|AUTO\s+MERGE/i.test(item.text)) {
    throw dslError(item.line, 1, "UNSUPPORTED_PREVIEW_SYNTAX", `${blockKind} clause is not supported by @synapsor/dsl 0.1 preview: ${item.text}`);
  }
  throw dslError(item.line, 1, "UNSUPPORTED_DSL_CLAUSE", `unsupported ${blockKind} clause: ${item.text}`);
}

function dslError(line: number, column: number, code: string, message: string): AgentDslError {
  return new AgentDslError(line, column, code, message);
}

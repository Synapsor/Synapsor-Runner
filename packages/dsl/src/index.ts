import {
  assertValidContract,
  normalizeContract,
  type AgentContextSpec,
  type ArgumentSpec,
  type CapabilitySpec,
  type PolicySpec,
  type ProtectedReadAggregateSpec,
  type ProtectedReadLimitsSpec,
  type ProtectedReadPredicateSpec,
  type ProtectedReadRelationshipSpec,
  type ProtectedReadSpec,
  type ProtectedReadValueSpec,
  type ScalarArgumentSpec,
  type SynapsorContract,
  type WorkflowSpec,
} from "@synapsor/spec";

export type AgentDslAst = {
  contexts: AgentDslContextAst[];
  capabilities: AgentDslCapabilityAst[];
  workflows: AgentDslWorkflowAst[];
};

export type AgentDslContextAst = {
  name: string;
  line?: number;
  bindings: Array<{ name: string; source: "session" | "environment" | "cloud_session" | "static_dev" | "http_claim"; key: string; required?: boolean }>;
  tenantBinding?: string;
  principalBinding?: string;
};

export type AgentDslCapabilityAst = {
  name: string;
  line?: number;
  kind: "read" | "aggregate_read" | "proposal";
  description?: string;
  returnsHint?: string;
  context: string;
  source?: string;
  schema: string;
  table: string;
  primaryKey: string;
  tenantKey?: string;
  principalScopeKey?: string;
  conflictKey?: string;
  weakConflictGuardAcknowledged?: boolean;
  lookup?: { arg: string; column: string; line?: number };
  args: Record<string, (
    | (ScalarArgumentSpec & { line?: number })
    | { type: "object_array"; required?: boolean; description?: string; max_items: number; fields: Record<string, ScalarArgumentSpec>; line?: number }
  )>;
  visibleFields: string[];
  keptOutFields: string[];
  evidenceRequired?: boolean;
  maxRows?: number;
  aggregate?: {
    function: "count" | "sum" | "avg";
    count_mode?: "rows" | "non_null";
    column?: string;
    selection?: { all: Array<{ column: string; operator: "eq"; value: string | number | boolean | null }> };
    minimum_group_size?: number;
  };
  protectedRead?: {
    mode: "rows" | "aggregate";
    boundaryDigest?: `sha256:${string}`;
    generationLockFingerprint?: `sha256:${string}`;
    predicates: ProtectedReadPredicateSpec[];
    relationship?: ProtectedReadRelationshipSpec;
    rowOrderBy: Array<{ field: string; direction: "asc" | "desc" }>;
    aggregate?: Partial<ProtectedReadAggregateSpec> & {
      measures?: ProtectedReadAggregateSpec["measures"];
      dimensions?: NonNullable<ProtectedReadAggregateSpec["dimensions"]>;
      comparison?: ProtectedReadAggregateSpec["comparison"];
    };
    limits?: ProtectedReadLimitsSpec;
  };
  proposal?: {
    action: string;
    allowedFields: string[];
    patch: Record<string, { fixed?: string | number | boolean | null; from_arg?: string; from_item?: string }>;
    numericBounds?: Record<string, { minimum?: number; maximum?: number }>;
    transitionGuards?: Record<string, { from_column?: string; allowed: Record<string, string[]> }>;
    reversible?: boolean;
    approvalRole?: string;
    requiredApprovals?: number;
    autoApprovalRules?: Array<{ field: string; max: number; line: number }>;
    autoApprovalLimits?: Array<{
      kind: "count" | "total";
      max: number;
      period: "day";
      field?: string;
      scope: "tenant_policy" | "tenant_policy_object";
      line: number;
    }>;
    operation?: {
      kind: "update" | "insert" | "delete";
      cardinality?: "single" | "set";
      selection?: { all: Array<{ column: string; operator: "eq"; value: string | number | boolean | null }> };
      max_rows?: number;
      aggregate_bounds?: Array<{ column: string; measure: "before" | "after" | "absolute_delta"; maximum: number }>;
      batch?: { items_from_arg: string };
      deduplication?: {
        components: Array<{
          column: string;
          source: "proposal_id" | "trusted_tenant" | "fixed" | "item_field";
          fixed?: string | number | boolean | null;
          item_field?: string;
        }>;
      };
      version_advance?: {
        column: string;
        strategy: "integer_increment" | "database_generated";
      };
    };
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

export type AgentDslValidationOptions = {
  target?: "canonical" | "runner";
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
  validatePrincipalScopeContexts(ast);
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
        ...(capability.principalScopeKey ? { principal_scope_key: capability.principalScopeKey } : {}),
        ...(capability.conflictKey ? { conflict_key: capability.conflictKey } : {}),
      },
      args: specArgsFromDsl(capability.args),
      ...(capability.lookup ? { lookup: { id_from_arg: capability.lookup.arg } } : {}),
      visible_fields: capability.visibleFields,
      ...(capability.keptOutFields.length ? { kept_out_fields: capability.keptOutFields } : {}),
      ...(capability.evidenceRequired !== undefined ? { evidence: { required: capability.evidenceRequired, query_audit: true } } : {}),
      ...(capability.maxRows ? { max_rows: capability.maxRows } : {}),
      ...(capability.aggregate ? { aggregate: {
        function: capability.aggregate.function,
        ...(capability.aggregate.count_mode ? { count_mode: capability.aggregate.count_mode } : {}),
        ...(capability.aggregate.column ? { column: capability.aggregate.column } : {}),
        ...(capability.aggregate.selection ? { selection: capability.aggregate.selection } : {}),
        minimum_group_size: capability.aggregate.minimum_group_size ?? 2,
      } } : {}),
      ...(capability.protectedRead ? { protected_read: protectedReadSpecFromDsl(capability) } : {}),
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
      const conflictGuard = capability.conflictKey
        ? { column: capability.conflictKey }
        : capability.weakConflictGuardAcknowledged
          ? { weak_guard_ack: true as const }
          : undefined;
      spec.proposal = {
        action: capability.proposal.action,
        ...(capability.proposal.operation ? { operation: capability.proposal.operation } : {}),
        allowed_fields: capability.proposal.allowedFields,
        patch: capability.proposal.patch,
        ...(capability.proposal.numericBounds ? { numeric_bounds: capability.proposal.numericBounds } : {}),
        ...(capability.proposal.transitionGuards ? { transition_guards: capability.proposal.transitionGuards } : {}),
        ...(capability.proposal.reversible ? { reversibility: { mode: "reviewed_inverse" as const } } : {}),
        ...(conflictGuard ? { conflict_guard: conflictGuard } : {}),
        approval: autoApprovalPolicyName
          ? {
            mode: "policy",
            required_role: capability.proposal.approvalRole ?? "local_reviewer",
            ...(capability.proposal.requiredApprovals ? { required_approvals: capability.proposal.requiredApprovals } : {}),
            policy: autoApprovalPolicyName,
          }
          : {
            mode: "human",
            required_role: capability.proposal.approvalRole ?? "local_reviewer",
            ...(capability.proposal.requiredApprovals ? { required_approvals: capability.proposal.requiredApprovals } : {}),
          },
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

function protectedReadSpecFromDsl(capability: AgentDslCapabilityAst): ProtectedReadSpec {
  const protectedRead = capability.protectedRead;
  if (!protectedRead?.boundaryDigest || !protectedRead.generationLockFingerprint || !protectedRead.limits) {
    throw dslError(capability.line ?? 1, 1, "PROTECTED_READ_INCOMPLETE", `${capability.name} requires BOUNDARY DIGEST, GENERATION LOCK, and PROTECTED LIMITS`);
  }
  if (protectedRead.mode === "aggregate" && !protectedRead.aggregate) {
    throw dslError(capability.line ?? 1, 1, "PROTECTED_AGGREGATE_REQUIRED", `${capability.name} requires reviewed aggregate clauses`);
  }
  return {
    version: "1",
    mode: protectedRead.mode,
    boundary_digest: protectedRead.boundaryDigest,
    generation_lock_fingerprint: protectedRead.generationLockFingerprint,
    ...(protectedRead.predicates.length ? { predicates: protectedRead.predicates } : {}),
    ...(protectedRead.relationship ? { relationship: protectedRead.relationship } : {}),
    ...(protectedRead.rowOrderBy.length ? { row_order_by: protectedRead.rowOrderBy } : {}),
    ...(protectedRead.aggregate ? { aggregate: protectedRead.aggregate as ProtectedReadAggregateSpec } : {}),
    limits: protectedRead.limits,
  };
}

function validatePrincipalScopeContexts(ast: AgentDslAst): void {
  const contexts = new Map(ast.contexts.map((context) => [context.name, context]));
  for (const capability of ast.capabilities) {
    if (!capability.principalScopeKey) continue;
    const context = contexts.get(capability.context);
    const principalBinding = context?.principalBinding;
    const binding = principalBinding ? context?.bindings.find((item) => item.name === principalBinding) : undefined;
    if (!context || !principalBinding || !binding || binding.required !== true) {
      throw dslError(capability.line ?? 1, 1, "PRINCIPAL_SCOPE_BINDING_REQUIRED", `${capability.name} PRINCIPAL SCOPE KEY requires a context with a required PRINCIPAL BINDING`);
    }
    if (Object.prototype.hasOwnProperty.call(capability.args, capability.principalScopeKey)) {
      throw dslError(capability.line ?? 1, 1, "MODEL_CONTROLLED_PRINCIPAL_SCOPE", `${capability.principalScopeKey} cannot be both a trusted principal scope and a model-facing ARG`);
    }
    if (capability.proposal?.allowedFields.includes(capability.principalScopeKey) || capability.proposal?.patch[capability.principalScopeKey]) {
      throw dslError(capability.line ?? 1, 1, "PRINCIPAL_SCOPE_WRITE_FORBIDDEN", `${capability.principalScopeKey} is forced from trusted context and cannot be model-writeable`);
    }
  }
}

export function validateAgentDsl(source: string, options: AgentDslValidationOptions = {}): ValidationResult {
  try {
    const result = compileAgentDslWithWarnings(source);
    if (options.target === "runner") validateRunnerTarget(parseAgentDsl(source));
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
  const context: AgentDslContextAst = { name: block.name, line: block.line, bindings: [] };
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

function validateRunnerTarget(ast: AgentDslAst): void {
  for (const context of ast.contexts) {
    const binding = context.bindings.find((candidate) => candidate.source === "session");
    if (!binding) continue;
    throw dslError(
      context.line ?? 1,
      1,
      "SESSION_BINDING_UNSUPPORTED",
      `${context.name} binds ${binding.name} FROM SESSION, but Synapsor Runner has no generic web-session trust provider; use ENVIRONMENT for local stdio, HTTP_CLAIM for verified HTTP JWT claims, or CLOUD_SESSION for verified Cloud-linked identity`,
    );
  }
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
    const principalScope = item.text.match(/^PRINCIPAL\s+SCOPE\s+KEY\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (principalScope?.[1]) {
      if (capability.principalScopeKey) throw dslError(item.line, 1, "DUPLICATE_PRINCIPAL_SCOPE", `${block.name} declares PRINCIPAL SCOPE KEY more than once`);
      capability.principalScopeKey = principalScope[1];
      continue;
    }
    if (/^CONFLICT\s+GUARD\s+WEAK\s+ROW\s+HASH\s+ACKNOWLEDGED$/i.test(item.text)) {
      if (capability.conflictKey || capability.weakConflictGuardAcknowledged) {
        throw dslError(item.line, 1, "DUPLICATE_CONFLICT_GUARD", `${block.name} declares CONFLICT GUARD more than once`);
      }
      capability.weakConflictGuardAcknowledged = true;
      continue;
    }
    const conflict = item.text.match(/^CONFLICT\s+GUARD\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (conflict?.[1]) {
      if (capability.conflictKey || capability.weakConflictGuardAcknowledged) {
        throw dslError(item.line, 1, "DUPLICATE_CONFLICT_GUARD", `${block.name} declares CONFLICT GUARD more than once`);
      }
      capability.conflictKey = conflict[1];
      continue;
    }
    const rowsArg = item.text.match(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)\s+ROWS\s+MAX\s+(\d+)(?:\s+REQUIRED)?$/i);
    if (rowsArg?.[1] && rowsArg[2]) {
      capability.args[rowsArg[1]] = {
        type: "object_array",
        required: /\sREQUIRED$/i.test(item.text),
        max_items: Number(rowsArg[2]),
        fields: {},
        line: item.line,
      };
      continue;
    }
    const itemField = item.text.match(/^ITEM\s+FIELD\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s+(STRING|TEXT|NUMBER|BOOLEAN|BOOL)\b(.*)$/i);
    if (itemField?.[1] && itemField[2] && itemField[3]) {
      const arg = capability.args[itemField[1]];
      if (!arg || arg.type !== "object_array") throw dslError(item.line, 1, "ITEM_FIELD_ROWS_ARG_REQUIRED", `ITEM FIELD requires ARG ${itemField[1]} ROWS MAX n first`);
      const parsed = parseArgSpec(itemField[2], itemField[3], itemField[4] ?? "", item.line);
      const { line: _line, ...field } = parsed;
      arg.fields[itemField[2]] = field;
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
      if (capability.proposal?.operation?.cardinality === "set") capability.proposal.operation.max_rows = Number(maxRows[1]);
      else capability.maxRows = Number(maxRows[1]);
      continue;
    }
    const protectedRead = item.text.match(/^PROTECTED\s+READ\s+(ROWS|AGGREGATE)$/i);
    if (protectedRead?.[1]) {
      if (capability.proposal || capability.aggregate || capability.protectedRead) throw dslError(item.line, 1, "PROTECTED_READ_CONFLICT", "PROTECTED READ cannot be combined with proposal, legacy aggregate, or another protected-read declaration");
      const mode = protectedRead[1].toLowerCase() as "rows" | "aggregate";
      capability.kind = mode === "aggregate" ? "aggregate_read" : "read";
      capability.protectedRead = {
        mode,
        predicates: [],
        rowOrderBy: [],
        ...(mode === "aggregate" ? {
          aggregate: {
            counted_entity: "subject",
            measures: [],
            dimensions: [],
          },
        } : {}),
      };
      continue;
    }
    const boundaryDigest = item.text.match(/^BOUNDARY\s+DIGEST\s+(sha256:[a-f0-9]{64})$/i);
    if (boundaryDigest?.[1]) {
      const reviewed = requireProtectedRead(capability, item);
      reviewed.boundaryDigest = boundaryDigest[1].toLowerCase() as `sha256:${string}`;
      continue;
    }
    const generationLock = item.text.match(/^GENERATION\s+LOCK\s+(sha256:[a-f0-9]{64})$/i);
    if (generationLock?.[1]) {
      const reviewed = requireProtectedRead(capability, item);
      reviewed.generationLockFingerprint = generationLock[1].toLowerCase() as `sha256:${string}`;
      continue;
    }
    const protectedRelationship = item.text.match(/^PROTECTED\s+RELATIONSHIP\s+([A-Za-z_][A-Za-z0-9_]*)\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)\s+REFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s+PRIMARY\s+KEY\s+([A-Za-z_][A-Za-z0-9_]*)\s+TENANT\s+KEY\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+PRINCIPAL\s+SCOPE\s+KEY\s+([A-Za-z_][A-Za-z0-9_]*))?$/i);
    if (protectedRelationship?.[1] && protectedRelationship[2] && protectedRelationship[3] && protectedRelationship[4] && protectedRelationship[5] && protectedRelationship[6] && protectedRelationship[7]) {
      const reviewed = requireProtectedRead(capability, item);
      if (reviewed.relationship) throw dslError(item.line, 1, "PROTECTED_RELATIONSHIP_LIMIT", "PROTECTED READ permits at most one reviewed many-to-one relationship");
      reviewed.relationship = {
        name: protectedRelationship[1],
        local_key: protectedRelationship[2],
        schema: protectedRelationship[3],
        table: protectedRelationship[4],
        target_key: protectedRelationship[5],
        primary_key: protectedRelationship[6],
        tenant_key: protectedRelationship[7],
        ...(protectedRelationship[8] ? { principal_scope_key: protectedRelationship[8] } : {}),
        cardinality: "many_to_one",
        max_fan_out: 1,
      };
      continue;
    }
    const protectedFilter = item.text.match(/^PROTECTED\s+FILTER\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s+(EQ|NEQ|LT|LTE|GT|GTE|IN)\s+(.+)$/i);
    if (protectedFilter?.[1] && protectedFilter[2] && protectedFilter[3]) {
      const reviewed = requireProtectedRead(capability, item);
      const reference = parseProtectedFieldReference(protectedFilter[1]);
      const operator = protectedFilter[2].toLowerCase() as ProtectedReadPredicateSpec["operator"];
      if (operator === "in") {
        const list = protectedFilter[3].match(/^\((.*)\)$/)?.[1];
        if (list === undefined) throw dslError(item.line, 1, "PROTECTED_FILTER_IN_LIST_REQUIRED", "PROTECTED FILTER ... IN requires a parenthesized fixed literal list");
        const values = splitEnumValues(list, item.line, "PROTECTED FILTER").map((value) => parseProtectedLiteral(value, item.line, 1));
        reviewed.predicates.push({ ...reference, operator: "in", values });
      } else {
        reviewed.predicates.push({
          ...reference,
          operator,
          value: parseProtectedValueBinding(protectedFilter[3], item.line),
        });
      }
      continue;
    }
    const rowOrder = item.text.match(/^ROW\s+ORDER\s+BY\s+([A-Za-z_][A-Za-z0-9_]*)\s+(ASC|DESC)$/i);
    if (rowOrder?.[1] && rowOrder[2]) {
      const reviewed = requireProtectedRead(capability, item);
      reviewed.rowOrderBy.push({ field: rowOrder[1], direction: rowOrder[2].toLowerCase() as "asc" | "desc" });
      continue;
    }
    const protectedMeasure = item.text.match(/^MEASURE\s+([A-Za-z_][A-Za-z0-9_]*)\s+(COUNT\s+ROWS|COUNT\s+DISTINCT\s+[A-Za-z_][A-Za-z0-9_.]*|SUM\s+[A-Za-z_][A-Za-z0-9_.]*|AVG\s+[A-Za-z_][A-Za-z0-9_.]*)$/i);
    if (protectedMeasure?.[1] && protectedMeasure[2]) {
      const aggregate = requireProtectedAggregate(capability, item);
      const words = protectedMeasure[2].trim().split(/\s+/);
      const fn = words[0]!.toLowerCase();
      const measure = fn === "count" && words[1]?.toUpperCase() === "ROWS"
        ? { name: protectedMeasure[1], function: "count" as const }
        : {
          name: protectedMeasure[1],
          function: fn === "count" ? "count_distinct" as const : fn as "sum" | "avg",
          ...parseProtectedFieldReference(words[fn === "count" ? 2 : 1]!),
        };
      aggregate.measures ??= [];
      aggregate.measures.push(measure);
      continue;
    }
    const protectedDimension = item.text.match(/^GROUP\s+DIMENSION\s+([A-Za-z_][A-Za-z0-9_]*)\s+BY\s+([A-Za-z_][A-Za-z0-9_.]*)$/i);
    if (protectedDimension?.[1] && protectedDimension[2]) {
      const aggregate = requireProtectedAggregate(capability, item);
      aggregate.dimensions ??= [];
      aggregate.dimensions.push({ name: protectedDimension[1], ...parseProtectedFieldReference(protectedDimension[2]) });
      continue;
    }
    const protectedTime = item.text.match(/^TIME\s+DIMENSION\s+([A-Za-z_][A-Za-z0-9_]*)\s+BY\s+(DAY|WEEK|MONTH)\s+OF\s+([A-Za-z_][A-Za-z0-9_.]*)$/i);
    if (protectedTime?.[1] && protectedTime[2] && protectedTime[3]) {
      const aggregate = requireProtectedAggregate(capability, item);
      aggregate.time_bucket = {
        name: protectedTime[1],
        bucket: protectedTime[2].toLowerCase() as "day" | "week" | "month",
        ...parseProtectedFieldReference(protectedTime[3]),
      };
      continue;
    }
    const comparisonRange = item.text.match(/^COMPARE\s+RANGE\s+([A-Za-z_][A-Za-z0-9_.]*)\s+FROM\s+(.+?)\s+TO\s+(.+)$/i);
    if (comparisonRange?.[1] && comparisonRange[2] && comparisonRange[3]) {
      const aggregate = requireProtectedAggregate(capability, item);
      const field = parseProtectedFieldReference(comparisonRange[1]);
      if (aggregate.comparison && (aggregate.comparison.field !== field.field || aggregate.comparison.relationship !== field.relationship)) {
        throw dslError(item.line, 1, "PROTECTED_COMPARISON_FIELD_MISMATCH", "all COMPARE RANGE clauses must use the same reviewed timestamp field");
      }
      aggregate.comparison ??= { ...field, ranges: [] };
      aggregate.comparison.ranges.push({
        start: parseProtectedValueBinding(comparisonRange[2], item.line),
        end: parseProtectedValueBinding(comparisonRange[3], item.line),
      });
      continue;
    }
    const aggregateOrder = item.text.match(/^AGGREGATE\s+ORDER\s+BY\s+(?:MEASURE\s+([A-Za-z_][A-Za-z0-9_]*)|TIME\s+BUCKET)\s+(ASC|DESC)$/i);
    if (aggregateOrder && aggregateOrder[2]) {
      const aggregate = requireProtectedAggregate(capability, item);
      aggregate.order_by = aggregateOrder[1]
        ? { kind: "measure", measure: aggregateOrder[1], direction: aggregateOrder[2].toLowerCase() as "asc" | "desc" }
        : { kind: "time_bucket", direction: aggregateOrder[2].toLowerCase() as "asc" | "desc" };
      continue;
    }
    const topGroups = item.text.match(/^TOP\s+(\d+)\s+GROUPS$/i);
    if (topGroups?.[1]) {
      const aggregate = requireProtectedAggregate(capability, item);
      aggregate.top_n = Number(topGroups[1]);
      continue;
    }
    const protectedLimits = item.text.match(/^PROTECTED\s+LIMITS\s+ROWS\s+(\d+)\s+GROUPS\s+(\d+)\s+CELLS\s+(\d+)\s+BYTES\s+(\d+)\s+TIMEOUT\s+MS\s+(\d+)\s+QUERIES\s+(\d+)\s+EXTRACTED\s+CELLS\s+(\d+)\s+DIFFERENCING\s+(\d+)\s+RATE\s+PER\s+MINUTE\s+(\d+)$/i);
    if (protectedLimits) {
      const reviewed = requireProtectedRead(capability, item);
      reviewed.limits = {
        max_rows: Number(protectedLimits[1]),
        max_groups: Number(protectedLimits[2]),
        max_response_cells: Number(protectedLimits[3]),
        max_response_bytes: Number(protectedLimits[4]),
        statement_timeout_ms: Number(protectedLimits[5]),
        max_queries_per_session: Number(protectedLimits[6]),
        max_extracted_cells_per_session: Number(protectedLimits[7]),
        max_differencing_queries: Number(protectedLimits[8]),
        rate_limit_per_minute: Number(protectedLimits[9]),
      };
      if (reviewed.mode === "rows") capability.maxRows = reviewed.limits.max_rows;
      continue;
    }
    const aggregateRead = item.text.match(/^AGGREGATE\s+READ\s+(COUNT\s+ROWS|COUNT\s+NON\s+NULL\s+[A-Za-z_][A-Za-z0-9_]*|SUM\s+[A-Za-z_][A-Za-z0-9_]*|AVG\s+[A-Za-z_][A-Za-z0-9_]*)$/i);
    if (aggregateRead?.[1]) {
      if (capability.proposal || capability.protectedRead) throw dslError(item.line, 1, "AGGREGATE_PROPOSAL_CONFLICT", "AGGREGATE READ cannot be combined with PROPOSE ACTION or PROTECTED READ");
      const parts = aggregateRead[1].trim().split(/\s+/);
      const fn = parts[0]!.toLowerCase() as "count" | "sum" | "avg";
      capability.kind = "aggregate_read";
      capability.aggregate = fn === "count" && parts[1]?.toUpperCase() === "ROWS"
        ? { function: "count", count_mode: "rows" }
        : fn === "count"
          ? { function: "count", count_mode: "non_null", column: parts[3] }
          : { function: fn, column: parts[1] };
      continue;
    }
    const minimumGroup = item.text.match(/^MIN\s+GROUP\s+SIZE\s+(\d+)$/i);
    if (minimumGroup?.[1]) {
      if (capability.protectedRead?.mode === "aggregate") {
        requireProtectedAggregate(capability, item).minimum_group_size = Number(minimumGroup[1]);
      } else {
        if (!capability.aggregate) throw dslError(item.line, 1, "AGGREGATE_READ_REQUIRED", "MIN GROUP SIZE requires AGGREGATE READ or PROTECTED READ AGGREGATE first");
        capability.aggregate.minimum_group_size = Number(minimumGroup[1]);
      }
      continue;
    }
    const propose = item.text.match(/^PROPOSE\s+ACTION\s+([A-Za-z_][A-Za-z0-9_.]*)(?:\s+(UPDATE|INSERT|DELETE)(\s+SET)?)?$/i);
    if (propose?.[1]) {
      capability.kind = "proposal";
      capability.proposal = {
        action: propose[1],
        allowedFields: [],
        patch: {},
        ...(propose[2] ? { operation: { kind: propose[2].toLowerCase() as "update" | "insert" | "delete", ...(propose[3] ? { cardinality: "set" as const } : {}) } } : {}),
      };
      continue;
    }
    const selection = item.text.match(/^SELECT\s+WHERE(?:\s+(.*))?$/i);
    if (selection) {
      const clause = selection[1] ?? "";
      const prefix = item.text.match(/^SELECT\s+WHERE\s*/i)?.[0] ?? "SELECT WHERE ";
      const terms = parseFixedSelection(clause, item.line, prefix.length + 1);
      if (capability.aggregate) {
        capability.aggregate.selection ??= { all: [] };
        if (capability.aggregate.selection.all.length + terms.length > 8) throw dslError(item.line, prefix.length + 1, "SELECT_WHERE_TERM_COUNT", "SELECT WHERE supports at most 8 fixed equality terms per capability");
        capability.aggregate.selection.all.push(...terms);
      } else {
        ensureSetProposal(capability, item);
        if (capability.proposal.operation.kind === "insert") throw dslError(item.line, 1, "BATCH_INSERT_SELECTION_FORBIDDEN", "batch INSERT reviews explicit items and cannot use SELECT WHERE");
        capability.proposal.operation.selection ??= { all: [] };
        if (capability.proposal.operation.selection.all.length + terms.length > 8) throw dslError(item.line, prefix.length + 1, "SELECT_WHERE_TERM_COUNT", "SELECT WHERE supports at most 8 fixed equality terms per capability");
        capability.proposal.operation.selection.all.push(...terms);
      }
      continue;
    }
    const aggregate = item.text.match(/^MAX\s+TOTAL\s+([A-Za-z_][A-Za-z0-9_]*)\s+(BEFORE|AFTER|ABSOLUTE\s+DELTA)\s+(-?\d+(?:\.\d+)?)$/i);
    if (aggregate?.[1] && aggregate[2] && aggregate[3]) {
      ensureSetProposal(capability, item);
      capability.proposal.operation.aggregate_bounds ??= [];
      capability.proposal.operation.aggregate_bounds.push({
        column: aggregate[1],
        measure: aggregate[2].toLowerCase().replace(/\s+/g, "_") as "before" | "after" | "absolute_delta",
        maximum: Number(aggregate[3]),
      });
      continue;
    }
    const batch = item.text.match(/^BATCH\s+ITEMS\s+FROM\s+ARG\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (batch?.[1]) {
      ensureSetProposal(capability, item);
      if (capability.proposal.operation.kind !== "insert") throw dslError(item.line, 1, "BATCH_INSERT_ONLY", "BATCH ITEMS is valid only for PROPOSE ACTION ... INSERT SET");
      capability.proposal.operation.batch = { items_from_arg: batch[1] };
      continue;
    }
    const dedup = item.text.match(/^DEDUP\s+KEY\s+(.+)$/i);
    if (dedup?.[1]) {
      ensureProposal(capability, item);
      if (capability.proposal.operation?.kind !== "insert") {
        throw dslError(item.line, 1, "DEDUP_KEY_INSERT_ONLY", "DEDUP KEY requires PROPOSE ACTION ... INSERT");
      }
      capability.proposal.operation.deduplication = { components: parseDedupComponents(dedup[1], item.line) };
      continue;
    }
    const versionAdvance = item.text.match(/^ADVANCE\s+VERSION\s+([A-Za-z_][A-Za-z0-9_]*)\s+USING\s+(INTEGER\s+INCREMENT|DATABASE\s+GENERATED)$/i);
    if (versionAdvance?.[1] && versionAdvance[2]) {
      ensureProposal(capability, item);
      if ((capability.proposal.operation?.kind ?? "update") !== "update") {
        throw dslError(item.line, 1, "VERSION_ADVANCE_UPDATE_ONLY", "ADVANCE VERSION is valid only for UPDATE");
      }
      capability.proposal.operation ??= { kind: "update" };
      capability.proposal.operation.version_advance = {
        column: versionAdvance[1],
        strategy: /^INTEGER/i.test(versionAdvance[2]) ? "integer_increment" : "database_generated",
      };
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
    if (/^REVERSIBLE$/i.test(item.text)) {
      ensureProposal(capability, item);
      capability.proposal.reversible = true;
      continue;
    }
    const approval = item.text.match(/^APPROVAL\s+ROLE\s+([A-Za-z_][A-Za-z0-9_.-]*)$/i);
    if (approval?.[1]) {
      ensureProposal(capability, item);
      capability.proposal.approvalRole = approval[1];
      continue;
    }
    const approvalQuorum = item.text.match(/^REQUIRE\s+(\d+)\s+APPROVALS$/i);
    if (approvalQuorum?.[1]) {
      ensureProposal(capability, item);
      const requiredApprovals = Number(approvalQuorum[1]);
      if (!Number.isSafeInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > 10) {
        throw dslError(item.line, 1, "INVALID_REQUIRED_APPROVALS", "REQUIRE N APPROVALS supports a small-team quorum from 1 through 10");
      }
      capability.proposal.requiredApprovals = requiredApprovals;
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
  if (capability.kind !== "aggregate_read" && capability.visibleFields.length === 0) throw dslError(block.line, 1, "CAPABILITY_VISIBLE_FIELDS_REQUIRED", `${block.name} requires ALLOW READ`);
  if (Object.keys(capability.args).length === 0 && capability.lookup) capability.args[capability.lookup.arg] = { type: "string", required: true, max_length: 128 };
  if (capability.kind !== "aggregate_read" && Object.keys(capability.args).length === 0 && !capability.protectedRead) throw dslError(block.line, 1, "CAPABILITY_ARGS_REQUIRED", `${block.name} requires ARG or LOOKUP`);
  if (capability.kind === "aggregate_read") {
    if (capability.lookup) throw dslError(block.line, 1, "AGGREGATE_LOOKUP_FORBIDDEN", `${block.name} aggregate reads cannot use LOOKUP`);
    if (capability.visibleFields.length > 0) throw dslError(block.line, 1, "AGGREGATE_VISIBLE_ROWS_FORBIDDEN", `${block.name} aggregate reads cannot expose ALLOW READ row fields`);
    if (capability.evidenceRequired !== true) throw dslError(block.line, 1, "AGGREGATE_EVIDENCE_REQUIRED", `${block.name} aggregate reads require REQUIRE EVIDENCE`);
    if (capability.protectedRead) {
      const protectedAggregate = capability.protectedRead.aggregate;
      if (capability.protectedRead.mode !== "aggregate" || !protectedAggregate) throw dslError(block.line, 1, "PROTECTED_AGGREGATE_REQUIRED", `${block.name} requires PROTECTED READ AGGREGATE`);
      if (!protectedAggregate.measures?.length) throw dslError(block.line, 1, "PROTECTED_MEASURE_REQUIRED", `${block.name} requires at least one MEASURE`);
      if (!protectedAggregate.top_n) throw dslError(block.line, 1, "PROTECTED_TOP_GROUPS_REQUIRED", `${block.name} requires TOP n GROUPS`);
      if (!protectedAggregate.minimum_group_size || protectedAggregate.minimum_group_size < 2) throw dslError(block.line, 1, "AGGREGATE_MINIMUM_GROUP_SIZE_REQUIRED", `${block.name} requires MIN GROUP SIZE 2 or greater`);
    } else {
      if (!capability.aggregate) throw dslError(block.line, 1, "AGGREGATE_READ_REQUIRED", `${block.name} requires AGGREGATE READ`);
      if (!capability.aggregate.minimum_group_size || capability.aggregate.minimum_group_size < 2) throw dslError(block.line, 1, "AGGREGATE_MINIMUM_GROUP_SIZE_REQUIRED", `${block.name} requires MIN GROUP SIZE 2 or greater`);
      if (Object.keys(capability.args).length > 0) throw dslError(block.line, 1, "AGGREGATE_MODEL_ARGS_FORBIDDEN", `${block.name} legacy aggregate reads cannot use model-controlled ARG predicates`);
    }
  }
  if (capability.protectedRead) {
    if (!capability.protectedRead.boundaryDigest) throw dslError(block.line, 1, "PROTECTED_BOUNDARY_DIGEST_REQUIRED", `${block.name} requires BOUNDARY DIGEST`);
    if (!capability.protectedRead.generationLockFingerprint) throw dslError(block.line, 1, "PROTECTED_GENERATION_LOCK_REQUIRED", `${block.name} requires GENERATION LOCK`);
    if (!capability.protectedRead.limits) throw dslError(block.line, 1, "PROTECTED_LIMITS_REQUIRED", `${block.name} requires PROTECTED LIMITS`);
    if (capability.evidenceRequired !== true) throw dslError(block.line, 1, "PROTECTED_EVIDENCE_REQUIRED", `${block.name} requires REQUIRE EVIDENCE`);
    if (capability.protectedRead.mode === "rows" && capability.lookup) throw dslError(block.line, 1, "PROTECTED_LOOKUP_FORBIDDEN", `${block.name} protected row reads use reviewed filters, not LOOKUP`);
  }
  if (capability.kind === "proposal") {
    if (!capability.proposal) throw dslError(block.line, 1, "PROPOSAL_ACTION_REQUIRED", `${block.name} requires PROPOSE ACTION`);
    const operation = capability.proposal.operation?.kind ?? "update";
    if (operation === "update" && !capability.conflictKey && !capability.weakConflictGuardAcknowledged) {
      throw dslError(
        block.line,
        1,
        "UPDATE_CONFLICT_GUARD_REQUIRED",
        `${block.name} UPDATE requires CONFLICT GUARD <column>; use CONFLICT GUARD WEAK ROW HASH ACKNOWLEDGED only for a deliberately accepted legacy source-db UPDATE`,
      );
    }
    if (operation !== "delete" && Object.keys(capability.proposal.patch).length === 0) {
      throw dslError(block.line, 1, "PROPOSAL_PATCH_REQUIRED", `${block.name} ${operation.toUpperCase()} proposal requires at least one PATCH line`);
    }
    if (operation === "delete" && Object.keys(capability.proposal.patch).length > 0) {
      throw dslError(block.line, 1, "DELETE_PATCH_FORBIDDEN", `${block.name} DELETE proposal must not contain PATCH lines`);
    }
    if (operation === "delete" && capability.proposal.allowedFields.length > 0) {
      throw dslError(block.line, 1, "DELETE_ALLOW_WRITE_FORBIDDEN", `${block.name} DELETE proposal must not contain ALLOW WRITE`);
    }
    if (operation === "delete" && !capability.conflictKey) {
      throw dslError(block.line, 1, "DELETE_CONFLICT_GUARD_REQUIRED", `${block.name} DELETE requires CONFLICT GUARD`);
    }
    if (operation === "insert" && capability.weakConflictGuardAcknowledged) {
      throw dslError(block.line, 1, "INSERT_WEAK_CONFLICT_GUARD_FORBIDDEN", `${block.name} INSERT uses source-enforced DEDUP KEY identity; a weak row-hash guard is not applicable`);
    }
    if (operation === "insert" && !capability.proposal.operation?.deduplication) {
      throw dslError(block.line, 1, "INSERT_DEDUP_KEY_REQUIRED", `${block.name} INSERT requires DEDUP KEY backed by an inspected source UNIQUE constraint`);
    }
    if (operation === "insert" && capability.proposal.operation?.deduplication) {
      const tenantKey = capability.tenantKey;
      const hasTrustedTenant = capability.proposal.operation.deduplication.components.some((component) => component.source === "trusted_tenant" && component.column === tenantKey);
      const hasProposalId = capability.proposal.operation.deduplication.components.some((component) => component.source === "proposal_id");
      const hasItemField = capability.proposal.operation.deduplication.components.some((component) => component.source === "item_field");
      if (!hasTrustedTenant) throw dslError(block.line, 1, "INSERT_TRUSTED_TENANT_DEDUP_REQUIRED", `${block.name} INSERT DEDUP KEY must bind ${tenantKey ?? "the tenant key"} from TRUSTED TENANT`);
      if (capability.proposal.operation.cardinality === "set" ? !hasItemField : !hasProposalId) throw dslError(block.line, 1, capability.proposal.operation.cardinality === "set" ? "INSERT_ITEM_DEDUP_REQUIRED" : "INSERT_PROPOSAL_ID_DEDUP_REQUIRED", capability.proposal.operation.cardinality === "set" ? `${block.name} batch INSERT DEDUP KEY must include an ITEM component` : `${block.name} INSERT DEDUP KEY must include a PROPOSAL ID component`);
    }
    if (operation === "delete" && capability.proposal.autoApprovalRules?.length) {
      throw dslError(block.line, 1, "DELETE_AUTO_APPROVAL_FORBIDDEN", `${block.name} DELETE cannot use AUTO APPROVE`);
    }
    if (capability.proposal.operation?.cardinality === "set") {
      const set = capability.proposal.operation;
      if (operation !== "insert" && !capability.conflictKey) throw dslError(block.line, 1, "SET_EXACT_CONFLICT_GUARD_REQUIRED", `${block.name} bounded set write requires an exact CONFLICT GUARD <column>`);
      if (!set.max_rows || set.max_rows > 100) throw dslError(block.line, 1, "SET_MAX_ROWS_REQUIRED", `${block.name} bounded set write requires MAX ROWS 1..100 after PROPOSE ACTION`);
      if (!set.aggregate_bounds?.length) throw dslError(block.line, 1, "SET_AGGREGATE_BOUND_REQUIRED", `${block.name} bounded set write requires MAX TOTAL <column> BEFORE|AFTER|ABSOLUTE DELTA <maximum>`);
      if (capability.proposal.autoApprovalRules?.length) throw dslError(block.line, 1, "SET_AUTO_APPROVAL_FORBIDDEN", `${block.name} bounded set writes require human/operator approval in the first release`);
      if (operation === "insert") {
        const itemsArg = set.batch?.items_from_arg;
        const arg = itemsArg ? capability.args[itemsArg] : undefined;
        if (!itemsArg || !arg || arg.type !== "object_array" || Object.keys(arg.fields).length === 0) throw dslError(block.line, 1, "BATCH_ITEMS_ARG_REQUIRED", `${block.name} batch INSERT requires BATCH ITEMS FROM ARG <rows-arg> and typed ITEM FIELD declarations`);
        if (arg.max_items > set.max_rows) throw dslError(block.line, 1, "BATCH_ITEMS_EXCEED_MAX_ROWS", `${block.name} rows argument MAX must not exceed MAX ROWS`);
      } else if (!set.selection?.all.length) {
        throw dslError(block.line, 1, "SET_FIXED_SELECTION_REQUIRED", `${block.name} bounded ${operation.toUpperCase()} requires one or more SELECT WHERE <column> = <literal> clauses`);
      }
    }
    if (capability.proposal.reversible) {
      if ((capability.proposal.writebackMode ?? "direct_sql") !== "direct_sql") {
        throw dslError(block.line, 1, "REVERSIBILITY_DIRECT_SQL_REQUIRED", `${block.name} REVERSIBLE requires WRITEBACK DIRECT SQL`);
      }
      if (capability.proposal.autoApprovalRules?.length) {
        throw dslError(block.line, 1, "REVERSIBILITY_AUTO_APPROVAL_FORBIDDEN", `${block.name} REVERSIBLE requires independent human/operator approval`);
      }
      if (operation === "update") {
        if (!capability.conflictKey) throw dslError(block.line, 1, "REVERSIBILITY_CONFLICT_GUARD_REQUIRED", `${block.name} reversible UPDATE requires CONFLICT GUARD`);
        if (capability.proposal.operation?.version_advance?.strategy !== "integer_increment") {
          throw dslError(block.line, 1, "REVERSIBILITY_INTEGER_VERSION_REQUIRED", `${block.name} reversible UPDATE requires ADVANCE VERSION <column> USING INTEGER INCREMENT`);
        }
      }
      if (operation === "insert") {
        const primaryKey = capability.primaryKey;
        const hasPrimaryDedup = capability.proposal.operation?.deduplication?.components.some((component) => component.column === primaryKey);
        if (!hasPrimaryDedup) throw dslError(block.line, 1, "REVERSIBILITY_PRIMARY_KEY_DEDUP_REQUIRED", `${block.name} reversible INSERT requires DEDUP KEY to derive PRIMARY KEY ${primaryKey}`);
      }
    }
  }
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
    if (capability.weakConflictGuardAcknowledged) {
      warnings.push({
        line,
        column: 1,
        code: "WEAK_CONFLICT_GUARD_ACKNOWLEDGED",
        message: `${capability.name} explicitly uses a weak row-hash guard. It hashes only the captured projection and may miss concurrent changes to columns outside that projection; prefer CONFLICT GUARD <version-column>.`,
      });
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

function ensureSetProposal(capability: AgentDslCapabilityAst, item: { line: number }): asserts capability is AgentDslCapabilityAst & { proposal: NonNullable<AgentDslCapabilityAst["proposal"]> & { operation: NonNullable<NonNullable<AgentDslCapabilityAst["proposal"]>["operation"]> & { cardinality: "set" } } } {
  ensureProposal(capability, item);
  if (!capability.proposal.operation || capability.proposal.operation.cardinality !== "set") throw dslError(item.line, 1, "SET_OPERATION_REQUIRED", "bounded-set clauses require PROPOSE ACTION ... UPDATE SET, INSERT SET, or DELETE SET");
}

function requireProtectedRead(
  capability: AgentDslCapabilityAst,
  item: { line: number },
): NonNullable<AgentDslCapabilityAst["protectedRead"]> {
  if (!capability.protectedRead) throw dslError(item.line, 1, "PROTECTED_READ_REQUIRED", "protected-read clauses require PROTECTED READ ROWS or PROTECTED READ AGGREGATE first");
  return capability.protectedRead;
}

function requireProtectedAggregate(
  capability: AgentDslCapabilityAst,
  item: { line: number },
): NonNullable<NonNullable<AgentDslCapabilityAst["protectedRead"]>["aggregate"]> {
  const protectedRead = requireProtectedRead(capability, item);
  if (protectedRead.mode !== "aggregate" || !protectedRead.aggregate) {
    throw dslError(item.line, 1, "PROTECTED_AGGREGATE_REQUIRED", "aggregate protection clauses require PROTECTED READ AGGREGATE first");
  }
  return protectedRead.aggregate;
}

function parseProtectedFieldReference(raw: string): { field: string; relationship?: string } {
  const parts = raw.split(".");
  if (parts.length === 1 && parts[0]) return { field: parts[0] };
  if (parts.length === 2 && parts[0] && parts[1]) return { relationship: parts[0], field: parts[1] };
  throw dslError(1, 1, "PROTECTED_FIELD_REFERENCE_INVALID", "protected field references must be field or relationship.field");
}

function parseProtectedValueBinding(raw: string, line: number): ProtectedReadValueSpec {
  const argument = raw.trim().match(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (argument?.[1]) return { from_arg: argument[1] };
  const fixed = raw.trim().match(/^FIXED\s+(.+)$/i);
  if (fixed?.[1]) return { fixed: parseProtectedLiteral(fixed[1], line, 1) };
  throw dslError(line, 1, "PROTECTED_VALUE_BINDING_REQUIRED", "protected values must use FIXED <literal> or ARG <name>");
}

function parseProtectedLiteral(raw: string, line = 1, column = 1): string | number | boolean | null {
  const value = parseLiteral(raw, line, column);
  return typeof value === "string" ? value.replace(/''/g, "'") : value;
}

function parsePatchBinding(raw: string): { fixed?: string | number | boolean | null; from_arg?: string; from_item?: string } {
  const trimmed = raw.trim();
  const arg = trimmed.match(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (arg?.[1]) return { from_arg: arg[1] };
  const item = trimmed.match(/^ITEM\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (item?.[1]) return { from_item: item[1] };
  return { fixed: parseLiteral(trimmed) };
}

function parseFixedSelection(
  raw: string,
  line: number,
  baseColumn: number,
): Array<{ column: string; operator: "eq"; value: string | number | boolean | null }> {
  const terms: Array<{ column: string; operator: "eq"; value: string | number | boolean | null }> = [];
  let index = 0;

  const columnAt = (offset = index): number => baseColumn + offset;
  const skipWhitespace = (): void => {
    while (index < raw.length && /\s/.test(raw[index] ?? "")) index += 1;
  };
  const fail = (code: string, message: string, offset = index): never => {
    throw dslError(line, columnAt(offset), code, message);
  };

  skipWhitespace();
  if (index >= raw.length) fail("SELECT_WHERE_SYNTAX", "SELECT WHERE requires <column> = <literal>");

  while (index < raw.length) {
    skipWhitespace();
    const termStart = index;
    const identifier = raw.slice(index).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    const column = identifier?.[1];
    if (!column) {
      if (raw[index] === "=" || /^AND\b/i.test(raw.slice(index))) {
        throw dslError(line, columnAt(termStart), "SELECT_WHERE_SYNTAX", "SELECT WHERE requires a column before =");
      }
      throw dslError(line, columnAt(termStart), "SELECT_WHERE_UNSUPPORTED", "SELECT WHERE supports only fixed literal equality terms joined by AND");
    }
    index += column.length;
    skipWhitespace();
    if (raw[index] !== "=") {
      if (["!", "<", ">", "("].includes(raw[index] ?? "")) {
        fail("SELECT_WHERE_UNSUPPORTED", "SELECT WHERE supports only the = operator", index);
      }
      fail("SELECT_WHERE_SYNTAX", `SELECT WHERE term ${column} requires = <literal>`, index);
    }
    index += 1;
    if (raw[index] === "=") fail("SELECT_WHERE_UNSUPPORTED", "SELECT WHERE supports =, not ==", index - 1);
    skipWhitespace();
    if (index >= raw.length) fail("SELECT_WHERE_SYNTAX", `SELECT WHERE term ${column} requires a literal value`);

    const literalStart = index;
    if (raw[index] === "'") {
      index += 1;
      let closed = false;
      while (index < raw.length) {
        if (raw[index] !== "'") {
          index += 1;
          continue;
        }
        if (raw[index + 1] === "'") {
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      if (!closed) fail("SELECT_WHERE_UNTERMINATED_STRING", `unterminated quoted literal for ${column}`, literalStart);
    } else {
      while (index < raw.length && !/\s/.test(raw[index] ?? "")) index += 1;
    }

    const literal = raw.slice(literalStart, index);
    const value = parseLiteral(literal, line, columnAt(literalStart));
    terms.push({ column, operator: "eq", value });
    if (terms.length > 8) fail("SELECT_WHERE_TERM_COUNT", "SELECT WHERE supports at most 8 fixed equality terms per capability", termStart);

    skipWhitespace();
    if (index >= raw.length) break;
    const separator = raw.slice(index).match(/^AND\b/i)?.[0];
    if (!separator) {
      throw dslError(line, columnAt(index), "SELECT_WHERE_UNSUPPORTED", "SELECT WHERE supports only fixed literal equality terms joined by AND");
    }
    index += separator.length;
    skipWhitespace();
    if (index >= raw.length) fail("SELECT_WHERE_SYNTAX", "SELECT WHERE cannot end with AND");
  }

  return terms;
}

function parseLiteral(raw: string, line = 1, column = 1): string | number | boolean | null {
  const trimmed = raw.trim();
  if (/^NULL$/i.test(trimmed)) return null;
  if (/^TRUE$/i.test(trimmed)) return true;
  if (/^FALSE$/i.test(trimmed)) return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const quoted = trimmed.match(/^'(.*)'$/);
  if (quoted) return quoted[1] ?? "";
  throw dslError(line, column, "FIXED_LITERAL_REQUIRED", `expected a quoted string, number, boolean, or NULL: ${trimmed}`);
}

function parseDedupComponents(
  raw: string,
  line: number,
): Array<{ column: string; source: "proposal_id" | "trusted_tenant" | "fixed" | "item_field"; fixed?: string | number | boolean | null; item_field?: string }> {
  const components = raw.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const match = item.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(PROPOSAL\s+ID|TRUSTED\s+TENANT|ITEM\s+[A-Za-z_][A-Za-z0-9_]*|FIXED\s+.+)$/i);
    if (!match?.[1] || !match[2]) {
      throw dslError(line, 1, "DEDUP_COMPONENT_INVALID", `DEDUP KEY component must use column = PROPOSAL ID, TRUSTED TENANT, ITEM <field>, or FIXED <value>: ${item}`);
    }
    const source = match[2].toUpperCase();
    if (source === "PROPOSAL ID") return { column: match[1], source: "proposal_id" as const };
    if (source === "TRUSTED TENANT") return { column: match[1], source: "trusted_tenant" as const };
    if (/^ITEM\s+/i.test(source)) return { column: match[1], source: "item_field" as const, item_field: match[2].replace(/^ITEM\s+/i, "") };
    const binding = parsePatchBinding(match[2].replace(/^FIXED\s+/i, ""));
    return { column: match[1], source: "fixed" as const, fixed: binding.fixed ?? null };
  });
  if (components.length === 0 || components.length > 8) {
    throw dslError(line, 1, "DEDUP_COMPONENT_COUNT", "DEDUP KEY requires 1 through 8 components");
  }
  if (new Set(components.map((component) => component.column)).size !== components.length) {
    throw dslError(line, 1, "DEDUP_COMPONENT_DUPLICATE", "DEDUP KEY component columns must be unique");
  }
  return components;
}

function parseArgSpec(
  name: string,
  rawType: string,
  rawOptions: string,
  line: number,
): ScalarArgumentSpec & { line?: number } {
  const type = normalizeArgType(rawType);
  let rest = rawOptions.trim();
  let description: string | undefined;
  const descriptionMatch = rest.match(/\bDESCRIPTION\s+'([^']*)'/i);
  if (descriptionMatch) {
    description = descriptionMatch[1] ?? "";
    rest = `${rest.slice(0, descriptionMatch.index)} ${rest.slice((descriptionMatch.index ?? 0) + descriptionMatch[0].length)}`.trim();
  }
  const enumOption = extractEnumOption(rest, name, type, line);
  const enumValues = enumOption.values;
  rest = enumOption.rest;
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
    ...(enumValues ? { enum: enumValues } : {}),
  };
}

function extractEnumOption(
  input: string,
  name: string,
  type: ScalarArgumentSpec["type"],
  line: number,
): { rest: string; values?: Array<string | number | boolean> } {
  const match = /\bENUM\s*\(/i.exec(input);
  if (!match || match.index === undefined) return { rest: input };
  const valueStart = match.index + match[0].length;
  let index = valueStart;
  let quoted = false;
  let closed = false;
  while (index < input.length) {
    const character = input[index];
    if (character === "'") {
      if (quoted && input[index + 1] === "'") { index += 2; continue; }
      quoted = !quoted;
      index += 1;
      continue;
    }
    if (character === ")" && !quoted) { closed = true; break; }
    index += 1;
  }
  if (!closed) throw dslError(line, 1, "ARG_ENUM_UNTERMINATED", `ARG ${name} ENUM requires a closing )`);
  const body = input.slice(valueStart, index);
  const trailing = input.slice(index + 1);
  if (/\bENUM\s*\(/i.test(trailing)) throw dslError(line, 1, "ARG_ENUM_DUPLICATE_CLAUSE", `ARG ${name} may declare ENUM once`);
  const rawValues = splitEnumValues(body, line, name);
  if (rawValues.length === 0) throw dslError(line, 1, "ARG_ENUM_EMPTY", `ARG ${name} ENUM requires at least one value`);
  if (rawValues.length > 64) throw dslError(line, 1, "ARG_ENUM_ITEM_LIMIT", `ARG ${name} ENUM supports at most 64 values`);
  const values = rawValues.map((value) => parseLiteral(value, line, 1));
  if (values.some((value) => value === null)) throw dslError(line, 1, "ARG_ENUM_NULL_UNSUPPORTED", `ARG ${name} ENUM cannot contain NULL`);
  const expectedType = type === "string" ? "string" : type;
  if (values.some((value) => typeof value !== expectedType)) throw dslError(line, 1, "ARG_ENUM_TYPE_MISMATCH", `ARG ${name} ENUM values must all be ${type.toUpperCase()} literals`);
  const keys = values.map((value) => `${typeof value}:${JSON.stringify(value)}`);
  if (new Set(keys).size !== keys.length) throw dslError(line, 1, "ARG_ENUM_DUPLICATE_VALUE", `ARG ${name} ENUM values must be unique after canonicalization`);
  return {
    rest: `${input.slice(0, match.index)} ${trailing}`.trim(),
    values: values as Array<string | number | boolean>,
  };
}

function splitEnumValues(body: string, line: number, name: string): string[] {
  const values: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "'") {
      if (quoted && body[index + 1] === "'") { index += 1; continue; }
      quoted = !quoted;
      continue;
    }
    if (body[index] === "," && !quoted) {
      const value = body.slice(start, index).trim();
      if (!value) throw dslError(line, 1, "ARG_ENUM_VALUE_REQUIRED", `ARG ${name} ENUM contains an empty item`);
      values.push(value);
      start = index + 1;
    }
  }
  if (quoted) throw dslError(line, 1, "ARG_ENUM_UNTERMINATED_STRING", `ARG ${name} ENUM contains an unterminated string literal`);
  const finalValue = body.slice(start).trim();
  if (finalValue) values.push(finalValue);
  else if (body.trim()) throw dslError(line, 1, "ARG_ENUM_VALUE_REQUIRED", `ARG ${name} ENUM contains an empty item`);
  return values;
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
    throw dslError(item.line, 1, "UNSUPPORTED_PREVIEW_SYNTAX", `${blockKind} clause is not supported by the current @synapsor/dsl grammar: ${item.text}`);
  }
  throw dslError(item.line, 1, "UNSUPPORTED_DSL_CLAUSE", `unsupported ${blockKind} clause: ${item.text}`);
}

function dslError(line: number, column: number, code: string, message: string): AgentDslError {
  return new AgentDslError(line, column, code, message);
}

import { assertValidContract, normalizeContract, type AgentContextSpec, type CapabilitySpec, type SynapsorContract, type WorkflowSpec } from "@synapsor/spec";

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
  kind: "read" | "proposal";
  context: string;
  source?: string;
  schema: string;
  table: string;
  primaryKey: string;
  tenantKey?: string;
  conflictKey?: string;
  lookup?: { arg: string; column: string };
  args: Record<string, { type: "string" | "number" | "boolean"; required?: boolean; max_length?: number }>;
  visibleFields: string[];
  keptOutFields: string[];
  evidenceRequired?: boolean;
  maxRows?: number;
  proposal?: {
    action: string;
    allowedFields: string[];
    patch: Record<string, { fixed?: string | number | boolean | null; from_arg?: string }>;
    approvalRole?: string;
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
  const ast = parseAgentDsl(source);
  const contexts: AgentContextSpec[] = ast.contexts.map((context) => ({
    name: context.name,
    bindings: context.bindings,
    ...(context.tenantBinding ? { tenant_binding: context.tenantBinding } : {}),
    ...(context.principalBinding ? { principal_binding: context.principalBinding } : {}),
  }));
  const capabilities: CapabilitySpec[] = ast.capabilities.map((capability) => {
    const spec: CapabilitySpec = {
      name: capability.name,
      kind: capability.kind,
      context: capability.context,
      ...(capability.source ? { source: capability.source } : {}),
      subject: {
        schema: capability.schema,
        table: capability.table,
        primary_key: capability.primaryKey,
        ...(capability.tenantKey ? { tenant_key: capability.tenantKey } : {}),
        ...(capability.conflictKey ? { conflict_key: capability.conflictKey } : {}),
      },
      args: capability.args,
      ...(capability.lookup ? { lookup: { id_from_arg: capability.lookup.arg } } : {}),
      visible_fields: capability.visibleFields,
      ...(capability.keptOutFields.length ? { kept_out_fields: capability.keptOutFields } : {}),
      ...(capability.evidenceRequired !== undefined ? { evidence: { required: capability.evidenceRequired, query_audit: true } } : {}),
      ...(capability.maxRows ? { max_rows: capability.maxRows } : {}),
    };
    if (capability.kind === "proposal" && capability.proposal) {
      spec.proposal = {
        action: capability.proposal.action,
        allowed_fields: capability.proposal.allowedFields,
        patch: capability.proposal.patch,
        conflict_guard: capability.conflictKey ? { column: capability.conflictKey } : { weak_guard_ack: true },
        approval: { mode: "human", required_role: capability.proposal.approvalRole ?? "local_reviewer" },
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
  };
  assertValidContract(contract);
  return normalizeContract(contract);
}

export function validateAgentDsl(source: string): ValidationResult {
  try {
    compileAgentDsl(source);
    return { ok: true, errors: [], warnings: [] };
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
    const arg = item.text.match(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)\s+(STRING|TEXT|NUMBER|BOOLEAN|BOOL)(?:\s+REQUIRED)?(?:\s+MAX\s+(\d+))?$/i);
    if (arg?.[1] && arg[2]) {
      capability.args[arg[1]] = {
        type: normalizeArgType(arg[2]),
        ...(item.text.match(/\sREQUIRED(?:\s|$)/i) ? { required: true } : {}),
        ...(arg[3] ? { max_length: Number(arg[3]) } : {}),
      };
      continue;
    }
    const lookup = item.text.match(/^LOOKUP\s+([A-Za-z_][A-Za-z0-9_]*)\s+BY\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (lookup?.[1] && lookup[2]) {
      capability.lookup = { arg: lookup[1], column: lookup[2] };
      capability.primaryKey = lookup[2];
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
    const approval = item.text.match(/^APPROVAL\s+ROLE\s+([A-Za-z_][A-Za-z0-9_.-]*)$/i);
    if (approval?.[1]) {
      ensureProposal(capability, item);
      capability.proposal.approvalRole = approval[1];
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
  if (capability.visibleFields.length === 0) throw dslError(block.line, 1, "CAPABILITY_VISIBLE_FIELDS_REQUIRED", `${block.name} requires ALLOW READ`);
  if (Object.keys(capability.args).length === 0 && capability.lookup) capability.args[capability.lookup.arg] = { type: "string", required: true, max_length: 128 };
  if (Object.keys(capability.args).length === 0) throw dslError(block.line, 1, "CAPABILITY_ARGS_REQUIRED", `${block.name} requires ARG or LOOKUP`);
  if (capability.kind === "proposal" && (!capability.proposal || Object.keys(capability.proposal.patch).length === 0)) throw dslError(block.line, 1, "PROPOSAL_PATCH_REQUIRED", `${block.name} proposal requires at least one PATCH line`);
  return capability;
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

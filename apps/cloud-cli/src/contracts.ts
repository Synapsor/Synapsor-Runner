import fs from "node:fs/promises";
import path from "node:path";
import { compileAgentDsl, formatAgentDsl } from "@synapsor/dsl";
import { normalizeContract, validateContract, type SynapsorContract, type ValidationIssue } from "@synapsor/spec";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";

export type ContractFile = {
  path: string;
  format: "json" | "dsl";
  contract: SynapsorContract;
  source: string;
};

export type SemanticChange = {
  area: string;
  change: string;
  name?: string;
  risk_increasing: boolean;
  before?: unknown;
  after?: unknown;
};

export async function loadContractFile(file: string): Promise<ContractFile> {
  const resolved = path.resolve(file);
  const source = await fs.readFile(resolved, "utf8");
  if (resolved.endsWith(".synapsor") || resolved.endsWith(".synapsor.sql")) {
    return { path: resolved, format: "dsl", contract: compileAgentDsl(source), source };
  }
  const parsed = JSON.parse(source) as unknown;
  const result = validateContract(parsed);
  if (!result.ok) throw contractValidationError(result.errors);
  return { path: resolved, format: "json", contract: normalizeContract(parsed), source };
}

export async function initializeContract(file: string, name = "synapsor-contract"): Promise<SynapsorContract> {
  const resolved = path.resolve(file);
  try {
    await fs.access(resolved);
    throw new Error(`contract_exists: ${resolved}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const contract = normalizeContract({
    spec_version: "0.1",
    kind: "SynapsorContract",
    metadata: { name, version: "1" },
    contexts: [{
      name: "local_operator",
      bindings: [
        { name: "tenant_id", source: "environment", key: "SYNAPSOR_TENANT_ID", required: true },
        { name: "principal", source: "environment", key: "SYNAPSOR_PRINCIPAL", required: true },
      ],
      tenant_binding: "tenant_id",
      principal_binding: "principal",
    }],
    resources: [{
      name: "example_records",
      engine: "postgres",
      schema: "public",
      table: "records",
      type: "table",
      primary_key: "id",
      tenant_key: "tenant_id",
    }],
    capabilities: [{
      name: "example.inspect_record",
      description: "Replace this starter capability with one reviewed for your schema.",
      kind: "read",
      context: "local_operator",
      source: "local_postgres",
      subject: { resource: "example_records" },
      args: { record_id: { type: "string", required: true, max_length: 128 } },
      lookup: { id_from_arg: "record_id" },
      visible_fields: ["id", "tenant_id"],
      kept_out_fields: [],
      evidence: { required: true, query_audit: true },
      max_rows: 1,
    }],
    workflows: [],
    policies: [],
  });
  if (isDslPath(resolved)) {
    const source = starterDsl(name);
    const compiled = compileAgentDsl(source);
    await atomicTextWrite(resolved, source, false);
    return compiled;
  }
  await atomicContractWrite(resolved, contract, false);
  return contract;
}

export async function formatContractFile(file: string, check = false): Promise<{ changed: boolean; contract: SynapsorContract }> {
  const loaded = await loadContractFile(file);
  const formatted = loaded.format === "dsl"
    ? `${formatAgentDsl(loaded.source).trimEnd()}\n`
    : `${JSON.stringify(loaded.contract, null, 2)}\n`;
  const changed = formatted !== loaded.source;
  if (changed && !check) await atomicTextWrite(loaded.path, formatted, true);
  return { changed, contract: loaded.contract };
}

export async function mutateDefinition(
  file: string,
  section: "contexts" | "capabilities" | "workflows",
  action: "create" | "update" | "remove",
  name: string,
  value?: Record<string, unknown>,
): Promise<{ contract: SynapsorContract; changes: SemanticChange[] }> {
  const loaded = await loadContractFile(file);
  if (loaded.format !== "json") throw new Error("dsl_mutation_requires_compile: compile the DSL to canonical JSON before structured mutation");
  const before = structuredClone(loaded.contract);
  const current = [...(loaded.contract[section] || [])] as Array<Record<string, unknown>>;
  const index = current.findIndex((item) => item.name === name);
  if (action === "create") {
    if (index >= 0) throw new Error(`${section.slice(0, -1)}_already_exists: ${name}`);
    if (!value) throw new Error("definition_input_required");
    current.push({ ...value, name });
  } else if (action === "update") {
    if (index < 0) throw new Error(`${section.slice(0, -1)}_not_found: ${name}`);
    if (!value) throw new Error("definition_input_required");
    current[index] = { ...current[index], ...value, name };
  } else {
    if (index < 0) throw new Error(`${section.slice(0, -1)}_not_found: ${name}`);
    const references = definitionReferences(loaded.contract, section, name);
    if (references.length) throw new Error(`definition_still_referenced: ${name} by ${references.join(", ")}`);
    current.splice(index, 1);
  }
  const candidate = { ...loaded.contract, [section]: current };
  const result = validateContract(candidate);
  if (!result.ok) throw contractValidationError(result.errors);
  const normalized = normalizeContract(candidate);
  const changes = semanticDiff(before, normalized);
  await atomicContractWrite(loaded.path, normalized, true);
  return { contract: normalized, changes };
}

export function inspectContract(contract: SynapsorContract): Record<string, unknown> {
  return {
    name: contract.metadata?.name,
    spec_version: contract.spec_version,
    digest: canonicalJsonDigest(contract),
    contexts: contract.contexts.map((context) => ({
      name: context.name,
      tenant_binding: context.tenant_binding,
      principal_binding: context.principal_binding,
      trusted_bindings: context.bindings.map((binding) => ({ name: binding.name, source: binding.source, required: binding.required === true })),
    })),
    capabilities: contract.capabilities.map((capability) => ({
      name: capability.name,
      kind: capability.kind,
      context: capability.context,
      tenant_key: capability.subject?.tenant_key,
      principal_scope_key: capability.subject?.principal_scope_key,
      visible_fields: capability.visible_fields || [],
      kept_out_fields: capability.kept_out_fields || [],
      approval: capability.proposal?.approval,
      writeback: capability.proposal?.writeback,
    })),
    workflows: (contract.workflows || []).map((workflow) => ({ name: workflow.name, context: workflow.context, allowed_capabilities: workflow.allowed_capabilities })),
  };
}

export function semanticDiff(before: SynapsorContract, after: SynapsorContract): SemanticChange[] {
  const changes: SemanticChange[] = [];
  for (const section of ["contexts", "capabilities", "workflows", "policies"] as const) {
    const left = new Map((before[section] || []).map((item) => [item.name, item]));
    const right = new Map((after[section] || []).map((item) => [item.name, item]));
    for (const name of [...right.keys()].filter((item) => !left.has(item)).sort()) {
      changes.push({ area: section, change: "added", name, risk_increasing: section !== "workflows", after: right.get(name) });
    }
    for (const name of [...left.keys()].filter((item) => !right.has(item)).sort()) {
      changes.push({ area: section, change: "removed", name, risk_increasing: section === "contexts", before: left.get(name) });
    }
    for (const name of [...right.keys()].filter((item) => left.has(item)).sort()) {
      const previous = left.get(name);
      const current = right.get(name);
      if (JSON.stringify(previous) === JSON.stringify(current)) continue;
      if (section === "capabilities") changes.push(...capabilityChanges(name, previous as Record<string, unknown>, current as Record<string, unknown>));
      else changes.push({ area: section, change: "changed", name, risk_increasing: true, before: previous, after: current });
    }
  }
  return changes;
}

export function renderSemanticDiff(changes: SemanticChange[]): string[] {
  if (!changes.length) return ["No semantic changes."];
  return changes.map((change) => `${change.risk_increasing ? "RISK" : "SAFE"} ${change.area}.${change.change}${change.name ? ` ${change.name}` : ""}`);
}

function capabilityChanges(name: string, before: Record<string, unknown>, after: Record<string, unknown>): SemanticChange[] {
  const changes: SemanticChange[] = [];
  const beforeSubject = object(before.subject);
  const afterSubject = object(after.subject);
  const previousScope = beforeSubject.principal_scope_key;
  const nextScope = afterSubject.principal_scope_key;
  if (previousScope !== nextScope) {
    changes.push({
      area: "authority",
      change: previousScope === undefined ? "principal_scope_added" : nextScope === undefined ? "principal_scope_removed" : "principal_scope_changed",
      name,
      risk_increasing: previousScope !== undefined,
      before: previousScope,
      after: nextScope,
    });
  }
  for (const field of ["visible_fields", "kept_out_fields"] as const) {
    const left = new Set(Array.isArray(before[field]) ? before[field] as string[] : []);
    const right = new Set(Array.isArray(after[field]) ? after[field] as string[] : []);
    const added = [...right].filter((item) => !left.has(item));
    const removed = [...left].filter((item) => !right.has(item));
    if (added.length) changes.push({ area: "fields", change: `${field}_added`, name, risk_increasing: field === "visible_fields", after: added });
    if (removed.length) changes.push({ area: "fields", change: `${field}_removed`, name, risk_increasing: field === "kept_out_fields", before: removed });
  }
  if (!changes.length) changes.push({ area: "capabilities", change: "changed", name, risk_increasing: true, before, after });
  return changes;
}

function definitionReferences(contract: SynapsorContract, section: "contexts" | "capabilities" | "workflows", name: string): string[] {
  if (section === "contexts") {
    return [
      ...contract.capabilities.filter((item) => item.context === name).map((item) => `capability:${item.name}`),
      ...(contract.workflows || []).filter((item) => item.context === name).map((item) => `workflow:${item.name}`),
    ];
  }
  if (section === "capabilities") {
    return (contract.workflows || []).filter((item) => item.allowed_capabilities.includes(name)).map((item) => `workflow:${item.name}`);
  }
  return [];
}

function contractValidationError(errors: ValidationIssue[]): Error {
  return new Error(`contract_validation_failed: ${errors.slice(0, 8).map((issue) => `${issue.path} ${issue.code}: ${issue.message}`).join("; ")}`);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isDslPath(file: string): boolean {
  return file.endsWith(".synapsor") || file.endsWith(".synapsor.sql");
}

function starterDsl(name: string): string {
  const displayName = name.replace(/[\r\n]+/g, " ").trim() || "synapsor-contract";
  return `-- Synapsor contract: ${displayName}
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENV SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENV SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY example.inspect_record
  DESCRIPTION 'Replace this starter capability with one reviewed for your schema.'
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.records
  PRIMARY KEY id
  TENANT KEY tenant_id
  LOOKUP record_id BY id
  ARG record_id STRING REQUIRED MAX LENGTH 128
  ALLOW READ id, tenant_id
  REQUIRE EVIDENCE
  MAX ROWS 1
END
`;
}

async function atomicContractWrite(file: string, contract: SynapsorContract, backup: boolean): Promise<void> {
  await atomicTextWrite(file, `${JSON.stringify(contract, null, 2)}\n`, backup);
}

async function atomicTextWrite(file: string, content: string, backup: boolean): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (backup) {
    try {
      await fs.copyFile(file, `${file}.bak`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, file);
}

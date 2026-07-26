import type {
  StoredProposal,
} from "@synapsor-runner/proposal-store";
import {
  z,
} from "zod";
import {
  buildProposalReviewView,
} from "./proposal-review-view.js";
import type {
  Scalar,
  RuntimeScalarArgConfig,
  RuntimeCapabilityConfig,
  RuntimeConfig,
  McpRuntime,
  LocalToolMetadata,
} from "./runtime-types.js";
import {
  resolveSupervisedWorkerEligibility,
} from "./capability-authority.js";
import {
  toolErrorPayload,
} from "./runtime-errors.js";
import {
  isRecord,
  scalar,
} from "./safe-values.js";

export async function toolCallResult(runtime: McpRuntime, toolName: string, args: Record<string, unknown>) {
  try {
    const result = await runtime.callTool(toolName, args);
    const structuredContent = await withProposalReviewPresentation(runtime, result);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  } catch (error) {
    const payload = toolErrorPayload(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  }
}

export async function withProposalReviewPresentation(
  runtime: McpRuntime,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const directId = typeof result.proposal_id === "string" ? result.proposal_id : undefined;
  const nested = isRecord(result.proposal) ? result.proposal : undefined;
  const proposalId = directId ?? (typeof nested?.id === "string" ? nested.id : undefined);
  if (!proposalId || proposalId === "wrp_unknown") return result;
  try {
    const resource = await runtime.readResource(`synapsor://proposals/${proposalId}`);
    const proposal = resource.proposal as StoredProposal | undefined;
    const receipts = Array.isArray(resource.receipts)
      ? resource.receipts as import("@synapsor-runner/proposal-store").StoredWritebackReceipt[]
      : [];
    if (!proposal?.proposal_id) return result;
    return {
      ...result,
      proposal_review: buildProposalReviewView(proposal, receipts),
    };
  } catch {
    // Presentation enrichment must never turn a successful governed action into a tool failure.
    return result;
  }
}

export function toolDescriptionWithCanonical(description: string, canonicalName: string, exposedName?: string): string {
  if (!exposedName || exposedName === canonicalName) return description;
  return `Canonical Synapsor capability: ${canonicalName}.\n${description}`;
}

export function zodInputShapeFromJsonSchema(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? new Set(schema.required.map(String)) : new Set<string>();
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = isRecord(rawProperty) ? rawProperty : {};
    let valueSchema: z.ZodTypeAny;
    if (Array.isArray(property.enum)) {
      const allowed = property.enum.map((item) => scalar(item));
      valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]).refine((value) => allowed.includes(value), "value is not allowlisted");
    } else if (property.type === "number" || property.type === "integer") valueSchema = z.number();
    else if (property.type === "boolean") valueSchema = z.boolean();
    else valueSchema = z.string();
    if (!required.has(name)) valueSchema = valueSchema.optional();
    shape[name] = valueSchema.describe(typeof property.description === "string" ? property.description : `${name} argument`);
  }
  return shape;
}

export function zodInputShape(capability: RuntimeCapabilityConfig): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, spec] of Object.entries(capability.args)) {
    let schema: z.ZodTypeAny = spec.type === "object_array"
      ? z.array(z.object(Object.fromEntries(Object.entries(spec.fields).map(([field, fieldSpec]) => [field, zodScalarArg(fieldSpec)]))).strict()).min(1).max(spec.max_items)
      : zodScalarArg(spec);
    if (spec.required === false) schema = schema.optional();
    shape[name] = schema.describe(spec.description ?? `${name} business argument`);
  }
  return shape;
}

export function zodScalarArg(spec: RuntimeScalarArgConfig): z.ZodTypeAny {
  let schema: z.ZodTypeAny = spec.type === "number" ? z.number() : spec.type === "boolean" ? z.boolean() : z.string();
  if (spec.type === "string" && spec.max_length) schema = (schema as z.ZodString).max(spec.max_length);
  if (spec.type === "number" && spec.minimum !== undefined) schema = (schema as z.ZodNumber).min(spec.minimum);
  if (spec.type === "number" && spec.maximum !== undefined) schema = (schema as z.ZodNumber).max(spec.maximum);
  if (spec.enum && spec.enum.length > 0) schema = schema.refine((value) => spec.enum?.includes(value as Scalar), "value is not allowlisted");
  if (spec.required === false) schema = schema.optional();
  return schema;
}

export function toolMetadata(capability: RuntimeCapabilityConfig, config?: RuntimeConfig): LocalToolMetadata {
  return {
    name: capability.name,
    title: capability.name,
    description: capabilityDescription(capability, config),
    kind: capability.kind,
    input_schema: Object.fromEntries(Object.entries(capability.args).map(([name, spec]) => [name, {
      type: spec.type === "object_array" ? "array" : spec.type,
      required: spec.required !== false,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.type === "object_array" ? { max_items: spec.max_items, fields: spec.fields } : {
        ...(spec.max_length !== undefined ? { max_length: spec.max_length } : {}),
        ...(spec.minimum !== undefined ? { minimum: spec.minimum } : {}),
        ...(spec.maximum !== undefined ? { maximum: spec.maximum } : {}),
        ...(spec.enum !== undefined ? { enum: spec.enum } : {}),
      }),
    }])),
    annotations: {
      readOnlyHint: capability.kind === "read" || capability.kind === "aggregate_read",
      destructiveHint: false,
      idempotentHint: capability.kind === "read" || capability.kind === "aggregate_read",
      openWorldHint: false,
      raw_sql_exposed: false,
      approval_or_commit_tool: false,
    },
  };
}

export function capabilityDescription(
  capability: RuntimeCapabilityConfig,
  config?: RuntimeConfig,
  exposedName?: string,
): string {
  const lines: string[] = [];
  if (exposedName && exposedName !== capability.name) {
    lines.push(`Canonical Synapsor capability: ${capability.name}.`);
  }
  if (capability.description) {
    lines.push(capability.description);
  } else if (capability.kind === "read") {
    lines.push(`Read ${capability.target.schema}.${capability.target.table} through a reviewed Synapsor capability with trusted tenant context and evidence.`);
  } else {
    const supervised = config
      ? resolveSupervisedWorkerEligibility(config, capability, { phase: "queue" })
      : undefined;
    if (supervised?.eligible) {
      if (capability.approval?.mode === "policy") {
        lines.push(
          `Create an evidence-backed Synapsor proposal for ${capability.target.schema}.${capability.target.table}. `
          + "If it satisfies the reviewed automatic-approval policy, a separately trusted Runner worker may later apply it without a per-request human click. "
          + "The model cannot approve, apply, start the worker, or change that policy.",
        );
      } else {
        lines.push(
          `Create an evidence-backed Synapsor proposal for ${capability.target.schema}.${capability.target.table}. `
          + "After the required human approval, a separately trusted Runner worker may later apply it. "
          + "The model cannot approve, apply, start the worker, or change that execution policy.",
        );
      }
    } else {
      lines.push(`Create an evidence-backed Synapsor proposal for ${capability.target.schema}.${capability.target.table}; the source database is not mutated by this tool.`);
    }
  }
  if (capability.returns_hint) {
    lines.push(capability.returns_hint);
  }
  lines.push("Evidence handles are audit/replay handles; the model does not need to call them during this turn.");
  return lines.join("\n");
}

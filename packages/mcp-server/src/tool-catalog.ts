import type {
  StoredProposal,
} from "@synapsor-runner/proposal-store";
import {
  buildProposalReviewView,
} from "./proposal-review-view.js";
import type {
  RuntimeCapabilityConfig,
  RuntimeConfig,
  McpRuntime,
  LocalToolMetadata,
} from "./runtime-types.js";
import {
  localCapabilities,
  resolveSupervisedWorkerEligibility,
} from "./capability-authority.js";
import {
  projectProtectedReadResultForModel,
} from "./protected-read-runtime.js";
import {
  toolErrorPayload,
} from "./runtime-errors.js";
import {
  isRecord,
} from "./safe-values.js";
export {
  zodInputShape,
  zodInputShapeFromJsonSchema,
  zodScalarArg,
} from "./tool-input-schema.js";

export async function toolCallResult(runtime: McpRuntime, toolName: string, args: Record<string, unknown>) {
  try {
    const result = await runtime.callTool(toolName, args);
    const structuredContent = await withProposalReviewPresentation(runtime, result);
    const capability = runtime.config.mode === "cloud"
      ? undefined
      : localCapabilities(runtime.config).find((item) => item.name === toolName);
    const projection = capability
      ? projectProtectedReadResultForModel(capability, structuredContent)
      : { value: structuredContent, withheld: false };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(projection.value, null, 2) }],
      structuredContent: projection.value,
      ...(projection.withheld
        ? {
          _meta: {
            "synapsor.model_withheld_values": true,
            "synapsor.local_full_result": structuredContent,
          },
        }
        : {}),
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

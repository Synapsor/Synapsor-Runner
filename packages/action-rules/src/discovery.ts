import { actionRulePublicEffects } from "./effect-inventory.js";
import type { ActionRuleSpecV1 } from "@synapsor/spec";
import type { CompiledActionRuleV1 } from "./types.js";
import { ActionRuleError } from "./errors.js";

export const ACTION_DISCOVERY_CONTRACT_BYTES = 12_288;

export function actionRuleDiscoveryMetadata(rule: ActionRuleSpecV1): { title: string; summary: string; aliases: string[] } {
  const extension = rule["x-runner-discovery"];
  const fallback = rule.name.split(".").slice(1).join(" ").replace(/[_:-]+/gu, " ").trim() || rule.name;
  if (extension === undefined) {
    const title = (fallback.charAt(0).toUpperCase() + fallback.slice(1)).slice(0, 160);
    return { title, summary: title, aliases: [] };
  }
  if (!extension || typeof extension !== "object" || Array.isArray(extension)
    || Object.keys(extension).some((key) => !["title", "summary", "aliases"].includes(key))) {
    throw new ActionRuleError("ACTION_RULE_INVALID", "x-runner-discovery requires only reviewed title, summary and aliases.");
  }
  const { title, summary, aliases = [] } = extension;
  const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0
    && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!text(title, 160) || !text(summary, 400) || !Array.isArray(aliases) || aliases.length > 16
    || aliases.some((value) => !text(value, 80))) {
    throw new ActionRuleError("ACTION_RULE_INVALID", "Reviewed discovery requires a title (160), summary (400), and at most 16 aliases (80 characters each).");
  }
  return { title, summary, aliases: aliases as string[] };
}

/** A complete public request contract, not the private verification program. */
export function actionRuleDiscoveryContract(compiled: CompiledActionRuleV1, approvalMode: "policy" | "human", availability = "available"): Record<string, unknown> {
  const metadata = actionRuleDiscoveryMetadata(compiled.rule);
  return {
    outcome: compiled.outcome, availability, description: metadata.title, summary: metadata.summary,
    inputs: (compiled.rule.inputs ?? []).map((definition) => ({ ...definition, required: true, origin: "caller_business_input" })),
    subjects: compiled.rule.subjects.map((subject) => ({ binding: subject.binding, resource: subject.resource, reference: "opaque Explore subject reference" })),
    request_shape: { outcome: compiled.outcome,
      subject_refs: Object.fromEntries(compiled.rule.subjects.map((subject) => [subject.binding, "obj_<opaque reference>"])),
      ...(compiled.rule.inputs?.length ? { inputs: Object.fromEntries(compiled.rule.inputs.map((definition) =>
        [definition.name, "<value matching this input's reviewed type and bounds>"])) } : {}) },
    eligibility: "not_checked; request_change validates this customer's references, inputs and current facts",
    proposal_effect: { scope: "primary_only; see business_effects for all components", operation: compiled.effect_envelope.operation, resource: compiled.effect_envelope.target_resource,
      fields: compiled.effect_envelope.allowed_fields.map((field) => field.name), max_rows: 1 },
    business_effects: actionRulePublicEffects(compiled),
    approval: { class: compiled.approval_class, decision: approvalMode === "policy"
      ? "automatic only when the separate reviewed policy and atomic limits pass; otherwise human review" : "human review required" },
    source_write: "never during request_change",
  };
}

export function assertActionDiscoveryContractFits(compiled: CompiledActionRuleV1, mode: "policy" | "human"): void {
  const contract = actionRuleDiscoveryContract(compiled, mode, "operator_review_required");
  if (Buffer.byteLength(JSON.stringify(contract)) > ACTION_DISCOVERY_CONTRACT_BYTES) {
    throw new ActionRuleError("ACTION_RULE_INVALID", "The complete public Action request contract exceeds 12288 bytes. Reduce input descriptions or supported vocabulary before activation; required constraints cannot be truncated.");
  }
  // The fixed discovery envelope also needs space. Reserve 4 KiB of the
  // 16 KiB transport limit for guidance, cursor and disclosure metadata.
  const value = { actions: [contract] };
  const response = { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
  if (Buffer.byteLength(JSON.stringify(response)) > ACTION_DISCOVERY_CONTRACT_BYTES) {
    throw new ActionRuleError("ACTION_RULE_INVALID", "The complete public Action request contract cannot fit the MCP response budget. Reduce input descriptions or supported vocabulary before activation; required constraints cannot be truncated.");
  }
}

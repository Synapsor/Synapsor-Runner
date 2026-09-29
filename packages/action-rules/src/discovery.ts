import { actionRulePublicEffects } from "./effect-inventory.js";
import type { ActionRuleSpecV1 } from "@synapsor/spec";
import type { CompiledActionRuleV1 } from "./types.js";
import { ActionRuleError } from "./errors.js";

export const ACTION_DISCOVERY_CONTRACT_BYTES = 12_288;

/** Inputs are caller intent, not access to private verification facts. */
export function actionRulePublicInputs(rule: ActionRuleSpecV1) {
  return (rule.inputs ?? []).map((definition) => ({ ...definition, required: true,
    ...(definition.type.kind === "string" && definition.type.min_length !== undefined ? {length_units:"utf16_code_units",normalization:"none"} : {}),
    origin: "caller_business_input" as const,
    acquisition: { source: "authorized_caller", public_lookup: "not_established_by_action_contract",
      guidance: "Use a value explicitly supplied by the authorized caller or their established business process. If missing, ask for it before requesting. Do not guess from private verification, an earlier request or current posted values." },
  }));
}


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

/** A complete public request shape, not the private approval/verification program. */
export function actionRuleDiscoveryContract(compiled: CompiledActionRuleV1, approvalMode: "policy" | "human", availability = "available"): Record<string, unknown> {
  const metadata = actionRuleDiscoveryMetadata(compiled.rule);
  return {
    outcome: compiled.outcome, availability, description: metadata.title, summary: metadata.summary,
    inputs: actionRulePublicInputs(compiled.rule),
    subjects: compiled.rule.subjects.map((subject) => ({ binding: subject.binding, resource: subject.resource, reference: "opaque Explore subject reference",
      navigation: { status: "not_established", describe_data: { resource: subject.resource },
        guidance: "Request exact current data detail to establish permitted rows, fields and filters. Use the reference accompanying the selected returned row; never fabricate it. Public rows do not establish private eligibility." },
    })),
    request_shape: { outcome: compiled.outcome,
      subject_refs: Object.fromEntries(compiled.rule.subjects.map((subject) => [subject.binding, "obj_<opaque reference>"])),
      ...(compiled.rule.inputs?.length ? { inputs: Object.fromEntries(compiled.rule.inputs.map((definition) =>
        [definition.name, "<value matching this input's reviewed type and bounds>"])) } : {}) },
    request_shape_is_template: true,
    request_guidance: "Replace every placeholder with the selected row's real opaque reference and authorized typed caller inputs. Unfilled placeholders are not usable arguments. Missing inputs require caller information, not guesses or eligibility probes.",
    eligibility: "not_checked; request_change validates this customer's references, inputs and current facts",
    proposal_effect: { scope: "primary_only; see business_effects for all components", operation: compiled.effect_envelope.operation, resource: compiled.effect_envelope.target_resource,
      fields: compiled.effect_envelope.allowed_fields.map((field) => field.name), max_rows: 1 },
    business_effects: actionRulePublicEffects(compiled),
    approval: { class: compiled.approval_class,
      disclosure: availability !== "available" ? "unavailable" : approvalMode === "policy" ? "mode_only" : "manual_only",
      decision: availability !== "available" ? "current approval route unavailable until operator review; no approval or execution readiness established"
        : approvalMode === "policy" ? "automatic only when current eligibility, the separate reviewed policy and available atomic allowance pass; otherwise eligible requests require human review"
          : "human review required",
      ...(approvalMode === "policy" && availability === "available" ? { conditions: "not_disclosed; no automatic threshold is established by this description" } : {}),
    },
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

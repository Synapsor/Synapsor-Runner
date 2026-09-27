import { z } from "zod";
import { isRecord } from "./safe-values.js";

export const RESULT_EVIDENCE_TOOLS = ["app.describe_data", "app.explore_data", "app.describe_actions", "app.request_change"] as const;
export type ResultEvidenceTool = typeof RESULT_EVIDENCE_TOOLS[number];
/** Registered output families, not a new authority or lifecycle registry. */
export const RESULT_EVIDENCE_FAMILIES = [
  "catalog.actions", "catalog.resources", "catalog.resources_unpaged", "catalog.settings", "catalog.contract_index", "catalog.contract_section", "actions.unavailable",
  "source.rows", "source.aggregate", "request.semantic", "settings.data", "settings.actions",
  "settings.summary", "settings.saved", "settings.replay", "refusal", "unknown",
] as const;
export type ResultEvidenceFamily = typeof RESULT_EVIDENCE_FAMILIES[number];

const fullResultEvidenceSchema = z.object({
  version: z.literal("synapsor.result-evidence.v1"),
  family: z.enum(RESULT_EVIDENCE_FAMILIES),
  observation: z.enum(["catalog_metadata", "source_rows", "aggregate_groups", "request_lifecycle", "agent_settings", "operation_refusal", "unknown"]),
  coverage: z.object({ scope: z.enum(["authorized_catalog_query", "executed_read_query", "one_request", "agent_settings", "unestablished"]),
    status: z.enum(["complete", "partial", "unknown", "not_applicable"]) }).strict(),
  returned: z.object({ count: z.number().int().nonnegative(), unit: z.enum(["items", "rows", "groups"]) }).strict().optional(),
  runner_history: z.enum(["not_inspected", "one_request_only", "unknown"]),
  reference: z.object({ meaning: z.literal("opaque_scoped_lookup"),
    not_proof_of: z.tuple([z.literal("intent"), z.literal("eligibility"), z.literal("approval"), z.literal("execution"), z.literal("snapshot")]) }).strict().optional(),
  request: z.object({ invocation: z.enum(["created_request", "returned_existing_request"]),
    execution: z.enum(["not_started", "queued", "in_progress", "retry_wait", "applied", "failed", "unknown"]),
    disposition: z.enum(["unknown", "reconciliation_required", "closed", "blocked", "open"]),
    approval: z.enum(["unknown", "pending_human_review", "not_approved", "automatic", "human"]),
    effect: z.enum(["verified_applied", "not_established"]) }).strict().optional(),
  next_step: z.enum(["continue_page", "inspect_contract", "use_reviewed_query", "use_authorized_status", "inspect_recorded_status", "human_settings_review", "follow_refusal", "information_unavailable"]),
}).strict();
// Catalog v2 declares its own query/page grammar. Projected unpaged Read
// metadata declares metadata-only observation and retains its resource array
// and existing continuation. Neither needs a duplicate observation envelope;
// unpaged metadata does not acquire v2 completeness from this addition.
const catalogResultEvidenceSchema = z.object({ runner_history: z.literal("not_inspected") }).strict();
export const resultEvidenceSchema = z.union([fullResultEvidenceSchema, catalogResultEvidenceSchema]);
export type ResultEvidence = z.infer<typeof resultEvidenceSchema>;
type FullResultEvidence = z.infer<typeof fullResultEvidenceSchema>;

const references = (): NonNullable<FullResultEvidence["reference"]> => ({ meaning: "opaque_scoped_lookup",
  not_proof_of: ["intent", "eligibility", "approval", "execution", "snapshot"] });
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

/** Select only host-owned root envelopes. Row/description text never selects a
 * family. Unknown envelopes get unknown coverage, never a guessed positive. */
export function resultEvidenceFamily(tool: ResultEvidenceTool, value: Record<string, unknown>): ResultEvidenceFamily {
  if (value.ok === false) return "refusal";
  if (value.ok !== true) return "unknown";
  const settings = value.policy_view === "agent_rules" && value.source === "runner_control_plane";
  if (value.catalog_version === "synapsor.scoped-catalog.v2" && isRecord(value.pagination)) {
    if ((tool === "app.describe_data" || tool === "app.describe_actions")
      && value.pagination.consistency === "fixed_authorized_contract") {
      if (value.pagination.scope === "contract_section_index" && isRecord(value.contract_navigation)
        && value.contract_navigation.complete_contract === false && Array.isArray(value.contract_navigation.sections)) return "catalog.contract_index";
      if (value.pagination.scope === "selected_contract_section" && isRecord(value.contract_section)
        && Array.isArray(value.contract_section.items)) return "catalog.contract_section";
      return "unknown";
    }
    if (settings && Array.isArray(value.resources)) return "catalog.settings";
    if (tool === "app.describe_actions" && Array.isArray(value.actions)) return "catalog.actions";
    if (tool === "app.describe_data" && Array.isArray(value.resources)) return "catalog.resources";
  }
  if (settings) switch (tool) {
    case "app.describe_data": return Array.isArray(value.resources) ? "settings.data" : "unknown";
    case "app.describe_actions": return Array.isArray(value.actions) ? "settings.actions" : "unknown";
    case "app.explore_data": return typeof value.control_ref === "string" ? "settings.summary" : "unknown";
    case "app.request_change": return value.replay === true ? "settings.replay"
      : typeof value.status === "string" && isRecord(value.review) ? "settings.saved" : "unknown";
  }
  if (tool === "app.describe_data" && value.metadata_only === true && value.contains_source_values === false
    && ["resource_detail", "resource_index"].includes(String(value.catalog_view))
    && Array.isArray(value.resources) && value.resources.every(isRecord)) return "catalog.resources_unpaged";
  if (tool === "app.explore_data" && record(value.outcome).type === "success" && Array.isArray(value.data) && value.data.every(isRecord)) {
    if (value.kind === "rows") return "source.rows";
    if (value.kind === "aggregate") return "source.aggregate";
  }
  if (tool === "app.describe_actions" && value.availability === "operator_review_required") return "actions.unavailable";
  if (tool === "app.request_change" && typeof value.outcome === "string" && isRecord(value.lifecycle)
    && ["created", "already_recorded"].includes(String(value.request_disposition))) return "request.semantic";
  return "unknown";
}

/** Derive presentation from the FINAL authorized object only. No DB/store
 * reads, currentness decisions, hidden counts or response-time timestamps. */
export function withResultEvidence(tool: string, value: Record<string, unknown>): Record<string, unknown> {
  if (!RESULT_EVIDENCE_TOOLS.includes(tool as ResultEvidenceTool)) return value;
  const family = resultEvidenceFamily(tool as ResultEvidenceTool, value);
  const compactReadGuidance = family === "catalog.resources_unpaged"
    && value.next_action === "Metadata only; use app.explore_data for values.";
  const evidence: FullResultEvidence = { version: "synapsor.result-evidence.v1", family, observation: "unknown",
    coverage: { scope: "unestablished", status: "unknown" }, runner_history: "unknown", next_step: "information_unavailable" };
  let summary: string;
  switch (family) {
    case "catalog.contract_index":
      summary = "Contract section-index page; collect every index page and its exact revision-bound sections. This is partial contract metadata; source and Runner work are unassessed.";
      break;
    case "catalog.contract_section":
      summary = "Contract section page; other sections remain separate. An ended page or selected item is not the complete contract, eligibility, approval or execution evidence.";
      break;
    case "catalog.actions": case "catalog.resources": case "catalog.settings": {
      const items = family === "catalog.actions" ? value.actions : value.resources;
      const count = (items as unknown[]).length;
      const more = record(value.pagination).has_more;
      evidence.observation = family === "catalog.settings" ? "agent_settings" : "catalog_metadata";
      evidence.coverage = { scope: "authorized_catalog_query", status: more === true ? "partial" : more === false ? "complete" : "unknown" };
      evidence.returned = { count, unit: "items" };
      evidence.runner_history = "not_inspected";
      evidence.next_step = more === true ? "continue_page" : "inspect_contract";
      summary = `${count} metadata items; source/Runner work unassessed.`;
      break;
    }
    case "catalog.resources_unpaged":
      // This resource-array count is not a complete source/catalog total.
      summary = `${(value.resources as unknown[]).length} metadata item${(value.resources as unknown[]).length === 1 ? "" : "s"}${value.catalog_view === "resource_detail" ? "; use app.explore_data" : ""}`;
      break;
    case "source.rows": case "source.aggregate": {
      const count = (value.data as unknown[]).length;
      const unit = family === "source.rows" ? "rows" : "groups";
      evidence.observation = family === "source.rows" ? "source_rows" : "aggregate_groups";
      evidence.coverage = { scope: "executed_read_query", status: "unknown" };
      evidence.returned = { count, unit };
      evidence.runner_history = "not_inspected";
      evidence.next_step = "use_authorized_status";
      if (Array.isArray(value.subjects) && value.subjects.length) evidence.reference = references();
      summary = `Returned ${count} ${unit} for this reviewed query. These are ${family === "source.rows" ? "business-record" : "authorized aggregate"} observations; this result does not inspect Runner request/approval/queue history. Query completeness is not established; ${family === "source.aggregate" ? "withheld values and omitted groups are not zero or a complete source total" : "the returned count is not a population total"}. ${evidence.reference ? "Opaque references identify scoped lookups subject to their returned expiry and later checks; they prove neither intent, eligibility, approval, execution nor a later snapshot. " : ""}For unassessed work status, use the existing authorized application/operator status surface.`;
      break;
    }
    case "request.semantic": {
      const invocation = record(value.invocation).operation;
      const execution = record(value.lifecycle).execution;
      const approval = record(value.authorization).approval;
      const disposition = record(value.lifecycle).disposition;
      const executionStates = ["not_started", "queued", "in_progress", "retry_wait", "applied", "failed", "unknown"] as const;
      const approvalStates = ["unknown", "pending_human_review", "not_approved", "automatic", "human"] as const;
      const dispositionStates = ["unknown", "reconciliation_required", "closed", "blocked", "open"] as const;
      if (invocation !== "created_request" && invocation !== "returned_existing_request") {
        summary = "This request result has unavailable invocation evidence. Do not infer an effect or global work status.";
        break;
      }
      evidence.observation = "request_lifecycle";
      evidence.coverage = { scope: "one_request", status: "not_applicable" };
      evidence.runner_history = "one_request_only";
      evidence.next_step = "inspect_recorded_status";
      evidence.request = { invocation,
        execution: executionStates.includes(execution as typeof executionStates[number]) ? execution as typeof executionStates[number] : "unknown",
        disposition: dispositionStates.includes(disposition as typeof dispositionStates[number]) ? disposition as typeof dispositionStates[number] : "unknown",
        approval: approvalStates.includes(approval as typeof approvalStates[number]) ? approval as typeof approvalStates[number] : "unknown",
        effect: execution === "applied" && record(value.execution_receipt).verified === true
          && record(value.execution_receipt).status === "applied" && record(value.execution_receipt).source_database_changed === true
          ? "verified_applied" : "not_established" };
      summary = `This observes one recorded request: approval ${evidence.request.approval}; execution ${evidence.request.execution}; disposition ${evidence.request.disposition}. ${invocation === "returned_existing_request" ? "This invocation returns existing work; it does not perform another effect." : "Creating a request does not establish application."} ${evidence.request.effect === "verified_applied" ? "The recorded applied effect has verified receipt evidence." : "No completed effect is established by this summary."} It is not a queue-wide inventory. Follow this request's recorded status and permitted next step; a fresh request_change can create work and is not a harmless status probe.`;
      break;
    }
    case "settings.data": case "settings.actions": case "settings.summary": case "settings.saved": case "settings.replay": {
      evidence.observation = "agent_settings";
      evidence.coverage = { scope: "agent_settings", status: "not_applicable" };
      evidence.runner_history = "not_inspected";
      evidence.next_step = family === "settings.saved" || family === "settings.replay" ? "human_settings_review" : "inspect_contract";
      if (family === "settings.data" || family === "settings.actions") evidence.returned = {
        count: (family === "settings.data" ? value.resources as unknown[] : value.actions as unknown[]).length, unit: "items" };
      summary = `${evidence.returned ? `Returned ${evidence.returned.count} settings metadata items. ` : ""}This observes permitted agent settings${family === "settings.replay" ? " from an existing revision receipt" : ""}, not source business records or Runner work history. A disabled revision or control reference is not activated authority, business approval or execution. Follow the existing settings review step.`;
      break;
    }
    case "actions.unavailable":
      evidence.next_step = "information_unavailable";
      summary = "Current reviewed Action availability is not established here. An empty unavailable catalog is not proof that no actions or pending work exist; ask the operator to inspect reviewed availability.";
      break;
    case "refusal":
      evidence.observation = "operation_refusal";
      evidence.next_step = "follow_refusal";
      summary = "This operation returned a refusal or error, not an empty successful observation. Follow its safe diagnosis; absence, completeness and business-effect outcome cannot be inferred from this error alone.";
      break;
    case "unknown":
      summary = "Observation scope and completeness are not established for this result variant. Use only its explicit supported facts; do not infer absence, approval or a completed effect.";
      break;
    default: {
      const exhaustive: never = family;
      throw new Error(`Unregistered result evidence family: ${exhaustive}`);
    }
  }
  // Place the boundary first in both representations. Ignore any preexisting
  // metadata with these reserved names; it never supplies host evidence.
  const { result_evidence: _oldEvidence, evidence_summary: _oldSummary, ...facts } = value;
  // Relocate this exact duplicate guidance beside the existing metadata-only
  // fields. Custom guidance and every executable/query fact remain untouched.
  if (compactReadGuidance) delete facts.next_action;
  const publishedEvidence: ResultEvidence = family.startsWith("catalog.")
    ? { runner_history: "not_inspected" } : evidence;
  return { result_evidence: publishedEvidence, evidence_summary: summary, ...facts };
}

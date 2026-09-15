export { validClientDutyInventory, type ClientDuty, type ClientDutyInventory } from "./authoring-policy-source.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { validClientDutyInventory, type ClientDuty, type ClientDutyInventory, type PolicyCoverage, type PolicyPassage, type PolicySourceSession } from "./authoring-policy-source.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";

const record = (v: unknown): Record<string, any> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;

/** Host-prepared Action inputs, never the provider's coverage passages or prose.
 * This authoring route selects the existing interactive four-tool contract;
 * it has no reviewed autonomous workload mode. */
export function clientDutyInventory(draft: unknown): ClientDutyInventory {
  const d = record(draft), contract = record(record(record(d?.runner_evidence)?.runtime_contract)?.client_contract);
  const actions: unknown = d?.actions;
  const subjects = Array.isArray(actions) ? actions.map(a => ({ outcome: record(a)?.outcome ?? null,
    subjects: (record(record(a)?.verification)?.resources ?? []).filter((r: any) => r.source?.kind === "subject_ref")
      .map((r: any) => ({ binding: r.binding, resource: r.resource })) })) : undefined;
  const mode = subjects?.length === 0 ? "read_only" : subjects?.length && subjects.every(a => a.subjects.length)
    && (!contract || contract.mode === "interactive_four_tool") ? "interactive_subject_action" : "unresolved";
  const client = typeof contract?.client === "string" ? contract.client : "unselected";
  const duties: ClientDuty[] = mode === "interactive_subject_action" ? ["customer_selection", "status_presentation"] : [];
  return { version: 1, origin: "PRODUCT-CLIENT-CONTRACT", mode, client, duties,
    contract_digest: canonicalJsonDigest({ version: 1, mode, client, subjects: subjects ?? null, duties,
      status_contract: "proposal/approval/queue/applied/refused/failed/unknown", ownership: "explicit_unverified" }) };
}

export function clientDutyAssigned(report: PolicyCoverage, duty: ClientDuty, session?: PolicySourceSession): boolean {
  const inventory = report.client_duties;
  return Boolean(inventory && validClientDutyInventory(inventory) && inventory.duties.includes(duty) && session?.application_assignments?.some(a =>
    a.origin === "PRODUCT-CLIENT-CONTRACT" && a.contract_digest === inventory.contract_digest
    && a.source_digest === report.source_digest && a.draft_digest === report.draft_digest
    && a.owner === "client_application" && a.verified === false && a.obligations.includes(duty)));
}

/** Ownership discharges only an isolated client-duty passage. Extra policy
 * claims must still validate independently, even after ownership is accepted. */
export function isClientDutyPassage(p: PolicyPassage): boolean {
  return (p.disposition === "needs_decision" || p.disposition === "unsupported") && p.responsibility === "application"
    && (p.issue_kind === undefined || p.issue_kind === "missing_configuration" || p.issue_kind === "unsupported_requirement")
    && !p.field_checks?.length && !p.counter_requirements?.length && !p.evidence_checks?.length
    && !p.deployment_prerequisite && !p.source_counter_obligation && !p.source_counter_resolution
    && !p.obligation_assessment && !p.counting_components?.length && !p.counting_resolution
    && Boolean(p.application_obligations?.length) && p.application_obligations!.every(d => d === "customer_selection" || d === "status_presentation")
    && p.draft_paths.length > 0 && p.draft_paths.every(path => p.application_obligations!.some(d =>
      path === `/runner_evidence/runtime_contract/application_obligations/${d}`));
}

export const clientDutyReviewContext = [
  "Selected product/client contract — these baseline duties are not quotations from the attached business policy.",
  "Target selection: the client must establish the intended target and material change. Runner checks scope and eligibility; an ordinary request does not prove the user's intent.",
  "A model-selected reference plus matching model-supplied text establishes consistency, not independent selection. Any stronger confirmation needs an independently controlled, operation-bound source.",
  "Status presentation: use actual host results to distinguish proposed, awaiting approval, approved/queued, applied, refused/failed and unknown. Approval or narration alone is not completion. Keep private refusal details private.",
  "Accepting ownership records planned responsibilities only: implementation, integration assurance and per-operation observations remain unverified. It grants no authority and satisfies no receipt or independent readback.",
];

export async function reviewClientDutyOwnership(input: { report: PolicyCoverage; sources: PolicySourceSession;
  session: Pick<BoundaryReviewInteractiveSession, "chooseOption">; assertCurrent: () => Promise<void> }) {
  const inventory = input.report.client_duties;
  const pending = inventory?.duties.filter(d => !clientDutyAssigned(input.report, d, input.sources)) ?? [];
  const policyPassages = inventory?.mode === "interactive_subject_action" ? [] : input.report.passages.filter(p => isClientDutyPassage(p)
    && !input.sources.application_assignments?.some(a => a.origin === undefined && a.source_digest === input.report.source_digest
      && a.draft_digest === input.report.draft_digest && a.start === p.start && a.end === p.end
      && a.owner === "client_application" && a.verified === false && a.obligations.length === p.application_obligations!.length
      && a.obligations.every(d => p.application_obligations!.includes(d))));
  if ((!pending.length && !policyPassages.length) || !input.session.chooseOption) return [];
  await input.assertCurrent();
  const choice = await input.session.chooseOption("CLIENT INTEGRATION RESPONSIBILITIES", [
    { value: "assign", label: "My client application will handle these responsibilities", detail: "Explicit ownership for the current source and client contract; not verified." },
    { value: "back", label: "Keep this decision pending" },
  ], { initialValue: "back", reviewOnly: true, displayContext: true, context: [...(pending.length ? clientDutyReviewContext : ["Attached-policy client duties: current explicit ownership, not implementation or verification.", ...policyPassages.map(p => p.interpretation)]),
    `Selected client: ${inventory?.client ?? "unresolved"}. Current duties: ${pending.join(", ")}.`,
    ...(input.sources.application_assignments?.length ? ["Previous ownership choices remain in history. They are not acceptance for a changed source or client contract."] : [])] });
  if (choice !== "assign") return [];
  await input.assertCurrent();
  return [...(pending.length ? [{ source_digest: input.report.source_digest, draft_digest: input.report.draft_digest,
    origin: "PRODUCT-CLIENT-CONTRACT" as const, contract_digest: inventory!.contract_digest,
    obligations: pending, assigned_at: new Date().toISOString(), owner: "client_application" as const, verified: false as const }] : []), ...policyPassages.map(p => ({ source_digest: input.report.source_digest, draft_digest: input.report.draft_digest,
      start: p.start, end: p.end, obligations: p.application_obligations!, assigned_at: new Date().toISOString(), owner: "client_application" as const, verified: false as const }))];
}

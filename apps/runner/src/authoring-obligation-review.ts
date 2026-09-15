import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { isDeferredSourceCounterMaintenance, isDeferredSourceReadback, receiptSetupComponentOnly as receiptOnly, type ReviewObligationAssessment, type PolicyPassage, type PolicyTextSnapshot } from "./authoring-policy-source.js";
export { deferredReviewObligation } from "./authoring-policy-source.js";

export const RECEIPT_PATH = "/runner_evidence/runtime_contract/receipts";
const SETUP_PATH = "/runner_evidence/runtime_contract/deployment_prerequisites/runner_execution_setup";
const READBACK_PATH = "/runner_evidence/runtime_contract/application_obligations/independent_source_readback";
const CONFIGURATION_PATH = "/runner_evidence/runtime_contract/receipt_configuration";
function at(draft: unknown, pointer: string): any {
  return pointer.slice(1).split("/").reduce<any>((value, key) => value?.[key.replace(/~1/gu, "/").replace(/~0/gu, "~")], draft);
}
/** Only an explicit receipt-mode requirement can supply this narrow binding.
 * Missing/ambiguous prose never means the default mode or an absent duty.
 * This does not interpret arbitrary delivery, atomicity or durability claims. */
function receiptRequirement(source: PolicyTextSnapshot, p: PolicyPassage): "runner_ledger" | "source_db" | undefined {
  const text = source.text.split(/\r\n|\r|\n/u).slice(p.start - 1, p.end).join("\n");
  const mentions = [...text.matchAll(/\b(runner[-_ ]ledger|source[-_ ]db|source-atomic)\s+receipt\b/giu)];
  if (mentions.length !== 1 || /\b(?:not|never|unless|instead|either|optional)\b/iu.test(text.slice(Math.max(0, mentions[0]!.index! - 45), mentions[0]!.index))) return undefined;
  const prefix = text.slice(0, mentions[0]!.index);
  if (!/\b(?:request|require|requires|required)(?:\s+a)?(?:\s+stored)?\s+$/iu.test(prefix)) return undefined;
  return /^runner/iu.test(mentions[0]![1]!) ? "runner_ledger" : "source_db";
}

/** The configured mode is a different, narrow claim from receipt production.
 * The enclosing provider passage is retained; a pending component below keeps
 * future setup/observation duties visible. No other fields use this proof. */
export function receiptSelectionComponent(p: PolicyPassage, source: PolicyTextSnapshot, draft: unknown): PolicyPassage | undefined {
  if (p.disposition !== "implemented" || p.responsibility !== "runner" || !p.draft_paths.includes(CONFIGURATION_PATH)) return undefined;
  const mode = receiptRequirement(source, p), configuration = at(draft, CONFIGURATION_PATH);
  if (!mode || p.draft_paths.some(path => path !== CONFIGURATION_PATH && path !== RECEIPT_PATH)
    || p.field_checks?.length || p.counter_requirements?.length || p.application_obligations?.length || p.deployment_prerequisite
    || p.source_counter_obligation || p.operator_override || p.evidence_checks?.some(c => !c.path.startsWith(`${CONFIGURATION_PATH}/`))) {
    throw new Error("OBLIGATION_CONFIGURATION_COMPONENT_MIXED: A selected receipt mode comparison must reference only its exact configuration and optional receipt context. Keep effects, conditions and observations separately checked.");
  }
  if (configuration?.status !== "current" || !configuration.modes?.length || configuration.modes.some((entry: { authority: string }) => entry.authority !== mode)) {
    throw new Error("OBLIGATION_RECEIPT_MODE_MISMATCH: The current receipt configuration does not establish the exact source-required mode. Keep this comparison unresolved and use the separate reviewed setup.");
  }
  return { start: p.start, end: p.end, disposition: "needs_decision", responsibility: "deployment", issue_kind: "missing_configuration",
    topic: "Receipt/execution setup", draft_paths: [RECEIPT_PATH],
    interpretation: "HOST-RESOLVED pending component: the configured receipt mode matches the explicit source requirement. Writer/provisioning verification, execution authorization and receipt production remain separate and unverified. The submitted configuration claim is retained separately.",
    next_step: "Continue through execution setup after authority review; an actual receipt and independent source readback still require their applicable later evidence." };
}

/** Recomputed from current host inputs, never deserialized as a provider claim.
 * All three families use the same phase record; their proof requirements differ. */
export function assessReviewObligation(p: PolicyPassage, source: PolicyTextSnapshot, draft: unknown): ReviewObligationAssessment | undefined {
  const selection = receiptSelectionComponent(p, source, draft);
  if (p.disposition === "implemented" && (p.draft_paths.includes(READBACK_PATH)
    || p.draft_paths.includes(RECEIPT_PATH) && receiptRequirement(source, p) && !selection)) {
    throw new Error("OBLIGATION_OBSERVATION_UNESTABLISHED: Receipt capability or selected configuration is not an observed receipt or independent source readback. Keep the applicable exact setup/after-execution duty pending; no observation evidence is supplied by this review.");
  }
  let family: ReviewObligationAssessment["family"], phase: ReviewObligationAssessment["phase"], requirement: string, pointer: string, evidence: unknown;
  let state: ReviewObligationAssessment["state"] = "pending";
  if (p.source_counter_obligation) {
    if (!isDeferredSourceCounterMaintenance(p)) return undefined;
    family = "source_counter_maintenance"; phase = "ongoing_source_operation";
    requirement = p.source_counter_obligation.requirement; pointer = p.source_counter_obligation.path;
    evidence = p.source_counter_resolution; state = "owner_attested_external_assurance_unverified";
  } else if (isDeferredSourceReadback(p)) {
    const contract = at(draft, READBACK_PATH);
    if (contract?.phase !== "after_execution" || contract.verified !== false || contract.receipt_proves_observation !== false || contract.observation_scope !== null) return undefined;
    const clauses = source.text.split(/\r\n|\r|\n/u).slice(p.start - 1, p.end).join("\n").split(/[.;]/u);
    const explicit = clauses.filter(clause => /\bindependent(?:ly)?\b/iu.test(clause) && /\b(?:source|row|readback)\b/iu.test(clause));
    if (!explicit.length || explicit.some(clause => /\b(?:automatically|runtime|transactional|postcondition)\b/iu.test(clause))) return undefined;
    family = "independent_source_readback"; phase = "after_execution"; requirement = "independent_source_readback";
    pointer = READBACK_PATH; evidence = contract;
  } else if (p.draft_paths.includes(RECEIPT_PATH) && p.disposition === "needs_decision") {
    if (!receiptOnly(p)) return undefined;
    const mode = receiptRequirement(source, p), setup = at(draft, SETUP_PATH);
    if (!mode) return undefined;
    if (setup?.supported !== true || setup.stage !== "after_authority_review" || setup.verified !== false
      || !Array.isArray(setup.receipt_modes_supported) || !setup.receipt_modes_supported.includes(mode)) return undefined;
    const configured = at(draft, "/runner_evidence/runtime_contract/receipt_configuration");
    if (configured?.status === "unavailable") return undefined;
    if (configured?.modes?.some((entry: { authority: string }) => entry.authority !== mode)) {
      throw new Error("OBLIGATION_RECEIPT_MODE_MISMATCH: The source receipt requirement differs from current configuration. Use the existing separately reviewed receipt setup; no receipt guarantee was deferred or weakened.");
    }
    // Source-atomic configuration requires exact current evidence. Generic
    // support or a missing store/configuration is never a source receipt proof.
    if (mode === "source_db" && (!configured?.modes?.length || configured.status !== "current")) return undefined;
    family = "receipt_setup"; phase = "after_authority_review"; requirement = mode; pointer = RECEIPT_PATH;
    evidence = { setup, configuration: configured ?? null, actions: at(draft, "/runner_evidence/actions") };
  } else return undefined;
  return { ...(family === "receipt_setup" ? { configuration_digest: at(draft, "/runner_evidence/runtime_contract/receipt_configuration")?.digest ?? null } : {}), origin: "HOST-RESOLVED", family, path: pointer, source_digest: source.digest, requirement, phase, state, verified: false,
    dependencies_digest: canonicalJsonDigest({ source: source.digest, range: [p.start, p.end], family, requirement, pointer, evidence }) };
}

import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { isDeferredSourceCounterMaintenance, isDeferredSourceReadback, receiptSetupComponentOnly as receiptOnly, receiptConfigurationComponentOnly, type ReviewObligationAssessment, type PolicyPassage, type PolicyTextSnapshot } from "./authoring-policy-source.js";
import { CoverageReceiptObservationError, CoverageReceiptReadContextError, CoverageReceiptReadExclusionError, CoverageReceiptConfigurationError, type ReceiptConfigurationFindingReason } from "./authoring-coverage-feedback.js";
export { deferredReviewObligation } from "./authoring-policy-source.js";

export const RECEIPT_PATH = "/runner_evidence/runtime_contract/receipts";
const SETUP_PATH = "/runner_evidence/runtime_contract/deployment_prerequisites/runner_execution_setup";
const READBACK_PATH = "/runner_evidence/runtime_contract/application_obligations/independent_source_readback";
const CONFIGURATION_PATH = "/runner_evidence/runtime_contract/receipt_configuration";
export const RECEIPT_READ_PATH = "/runner_evidence/runtime_contract/receipt_read_exclusion";
function at(draft: unknown, pointer: string): any {
  return pointer.slice(1).split("/").reduce<any>((value, key) => value?.[key.replace(/~1/gu, "/").replace(/~0/gu, "~")], draft);
}
function currentReceiptReadExclusion(draft: unknown): boolean {
  const proof = at(draft, RECEIPT_READ_PATH), read = at(draft, '/read'), configuration = at(draft, CONFIGURATION_PATH);
  return proof?.origin === 'HOST-CONFIGURATION-AND-READ' && proof.scope === 'selected_read_graph' && proof.excluded === true
    && configuration?.status === 'current' && proof.configuration_digest === configuration.digest
    && proof.selected_read_digest === canonicalJsonDigest(read) && proof.graph_digest === canonicalJsonDigest(read?.pack?.resources)
    && proof.generation_lock_fingerprint === read?.generation_lock_fingerprint
    && configuration.modes?.length > 0
    && configuration.modes.every((mode: any) => mode.source === read.source && mode.authority === 'source_db')
    && configuration.source_receipt_destinations?.length > 0
    && configuration.source_receipt_destinations.length === configuration.modes.length
    && configuration.source_receipt_destinations.every((destination: any) => destination.source === read.source
      && /^sha256:[a-f0-9]{64}$/u.test(destination.relation_digest ?? ''))
    && proof.destination_binding_digest === canonicalJsonDigest(configuration.source_receipt_destinations);
}
function isolatedReceiptReadFields(p: PolicyPassage): boolean {
  return p.responsibility === 'runner' && !p.field_checks?.length && !p.counter_requirements?.length
    && !p.application_obligations?.length && !p.deployment_prerequisite && !p.source_counter_obligation && !p.operator_override
    && !p.evidence_checks?.length;
}

/** A bounded correction subcase, not acceptance or a claim about prose meaning.
 * Only known prepared capability/configuration roots may accompany the current
 * exclusion proof. Their actual claims still undergo full replacement validation. */
function isolatableReceiptReadExclusion(p: PolicyPassage, draft: unknown): boolean {
  if (!isolatedReceiptReadFields(p) || p.issue_kind !== 'coverage_link'
    || p.draft_paths.length < 2 || !p.draft_paths.includes(RECEIPT_READ_PATH)
    || new Set(p.draft_paths).size !== p.draft_paths.length
    || !p.draft_paths.some(path => path !== RECEIPT_READ_PATH)) return false;
  const roots = (at(draft, '/actions') ?? []).flatMap((action: any) => {
    const root = `/runner_evidence/actions/${action.outcome.replace(/~/gu, '~0').replace(/\//gu, '~1')}/effect`;
    const effect = at(draft, root);
    return action.effect?.writeback === 'supervised' && effect
      && effect.target_resource === action.effect.target_resource
      && effect.target_binding === action.effect.target_binding
      && effect.operation === action.effect.operation ? [root] : [];
  });
  return p.draft_paths.every(path => path === RECEIPT_READ_PATH || path === CONFIGURATION_PATH || roots.includes(path));
}

/** Host preparation already checks the selected management revision against
 * project/store, metadata and policy binding. Check its exact candidate links
 * again here; the complete evidence digest is rechecked on save and reuse. */
function currentReceiptSelection(source: PolicyTextSnapshot, draft: unknown, mode: string): boolean {
  const configured = at(draft, CONFIGURATION_PATH);
  const actions = at(draft, "/actions")?.filter((a: any) => a.effect?.writeback === "supervised");
  if (!Array.isArray(actions) || !actions.length) return false;
  if (configured?.status === "current" && configured.modes?.length
    && configured.modes.every((e: any) => e.authority === mode && e.source === at(draft, "/read/source"))) return true;
  const intent = configured?.reviewed_intent;
  return intent?.phase === "disabled_authoring" && intent.status === "current" && intent.verified === false
    && intent.outcomes?.length === actions.length
    && new Set(intent.outcomes.map((entry: any) => entry.outcome)).size === actions.length
    && actions.every((action: any) => intent.outcomes.some((entry: any) => entry.selection_current === true
      && entry.mode === mode && entry.outcome === action.outcome && entry.source_digest === source.digest
      && entry.source === at(draft, "/read/source")
      && /^sha256:[a-f0-9]{64}$/u.test(entry.binding_digest ?? "")
      && /^policy:[a-f0-9]{64}$/u.test(entry.revision_id ?? "")
      && entry.read_digest === canonicalJsonDigest(at(draft, "/read"))
      && entry.action_digest === canonicalJsonDigest(action)));
}

/** Prepared configuration is host-built under the governed binding reader.
 * Recheck its local source/candidate links here; persistence/reuse still compare
 * the whole prepared context. This establishes selection, never an observation. */
function receiptSelectionProblem(source: PolicyTextSnapshot, draft: unknown, mode: string | undefined): ReceiptConfigurationFindingReason | undefined {
  if (!mode) return 'source_requirement_unestablished';
  const configured = at(draft, CONFIGURATION_PATH);
  const modes = configured?.modes;
  if (configured?.status === 'current' && Array.isArray(modes) && modes.some((entry: any) => ['runner_ledger', 'source_db'].includes(entry.authority) && entry.authority !== mode)) return 'mode_mismatch';
  if (!currentReceiptSelection(source, draft, mode)) return 'selection_unavailable';
  if (configured.status === 'current') {
    if (!/^sha256:[a-f0-9]{64}$/u.test(configured.digest ?? '')
      || !Array.isArray(modes) || !modes.length
      || new Set(modes.map((entry: any) => entry.source)).size !== modes.length
      || modes.some((entry: any) => entry.authority !== mode || entry.source !== at(draft, '/read/source'))) return 'selection_unavailable';
    if (mode === 'source_db') {
      const destinations = configured.source_receipt_destinations;
      if (!Array.isArray(destinations) || destinations.length !== modes.length
        || destinations.some((entry: any) => entry.source !== at(draft, '/read/source') || !/^sha256:[a-f0-9]{64}$/u.test(entry.relation_digest ?? ''))
        || new Set(destinations.map((entry: any) => entry.source)).size !== destinations.length) return 'selection_unavailable';
      const exclusion = at(draft, RECEIPT_READ_PATH);
      // When supplied, this independent host binding must agree even though
      // exclusion itself does not prove selection or any other receipt fact.
      if (exclusion && (exclusion.configuration_digest !== configured.digest
        || exclusion.destination_binding_digest !== canonicalJsonDigest(destinations)
        || exclusion.selected_read_digest !== canonicalJsonDigest(at(draft, '/read')))) return 'selection_unavailable';
    }
  }
  const snapshot = at(draft, '/runner_evidence/runtime_contract/authoring_lifecycle/current_policy_snapshot');
  if (snapshot && snapshot.digest !== source.digest) return 'selection_unavailable';
  return undefined;
}
function receiptCapabilityRoots(draft: unknown): string[] {
  return (at(draft, '/actions') ?? []).flatMap((action: any, index: number) => {
    const base = `/runner_evidence/actions/${action.outcome.replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
    const effect = at(draft, `${base}/effect`), execution = at(draft, `${base}/execution`);
    return action.effect?.writeback === 'supervised' && effect
      && effect.target_resource === action.effect.target_resource && effect.target_binding === action.effect.target_binding
      && effect.operation === action.effect.operation && execution?.configured_mode === 'direct_sql'
      && execution.activation === 'separate_operator_review'
      ? [`${base}/effect`, `${base}/execution`, `/actions/${index}/effect`] : [];
  });
}
function isolatableReceiptConfiguration(p: PolicyPassage, source: PolicyTextSnapshot, draft: unknown): boolean {
  const mode = receiptRequirement(source, p);
  if (!mode || receiptSelectionProblem(source, draft, mode) || !supportedReceiptSetup(draft, mode)
    || !isolatedReceiptReadFields(p) || p.issue_kind !== 'coverage_link'
    || p.draft_paths.length < 2 || new Set(p.draft_paths).size !== p.draft_paths.length) return false;
  const roots = receiptCapabilityRoots(draft);
  return p.draft_paths.includes(CONFIGURATION_PATH) && p.draft_paths.some(path => roots.includes(path))
    && p.draft_paths.every(path => path === CONFIGURATION_PATH || path === RECEIPT_PATH || roots.includes(path));
}

function supportedReceiptSetup(draft: unknown, mode: string): boolean {
  const setup = at(draft, SETUP_PATH), actions = at(draft, '/actions')?.filter((action: any) => action.effect?.writeback === 'supervised');
  return setup?.supported === true && setup.stage === "after_authority_review" && setup.verified === false
    && Array.isArray(setup.receipt_modes_supported) && setup.receipt_modes_supported.includes(mode)
    && Array.isArray(actions) && actions.length > 0 && Array.isArray(setup.outcomes) && setup.outcomes.length === actions.length
    && new Set(setup.outcomes.map((entry: any) => entry.outcome)).size === actions.length
    && actions.every((action: any) => {
      const execution = at(draft, `/runner_evidence/actions/${action.outcome.replace(/~/gu, '~0').replace(/\//gu, '~1')}/execution`);
      return execution?.configured_mode === 'direct_sql' && setup.outcomes.some((entry: any) => entry.outcome === action.outcome
        && entry.configured_mode === execution.configured_mode);
    });
}

/** A correction, never a successful assessment. Exact typed capability roots
 * can be separated from receipt duties; arbitrary child/observation claims,
 * private/threshold claims and missing source/selection evidence cannot. */
function isolatableReceiptCapability(p: PolicyPassage, source: PolicyTextSnapshot, draft: unknown): boolean {
  const mode = receiptRequirement(source, p);
  if (!mode || !supportedReceiptSetup(draft, mode) || !currentReceiptSelection(source, draft, mode)
    || p.responsibility !== "runner" || p.issue_kind !== "coverage_link"
    || p.field_checks?.length || p.counter_requirements?.length || p.evidence_checks?.length
    || p.application_obligations?.length || p.deployment_prerequisite || p.source_counter_obligation || p.operator_override) return false;
  const configured = at(draft, CONFIGURATION_PATH);
  if (configured?.status === "unavailable" || configured?.modes?.some((e: any) => e.authority !== mode)) return false;
  const roots = receiptCapabilityRoots(draft);
  return !receiptSelectionProblem(source, draft, mode)
    && new Set(p.draft_paths).size === p.draft_paths.length
    && p.draft_paths.includes(RECEIPT_PATH) && p.draft_paths.some(path => roots.includes(path))
    && p.draft_paths.every(path => path === RECEIPT_PATH || path === CONFIGURATION_PATH || roots.includes(path));
}
/** Only an explicit receipt-mode requirement can supply this narrow binding.
 * Missing/ambiguous prose never means the default mode or an absent duty.
 * This does not interpret arbitrary delivery, atomicity or durability claims. */
export function receiptRequirement(source: PolicyTextSnapshot, p: Pick<PolicyPassage, "start" | "end">): "runner_ledger" | "source_db" | undefined {
  const text = source.text.split(/\r\n|\r|\n/u).slice(p.start - 1, p.end).join("\n");
  const mentions = [...text.matchAll(/\b(runner[-_ ]ledger|source[-_ ]db|source-atomic)\s+receipt\b/giu)];
  if (mentions.length !== 1 || /\b(?:not|never|unless|instead|either|optional)\b/iu.test(text.slice(Math.max(0, mentions[0]!.index! - 45), mentions[0]!.index))) return undefined;
  const prefix = text.slice(0, mentions[0]!.index);
  const direct = /\b(?:request|require|requires|required)(?:\s+a)?(?:\s+stored)?\s+$/iu.test(prefix);
  const selected = /\b(?:use|using)(?:\s+the)?(?:\s+(?:existing|local))?\s+$/iu.test(prefix);
  if (!direct && !selected) return undefined;
  if (selected && /["“”]|\b(?:not|never|unless|instead|either|optional)\b/iu.test(prefix.split(/[.;\n]/u).at(-1) ?? "")) return undefined;
  return /^runner/iu.test(mentions[0]![1]!) ? "runner_ledger" : "source_db";
}

/** The configured mode is a different, narrow claim from receipt production.
 * The enclosing provider passage is retained; a pending component below keeps
 * future setup/observation duties visible. No other fields use this proof. */
export function receiptSelectionComponent(p: PolicyPassage, source: PolicyTextSnapshot, draft: unknown): PolicyPassage | undefined {
  if (p.disposition !== "implemented" || p.responsibility !== "runner" || !p.draft_paths.includes(CONFIGURATION_PATH)) return undefined;
  const mode = receiptRequirement(source, p), problem = receiptSelectionProblem(source, draft, mode);
  // Determine evidence independently of the submitted disposition/shape. A
  // conflict or unavailable binding is not a formatting problem, regardless of
  // which pointer is first. The original grouping is still strictly rejected.
  if (problem) throw new CoverageReceiptConfigurationError(problem);
  if (p.draft_paths.some(path => path !== CONFIGURATION_PATH && path !== RECEIPT_PATH)
    || new Set(p.draft_paths).size !== p.draft_paths.length
    || p.field_checks?.length || p.counter_requirements?.length || p.application_obligations?.length || p.deployment_prerequisite
    || p.source_counter_obligation || p.operator_override || p.evidence_checks?.some(c => !c.path.startsWith(`${CONFIGURATION_PATH}/`))) {
    throw new CoverageReceiptConfigurationError(isolatableReceiptConfiguration(p, source, draft)
      ? 'current_selection_mixed_component' : 'component_not_isolatable');
  }
  if (at(draft, CONFIGURATION_PATH)?.status !== 'current') throw new CoverageReceiptConfigurationError('selection_unavailable');
  return { start: p.start, end: p.end, disposition: "needs_decision", responsibility: "deployment", issue_kind: "missing_configuration",
    topic: "Receipt/execution setup", draft_paths: [RECEIPT_PATH],
    interpretation: "HOST-RESOLVED pending component: the configured receipt mode matches the explicit source requirement. Writer/provisioning verification, execution authorization and receipt production remain separate and unverified. The submitted configuration claim is retained separately.",
    next_step: "Continue through execution setup after authority review; an actual receipt and independent source readback still require their applicable later evidence." };
}

/** Recomputed from current host inputs, never deserialized as a provider claim.
 * All three families use the same phase record; their proof requirements differ. */
export function assessReviewObligation(p: PolicyPassage, source: PolicyTextSnapshot, draft: unknown): ReviewObligationAssessment | undefined {
  if (p.disposition === 'implemented' && p.draft_paths.some(path => path === RECEIPT_READ_PATH || path.startsWith(`${RECEIPT_READ_PATH}/`))) {
    if (!currentReceiptReadExclusion(draft)) throw new CoverageReceiptReadExclusionError('proof_unavailable');
    if (!isolatedReceiptReadFields(p) || p.draft_paths.length !== 1 || p.draft_paths[0] !== RECEIPT_READ_PATH) {
      throw new CoverageReceiptReadExclusionError(isolatableReceiptReadExclusion(p, draft)
        ? 'current_proof_mixed_component' : 'component_not_isolatable');
    }
  }
  // No claim is accepted or rewritten here. A narrow alternative exists only
  // with current host proof; the provider must resubmit a complete report.
  if (p.disposition === 'implemented' && isolatedReceiptReadFields(p) && currentReceiptReadExclusion(draft)
    && p.draft_paths.length === 2 && p.draft_paths.includes('/read') && p.draft_paths.includes(RECEIPT_PATH)) {
    throw new CoverageReceiptReadContextError();
  }
  const selection = receiptSelectionComponent(p, source, draft);
  if (p.disposition === "implemented" && (p.draft_paths.includes(READBACK_PATH)
    || p.draft_paths.includes(RECEIPT_PATH) && receiptRequirement(source, p) && !selection)) {
    throw new CoverageReceiptObservationError(isolatableReceiptCapability(p, source, draft));
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
  } else if (receiptOnly(p) || receiptConfigurationComponentOnly(p)) {
    const mode = receiptRequirement(source, p), setup = at(draft, SETUP_PATH);
    if (!mode) return undefined;
    if (setup?.supported !== true || setup.stage !== "after_authority_review" || setup.verified !== false
      || !Array.isArray(setup.receipt_modes_supported) || !setup.receipt_modes_supported.includes(mode)) return undefined;
    const configured = at(draft, "/runner_evidence/runtime_contract/receipt_configuration");
    if (configured?.status === "unavailable") return undefined;
    if (configured?.modes?.some((entry: { authority: string }) => entry.authority !== mode)) {
      throw new CoverageReceiptConfigurationError("mode_mismatch");
    }
    // A configuration pointer is not a global receipt alias. It needs an exact
    // current selection as well as independent required meaning. Submitted
    // paths/prose/disposition are never rewritten.
    if (receiptConfigurationComponentOnly(p) && !currentReceiptSelection(source, draft, mode)) return undefined;
    // Source-atomic configuration requires exact current evidence. Generic
    // support or a missing store/configuration is never a source receipt proof.
    if (mode === "source_db" && (!configured?.modes?.length || configured.status !== "current")) {
      const intent = configured?.reviewed_intent;
      const actions = at(draft, "/actions")?.filter((action: any) => action.effect?.writeback === "supervised");
      if (intent?.phase !== "disabled_authoring" || intent.status !== "current" || intent.verified !== false
        || !Array.isArray(actions) || !actions.length || intent.outcomes?.length !== actions.length
        || new Set(intent.outcomes.map((entry: any) => entry.outcome)).size !== actions.length
        || !actions.every((action: any) => intent.outcomes.some((entry: any) => entry.selection_current === true
          && entry.mode === mode && entry.outcome === action.outcome && entry.source_digest === source.digest
          && entry.read_digest === canonicalJsonDigest(at(draft, "/read"))
          && entry.action_digest === canonicalJsonDigest(action)))) return undefined;
    }
    family = "receipt_setup"; phase = "after_authority_review"; requirement = mode; pointer = RECEIPT_PATH;
    evidence = { setup, configuration: configured ?? null, actions: at(draft, "/runner_evidence/actions") };
  } else return undefined;
  return { ...(family === "receipt_setup" ? { configuration_digest: at(draft, CONFIGURATION_PATH)?.digest ?? null,
    ...(receiptConfigurationComponentOnly(p) ? { association: { kind: "reviewed_receipt_configuration" as const,
      submitted_path: CONFIGURATION_PATH, evidence_digest: canonicalJsonDigest(evidence) } } : {}) } : {}), origin: "HOST-RESOLVED", family, path: pointer, source_digest: source.digest, requirement, phase, state, verified: false,
    dependencies_digest: canonicalJsonDigest({ source: source.digest, range: [p.start, p.end], family, requirement, pointer, evidence }) };
}

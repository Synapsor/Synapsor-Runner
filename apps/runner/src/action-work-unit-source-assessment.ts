import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { ActionWorkUnitSourcePendingError, validateActionWorkUnitAssessment, type ActionWorkUnitContext,
  type ActionWorkUnitFidelityAssessment, type ActionWorkUnitSourceReview } from "./action-authoring-work-unit-contract.js";
import { parseActionWorkUnitCoverageProvenance, type ActionRuleSourceRepairCheckpoint, type ActionWorkUnitCoverageProvenance } from "./action-rule-authoring-checkpoint.js";
import type { ActionRuleCoverageLineage } from "./action-rule-authority.js";
import { activePolicySource, policyTextSnapshot, isDeferredPolicyDeployment, type PolicyCoverage, type PolicyPassage } from "./authoring-policy-source.js";
import { parsePolicyCoverage, collectCoverageFeedback, coverageReferences, referencesReadPolicy } from "./authoring-policy-coverage.js";
import { deferredReviewObligation, assertRequiredReceiptCoupling } from "./authoring-obligation-review.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { prepareRetainedDutyReview, assembleRetainedDutyReview } from "./authoring-retained-duties.js";
import { createCoverageRepairScope, assembleScopedCoverageReplacement } from "./authoring-scoped-correction.js";
import { validateScopedReceiptComponents } from "./authoring-scoped-receipt-components.js";

type Prepared = ReturnType<typeof policyCoverageDraft>;
type Digest = `sha256:${string}`;
export type ActionWorkUnitSourceAssessmentRetention = { previousReport: PolicyCoverage; lineage?: ActionRuleCoverageLineage; coverageAuthorityDigest?: string };
type Retention = ActionWorkUnitSourceAssessmentRetention;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const parts = (p: string) => p.slice(1).split("/").map(s => s.replace(/~1/gu, "/").replace(/~0/gu, "~"));
const escape = (s: string) => s.replace(/~/gu, "~0").replace(/\//gu, "~1");
const unresolved = (p: PolicyPassage) => ["conflict", "needs_decision", "unsupported"].includes(p.disposition);
function changed(): never { throw new ActionWorkUnitSourcePendingError("currentness"); }
function incomplete(): never { throw new ActionWorkUnitSourcePendingError("assessment_incomplete"); }
const at = (v: unknown, path: string[]): unknown => path.reduce<unknown>((value, key) => object(value) || Array.isArray(value)
  ? Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined : undefined, v);

function bindPrepared(context: ActionWorkUnitContext, prepared: Prepared, action: ActionRuleModelDraftV1) {
  const source = activePolicySource(context.policySources);
  if (!source || canonicalJsonDigest(prepared.read) !== canonicalJsonDigest(context.readBoundary)
    || context.readBoundaryDigest !== explorationBoundaryCandidateDigest(context.readBoundary)
    || prepared.actions.filter(a => a.outcome === action.outcome).length !== 1
    || canonicalJsonDigest(prepared.actions.find(a => a.outcome === action.outcome)) !== canonicalJsonDigest(action)) changed();
  if (canonicalJsonDigest(policyTextSnapshot(Buffer.from(source.text, "utf8"), source.name, source.version)) !== canonicalJsonDigest(source)) changed();
  const compiled = compileActionRuleModelDraft({ ...context, draft: action });
  if (canonicalJsonDigest(compiled.draft) !== canonicalJsonDigest(action)) changed();
  const actualBindings = prepared.runner_evidence.actions[action.outcome]?.scoped_bindings;
  const currentBindings = policyCoverageDraft({ read: context.readBoundary, decisions: [], actions: [compiled], policySources: context.policySources })
    .runner_evidence.actions[action.outcome]!.scoped_bindings;
  // Database proof requires the host's actual inspection and remains part of
  // its full prepared-draft identity. The existing factory can independently
  // rederive these compiler/Read/catalog fields without inventing that proof.
  const comparable = (b: NonNullable<typeof actualBindings>[string]) => {
    const { database_scope_proof: _hostProof, ...rest } = b; return rest;
  };
  if (!actualBindings || canonicalJsonDigest(Object.fromEntries(Object.entries(actualBindings).map(([key, value]) => [key, comparable(value)])))
    !== canonicalJsonDigest(Object.fromEntries(Object.entries(currentBindings).map(([key, value]) => [key, comparable(value)])))) changed();
  return source;
}

function parseCurrent(context: ActionWorkUnitContext, prepared: Prepared, args: Record<string, unknown>, retention?: Retention) {
  const source = activePolicySource(context.policySources);
  if (!source) changed();
  const parse = (passages: PolicyPassage[]) => parsePolicyCoverage({ passages }, source, prepared,
    context.policySources?.operator_messages ?? [], context.policySources);
  const report = parsePolicyCoverage(args, source, prepared, context.policySources?.operator_messages ?? [], context.policySources);
  if (!retention) return report;
  if (retention.previousReport.retained_duty_history?.length && !retention.lineage) changed();
  const plan = prepareRetainedDutyReview(retention.previousReport, source, prepared, retention.lineage, retention.coverageAuthorityDigest);
  return assembleRetainedDutyReview(report, plan, source, prepared, parse);
}

export type ActionWorkUnitSourceAssessmentResult = {
  assessment: ActionWorkUnitFidelityAssessment;
  /** Associations in a current interpreted report, never predicate equivalence
   * or complete Source fidelity. All residual obligations stay visible. */
  scope: {
    assurance: "current_interpreted_associations_only";
    whole_source_review_pending: true;
    report_digest: Digest; prepared_draft_digest: Digest;
    current_passage_indexes: number[]; applicable_global_indexes: number[];
    other_action_pending_indexes: number[]; unscoped_pending_indexes: number[];
    read_catalog_pending_indexes: number[]; deferred_indexes: number[];
    caller_reference_pending_bindings: string[];
    subject_meaning_checked: false; predicate_equivalence_checked: false;
  };
};

/** Public canonical-report level. The caller owns actual report provenance,
 * Source consent/ACL/currentness and coordinated persistence. */
export function assessActionWorkUnitSource(input: { context: ActionWorkUnitContext; currentAction: ActionRuleModelDraftV1;
  preparedDraft: Prepared; report: PolicyCoverage; expectedReportDigest: Digest; sourceAnswerHistoryDigest: Digest;
  retention?: Retention; coverageProvenance?: ActionWorkUnitCoverageProvenance }): ActionWorkUnitSourceAssessmentResult {
  const { context, currentAction: action, preparedDraft: prepared } = input;
  const source = bindPrepared(context, prepared, action);
  if (input.report.source_digest !== source.digest || input.report.draft_digest !== canonicalJsonDigest(prepared)
    || input.expectedReportDigest !== canonicalJsonDigest(input.report)
    || input.sourceAnswerHistoryDigest !== canonicalJsonDigest(context.policySources?.operator_messages ?? [])) changed();
  if (input.report.retained_duty_history?.length && !input.retention?.lineage) changed();
  let report: PolicyCoverage;
  try { report = parseCurrent(context, prepared, { passages: input.report.passages }, input.retention); }
  catch (error) { if (error instanceof ActionWorkUnitSourcePendingError) throw error; incomplete(); }
  if (canonicalJsonDigest(report) !== canonicalJsonDigest(input.report)) changed();
  const currentIndex = prepared.actions.findIndex(a => a.outcome === action.outcome);
  const actionOf = (path: string): string | undefined => {
    const p = parts(path);
    if (p[0] === "actions" && /^(?:0|[1-9]\d*)$/u.test(p[1] ?? "")) return prepared.actions[Number(p[1])]?.outcome;
    if (p[0] === "runner_evidence" && p[1] === "actions" && p[2] && Object.hasOwn(prepared.runner_evidence.actions, p[2])) return p[2];
    return undefined;
  };
  const current: number[] = [], global: number[] = [], other: number[] = [], unscoped: number[] = [], roles: number[] = [], deferred: number[] = [];
  const conflicts = { subject: [] as number[], predicate: [] as number[] };
  const editable = { subject: new Set<string>(), predicate: new Set<string>() };
  const bindings = prepared.runner_evidence.actions[action.outcome]?.scoped_bindings ?? {};
  const referencePending = action.verification.resources.filter(binding => binding.source.kind === "subject_ref"
    && context.builtCatalog.authoring.resources.find(r => r.name === binding.resource)?.subject_reference?.obtainable !== true).map(b => b.binding);
  const fieldApplies = (p: PolicyPassage) => p.field_checks?.some(check =>
    Object.values(bindings).some(b => b.resource === check.resource && Object.hasOwn(b.fields, check.field))
    || Object.hasOwn(prepared.runner_evidence.read_access[check.resource]?.fields ?? {}, check.field)) === true;
  for (const [index, passage] of report.passages.entries()) {
    const owners = passage.draft_paths.map(actionOf).filter((v): v is string => !!v);
    const own = owners.includes(action.outcome);
    const broadActions = passage.draft_paths.some(p => p === "/actions" || p === "/runner_evidence/actions");
    const shared = fieldApplies(passage) || referencesReadPolicy(passage)
      || !broadActions && !owners.length && passage.draft_paths.length > 0;
    const later = isDeferredPolicyDeployment(passage) || !!deferredReviewObligation(passage);
    if (own) current.push(index);
    if (shared) global.push(index);
    if (later) deferred.push(index);
    if (unresolved(passage) && !own && !shared && owners.length) other.push(index);
    if (!own && !shared && !owners.length && (unresolved(passage)
      || broadActions && !["background", "overridden"].includes(passage.disposition))) unscoped.push(index);
    if (unresolved(passage) && fieldApplies(passage)) roles.push(index);
    if (!own || passage.disposition !== "conflict" || passage.responsibility !== "runner" || passage.issue_kind !== "contradiction"
      || passage.field_checks?.length || passage.evidence_checks?.length || passage.counter_requirements?.length
      || passage.application_obligations?.length || passage.deployment_prerequisite || passage.receipt_component || passage.source_counter_obligation) continue;
    const nominations = passage.draft_paths.map(path => {
      const p = parts(path);
      if (p[0] !== "actions" || p[1] !== String(currentIndex)) return undefined;
      const local = p.slice(2), value = at(action, local);
      if (local.length === 4 && local[0] === "verification" && local[1] === "resources" && local[3] === "source"
        && /^(?:0|[1-9]\d*)$/u.test(local[2]!)) {
        const binding = action.verification.resources[Number(local[2])];
        const catalog = context.builtCatalog.authoring.resources.find(r => r.name === binding?.resource);
        const evidence = binding && bindings[binding.binding];
        if (!binding || !catalog || typeof catalog.subject_reference?.obtainable !== "boolean" || !evidence
          || evidence.resource !== binding.resource || !object(value)
          || !["subject_ref", "relationship"].includes(value.kind as string)
          || binding.fields.some(field => !catalog.fields.some(f => f.name === field)
            || !Object.hasOwn(evidence.fields, field))) return undefined;
        return { component: "subject" as const, pointer: `/${local.map(escape).join("/")}` };
      }
      // Whole component/root references are context, not an edit nomination.
      if (!(local[0] === "require" && local.length > 1
        || local[0] === "approval" && local[1] === "auto_approve_when" && local.length > 2)
        || !object(value) || !["all", "any", "not", "compare", "null_check", "in", "exists"].includes(value.kind as string)) return undefined;
      return { component: "predicate" as const, pointer: `/${local.map(escape).join("/")}` };
    });
    if (!nominations.length || nominations.some(n => n === undefined)) continue;
    const component = nominations[0]!.component;
    if (nominations.some(n => n!.component !== component)) continue;
    conflicts[component].push(index); nominations.forEach(n => editable[component].add(n!.pointer));
  }
  const scope: ActionWorkUnitSourceAssessmentResult["scope"] = { assurance: "current_interpreted_associations_only", whole_source_review_pending: true,
    report_digest: canonicalJsonDigest(report), prepared_draft_digest: canonicalJsonDigest(prepared), current_passage_indexes: current,
    applicable_global_indexes: global, other_action_pending_indexes: other, unscoped_pending_indexes: unscoped,
    read_catalog_pending_indexes: roles, deferred_indexes: deferred, caller_reference_pending_bindings: referencePending,
    subject_meaning_checked: false, predicate_equivalence_checked: false };
  const review = (indexes: number[]): ActionWorkUnitSourceReview => ({ draft: structuredClone(prepared), report, passage_indexes: indexes,
    source_answer_history_digest: input.sourceAnswerHistoryDigest,
    ...(input.coverageProvenance ? { coverage_provenance: parseActionWorkUnitCoverageProvenance(input.coverageProvenance) } : {}) });
  const component: "subject" | "predicate" | undefined = conflicts.subject.length ? "subject" : conflicts.predicate.length ? "predicate" : undefined;
  if (component) {
    const assessment = { state: "representation_mismatch" as const, component,
      editable_paths: [...editable[component]], source_review: review(conflicts[component]) };
    validateActionWorkUnitAssessment(context, action, assessment);
    return { assessment, scope };
  }
  const relevant = [...new Set([...current, ...global])].filter(i => !deferred.includes(i));
  const pending = relevant.filter(i => unresolved(report.passages[i]!));
  if (pending.some(i => report.passages[i]!.responsibility === "operator"
    && ["business_choice", "schema_meaning"].includes(report.passages[i]!.issue_kind ?? ""))) return { assessment: { state: "owner_meaning_pending" }, scope };
  if (!current.length || pending.length || unscoped.length || referencePending.length) return { assessment: { state: "source_interpretation_pending" }, scope };
  const assessment = { state: "current_registered_requirements_satisfied" as const, source_review: review(relevant) };
  validateActionWorkUnitAssessment(context, action, assessment);
  return { assessment, scope };
}

/** Episode level: hashes and raw captures are re-parsed, not promoted to proof.
 * expectedCoverageContextKey is the real original key returned by the existing
 * ensurePreparedPolicyCoverage path; the host owns its authentic currentness. */
export function reconstructOriginalActionWorkUnitSourceAssessment(input: { context: ActionWorkUnitContext;
  savedRepair: ActionRuleSourceRepairCheckpoint; originalPreparedDraft: Prepared; expectedCoverageContextKey: Digest;
  currentSourceSessionDigest: Digest; episodeIdentity?: { id: string; submission_number: number }; retention?: Retention }) {
  const { context, savedRepair: saved, originalPreparedDraft: prepared } = input;
  const source = bindPrepared(context, prepared, saved.original_parent);
  if (!saved.coverage_provenance) incomplete();
  const provenance = parseActionWorkUnitCoverageProvenance(saved.coverage_provenance);
  if (input.currentSourceSessionDigest !== canonicalJsonDigest(context.policySources)
    || input.expectedCoverageContextKey !== provenance.context_key
    || input.episodeIdentity && (input.episodeIdentity.id !== provenance.episode_id || input.episodeIdentity.submission_number !== provenance.submission_number)) changed();
  if (canonicalJsonDigest(prepared) !== saved.prepared_draft_digest || saved.correction.parent_digest !== canonicalJsonDigest(saved.original_parent)
    || saved.correction.source_answer_history_digest !== canonicalJsonDigest(context.policySources?.operator_messages ?? [])
    || !/^sha256:[a-f0-9]{64}$/u.test(input.expectedCoverageContextKey)) changed();
  const episodes = context.policySources?.coverage_episodes ?? [];
  if (episodes.length > 120 || episodes.some(e => e.submissions.length > 3)) incomplete();
  const matches: Array<{ assessment: Extract<ActionWorkUnitFidelityAssessment, { state: "representation_mismatch" }>; episodeIdentity: { id: string; submission_number: number } }> = [];
  const messages = context.policySources?.operator_messages ?? [];
  const narrow = canonicalJsonDigest({ source: source.digest, draft: prepared, messages });
  const repairContext = { source, draft: prepared, messages };
  for (const episode of episodes) {
    if (episode.context !== input.expectedCoverageContextKey || episode.id !== provenance.episode_id) continue;
    let parent: Record<string, unknown> | undefined, previousError: unknown;
    for (const [index, submission] of episode.submissions.entries()) {
      const tentative = submission.tentative;
      if (submission.number !== index + 1 || !submission.completed_at || !tentative || tentative.context !== narrow
        || tentative.status !== "unaccepted_generation" || !object(tentative.raw_response)) break;
      let candidate = tentative.raw_response;
      try {
        if (candidate.representation === "replacement_only_v2") {
          if (!parent || !previousError || !tentative.scope || JSON.stringify(tentative.raw_parent) !== JSON.stringify(parent)) changed();
          const feedback = collectCoverageFeedback(parent, source, prepared, messages, previousError, context.policySources);
          const scope = createCoverageRepairScope(parent, feedback, repairContext, { ordinaryReferences: coverageReferences(prepared) });
          if (canonicalJsonDigest(scope) !== canonicalJsonDigest(tentative.scope)) changed();
          const assembly = assembleScopedCoverageReplacement(scope, parent, candidate, repairContext);
          if (JSON.stringify(assembly.assembled) !== JSON.stringify(tentative.assembled)
            || canonicalJsonDigest(assembly.audit.host_supplied_fields) !== canonicalJsonDigest(tentative.host_supplied_fields ?? [])) changed();
          validateScopedReceiptComponents(assembly.assembled, assembly.categories, scope, source, prepared, context.policySources);
          assertRequiredReceiptCoupling(assembly.assembled.passages as PolicyPassage[], source, prepared,
            scope.targets.filter(t => t.receipt_region).flatMap(t => t.source_ranges), context.policySources);
          candidate = assembly.assembled;
        } else if (tentative.scope || tentative.raw_parent || tentative.assembled || tentative.host_supplied_fields) changed();
        parent = structuredClone(candidate);
        const report = parseCurrent(context, prepared, candidate, input.retention);
        previousError = undefined;
        if (submission.validated !== true) break; // A valid claim is not a completed accepted episode submission.
        if (submission.number !== provenance.submission_number) break;
        if (canonicalJsonDigest(report) !== saved.correction.interpretation_digest) break;
        const result = assessActionWorkUnitSource({ context, currentAction: saved.original_parent, preparedDraft: prepared, report, retention: input.retention,
          expectedReportDigest: saved.correction.interpretation_digest, sourceAnswerHistoryDigest: saved.correction.source_answer_history_digest,
          coverageProvenance: provenance });
        if (result.assessment.state !== "representation_mismatch") break;
        const checked = validateActionWorkUnitAssessment(context, saved.original_parent, result.assessment);
        if (canonicalJsonDigest(checked.correction) !== canonicalJsonDigest(saved.correction)
          || canonicalJsonDigest(result.assessment.source_review.passage_indexes) !== canonicalJsonDigest(saved.passage_indexes)) break;
        matches.push({ assessment: result.assessment, episodeIdentity: { id: episode.id, submission_number: submission.number } });
        break;
      } catch (error) {
        if (submission.validated === true) break;
        parent = structuredClone(candidate); previousError = error;
      }
    }
  }
  if (matches.length !== 1) incomplete();
  return matches[0]!;
}

import {
  ProposalStore
} from "@synapsor-runner/proposal-store";
import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import {
  canonicalJsonDigest,
  type ActionBoundarySharedLimitV1,
} from "@synapsor-runner/protocol";
import type {
  ActionRuleBooleanExpressionV1,
  ActionRuleScalarExpressionV1,
  ActionRuleScalarTypeSpecV1,
} from "@synapsor/spec";
import {
  databaseGrammarFeatureAvailable,
  databaseServerCompatibility,
  inspectDatabase,
  schemaFingerprintForInspection,
  type SchemaInspection,
} from "@synapsor-runner/schema-inspector";
import crypto from "node:crypto";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { explicitActionExecutionIntent } from "./action-execution-intent.js";
import { prepareActionRuleReadRevision, rebindActionCatalogForReadPolicyRevision, rebuildActionCatalogAfterMetadataRefresh, buildActionCatalogForSavedReadRevision, combineReviewedActionCatalogs,
  rebindActiveActionRuleAuthorityForReadRevision, rebindStoredActionRuleAuthorityDraftForReadRevision } from "./action-rule-read-revision.js";
import { prepareSavedActionRuleRemoval, reviewFinalActionRemoval } from "./action-rule-removal.js";
import { assertJointApprovalLimitsPreserved } from "./action-policy-scope.js";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { reviewActionRevisionImpact } from "./action-revision-impact.js";
import readline from "node:readline/promises";
import {
  EXPLORATION_AUTO_BAND_METHODS,
  EXPLORATION_BUDGET_REVIEW_CEILINGS,
  MAX_AUTO_BAND_BUCKETS,
  MIN_AUTO_BAND_BUCKETS,
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  activateExplorationBoundary,
  explorationBoundaryCandidateDigest,
  loadGenerationLockSnapshot,
  hasReviewedPrincipalScope,
  loadActivatedExplorationBoundary,
  loadActivatedExplorationBoundaries,
  resolveReviewedChildCountLink,
  reviewExplorationBoundaryCandidate,
  type ActivatedExplorationBoundary,
  type ExplorationDerivedBaseMeasure,
  type ExplorationAutoBandLabelStyle,
  type ExplorationAutoBandMethod,
  type ExplorationBoundaryDraft,
  type GenerationLock
} from "./auto-boundary.js";
import { cliCommandName } from "./cli-command-meta.js";
import { fileExists, readJsonFileWithLocation } from "./cli-files.js";
import { shellQuote } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { redactCliErrorMessage } from "./cli-logging.js";
import { assertDatabaseRoleSafeForModelReads } from "./database-role-posture.js";
import { assertKnownOptions, envValue, listArg, optionalArg, positional, repeatedArgs } from "./cli-options.js";
import { readRuntimeConfig } from "./cli-project.js";
import {
  readGuidedOnboardingState,
  reconcileGuidedProjectTrustedContext,
  updateGuidedOnboardingState,
} from "./guided-project.js";
import {
  boundaryReviewDecisions,
  createBoundaryReviewProgress,
  type BoundaryReviewProgress,
} from "./boundary-review-domain.js";
import {
  readBoundaryReviewProgress,
  saveBoundaryReviewProgress,
} from "./boundary-review-persistence.js";
import { assertReadAuthoringBindings, readProjectReadAuthoring, type ReadAuthoringBindings } from "./control-policy-read-authoring-project.js";
import { openProjectControlPolicies } from "./control-policy-store.js";
import { assertGovernedReadActivationDecision, readActivationAlreadyConsumed, readActivationEventId,
  type GovernedReadActivationDecision } from "./control-policy-activation.js";
import { assertGovernedReadEditDecision, readEditAlreadyConsumed, readEditEventId,
  type GovernedReadEditDecision } from "./control-policy-read-edit.js";
import { displayPath } from "./onboarding.js";
import { sharedPostgresLedgerDoctorChecks } from "./doctor-domain.js";
import {
  formatDerivedScopePath,
  formatRelationshipJoinColumns,
  formatRelationshipPath,
} from "./derived-scope-display.js";
import { resolveOperatorIdentity, verifyJwtOperatorProof, verifySignedOperatorProof, type OperatorIdentityConfig } from "./operator-identity.js";
import { resolveSynapsorProject } from "./project-resolution.js";
import {
  exploreModelFacingFieldIds,
  exploreBoundaryVocabularyGaps,
  formatExploreVocabularyCoverage,
} from "./explore-vocabulary.js";
import {
  DEFAULT_TERMINAL_ANTHROPIC_ASK_MODEL,
  DEFAULT_TERMINAL_OPENAI_ASK_MODEL,
} from "./terminal-ask-defaults.js";
import { discoverOpenAiCompatibleModels } from "./openai-compatible-models.js";
import { discoverHostedProviderModels } from "./hosted-provider-models.js";
import { withTerminalProgress } from "./terminal-prompt.js";
import { AskError, type AskProviderDependencies } from "./model-ask.js";
import {
  readModelAuthorityMetadataMode,
  updateModelAuthorityMetadataMode,
} from "./model-output-config.js";
import {
  askIntentCheckModeForBoundary,
  askIntentCheckModesForBoundaries,
  deleteAskIntentCheckPreference,
  renameAskIntentCheckPreference,
  setAskIntentCheckMode,
} from "./ask-intent-preferences.js";
import { disableScopedExplore } from "./protect-query.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import {
  createSavedBoundary,
  discardOnlySavedBoundaryReview,
  deleteSavedBoundary,
  renameSavedBoundary,
  resolveSavedBoundaryReviewAuthority,
  switchSavedBoundary,
  synchronizeBoundaryLibrary,
} from "./boundary-library.js";
import { compileSafeActionDraft, safeActionStatus, SafeActionValidationError, scaffoldSafeAction } from "./safe-action.js";
import {
  activateGuidedAction,
  createGuidedActionDraft,
  guidedActionOptions,
  guidedActionOptionsFromCandidate,
  guidedActionStatus,
  readGuidedActionDraft,
  recordGuidedActionPreview,
  recordGuidedActionStructuralPreview,
  reviseGuidedActionAuthority,
  type GuidedActionAuthorityRevisionInput,
  type GuidedActionInput,
} from "./guided-action.js";
import { executeGuidedActionPreview } from "./guided-action-runtime.js";
import {
  conventionalModelAuthoringSession,
  inspectActionProject,
  renderActionControlPlaneTable,
  runActionControlPlane,
  type ActionModelSuggestionSession,
} from "./action-tui.js";
import {
  createBoundaryAuthoringChat,
  type BoundaryAuthoringChat,
  type BoundaryAuthoringChatFactory,
} from "./boundary-authoring-chat.js";
import {
  createModelAuthoringConversation,
  modelAuthoringHistory,
  rememberModelAuthoringClarification,
  rememberModelAuthoringTurn,
} from "./model-authoring-conversation.js";
import {
  buildBoundaryAuthoringResumeState,
  prepareBoundaryActionRevision,
  clearBoundaryAuthoringResumeState,
  boundaryAuthoringActionIsUnfinished,
  readBoundaryAuthoringResumeState,
  revalidateBoundaryAuthoringResume,
  writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeAction,
  type BoundaryAuthoringActionAddition,
  type BoundaryAuthoringResumeBinding,
  type BoundaryAuthoringResumeRead,
  type BoundaryAuthoringResumeStage,
  type BoundaryAuthoringResumeState,
} from "./boundary-authoring-resume.js";
import { reviewPrivateActionSourceForModel } from "./action-rule-source-consent.js";
import {
  MAX_BOUNDARY_ACTION_INTENT_CHARACTERS,
  MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS,
  MAX_BOUNDARY_READ_QUESTION_CHARACTERS,
} from "./boundary-authoring-limits.js";
import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";
import {
  planModelBoundaryJob,
  type BoundaryJobCurrentState,
  type BoundaryJobPlan,
} from "./boundary-job-model.js";
import {
  interpretPrincipalScopeAnswer,
  type ModelPrincipalScopeOption,
} from "./model-principal-scope-review.js";
import {
  boundaryMapOperationLegend,
  renderBoundaryMapFieldMatrix,
  renderBoundaryMapTable,
  type BoundaryMapFieldRow,
} from "./boundary-map-presentation.js";
import { terminalContentWidth, wrapStyledTerminalLine } from "./terminal-layout.js";
import {
  importActionSuggestion,
  listActionSuggestions,
} from "./action-suggestions.js";
import {
  generateModelActionSuggestion,
  generateModelActionSuggestionSet,
} from "./action-suggestion-model.js";
import {
  buildActionRuleAuthoringCatalog,
  type BuiltActionRuleAuthoringCatalogV1,
} from "./action-rule-authoring.js";
import {
  actionRuleModelDraftFromAuthority,
  compileActionRuleModelDraft,
  type ActionRuleModelDraftV1,
  type CompiledActionRuleModelDraftV1,
} from "./action-rule-draft.js";
import {
  generateModelActionRuleDraft,
  modelActionRuleRevisionFocus,
  type ModelActionRuleDraftResult,
} from "./action-rule-model.js";
import {
  buildActionRuleAuthorityDraft,
  mergeActionRuleAuthorityDraft,
  deactivateActionRuleAuthority,
  loadActiveActionRuleAuthority,
  listActionRuleAuthorityDrafts,
  readActionRuleAuthorityActivation,
  readActionRuleAuthorityDraft,
  readActionRuleAuthorityRevisionBaseline,
  writeActionRuleAuthorityDraftIfCurrent,
  type ActionRuleAuthorityActivationV1,
  type ActionRuleAuthorityDraftV1,
  type ActionRuleAuthorityRevisionBaseline,
} from "./action-rule-authority.js";
import {
  activateSemanticActionRuntime,
  executionReReviewOutcomesForActionActivation,
  inspectDraftSemanticWriter,
  readSemanticSupervisedExecutionState,
} from "./semantic-action-deployment.js";
import { SemanticWriterPostureError, executionSetupProblem } from "./semantic-execution-setup.js";
import { writerProvisioningSql } from "./writer-provisioning.js";
export { reviewVerifiedActionAuthority } from "./verified-action-review.js";
import {
  reviewSemanticSupervisedExecution,
  reviewVerifiedActionAuthority,
  verifiedActionAuthorityDetails,
  verifiedActionAuthoritySections,
} from "./verified-action-review.js";
import { prepareQuickProposalAction } from "./guided-action-quick.js";
import {
  buildDelegationDraft,
  writeDelegationDraft,
  type DelegationModelAssist,
} from "./delegation-setup.js";
import {
  applyJobMappingCatalog,
  loadJobMappingCatalog,
  refreshIncompleteReadMappingRelationships,
} from "./job-mapping-catalog.js";
import {
  generateModelReadWorkload,
  type ModelReadClarificationDecision,
  type ModelReadClarificationRequest,
  type ModelReadValueContextDecision,
  type ModelReadValueRequest,
} from "./read-workload-model.js";
import { ReadWorkloadDraftError, readWorkloadDiagnosticLines, type ReadWorkloadDiagnostic } from "./read-workload-diagnostics.js";
import {
  generateModelReadBoundaryRevision,
  assertVocabularyOnlyReadRevision,
  readBoundaryRevisionCatalog,
  reviewedModelAnalysisOperations,
  type ReadBoundaryFieldExposure,
  type ModelReadBoundaryRevisionResult,
} from "./read-boundary-revision-model.js";
import { parseReadPolicySettings } from "./read-boundary-policy-revision.js";
import { assertReviewedReadRelationshipRetained, reviewReadRelationship, validateReviewedReadRelationship } from "./read-relationship-review.js";
import { readBoundaryReviewSections, readRevisionDiff, reviewSectionLines, loadReadReviewDiff, saveReadReviewDiff, type ReviewSection } from "./read-boundary-review-view.js";
import { readDiscoveryCompatibility, readOptionalExplorationDraft } from "./auto-boundary.js";
import { readDiscoveryConcernLines } from "./read-discovery-compatibility.js";
import { readPrivacyReview, readPrivacySummary, readPrivacyExplanationFacts, type ReadPrivacyReview } from "./read-boundary-privacy-review.js";
import { automaticApprovalBusinessSummary } from "./authoring-business-review.js";
import { authoringClientChoices, authoringClientLabel, authoringClientSetupFacts, isAuthoringClientPlan, type AuthoringClientPlan } from "./authoring-client-plan.js";
import { renderReviewFacts } from "./review-facts.js";
import { renderRunnerResultPanel } from "./runner-result-panel.js";
import { newPolicySourceSession, loadPolicySources, activePolicySource, authoringDestination, savePolicySources, bindPolicyCoverage, recordReadInterpretation, confirmedReadFieldMeanings } from "./authoring-policy-source.js";
import { BoundaryJobPlanningError, planningDiagnosticLines, saveBoundaryJobPlanningDiagnostic } from "./boundary-job-diagnostics.js";
import { installPolicySourceCommands } from "./authoring-policy-source-ui.js";
import { reviewPolicyCoverage, parsePolicyCoverage, policyCoverageSection, policyCoverageSummary, unresolvedPolicyPassages, isMechanicalApprovalCounterPassage, isReadOnlyPolicyPassage, referencesReadPolicy, actionablePolicyRequirements, prioritizePolicyRepairs, type PolicyCoverage } from "./authoring-policy-coverage.js";
import { policyCoverageDraft, policyCoverageActionTargets } from "./authoring-policy-evidence.js";
import { hasReviewedCustomerReadEntry } from "./read-relationship-access.js";
import { knownPolicyPrivacyReductions, policyReviewReadiness, policyReadinessItems } from "./authoring-review-readiness.js";
import { ActionAuthoringReadOnlyRequest } from "./action-rule-model.js";
import {
  READ_WORKLOAD_ANALYSIS_VERSION,
  analyzeReadWorkloadSet,
  buildReadWorkloadPlanCards,
  normalizeReadWorkloadSet,
  rankReadWorkloadPlanCardsForJob,
  recommendReadWorkloadPlanCardsForJob,
  readWorkloadFromPlanCards,
  rehydrateSanitizedReadWorkloadPlan,
  type ReadWorkloadPlanCard,
  type ReadWorkloadSet,
} from "./read-workload-assist.js";
import {
  commitReadWorkloadCandidate,
  prepareReadWorkloadCandidate,
  type ReadWorkloadCandidatePreview,
} from "./read-workload-authoring.js";
import {
  listReadWorkloadAnalyses,
  recordReadWorkloadReview,
  readReadWorkloadAnalysis,
  storeReadWorkloadAnalysis,
  type ReadWorkloadReview,
  type ReadWorkloadView,
} from "./read-workloads.js";
import {
  boundaryReviewRequestsFromDecisionFile,
  parseBoundaryReviewDecisionFile,
} from "./boundary-review-decision-file.js";
import {
  createBoundaryReviewInteractiveSession,
  formatBoundaryOverviewMap,
  formatBoundaryResourceMap,
  terminalTheme,
  type BoundaryAccessNotice,
  type BoundaryFieldTier,
  type BoundaryReviewOverview,
  type BoundaryReviewInteractiveSession,
} from "./boundary-cli-picker.js";
import {
  commitBoundaryReviewMutationBatch,
  commitExactBoundaryCandidateMutation,
  commitBoundaryResourceReviewMutation,
  inspectBoundaryResourceReview,
  listBoundaryResourceReviews,
  prepareBoundaryReviewMutationBatch,
  prepareBoundaryResourceReviewMutation,
  reviewedBoundaryFieldTier,
  type BoundaryResourceReviewView,
  type BoundaryResourceReviewRequest,
  type BoundaryReviewMutationBatchPreview,
  type BoundaryExactCandidateMutationPreview,
  type BoundaryReviewMutationBindings,
  type BoundaryReviewMutationPreview,
} from "./boundary-review-mutation.js";
import { prepareReadPrerequisiteRevision } from "./read-prerequisite-revision.js";
import { reviewReadPrerequisiteMetadata, reviewReadPrerequisiteSelection } from "./read-prerequisite-consent.js";
import { generateModelReadPrerequisite, validateReadPrerequisiteBusinessAnswer } from "./read-prerequisite-model.js";

const REVIEWED_SHAPE_LIMIT_FLAGS = [
  ["--max-rows", "max_rows"],
  ["--max-groups", "max_groups"],
  ["--max-top-n", "max_top_n"],
  ["--max-response-cells", "max_response_cells"],
  ["--max-response-bytes", "max_response_bytes"],
  ["--statement-timeout-ms", "statement_timeout_ms"],
  ["--max-measures", "max_measures"],
  ["--max-dimensions", "max_dimensions"],
  ["--max-derived-scope-hops", "max_derived_scope_hops"],
  ["--max-analysis-relationship-hops", "max_analysis_relationship_hops"],
] as const;


type BoundaryReviewBundle = {
  schema_version: "synapsor.boundary-review-bundle.v1";
  candidate_digest: `sha256:${string}`;
  bundle_digest: `sha256:${string}`;
  activation: "disabled_unreviewed";
  mutation_bindings: BoundaryReviewMutationBindings;
  authority: {
    source: string;
    deployment_profile: "development" | "staging" | "production";
    compiler_version: string;
    spec_version: string;
    generation_lock_fingerprint: `sha256:${string}`;
    schema_fingerprint: `sha256:${string}`;
    role_posture_fingerprint: `sha256:${string}`;
    environment: string;
    budgets: ExplorationBoundaryDraft["budgets"];
  };
  decisions: Array<ReturnType<typeof boundaryReviewDecisions>[number] & { confirmed: boolean }>;
  outstanding_decision_ids: string[];
  candidate: ExplorationBoundaryDraft;
};

export type BoundaryActivationHandoff = (input: {
  projectRoot: string;
  boundaryName: string;
  boundaryDigest: `sha256:${string}`;
}) => Promise<number>;

export type BoundaryModelDiscoveryDependencies = {
  discoverModels?: typeof discoverOpenAiCompatibleModels;
  discoverHostedModels?: typeof discoverHostedProviderModels;
  env?: NodeJS.ProcessEnv;
};

export type BoundaryReviewCommandOptions = {
  clientSetup?: (projectRoot: string) => Promise<number>;
  activationReviewNotice?: (input: {
    projectRoot: string;
    boundaryName: string;
    boundaryDigest: `sha256:${string}`;
  }) => string;
  startAtBoundaryList?: boolean;
  /** Reuses the already-consented Ask model without persisting its credential. */
  modelAuthoringSession?: ActionModelSuggestionSession;
  modelReadWorkloadGenerator?: typeof generateModelReadWorkload;
  modelReadBoundaryRevisionGenerator?: typeof generateModelReadBoundaryRevision;
  modelBoundaryJobPlanner?: typeof planModelBoundaryJob;
  modelActionSuggestionGenerator?: typeof generateModelActionSuggestion;
  modelActionSuggestionSetGenerator?: typeof generateModelActionSuggestionSet;
  modelActionRuleGenerator?: typeof generateModelActionRuleDraft;
  modelAuthoringNarrator?: typeof narrateValidatedAuthoringStep;
  modelPrincipalScopeInterpreter?: typeof interpretPrincipalScopeAnswer;
  modelDiscovery?: BoundaryModelDiscoveryDependencies;
  actionProjectInspector?: typeof inspectActionProject;
  runDelegationActionReview?: typeof runActionControlPlane;
  /** Overrides the persistent model-assisted authoring surface in tests or embedded clients. */
  boundaryAuthoringChatFactory?: BoundaryAuthoringChatFactory;
  /** Opens the one-job Read + Action Boundary setup before the schema editor. */
  startWithAgentJob?: boolean;
  /** Internal navigation from an existing review; does not start another job. */
  initialSavedReadRevision?: boolean;
  /** Returns after that one model-guided job instead of opening the Boundary list. */
  exitAfterAgentJob?: boolean;
};

export async function boundaryAssistCommand(
  args: string[],
  schemaInspector: typeof inspectDatabase = inspectDatabase,
): Promise<number> {
  const allowed = new Set([
    "--project-root", "--workload", "--intent", "--analysis", "--list",
    "--provider", "--model", "--api-key-env", "--base-url",
    "--acknowledge-structural-metadata-egress", "--actor", "--reason",
    "--apply", "--confirm", "--json",
  ]);
  assertKnownOptions(args, allowed, "boundary assist");
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const context = await loadBoundaryReviewContext(projectRoot);
  if (args.includes("--list")) {
    if (args.some((arg) => ["--workload", "--intent", "--analysis", "--apply"].includes(arg))) {
      throw new Error("boundary assist --list cannot be combined with workload creation or application flags.");
    }
    const workloads = await listReadWorkloadAnalyses({
      projectRoot,
      generatedBoundary: context.draft,
    });
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ok: true, workloads }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatReadWorkloadList(workloads)}\n`);
    }
    return 0;
  }

  const workloadPath = optionalArg(args, "--workload");
  const intentPath = optionalArg(args, "--intent");
  const analysisId = optionalArg(args, "--analysis");
  const selectedInputs = [workloadPath, intentPath, analysisId].filter(Boolean);
  if (selectedInputs.length !== 1) {
    throw new Error(
      "boundary assist requires exactly one of --workload <exact-plan.json>, --intent <questions.json>, or --analysis <rw_id>. Use --list to inspect saved analyses.",
    );
  }

  let workload: ReadWorkloadView;
  if (analysisId) {
    workload = await readReadWorkloadAnalysis({
      projectRoot,
      analysisId,
      generatedBoundary: context.draft,
    });
  } else if (workloadPath) {
    const exact = normalizeReadWorkloadSet(
      await readJsonFileWithLocation<unknown>(path.resolve(workloadPath), "read workload"),
    );
    if (exact.source?.kind !== "operator_exact_plan" && exact.source?.kind !== "plan_playground") {
      throw new Error("Exact workload import must declare source.kind=operator_exact_plan or plan_playground.");
    }
    const analysis = analyzeReadWorkloadSet({
      workload: exact,
      generatedBoundary: context.draft,
    });
    workload = await storeReadWorkloadAnalysis({
      projectRoot,
      generatedBoundary: context.draft,
      source: exact.source,
      analysis,
    });
  } else {
    const intent = parseReadWorkloadIntent(
      await readJsonFileWithLocation<unknown>(path.resolve(intentPath!), "read workload intent"),
    );
    const provider = optionalArg(args, "--provider");
    if (provider !== "openai" && provider !== "anthropic" && provider !== "openrouter" && provider !== "openai_compatible") {
      throw new Error("Model-assisted boundary assist requires --provider openai, anthropic, openrouter, or openai_compatible.");
    }
    const defaultModel = defaultHostedModel(provider);
    const mapped = await generateModelReadWorkload({
      name: intent.name,
      allowedQuestions: intent.allowed_questions,
      forbiddenQuestions: intent.forbidden_questions,
      provider,
      model: optionalArg(args, "--model") ?? defaultModel,
      generatedBoundary: context.draft,
      ...(optionalArg(args, "--api-key-env") ? { apiKeyEnv: optionalArg(args, "--api-key-env") } : {}),
      ...(optionalArg(args, "--base-url") ? { baseUrl: optionalArg(args, "--base-url") } : {}),
      egressAcknowledged: args.includes("--acknowledge-structural-metadata-egress"),
    });
    workload = await storeReadWorkloadAnalysis({
      projectRoot,
      generatedBoundary: context.draft,
      source: mapped.workload.source!,
      analysis: mapped.analysis,
    });
  }

  let preview: ReadWorkloadCandidatePreview | undefined;
  const actor = optionalArg(args, "--actor");
  const reason = optionalArg(args, "--reason");
  if (Boolean(actor) !== Boolean(reason)) {
    throw new Error("An actionable Boundary Assist preview requires both --actor <human> and --reason <concrete-review-reason>.");
  }
  if (workload.state === "ready" && actor && reason) {
    preview = await prepareReadWorkloadCandidate({
      projectRoot,
      workload,
      actor,
      reason,
      expectedBindings: context.bundle.mutation_bindings,
      schemaInspector,
    });
  }
  const output = {
    ok: workload.state === "ready",
    workload,
    ...(preview ? {
      preview: {
        decision_digest: preview.mutation.decision_digest,
        candidate_digest: preview.mutation.candidate_digest,
        semantic_diff: preview.mutation.semantic_diff,
        authority_activated: false,
        source_database_changed: false,
      },
    } : {}),
  };
  if (!args.includes("--apply")) {
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else process.stdout.write(`${formatReadWorkloadPreview(workload, preview)}\n`);
    return workload.state === "ready" ? 0 : 2;
  }
  if (!preview) {
    throw new Error("READ_WORKLOAD_BLOCKED: resolve every listed blocker before creating a boundary revision.");
  }
  if (!actor || !reason) {
    throw new Error("Applying a workload candidate requires --actor <human> and --reason <concrete-review-reason>.");
  }
  const expectedConfirmation = `APPLY WORKLOAD ${preview.mutation.decision_digest}`;
  if (optionalArg(args, "--confirm") !== expectedConfirmation) {
    throw new Error(
      `No boundary revision was saved. Re-run with --confirm ${shellQuote(expectedConfirmation)} after reviewing the preview.`,
    );
  }
  const committed = await commitReadWorkloadCandidate({ projectRoot, preview });
  const applied = {
    ok: true,
    analysis_id: workload.analysis_id,
    candidate_digest: committed.candidate_digest,
    review_revision: committed.review_revision,
    authority_activated: false,
    source_query_executed: false,
    explore_budget_consumed: false,
    source_database_changed: false,
    next: `${cliCommandName()} boundary review --project-root ${displayPath(projectRoot)}`,
  };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(applied, null, 2)}\n`);
  else {
    const theme = terminalTheme(process.stdout.isTTY && !process.env.NO_COLOR);
    process.stdout.write([
      theme.success("READ BOUNDARY CANDIDATE SAVED"),
      `Workload: ${workload.analysis.workload_name}`,
      `Coverage: ${workload.analysis.coverage.allowed_supported}/${workload.analysis.coverage.allowed_total} allowed; `
        + `${workload.analysis.coverage.forbidden_denied}/${workload.analysis.coverage.forbidden_total} forbidden examples denied`,
      "Status: disabled review revision; agent authority is unchanged.",
      "Source query executed: no | Explore budget consumed: no | Source database changed: no",
      `Next: review the focused decisions with ${applied.next}, then activate the exact boundary explicitly.`,
      "After read activation, run the existing Action Assist flow only for proposal capabilities this agent needs.",
      "",
    ].join("\n"));
  }
  return 0;
}

function textCharacterCount(value: string): number {
  return Array.from(value).length;
}

function parseReadWorkloadIntent(value: unknown): {
  name: string;
  allowed_questions: string[];
  forbidden_questions: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Read workload intent must be one JSON object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const unknown = keys.filter((key) => !["name", "allowed_questions", "forbidden_questions"].includes(key));
  if (unknown.length) throw new Error(`Read workload intent contains unknown key ${unknown[0]}.`);
  if (typeof record.name !== "string" || !record.name.trim() || record.name.trim().length > 80) {
    throw new Error("Read workload intent requires name with 1-80 characters.");
  }
  const questions = (key: "allowed_questions" | "forbidden_questions", required: boolean) => {
    const values = record[key];
    if (!Array.isArray(values) || (required && values.length < 1) || values.length > 40
      || values.some((item) => typeof item !== "string"
        || !item.trim()
        || textCharacterCount(item.trim()) > MAX_BOUNDARY_READ_QUESTION_CHARACTERS)) {
      throw new Error(
        `${key} must contain ${required ? "1-40" : "0-40"} questions of at most `
        + `${MAX_BOUNDARY_READ_QUESTION_CHARACTERS} characters.`,
      );
    }
    return values.map((item) => (item as string).trim());
  };
  return {
    name: record.name.trim(),
    allowed_questions: questions("allowed_questions", true),
    forbidden_questions: questions("forbidden_questions", false),
  };
}

function formatReadWorkloadList(workloads: ReadWorkloadView[]): string {
  if (!workloads.length) {
    return [
      "BOUNDARY ASSIST WORKLOADS",
      "No workload analyses are stored for this project.",
      `Create one with ${cliCommandName()} boundary assist --workload <exact-plan.json>.`,
    ].join("\n");
  }
  return [
    "BOUNDARY ASSIST WORKLOADS",
    ...workloads.map((workload) =>
      `${workload.analysis_id}  ${workload.state.toUpperCase().padEnd(8)}  ${workload.analysis.workload_name}  `
      + `${workload.analysis.coverage.allowed_supported}/${workload.analysis.coverage.allowed_total} allowed`),
  ].join("\n");
}

function formatReadWorkloadPreview(
  workload: ReadWorkloadView,
  preview?: ReadWorkloadCandidatePreview,
): string {
  const analysis = workload.analysis;
  const lines = [
    "BOUNDARY ASSIST - READ WORKLOAD",
    `Workload: ${analysis.workload_name}`,
    `Analysis: ${workload.analysis_id} (${workload.state})`,
    `Coverage: ${analysis.coverage.allowed_supported}/${analysis.coverage.allowed_total} allowed questions supported`,
    `Deny tests: ${analysis.coverage.forbidden_denied}/${analysis.coverage.forbidden_total} exact forbidden plans denied`,
    `Candidate: ${analysis.exposure.candidate_resources} resources | ${analysis.exposure.candidate_return_fields} return fields | `
      + `${analysis.exposure.candidate_operation_fields} operation fields | ${analysis.exposure.candidate_relationships} relationships`,
    "Agent authority: disabled | Source query: no | Explore budget: no | Source database changed: no",
  ];
  if (analysis.blockers.length) {
    lines.push("", "BLOCKERS", ...analysis.blockers.map((blocker) => `  - ${blocker}`));
  }
  if (preview) {
    const confirmation = `APPLY WORKLOAD ${preview.mutation.decision_digest}`;
    lines.push(
      "",
      "This replaces only the selected disabled boundary draft. Existing active boundaries remain unchanged.",
      `Save disabled revision: ${cliCommandName()} boundary assist --analysis ${workload.analysis_id} --apply --actor <human> --reason <reason> --confirm ${shellQuote(confirmation)}`,
      "Activation remains a separate human decision.",
    );
  } else if (workload.state === "ready") {
    lines.push(
      "",
      `Prepare the digest-bound disabled revision: ${cliCommandName()} boundary assist --analysis ${workload.analysis_id} --actor <human> --reason <reason>`,
      "Runner will recheck current schema and trusted authority before showing the exact apply phrase.",
    );
  }
  return lines.join("\n");
}

type ProductionActivationReadiness = {
  ready: boolean;
  config_valid: boolean;
  shared_ledger_initialized: boolean;
  config_path?: string;
};

type BoundaryActivateCommandOptions = {
  inspectProductionReadiness?: (input: {
    args: string[];
    projectRoot: string;
  }) => Promise<ProductionActivationReadiness>;
};

export async function boundaryRenameCommand(args: string[]): Promise<number> {
  assertKnownOptions(
    args,
    new Set(["--project-root", "--to", "--actor", "--reason", "--json"]),
    "boundary rename",
  );
  const currentName = positional(args, 0)?.trim();
  const newName = optionalArg(args, "--to")?.trim().toLowerCase();
  const actor = optionalArg(args, "--actor")?.trim();
  const reason = optionalArg(args, "--reason")?.trim();
  if (!currentName || !newName) {
    throw new Error("boundary rename requires <current-name> --to <new-name>.");
  }
  if (!actor || !reason) {
    throw new Error("Renaming a disabled boundary requires --actor <human> and --reason <review-reason>.");
  }
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  let context = await loadBoundaryReviewContext(projectRoot);
  await synchronizeBoundaryLibrary({
    expectedAuthoring: context.bundle.mutation_bindings.authoring,
    projectRoot,
    draft: context.draft,
    currentCandidate: context.candidate,
    ...(context.progress ? { currentProgress: context.progress } : {}),
  });
  if (context.candidate.pack.name !== currentName) {
    await switchSavedBoundary({
      expectedAuthoring: context.bundle.mutation_bindings.authoring,
      projectRoot,
      draft: context.draft,
      currentCandidate: context.candidate,
      ...(context.progress ? { currentProgress: context.progress } : {}),
      name: currentName,
    });
    context = await loadBoundaryReviewContext(projectRoot);
  }
  const progress = await renameSavedBoundary({
    expectedAuthoring: context.bundle.mutation_bindings.authoring,
    projectRoot,
    draft: context.draft,
    currentCandidate: context.candidate,
    ...(context.progress ? { currentProgress: context.progress } : {}),
    name: currentName,
    newName,
    actor,
    reason,
  });
  await renameAskIntentCheckPreference({
    projectRoot,
    previousName: currentName,
    nextName: newName,
  });
  const payload = {
    ok: true,
    previous_name: currentName,
    name: progress.candidate.pack.name,
    state: "disabled",
    table_count: progress.candidate.pack.resources.length,
    authority_activated: false,
    source_database_changed: false,
  };
  process.stdout.write(args.includes("--json")
    ? `${JSON.stringify(payload, null, 2)}\n`
    : [
      `Renamed disabled boundary "${currentName}" to "${payload.name}".`,
      `Tables retained: ${payload.table_count}`,
      "Authority activated: no",
      "Source database changed: no",
      `Next: ${cliCommandName()} boundary review`,
      "",
    ].join("\n"));
  return 0;
}

export async function boundaryDeleteCommand(
  args: string[],
  session?: Pick<BoundaryReviewInteractiveSession, "confirm">,
): Promise<number> {
  assertKnownOptions(
    args,
    new Set(["--project-root", "--yes", "--json", "--discard-curated-review"]),
    "boundary delete",
  );
  const name = positional(args, 0)?.trim();
  if (!name) throw new Error("boundary delete requires <disabled-boundary-name>.");
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const discardCuratedReview = args.includes("--discard-curated-review");
  if (!args.includes("--yes")) {
    const interactive = session ?? (process.stdin.isTTY && process.stdout.isTTY
      ? createBoundaryReviewInteractiveSession()
      : undefined);
    if (!interactive) {
      throw new Error("boundary delete requires --yes outside an interactive terminal.");
    }
    const question = discardCuratedReview
      ? `Discard every curated review decision for the only saved boundary "${name}"? Config, ledger, evidence, and source data remain.`
      : `Delete saved disabled boundary "${name}"?`;
    if (!await interactive.confirm(question, { defaultValue: false })) {
      process.stdout.write("Boundary deletion cancelled. Nothing changed.\n");
      return 0;
    }
  }
  const context = await loadBoundaryReviewContext(projectRoot);
  await synchronizeBoundaryLibrary({
    expectedAuthoring: context.bundle.mutation_bindings.authoring,
    projectRoot,
    draft: context.draft,
    currentCandidate: context.candidate,
    ...(context.progress ? { currentProgress: context.progress } : {}),
  });
  if (discardCuratedReview) {
    const discarded = await discardOnlySavedBoundaryReview({
      expectedAuthoring: context.bundle.mutation_bindings.authoring,
      projectRoot,
      boundaryRoot: context.boundaryRoot,
      draft: context.draft,
      currentCandidate: context.candidate,
      ...(context.progress ? { currentProgress: context.progress } : {}),
      name,
    });
    await deleteAskIntentCheckPreference(projectRoot, name);
    const next = `${cliCommandName()} boundary draft --from-env ${context.lock.source_env} --project-root ${shellQuote(displayPath(projectRoot))}`;
    const payload = {
      ok: true,
      discarded_curated_review: true,
      deleted: name,
      removed_managed_paths: discarded.removed,
      preserved: ["runner config", "local ledger and evidence", "source database"],
      authority_activated: false,
      source_database_changed: false,
      next,
    };
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(payload, null, 2)}\n`
      : [
        `Discarded curated review for disabled boundary "${name}".`,
        "Preserved: Runner config, local ledger and evidence, and source database.",
        "Authority activated: no",
        "Source database changed: no",
        `Next: ${next}`,
        "",
      ].join("\n"));
    return 0;
  }
  const deleted = await deleteSavedBoundary({
    expectedAuthoring: context.bundle.mutation_bindings.authoring,
    projectRoot,
    draft: context.draft,
    currentCandidate: context.candidate,
    ...(context.progress ? { currentProgress: context.progress } : {}),
    name,
  });
  await deleteAskIntentCheckPreference(projectRoot, name);
  const payload = {
    ok: true,
    deleted: name,
    selected_boundary: deleted.selected_name,
    authority_activated: false,
    source_database_changed: false,
  };
  process.stdout.write(args.includes("--json")
    ? `${JSON.stringify(payload, null, 2)}\n`
    : [
      `Deleted saved disabled boundary "${name}".`,
      `Selected boundary: ${deleted.selected_name}`,
      "Active reviewed boundaries were unchanged.",
      "Source database changed: no",
      "",
    ].join("\n"));
  return 0;
}


export async function boundaryReviewCommand(
  args: string[],
  schemaInspector: typeof inspectDatabase = inspectDatabase,
  interactiveSession?: BoundaryReviewInteractiveSession,
  activationHandoff?: BoundaryActivationHandoff,
  options: BoundaryReviewCommandOptions = {},
): Promise<number> {
  if (args.includes("--apply-decisions")) {
    return boundaryDecisionFileCommand(args, schemaInspector);
  }
  if (args[0] === "resource") {
    return boundaryResourceReviewCommand(
      args.slice(1),
      schemaInspector,
      interactiveSession,
      activationHandoff,
      options,
    );
  }
  assertKnownOptions(
    args,
    new Set(["--project-root", "--output", "--json", "--confirm", "--actor", "--map", "--all", "--details", "--access", "--job-first"]),
    "boundary review",
  );
  if (args.includes("--all") && !args.includes("--map")) {
    throw new Error("Boundary review --all is available only with --map.");
  }
  if (args.includes("--details") && !args.includes("--map")) {
    throw new Error("Boundary review --details is available only with --map.");
  }
  if (args.includes("--details") && !args.includes("--all")) {
    throw new Error(
      "Boundary review --details requires --map --all. For one table, use boundary review resource <table> --map --details.",
    );
  }
  if (args.includes("--confirm") && args.includes("--json")) {
    throw new Error("Interactive boundary review cannot use --json; confirm decisions in a terminal, then export JSON.");
  }
  if (args.includes("--access")
    && (args.includes("--json")
      || args.includes("--confirm")
      || args.includes("--map")
      || args.includes("--all")
      || optionalArg(args, "--output") !== undefined)) {
    throw new Error(
      "The focused boundary access editor cannot be combined with JSON, map, confirmation, or output options.",
    );
  }
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  if (args.includes("--map")) {
    if (args.includes("--json") || args.includes("--confirm") || optionalArg(args, "--output")) {
      throw new Error(
        "Boundary overview --map is human-readable inspection and cannot be combined with JSON, confirmation, or output-file options.",
      );
    }
    process.stdout.write(formatBoundaryOverviewMap(
      await listBoundaryResourceReviews(projectRoot),
      {
        color: process.stdout.isTTY,
        exhaustive: args.includes("--all"),
        details: args.includes("--details"),
        commandName: cliCommandName(),
      },
    ));
    return 0;
  }
  const explicitSummaryOutput = args.includes("--json")
    || optionalArg(args, "--output") !== undefined
    || args.includes("--confirm");
  if (!explicitSummaryOutput) {
    const session = interactiveSession
      ?? (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY
        ? createBoundaryReviewInteractiveSession()
        : undefined);
    if (!session) {
      process.stdout.write(formatBoundaryOverviewMap(
        await listBoundaryResourceReviews(projectRoot),
        {
          color: false,
          exhaustive: false,
          commandName: cliCommandName(),
        },
      ));
      return 0;
    }
    return interactiveBoundaryReviewLoop({
      projectRoot,
      schemaInspector,
      session,
      activationHandoff,
      activationReviewNotice: options.activationReviewNotice,
      clientSetup: options.clientSetup,
      initialView: args.includes("--access") ? "access" : "boundaries",
      startAtBoundaryList: options.startAtBoundaryList,
      modelAuthoringSession: options.modelAuthoringSession,
      modelReadWorkloadGenerator: options.modelReadWorkloadGenerator,
      modelReadBoundaryRevisionGenerator: options.modelReadBoundaryRevisionGenerator,
      modelBoundaryJobPlanner: options.modelBoundaryJobPlanner,
      modelActionSuggestionGenerator: options.modelActionSuggestionGenerator,
      modelActionSuggestionSetGenerator: options.modelActionSuggestionSetGenerator,
      modelActionRuleGenerator: options.modelActionRuleGenerator,
      modelAuthoringNarrator: options.modelAuthoringNarrator,
      modelPrincipalScopeInterpreter: options.modelPrincipalScopeInterpreter,
      modelDiscovery: options.modelDiscovery,
      actionProjectInspector: options.actionProjectInspector,
      runDelegationActionReview: options.runDelegationActionReview,
      boundaryAuthoringChatFactory: options.boundaryAuthoringChatFactory,
      startWithAgentJob: options.startWithAgentJob ?? args.includes("--job-first"),
      initialSavedReadRevision: options.initialSavedReadRevision,
      exitAfterAgentJob: options.exitAfterAgentJob,
    });
  }
  let context = await loadBoundaryReviewContext(projectRoot);
  let reviewActor: string | undefined;
  let reviewSession: BoundaryReviewInteractiveSession | undefined;
  if (args.includes("--confirm")) {
    if (!interactiveSession && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      throw new Error(
        "Interactive boundary review requires a real terminal. For automation, export a review bundle and use boundary activate --headless with a verified signed_key or jwt_oidc identity.",
      );
    }
    reviewSession = interactiveSession ?? createBoundaryReviewInteractiveSession();
    const reviewed = await confirmBoundaryReviewInteractively({
      projectRoot,
      context,
      session: reviewSession,
      actor: optionalArg(args, "--actor")?.trim(),
    });
    context = reviewed.context;
    reviewActor = reviewed.actor;
  }

  const output = optionalArg(args, "--output");
  if (output) {
    const outputPath = path.resolve(output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(context.bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`Wrote deterministic boundary review bundle: ${displayPath(outputPath)}\n`);
  }
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(context.bundle, null, 2)}\n`);
  } else if ((!output || args.includes("--confirm"))
    && !(args.includes("--confirm")
      && !output
      && context.bundle.outstanding_decision_ids.length === 0)) {
    process.stdout.write(await formatBoundaryReviewSummary(context.bundle, projectRoot));
  }
  if (args.includes("--confirm")
    && !output
    && context.bundle.outstanding_decision_ids.length === 0) {
    return boundaryActivateCommand(
      [
        "--project-root", projectRoot,
        ...(reviewActor ? ["--actor", reviewActor] : []),
      ],
      schemaInspector,
      reviewSession,
      activationHandoff,
    );
  }
  return 0;
}

export async function boundaryDisableCommand(
  args: string[],
  interactiveSession?: BoundaryReviewInteractiveSession,
  options: { keepAccessOpen?: boolean } = {},
): Promise<number> {
  assertKnownOptions(
    args,
    new Set(["--project-root", "--name", "--actor", "--confirm", "--yes", "--json"]),
    "boundary disable",
  );
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  let activeBoundaries: Awaited<ReturnType<typeof loadActivatedExplorationBoundaries>>;
  try {
    activeBoundaries = await loadActivatedExplorationBoundaries(projectRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    activeBoundaries = [];
  }
  if (activeBoundaries.length === 0) {
    const payload = {
      ok: true,
      disabled: false,
      activation: "disabled",
      protected_capabilities_changed: false,
      review_state_changed: false,
      source_database_changed: false,
      message: "Scoped Explore is already disabled.",
    };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write([
      payload.message,
      "The disabled next boundary, review decisions, protected capabilities, evidence, and ledger were preserved.",
      "",
    ].join("\n"));
    return 0;
  }

  const requestedName = optionalArg(args, "--name")?.trim();
  const active = requestedName
    ? activeBoundaries.find((boundary) => boundary.pack.name === requestedName)
    : activeBoundaries.at(-1);
  if (!active) throw new Error(`Boundary ${requestedName} is not active.`);
  const expectedConfirmation = `DISABLE ${active.activation.digest}`;
  const actor = optionalArg(args, "--actor")?.trim()
    || envValue(process.env, "USER")
    || "local-operator";
  const suppliedConfirmation = optionalArg(args, "--confirm")?.trim();
  let confirmed = args.includes("--yes") || suppliedConfirmation === expectedConfirmation;
  if (!confirmed && interactiveSession) {
    confirmed = await interactiveSession.confirm(
      `Disable Scoped Explore boundary "${active.pack.name}"? ` +
      "The disabled next boundary and protected capabilities stay intact.",
    ) === true;
  } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (!confirmed) {
      throw new Error(
        `Noninteractive boundary disable requires --confirm ${shellQuote(expectedConfirmation)}.`,
      );
    }
  } else if (!confirmed) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = (await rl.question(
          `Disable Scoped Explore boundary "${active.pack.name}"? ` +
          "The disabled next boundary and protected capabilities stay intact. [y/N] ",
        )).trim().toLowerCase();
        confirmed = answer === "y" || answer === "yes";
      } finally {
        rl.close();
      }
  }
  if (!confirmed) {
    process.stdout.write("Scoped Explore remains active. Nothing changed.\n");
    return 0;
  }

  const result = await disableScopedExplore(projectRoot, active.pack.name);
  await updateGuidedOnboardingState({
    projectRoot,
    status: "review_boundary",
    authorityActive: result.remaining_boundaries.length > 0,
    recommendedNextAction: result.remaining_boundaries.length
      ? "Continue asking through the remaining active boundaries, or review another saved boundary."
      : "Review or reactivate a saved boundary.",
  }).catch(() => undefined);
  const payload = {
    ok: true,
    ...result,
    activation: "disabled",
    boundary_name: active.pack.name,
    disabled_digest: active.activation.digest,
    actor,
    protected_capabilities_changed: false,
    review_state_changed: false,
    source_database_changed: false,
    next_action: options.keepAccessOpen
      ? "Continue in /access."
      : `${cliCommandName()} boundary review --project-root ${shellQuote(displayPath(projectRoot))}`,
  };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write([
    `Scoped Explore boundary "${payload.boundary_name}" is disabled.`,
    `Disabled authority: ${payload.disabled_digest}`,
    "Preserved: disabled next boundary, review decisions, protected capabilities, evidence, and ledger.",
    "Source database changed: no.",
    options.keepAccessOpen ? payload.next_action : `Next: ${payload.next_action}`,
    "",
  ].join("\n"));
  return 0;
}

async function boundaryDecisionFileCommand(
  args: string[],
  schemaInspector: typeof inspectDatabase,
): Promise<number> {
  assertKnownOptions(
    args,
    new Set([
      "--project-root",
      "--apply-decisions",
      "--apply",
      "--confirm",
      "--json",
      "--config",
      "--identity",
      "--identity-key",
      "--required-role",
      "--expires-at",
      "--nonce",
    ]),
    "boundary review --apply-decisions",
  );
  const decisionPath = optionalArg(args, "--apply-decisions");
  if (!decisionPath) {
    throw new Error("boundary review --apply-decisions requires a versioned JSON decision file.");
  }
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const file = parseBoundaryReviewDecisionFile(
    await readJsonFileWithLocation<unknown>(decisionPath, "boundary-review decision file"),
  );
  const context = await loadBoundaryReviewContext(projectRoot);
  if (file.review_bundle_digest !== context.bundle.bundle_digest) {
    throw new Error(
      "Boundary-review decision file is stale or belongs to another review bundle. " +
      "No decision was applied; export the current boundary review and prepare a new decision file.",
    );
  }
  const requests = boundaryReviewRequestsFromDecisionFile(file);
  const preview = await prepareBoundaryReviewMutationBatch(
    projectRoot,
    requests,
    schemaInspector,
    file.bindings,
  );
  const expectedConfirmation = `APPLY REVIEW ${preview.decision_digest}`;
  const shouldApply = args.includes("--apply") || optionalArg(args, "--confirm") !== undefined;
  if (!shouldApply) {
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(boundaryBatchMutationPublicPreview(preview), null, 2)}\n`
      : formatBoundaryBatchMutationPreview(preview, expectedConfirmation));
    return 0;
  }

  let confirmation = optionalArg(args, "--confirm")?.trim();
  let verifiedDecision: Awaited<ReturnType<typeof verifyBoundaryReviewMutationOperator>> | undefined;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (confirmation !== expectedConfirmation) {
      throw new Error(`Noninteractive boundary-review mutation requires --confirm ${shellQuote(expectedConfirmation)}.`);
    }
    verifiedDecision = await verifyBoundaryReviewMutationOperator({
      args,
      projectRoot,
      preview,
      expectedActor: file.actor,
      reason: file.reason,
    });
  } else if (!confirmation) {
    process.stdout.write(formatBoundaryBatchMutationPreview(preview, expectedConfirmation));
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      confirmation = (await rl.question(
        `Type ${expectedConfirmation} to save all disabled review decisions atomically: `,
      )).trim();
    } finally {
      rl.close();
    }
  }
  if (confirmation !== expectedConfirmation) {
    throw new Error(`Boundary-review mutation requires the exact confirmation ${expectedConfirmation}.`);
  }

  let committed: Awaited<ReturnType<typeof commitBoundaryReviewMutationBatch>>;
  try {
    committed = await commitBoundaryReviewMutationBatch(projectRoot, preview, verifiedDecision?.governed);
    if (verifiedDecision?.store) {
      verifiedDecision.store.setRunnerState(verifiedDecision.key!, {
        status: "applied_disabled_review",
        decision_id: verifiedDecision.decisionId,
        review_decision_digest: preview.decision_digest,
        candidate_digest: committed.candidate_digest,
        resource_count: preview.requests.length,
        subject: verifiedDecision.subject,
        provider: verifiedDecision.provider,
        applied_at: new Date().toISOString(),
        source_database_changed: false,
      });
    }
  } catch (error) {
    if (verifiedDecision?.store) {
      verifiedDecision.store.setRunnerState(verifiedDecision.key!, {
        status: "consumed_review_failed",
        decision_id: verifiedDecision.decisionId,
        review_decision_digest: preview.decision_digest,
        subject: verifiedDecision.subject,
        provider: verifiedDecision.provider,
        failed_at: new Date().toISOString(),
        safe_error: redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
        source_database_changed: false,
      });
    }
    throw error;
  } finally {
    verifiedDecision?.store?.close();
  }
  process.stdout.write(args.includes("--json")
    ? `${JSON.stringify({ ok: true, decision_digest: preview.decision_digest, ...committed }, null, 2)}\n`
    : [
      `Saved ${preview.requests.length} disabled boundary decisions in review revision ${committed.review_revision}.`,
      `Candidate digest: ${committed.candidate_digest}`,
      "Authority activated: no",
      "Source database changed: no",
      `Next: ${cliCommandName()} boundary review --project-root ${shellQuote(projectRoot)}`,
      "",
    ].join("\n"));
  return 0;
}


async function boundaryResourceReviewCommand(
  args: string[],
  schemaInspector: typeof inspectDatabase,
  interactiveSession?: BoundaryReviewInteractiveSession,
  activationHandoff?: BoundaryActivationHandoff,
  options: BoundaryReviewCommandOptions = {},
): Promise<number> {
  const allowed = new Set([
    "--project-root",
    "--json",
    "--map",
    "--details",
    "--include",
    "--exclude",
    "--label",
    "--description",
    "--field-label",
    "--field-description",
    "--row-identity",
    "--tenant-key",
    "--tenant-scope-path",
    "--shared-reference",
    "--acknowledge-table-has-no-per-tenant-rows",
    "--principal-key",
    "--principal-scope-path",
    "--principal-rls-setting",
    "--no-principal",
    "--keep-out",
    "--withhold-from-model",
    "--allow-reviewed-field",
    "--visible-fields",
    "--filter-fields",
    "--sort-fields",
    "--group-fields",
    "--allow-exact-grouping",
    "--remove-exact-grouping",
    "--allow-exact-numeric-grouping",
    "--remove-exact-numeric-grouping",
    "--measure-fields",
    "--count-distinct-fields",
    "--time-fields",
    "--minimum-cohort",
    "--max-ranked-groups",
    "--max-queries-per-24-hours",
    "--requests-per-minute",
    ...REVIEWED_SHAPE_LIMIT_FLAGS.map(([flag]) => flag),
    "--relationships",
    "--nullable-relationship",
    "--unmatched-rows",
    "--actor",
    "--reason",
    "--apply",
    "--confirm",
    "--config",
    "--identity",
    "--identity-key",
    "--required-role",
    "--expires-at",
    "--nonce",
  ]);
  assertKnownOptions(args, allowed, "boundary review resource");
  if (args.includes("--details") && !args.includes("--map")) {
    throw new Error("boundary review resource --details is available only with --map.");
  }
  const resourceId = positional(args, 0);
  if (!resourceId) {
    throw new Error("boundary review resource requires <schema.table>, for example public.orders.");
  }
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const mutationRequested = args.some((arg) => [
    "--include",
    "--exclude",
    "--label",
    "--description",
    "--field-label",
    "--field-description",
    "--row-identity",
    "--tenant-key",
    "--tenant-scope-path",
    "--shared-reference",
    "--acknowledge-table-has-no-per-tenant-rows",
    "--principal-key",
    "--principal-scope-path",
    "--principal-rls-setting",
    "--no-principal",
    "--keep-out",
    "--withhold-from-model",
    "--allow-reviewed-field",
    "--visible-fields",
    "--filter-fields",
    "--sort-fields",
    "--group-fields",
    "--allow-exact-grouping",
    "--remove-exact-grouping",
    "--allow-exact-numeric-grouping",
    "--remove-exact-numeric-grouping",
    "--measure-fields",
    "--count-distinct-fields",
    "--time-fields",
    "--minimum-cohort",
    "--max-ranked-groups",
    "--max-queries-per-24-hours",
    "--requests-per-minute",
    ...REVIEWED_SHAPE_LIMIT_FLAGS.map(([flag]) => flag),
    "--relationships",
    "--nullable-relationship",
  ].includes(arg));
  if (args.includes("--map") && mutationRequested) {
    throw new Error("boundary review resource --map is inspection-only and cannot be combined with decision flags.");
  }
  if (!mutationRequested) {
    const view = await inspectBoundaryResourceReview(projectRoot, resourceId);
    if (args.includes("--map")) {
      if (args.includes("--json")) {
        throw new Error("boundary review resource accepts either --map or --json, not both.");
      }
      process.stdout.write(formatBoundaryResourceMap(view, {
        color: process.stdout.isTTY,
        columns: process.stdout.columns,
        details: args.includes("--details"),
        commandName: cliCommandName(),
      }));
      return 0;
    }
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
      return 0;
    }
    const session = interactiveSession
      ?? (process.stdin.isTTY && process.stderr.isTTY
        ? createBoundaryReviewInteractiveSession()
        : undefined);
    if (!session) {
      process.stderr.write([
        `No boundary decision was supplied for ${resourceId}.`,
        `Use decision flags such as --withhold-from-model <column> with --actor and --reason,`,
        `or run ${cliCommandName()} boundary review in a terminal for the interactive picker.`,
        "",
      ].join("\n"));
      usage(["boundary"]);
      return 2;
    }
    const result = await interactiveBoundaryResourceReview({
      projectRoot,
      resourceId,
      view,
      schemaInspector,
      session,
    });
    if (result === "back") {
      return interactiveBoundaryReviewLoop({
        projectRoot,
        schemaInspector,
        session,
        activationHandoff,
        activationReviewNotice: options.activationReviewNotice,
        clientSetup: options.clientSetup,
        modelAuthoringSession: options.modelAuthoringSession,
        modelReadWorkloadGenerator: options.modelReadWorkloadGenerator,
        modelReadBoundaryRevisionGenerator: options.modelReadBoundaryRevisionGenerator,
        modelActionSuggestionGenerator: options.modelActionSuggestionGenerator,
        modelActionSuggestionSetGenerator: options.modelActionSuggestionSetGenerator,
        modelActionRuleGenerator: options.modelActionRuleGenerator,
        modelAuthoringNarrator: options.modelAuthoringNarrator,
        modelPrincipalScopeInterpreter: options.modelPrincipalScopeInterpreter,
        modelDiscovery: options.modelDiscovery,
        actionProjectInspector: options.actionProjectInspector,
        runDelegationActionReview: options.runDelegationActionReview,
        boundaryAuthoringChatFactory: options.boundaryAuthoringChatFactory,
      });
    }
    if (result === "review") {
      return confirmAndActivateFocusedBoundary({
        projectRoot,
        schemaInspector,
        session,
        activationHandoff,
        activationReviewNotice: options.activationReviewNotice,
      });
    }
    return result;
  }

  const actor = optionalArg(args, "--actor")?.trim();
  const reason = optionalArg(args, "--reason")?.trim();
  if (!actor || !reason) {
    throw new Error("Changing disabled boundary review state requires --actor <human> and --reason <concrete-review-reason>.");
  }
  const sharedReference = args.includes("--shared-reference");
  const sharedReferenceAcknowledged = args.includes(
    "--acknowledge-table-has-no-per-tenant-rows",
  );
  if (sharedReference !== sharedReferenceAcknowledged) {
    throw new Error(
      "--shared-reference requires --acknowledge-table-has-no-per-tenant-rows, and the acknowledgement is valid only with --shared-reference.",
    );
  }
  const tenantModeFlags = [
    args.includes("--tenant-key"),
    args.includes("--tenant-scope-path"),
    sharedReference,
  ].filter(Boolean).length;
  if (tenantModeFlags > 1) {
    throw new Error(
      "Use one tenant mode: --tenant-key, --tenant-scope-path, or --shared-reference with its acknowledgement.",
    );
  }
  const principalModeFlags = [
    args.includes("--principal-key"),
    args.includes("--principal-scope-path"),
    args.includes("--principal-rls-setting"),
    args.includes("--no-principal"),
  ].filter(Boolean).length;
  if (principalModeFlags > 1) {
    throw new Error(
      "Use one of --principal-key <column>, --principal-scope-path <path>, --principal-rls-setting <setting>, or --no-principal.",
    );
  }
  if (args.includes("--allow-exact-grouping") && args.includes("--allow-exact-numeric-grouping")) {
    throw new Error("Use --allow-exact-grouping; do not combine it with its legacy --allow-exact-numeric-grouping alias.");
  }
  if (args.includes("--remove-exact-grouping") && args.includes("--remove-exact-numeric-grouping")) {
    throw new Error("Use --remove-exact-grouping; do not combine it with its legacy --remove-exact-numeric-grouping alias.");
  }
  const allowExactGroupingFields = listArg(args, "--allow-exact-grouping")
    ?? listArg(args, "--allow-exact-numeric-grouping");
  const removeExactGroupingFields = listArg(args, "--remove-exact-grouping")
    ?? listArg(args, "--remove-exact-numeric-grouping");
  const nullableRelationship = optionalArg(args, "--nullable-relationship");
  const unmatchedRows = optionalArg(args, "--unmatched-rows");
  const minimumCohortText = optionalArg(args, "--minimum-cohort");
  const minimumCohort = minimumCohortText === undefined
    ? undefined
    : Number(minimumCohortText);
  if (minimumCohortText !== undefined
    && (typeof minimumCohort !== "number"
      || !Number.isSafeInteger(minimumCohort)
      || minimumCohort < 1
      || minimumCohort > 5)) {
    throw new Error(
      "--minimum-cohort must be an integer from 1 through 5. A value of 1 disables small-group suppression and can identify individuals; 5 restores the default.",
    );
  }
  const maxRankedGroupsText = optionalArg(args, "--max-ranked-groups");
  const maxRankedGroups = maxRankedGroupsText === undefined
    ? undefined
    : Number(maxRankedGroupsText);
  if (maxRankedGroupsText !== undefined
    && (!Number.isSafeInteger(maxRankedGroups)
      || Number(maxRankedGroups) < 1
      || Number(maxRankedGroups) > 10_000)) {
    throw new Error("--max-ranked-groups must be an integer from 1 through 10000.");
  }
  const maxQueriesText = optionalArg(args, "--max-queries-per-24-hours");
  const maxQueries = maxQueriesText === undefined ? undefined : Number(maxQueriesText);
  if (maxQueriesText !== undefined
    && (!Number.isSafeInteger(maxQueries) || Number(maxQueries) < 1 || Number(maxQueries) > 1_000)) {
    throw new Error("--max-queries-per-24-hours must be an integer from 1 through 1000.");
  }
  const requestsPerMinuteText = optionalArg(args, "--requests-per-minute");
  const requestsPerMinute = requestsPerMinuteText === undefined
    ? undefined
    : Number(requestsPerMinuteText);
  if (requestsPerMinuteText !== undefined
    && (!Number.isSafeInteger(requestsPerMinute)
      || Number(requestsPerMinute) < 1
      || Number(requestsPerMinute) > 120)) {
    throw new Error("--requests-per-minute must be an integer from 1 through 120.");
  }
  const reviewedShapeLimits: Partial<BoundaryResourceReviewRequest> = {};
  for (const [flag, key] of REVIEWED_SHAPE_LIMIT_FLAGS) {
    const text = optionalArg(args, flag);
    if (text === undefined) continue;
    const value = Number(text);
    const ceiling = Number(EXPLORATION_BUDGET_REVIEW_CEILINGS[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new Error(`${flag} must be an integer from 1 through ${ceiling}.`);
    }
    (reviewedShapeLimits as Record<string, number>)[key] = value;
  }
  if ((nullableRelationship && unmatchedRows !== "exclude" && unmatchedRows !== "keep_null")
    || (!nullableRelationship && unmatchedRows)) {
    throw new Error("--nullable-relationship <id> requires --unmatched-rows exclude|keep_null.");
  }
  const reviewedMetadata = reviewedMetadataFromArgs(args);
  const request: BoundaryResourceReviewRequest = {
    resource_id: resourceId,
    ...(reviewedMetadata.resource ? { metadata: reviewedMetadata.resource } : {}),
    ...(reviewedMetadata.fields.length ? { field_metadata: reviewedMetadata.fields } : {}),
    ...(args.includes("--include") ? { include: true } : {}),
    ...(args.includes("--exclude") ? { exclude: true } : {}),
    ...(optionalArg(args, "--row-identity") ? { row_identity: optionalArg(args, "--row-identity") } : {}),
    ...(optionalArg(args, "--tenant-key") ? { tenant_key: optionalArg(args, "--tenant-key") } : {}),
    ...(optionalArg(args, "--tenant-scope-path")
      ? { tenant_scope_path: optionalArg(args, "--tenant-scope-path") }
      : {}),
    ...(sharedReference
      ? { shared_reference_scope: SHARED_REFERENCE_ACKNOWLEDGEMENT }
      : {}),
    ...(args.includes("--no-principal")
      ? { principal_key: null, principal_scope_path: null, principal_rls_setting: null }
      : optionalArg(args, "--principal-key")
        ? { principal_key: optionalArg(args, "--principal-key") }
        : optionalArg(args, "--principal-scope-path")
          ? { principal_scope_path: optionalArg(args, "--principal-scope-path") }
          : optionalArg(args, "--principal-rls-setting")
            ? { principal_rls_setting: optionalArg(args, "--principal-rls-setting") }
          : {}),
    ...(listArg(args, "--keep-out") ? { keep_out_fields: listArg(args, "--keep-out") } : {}),
    ...(listArg(args, "--withhold-from-model")
      ? { withhold_from_model_fields: listArg(args, "--withhold-from-model") }
      : {}),
    ...(listArg(args, "--allow-reviewed-field")
      ? { allow_reviewed_fields: listArg(args, "--allow-reviewed-field") }
      : {}),
    ...(listArg(args, "--visible-fields") ? { selectable_fields: listArg(args, "--visible-fields") } : {}),
    ...(listArg(args, "--filter-fields") ? { filterable_fields: listArg(args, "--filter-fields") } : {}),
    ...(listArg(args, "--sort-fields") ? { sortable_fields: listArg(args, "--sort-fields") } : {}),
    ...(listArg(args, "--group-fields") ? { groupable_fields: listArg(args, "--group-fields") } : {}),
    ...(allowExactGroupingFields
      ? {
          allow_exact_numeric_grouping_fields: allowExactGroupingFields,
        }
      : {}),
    ...(removeExactGroupingFields
      ? {
          remove_exact_numeric_grouping_fields: removeExactGroupingFields,
        }
      : {}),
    ...(listArg(args, "--measure-fields") ? { aggregate_measures: listArg(args, "--measure-fields") } : {}),
    ...(listArg(args, "--count-distinct-fields")
      ? { count_distinct_fields: listArg(args, "--count-distinct-fields") }
      : {}),
    ...(listArg(args, "--time-fields") ? { time_bucket_fields: listArg(args, "--time-fields") } : {}),
    ...(minimumCohort === undefined ? {} : { minimum_cohort_size: minimumCohort }),
    ...(maxRankedGroups === undefined ? {} : { max_ranked_groups: maxRankedGroups }),
    ...(maxQueries === undefined ? {} : { max_queries_per_session: maxQueries }),
    ...(requestsPerMinute === undefined ? {} : { rate_limit_per_minute: requestsPerMinute }),
    ...reviewedShapeLimits,
    ...(listArg(args, "--relationships") ? { relationship_ids: listArg(args, "--relationships") } : {}),
    ...(nullableRelationship ? {
      nullable_relationship: {
        relationship_id: nullableRelationship,
        unmatched_rows: unmatchedRows as "exclude" | "keep_null",
      },
    } : {}),
    actor,
    reason,
  };
  const preview = await prepareBoundaryResourceReviewMutation(projectRoot, request, schemaInspector);
  const view = await inspectBoundaryResourceReview(projectRoot, resourceId);
  const expectedConfirmation = `APPLY REVIEW ${preview.decision_digest}`;
  const applyCommand = boundaryResourceApplyCommand(args);
  const shouldApply = args.includes("--apply") || optionalArg(args, "--confirm") !== undefined;
  if (!shouldApply) {
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(boundaryMutationPublicPreview(preview), null, 2)}\n`
      : formatBoundaryMutationPreview(preview, view, applyCommand));
    return 0;
  }
  let confirmation = optionalArg(args, "--confirm")?.trim();
  let verifiedDecision: Awaited<ReturnType<typeof verifyBoundaryReviewMutationOperator>> | undefined;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (confirmation !== expectedConfirmation) {
      throw new Error(`Noninteractive boundary-review mutation requires --confirm ${shellQuote(expectedConfirmation)}.`);
    }
    verifiedDecision = await verifyBoundaryReviewMutationOperator({
      args,
      projectRoot,
      preview,
      expectedActor: actor,
      reason,
    });
  } else if (!confirmation) {
    process.stdout.write(formatBoundaryMutationPreview(preview, view, applyCommand));
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      confirmation = (await rl.question(`Type ${expectedConfirmation} to save this disabled review state: `)).trim();
    } finally {
      rl.close();
    }
  }
  if (confirmation !== expectedConfirmation) {
    throw new Error(`Boundary-review mutation requires the exact confirmation ${expectedConfirmation}.`);
  }
  let committed: Awaited<ReturnType<typeof commitBoundaryResourceReviewMutation>>;
  try {
    committed = await commitBoundaryResourceReviewMutation(projectRoot, preview, verifiedDecision?.governed);
    if (verifiedDecision?.store) {
      verifiedDecision.store.setRunnerState(verifiedDecision.key!, {
        status: "applied_disabled_review",
        decision_id: verifiedDecision.decisionId,
        review_decision_digest: preview.decision_digest,
        candidate_digest: committed.candidate_digest,
        subject: verifiedDecision.subject,
        provider: verifiedDecision.provider,
        applied_at: new Date().toISOString(),
        source_database_changed: false,
      });
    }
  } catch (error) {
    if (verifiedDecision?.store) {
      verifiedDecision.store.setRunnerState(verifiedDecision.key!, {
        status: "consumed_review_failed",
        decision_id: verifiedDecision.decisionId,
        review_decision_digest: preview.decision_digest,
        subject: verifiedDecision.subject,
        provider: verifiedDecision.provider,
        failed_at: new Date().toISOString(),
        safe_error: redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
        source_database_changed: false,
      });
    }
    throw error;
  } finally {
    verifiedDecision?.store?.close();
  }
  process.stdout.write(args.includes("--json")
    ? `${JSON.stringify({ ok: true, decision_digest: preview.decision_digest, ...committed }, null, 2)}\n`
    : formatBoundaryMutationCommit(
      projectRoot,
      committed.review_revision,
      committed.candidate_digest,
      actor,
    ));
  return 0;
}

async function interactiveBoundaryReviewLoop(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  activationHandoff?: BoundaryActivationHandoff;
  activationReviewNotice?: BoundaryReviewCommandOptions["activationReviewNotice"];
  clientSetup?: BoundaryReviewCommandOptions["clientSetup"];
  initialView?: "boundaries" | "access";
  startAtBoundaryList?: boolean;
  modelAuthoringSession?: ActionModelSuggestionSession;
  modelReadWorkloadGenerator?: typeof generateModelReadWorkload;
  modelReadBoundaryRevisionGenerator?: typeof generateModelReadBoundaryRevision;
  modelBoundaryJobPlanner?: typeof planModelBoundaryJob;
  modelActionSuggestionGenerator?: typeof generateModelActionSuggestion;
  modelActionSuggestionSetGenerator?: typeof generateModelActionSuggestionSet;
  modelActionRuleGenerator?: typeof generateModelActionRuleDraft;
  modelAuthoringNarrator?: typeof narrateValidatedAuthoringStep;
  modelPrincipalScopeInterpreter?: typeof interpretPrincipalScopeAnswer;
  modelDiscovery?: BoundaryModelDiscoveryDependencies;
  actionProjectInspector?: typeof inspectActionProject;
  runDelegationActionReview?: typeof runActionControlPlane;
  boundaryAuthoringChatFactory?: BoundaryAuthoringChatFactory;
  startWithAgentJob?: boolean;
  initialSavedReadRevision?: boolean;
  exitAfterAgentJob?: boolean;
}): Promise<number> {
  let startAtBoundaryList = input.startAtBoundaryList;
  let continueSavedAgentJob = false;
  let selectedResourceId: string | undefined;
  let accessNotice: BoundaryAccessNotice | undefined;
  let deferredActivationHandoff: Parameters<BoundaryActivationHandoff>[0] | undefined;
  const accessActivationInput = {
    ...input,
    ...(input.activationHandoff
      ? {
          activationHandoff: async (handoffInput: Parameters<BoundaryActivationHandoff>[0]) => {
            deferredActivationHandoff = handoffInput;
            return 0;
          },
        }
      : {}),
  };
  let startWithAgentJob = input.startWithAgentJob === true;
  while (true) {
    let context = await loadBoundaryReviewContext(input.projectRoot);
    const boundaryLibrary = await synchronizeBoundaryLibrary({
      expectedAuthoring: context.bundle.mutation_bindings.authoring,
      projectRoot: input.projectRoot,
      draft: context.draft,
      currentCandidate: context.candidate,
      ...(context.progress ? { currentProgress: context.progress } : {}),
    });
    context = await loadBoundaryReviewContext(input.projectRoot);
    const notice = accessNotice;
    accessNotice = undefined;
    const askIntentModes = await askIntentCheckModesForBoundaries(
      input.projectRoot,
      boundaryLibrary.entries.map((entry) => entry.name),
    );
    const [guidedActions, semanticRuleDrafts] = await Promise.all([
      guidedActionStatus(input.projectRoot),
      listActionRuleAuthorityDrafts(input.projectRoot),
    ]);
    let semanticRuleActivation: ActionRuleAuthorityActivationV1 | undefined;
    let semanticRuleActivationError: string | undefined;
    try {
      semanticRuleActivation = await readActionRuleAuthorityActivation(input.projectRoot);
    } catch (error) {
      semanticRuleActivationError = error instanceof Error ? error.message : String(error);
    }
    const resolvedProject = await resolveSynapsorProject(input.projectRoot, process.env);
    const modelOutputConfigPath = resolvedProject?.config_path;
    const modelAuthorityMetadataMode = modelOutputConfigPath
      ? await readModelAuthorityMetadataMode(modelOutputConfigPath)
      : "semantic";
    const actionBoundaryCurrent = guidedActions.action_boundary.draft
      ?? guidedActions.action_boundary.active;
    const actionBoundaryOverview = {
      ...(actionBoundaryCurrent ? { name: actionBoundaryCurrent.name } : {}),
      state: guidedActions.action_boundary.active && guidedActions.action_boundary.draft
        ? "active_with_disabled_changes" as const
        : guidedActions.action_boundary.active
          ? "active" as const
          : guidedActions.action_boundary.draft
            ? "disabled" as const
            : "off" as const,
      active_action_count: guidedActions.action_boundary.active?.authority.capabilities.length ?? 0,
      draft_action_count: guidedActions.action_boundary.draft?.authority.capabilities.length ?? 0,
    };
    if (startWithAgentJob) {
      startWithAgentJob = false;
      const continueSavedJob = continueSavedAgentJob;
      continueSavedAgentJob = false;
      try {
        const assist = await interactiveReadWorkloadAssist({
          projectRoot: input.projectRoot,
          ...(modelOutputConfigPath ? { baseConfigPath: modelOutputConfigPath } : {}),
          schemaInspector: input.schemaInspector,
          session: input.session,
          modelAuthoringSession: input.modelAuthoringSession,
          modelReadWorkloadGenerator: input.modelReadWorkloadGenerator,
          modelReadBoundaryRevisionGenerator: input.modelReadBoundaryRevisionGenerator,
          modelBoundaryJobPlanner: input.modelBoundaryJobPlanner,
          modelActionSuggestionGenerator: input.modelActionSuggestionGenerator,
          modelActionSuggestionSetGenerator: input.modelActionSuggestionSetGenerator,
          modelActionRuleGenerator: input.modelActionRuleGenerator,
          modelAuthoringNarrator: input.modelAuthoringNarrator,
          modelPrincipalScopeInterpreter: input.modelPrincipalScopeInterpreter,
          modelDiscovery: input.modelDiscovery,
          actionProjectInspector: input.actionProjectInspector,
          runDelegationActionReview: input.runDelegationActionReview,
          boundaryAuthoringChatFactory: input.boundaryAuthoringChatFactory,
          completeReadReview: async (mode, session = input.session, reviewOptions) => confirmActivateAndKeepAccessOpen({
            ...accessActivationInput,
            session,
            prepareDependentActions: mode === "prepare_actions",
            reviewOptions,
          }),
          jobFirst: true,
          initialSavedReadRevision: input.initialSavedReadRevision,
          ...(continueSavedJob ? { continueSavedJob: true } : {}),
        });
        if (assist.activation_ready && !assist.notice_presented) {
          process.stdout.write([
            "",
            "READ BOUNDARY DRAFT READY",
            ...assist.notice.lines,
            "The exact disabled draft is saved. Nothing is active until you review and activate it.",
            "",
          ].join("\n"));
        }
        if (assist.handoff_ready && input.activationHandoff) {
          if (!assist.notice_presented) writeBoundaryAccessNotice(assist.notice);
          const reviewed = await loadBoundaryReviewContext(input.projectRoot);
          return input.activationHandoff(deferredActivationHandoff ?? {
            projectRoot: input.projectRoot,
            boundaryName: reviewed.candidate.pack.name,
            boundaryDigest: reviewed.bundle.candidate_digest,
          });
        }
        if (!assist.notice_presented) accessNotice = assist.notice;
        if (assist.navigation === "pause") return 0;
        if (assist.navigation === "resume_agent_job") {
          startWithAgentJob = true;
          continueSavedAgentJob = true;
          continue;
        }
        if (assist.navigation) startAtBoundaryList = assist.navigation === "boundary_list";
      } catch (error) {
        const recovery = await showBoundaryAuthoringFailure(input.session, error, true);
        if (recovery === "pause") return 0;
        startWithAgentJob = recovery === "resume";
      }
      if (input.exitAfterAgentJob) return 0;
      continue;
    }
    const selected = await input.session.chooseResource(
      await listBoundaryResourceReviews(input.projectRoot),
      {
        ...boundaryReviewOverview(context.bundle),
        discovery_concerns: readDiscoveryCompatibility(context.candidate, context.bundle.candidate_digest, context.draft),
        model_authority_metadata_mode: modelAuthorityMetadataMode,
        action_boundary: actionBoundaryOverview,
        boundaries: boundaryLibrary.entries.map((entry) => {
          const actionDrafts = guidedActions.drafts.filter((draft) =>
            draft.boundary_name === entry.name);
          const activeActions = guidedActions.activations.filter((activation) =>
            activation.boundary_name === entry.name);
          const semanticDrafts = semanticRuleDrafts.filter((draft) =>
            draft.authority.rules.some((rule) => rule.read_boundary_name === entry.name));
          const semanticDraftCount = semanticDrafts.reduce((total, draft) => {
            const linkedOutcomes = new Set(draft.authority.rules
              .filter((rule) => rule.read_boundary_name === entry.name)
              .map((rule) => rule.rule.outcome));
            return total + draft.authority.action_boundary.rules.filter((rule) =>
              linkedOutcomes.has(rule.outcome)).length;
          }, 0);
          const semanticActiveOutcomes = new Set(semanticRuleActivation?.authority.rules
            .filter((rule) => rule.read_boundary_name === entry.name)
            .map((rule) => rule.rule.outcome) ?? []);
          const semanticActiveCount = semanticRuleActivation?.authority.action_boundary.rules.filter((rule) =>
            semanticActiveOutcomes.has(rule.outcome)).length ?? 0;
          const semanticBoundaryName = semanticDrafts[0]?.authority.action_boundary.name
            ?? (semanticActiveCount ? semanticRuleActivation?.authority.action_boundary.name : undefined);
          return {
            ...entry,
            ask_intent_check_mode: askIntentModes[entry.name] ?? "balanced",
            proposal_action_state: actionDrafts.some((draft) => draft.effect_preview)
              ? "rehearsed" as const
              : actionDrafts.length
                ? "draft" as const
                : activeActions.length
                  ? "active" as const
                  : "none" as const,
            proposal_action_active_count: activeActions.length,
            proposal_action_draft_count: actionDrafts.length,
            ...(semanticBoundaryName ? { verified_action_boundary_name: semanticBoundaryName } : {}),
            ...(semanticDraftCount || semanticActiveCount || (entry.selected && semanticRuleActivationError)
              ? {
                  verified_action_state: semanticRuleActivationError && entry.selected
                    ? "blocked" as const
                    : semanticActiveCount && semanticDraftCount
                      ? "active_with_disabled_changes" as const
                      : semanticActiveCount
                        ? "active" as const
                        : "disabled" as const,
                  verified_action_active_count: semanticActiveCount,
                  verified_action_draft_count: semanticDraftCount,
                  ...(semanticRuleActivationError && entry.selected
                    ? { verified_action_error: semanticRuleActivationError }
                    : {}),
                }
              : {}),
          };
        }),
      },
      {
        initialView: input.initialView ?? "boundaries",
        startAtBoundaryList,
        ...(selectedResourceId ? { initialResourceId: selectedResourceId } : {}),
        ...(notice ? { notice } : {}),
      },
    );
    if (!selected) {
      process.stdout.write(input.initialView === "access"
        ? [
            "Access editor closed. Reviewed authority is unchanged.",
            "",
          ].join("\n")
        : [
            "Boundary review paused. No new decision or authority was recorded.",
            `Resume: ${cliCommandName()} start --from-env ${context.lock.source_env} --cli`,
            "",
          ].join("\n"));
      if (deferredActivationHandoff && input.activationHandoff) {
        return input.activationHandoff(deferredActivationHandoff);
      }
      return 0;
    }
    if (selected.action === "workloads") {
      try {
        const assist = await interactiveReadWorkloadAssist({
          projectRoot: input.projectRoot,
          ...(modelOutputConfigPath ? { baseConfigPath: modelOutputConfigPath } : {}),
          schemaInspector: input.schemaInspector,
          session: input.session,
          modelAuthoringSession: input.modelAuthoringSession,
          modelReadWorkloadGenerator: input.modelReadWorkloadGenerator,
          modelReadBoundaryRevisionGenerator: input.modelReadBoundaryRevisionGenerator,
          modelActionSuggestionGenerator: input.modelActionSuggestionGenerator,
          modelActionSuggestionSetGenerator: input.modelActionSuggestionSetGenerator,
          modelActionRuleGenerator: input.modelActionRuleGenerator,
          modelAuthoringNarrator: input.modelAuthoringNarrator,
          modelPrincipalScopeInterpreter: input.modelPrincipalScopeInterpreter,
          actionProjectInspector: input.actionProjectInspector,
          runDelegationActionReview: input.runDelegationActionReview,
          boundaryAuthoringChatFactory: input.boundaryAuthoringChatFactory,
          completeReadReview: async (mode, session = input.session, reviewOptions) => confirmActivateAndKeepAccessOpen({
            ...accessActivationInput,
            session,
            prepareDependentActions: mode === "prepare_actions",
            reviewOptions,
          }),
          jobFirst: true,
        });
        if (assist.activation_ready) {
          if (!assist.notice_presented) {
            process.stdout.write([
              "",
              "READ CANDIDATE READY",
              ...assist.notice.lines,
              "The immutable analysis and disabled candidate are saved. Agent authority is still unchanged.",
              "Review the complete read boundary next; activation is the only authority confirmation.",
              "",
            ].join("\n"));
          }
          const activationResult = await confirmActivateAndKeepAccessOpen(accessActivationInput);
          if (activationResult !== 0) return activationResult;
        } else if (assist.handoff_ready && input.activationHandoff) {
          if (!assist.notice_presented) writeBoundaryAccessNotice(assist.notice);
          const reviewed = await loadBoundaryReviewContext(input.projectRoot);
          return input.activationHandoff(deferredActivationHandoff ?? {
            projectRoot: input.projectRoot,
            boundaryName: reviewed.candidate.pack.name,
            boundaryDigest: reviewed.bundle.candidate_digest,
          });
        } else if (!assist.notice_presented) {
          accessNotice = assist.notice;
        }
        if (assist.navigation === "pause") return 0;
        if (assist.navigation) startAtBoundaryList = assist.navigation === "boundary_list";
      } catch (error) {
        const recovery = await showBoundaryAuthoringFailure(input.session, error, false);
        if (recovery === "pause") return 0;
        startWithAgentJob = recovery === "resume";
      }
      continue;
    }
    if (selected.action === "actions") {
      const semanticDraft = semanticRuleDrafts.find((draft) =>
        draft.authority.rules.some((rule) => rule.read_boundary_name === selected.boundary_name));
      const semanticActive = semanticRuleActivation?.authority.rules.some((rule) =>
        rule.read_boundary_name === selected.boundary_name)
        ? semanticRuleActivation
        : undefined;
      const hasDiscretionary = guidedActions.drafts.some((draft) => draft.boundary_name === selected.boundary_name)
        || guidedActions.activations.some((activation) => activation.boundary_name === selected.boundary_name);
      if (semanticRuleActivationError) {
        accessNotice = {
          tone: "danger",
          title: "Verified Action authority is blocked.",
          lines: [semanticRuleActivationError],
          footer: "The agent has no usable verified outcome from this invalid state. Use W to prepare a replacement or inspect the exact local artifact.",
        };
        continue;
      }
      if (!semanticDraft && !semanticActive && !hasDiscretionary) {
        const route = input.session.chooseOption
          ? await input.session.chooseOption("DESCRIBE A CHANGE", [
              { value: "guided", label: "Describe the business rules with a model",
                detail: "Continue this saved setup. Missing meanings are clarified before a disabled rule is prepared." },
              { value: "manual", label: "Use the manual rule editor",
                detail: "Choose a supported change and its limits directly. Activation remains separate." },
              { value: "back", label: "Back" },
            ], { initialValue: "guided" })
          : "guided";
        if (route === "guided") {
          startWithAgentJob = true;
          continue;
        }
        if (route === "manual") {
          await reviewActionsCommand(
            ["--project-root", input.projectRoot, "--boundary", selected.boundary_name],
            input.actionProjectInspector ?? inspectActionProject,
            input.modelAuthoringSession, input.runDelegationActionReview, false, true,
          );
        }
        continue;
      }
      let actionKind: "verified" | "discretionary" = semanticDraft || semanticActive
        ? "verified"
        : "discretionary";
      if ((semanticDraft || semanticActive) && hasDiscretionary && input.session.chooseOption) {
        const selectedKind = await input.session.chooseOption(
          "ACTION AUTHORITIES",
          [
            {
              value: "verified",
              label: "Verified outcomes",
              detail: "The agent nominates an outcome; Runner privately verifies facts and derives the exact effect.",
            },
            {
              value: "discretionary",
              label: "Caller-supplied proposal values",
              detail: "The agent supplies only the fields and values explicitly bounded by a reviewed proposal action.",
            },
            { value: "back", label: "Back" },
          ],
          { initialValue: "verified" },
        );
        if (!selectedKind || selectedKind === "back") continue;
        actionKind = selectedKind as "verified" | "discretionary";
      }
      if (actionKind === "verified") {
        accessNotice = await reviewVerifiedActionAuthority({
          projectRoot: input.projectRoot,
          ...(modelOutputConfigPath ? { baseConfigPath: modelOutputConfigPath } : {}),
          boundaryName: selected.boundary_name,
          session: input.session,
          ...(semanticDraft ? { draft: semanticDraft } : {}),
          ...(semanticActive ? { active: semanticActive } : {}),
          ...(input.clientSetup ? { clientSetup: () => input.clientSetup!(input.projectRoot) } : {}),
          reviewRead: () => reviewReadFromSavedActions({ projectRoot: input.projectRoot,
            boundaryName: selected.boundary_name, session: input.session, schemaInspector: input.schemaInspector,
            authoringOptions: input }),
          manualRevision: { run: async () => {
            await reviewActionsCommand(["--project-root", input.projectRoot, "--boundary", selected.boundary_name],
              input.actionProjectInspector ?? inspectActionProject, input.modelAuthoringSession,
              input.runDelegationActionReview, false, true);
            return { tone: "success", title: "Manual action editor closed.",
              lines: ["Saved edits remain disabled. Active permissions and customer data are unchanged."] };
          } },
          modelRevision: {
            label: input.modelAuthoringSession
              ? `Describe a verified outcome change with ${boundaryModelLabel(input.modelAuthoringSession)}`
              : "Describe a verified outcome change with a model",
            detail: "Keeps the exact current Read and Action authority while the model prepares a disabled replacement for review.",
            run: async () => {
              const assist = await interactiveReadWorkloadAssist({
                projectRoot: input.projectRoot,
                ...(modelOutputConfigPath ? { baseConfigPath: modelOutputConfigPath } : {}),
                schemaInspector: input.schemaInspector,
                session: input.session,
                modelAuthoringSession: input.modelAuthoringSession,
                modelReadWorkloadGenerator: input.modelReadWorkloadGenerator,
                modelReadBoundaryRevisionGenerator: input.modelReadBoundaryRevisionGenerator,
                modelBoundaryJobPlanner: input.modelBoundaryJobPlanner,
                modelActionSuggestionGenerator: input.modelActionSuggestionGenerator,
                modelActionSuggestionSetGenerator: input.modelActionSuggestionSetGenerator,
                modelActionRuleGenerator: input.modelActionRuleGenerator,
                modelAuthoringNarrator: input.modelAuthoringNarrator,
                modelPrincipalScopeInterpreter: input.modelPrincipalScopeInterpreter,
                modelDiscovery: input.modelDiscovery,
                actionProjectInspector: input.actionProjectInspector,
                runDelegationActionReview: input.runDelegationActionReview,
                boundaryAuthoringChatFactory: input.boundaryAuthoringChatFactory,
                completeReadReview: async (mode, session = input.session, reviewOptions) => confirmActivateAndKeepAccessOpen({
                  ...accessActivationInput,
                  session,
                  prepareDependentActions: mode === "prepare_actions",
                  reviewOptions,
                }),
                jobFirst: true,
              });
              return assist.notice;
            },
          },
        });
        continue;
      }
      await reviewActionsCommand(
        ["--project-root", input.projectRoot, "--boundary", selected.boundary_name],
        input.actionProjectInspector ?? inspectActionProject,
        input.modelAuthoringSession,
        input.runDelegationActionReview,
        Boolean(semanticDraft || semanticActive),
      );
      const actionStatus = await guidedActionStatus(input.projectRoot);
      const rehearsedDrafts = actionStatus.drafts.filter((draft) =>
        draft.boundary_name === selected.boundary_name && draft.effect_preview);
      const reviewed = await loadBoundaryReviewContext(input.projectRoot);
      const readBoundaryActive = await exactReadBoundaryIsActive({
        projectRoot: input.projectRoot,
        boundaryName: selected.boundary_name,
        candidateDigest: reviewed.bundle.candidate_digest,
      });
      accessNotice = rehearsedDrafts.length
        ? {
            tone: "success",
            title: "Proposal rehearsal passed. Source data is unchanged.",
            lines: [
              `${rehearsedDrafts.length} proposal-only action${rehearsedDrafts.length === 1 ? " is" : "s are"} ready for authority review.`,
              readBoundaryActive
                ? `Read Boundary ${selected.boundary_name} is already active. Press Y to review the exact rehearsed proposal action.`
                : "Press C to review and activate this Read Boundary. Then press Y to review the exact rehearsed proposal action.",
            ],
            footer: "No proposal action, approval, apply, or writeback authority is active yet.",
          }
        : {
            tone: "success",
            title: "Returned from Safe Actions.",
            lines: [
              "Read-boundary review and active authority are unchanged.",
              "New action revisions remain disabled until their own rehearsal and activation.",
            ],
          };
      continue;
    }
    if (selected.action === "intent_check") {
      const currentMode = await askIntentCheckModeForBoundary(
        input.projectRoot,
        selected.boundary_name,
      );
      const nextMode = currentMode === "balanced" ? "boundary_only" : "balanced";
      if (nextMode === "boundary_only") {
        const accepted = await input.session.confirm(
          "Turn off the English question-to-plan check for local Ask on this boundary? A model may execute a valid reviewed plan even when it does not answer the wording of the question. Reviewed fields, operations, scope, suppression, drift, read-only compilation, and budgets remain enforced.",
          { defaultValue: false },
        );
        if (!accepted) {
          accessNotice = {
            tone: "success",
            title: "Local Ask remains in Balanced mode.",
            lines: [
              "Runner still compares the English question with the model's proposed reviewed plan before execution.",
            ],
          };
          continue;
        }
      }
      await setAskIntentCheckMode({
        projectRoot: input.projectRoot,
        boundaryName: selected.boundary_name,
        mode: nextMode,
      });
      accessNotice = nextMode === "boundary_only"
        ? {
            tone: "warning",
            title: `Local Ask for ${selected.boundary_name} now uses Boundary-only mode.`,
            lines: [
              "The English question-to-plan comparison is off for this boundary.",
              "Every plan still passes the same reviewed Explore validator and compiler; no data authority changed.",
              "Press T again to restore Balanced mode.",
            ],
            footer: "No review or activation is required for this local Ask preference.",
          }
        : {
            tone: "success",
            title: `Local Ask for ${selected.boundary_name} now uses Balanced mode.`,
            lines: [
              "Runner will refuse a model plan that contradicts the English question before Explore execution.",
            ],
            footer: "Reviewed data authority and source data were unchanged.",
          };
      continue;
    }
    if (selected.action === "model_output") {
      if (!modelOutputConfigPath) {
        accessNotice = {
          tone: "danger",
          title: "Runner config was not found.",
          lines: [
            "Model output cannot be changed until this project has one discoverable synapsor.runner.json.",
          ],
          footer: `Scriptable path: ${cliCommandName()} config model-output --config <path>`,
        };
        continue;
      }
      const nextMode = modelAuthorityMetadataMode === "semantic" ? "exact" : "semantic";
      if (nextMode === "exact" && selected.exact_metadata_confirmed !== true) {
        const accepted = await input.session.confirm(
          "Show exact Runner digests, fingerprints, and query-audit hashes to model-facing MCP clients and local Ask? Operator evidence is already exact. Use this only for a diagnostic client.",
          { defaultValue: false },
        );
        if (!accepted) {
          accessNotice = {
            tone: "success",
            title: "Model responses remain Semantic.",
            lines: ["Exact Runner metadata stays in operator details, evidence, and query audit."],
          };
          continue;
        }
      }
      try {
        await updateModelAuthorityMetadataMode({
          configPath: modelOutputConfigPath,
          mode: nextMode,
        });
      } catch (error) {
        accessNotice = {
          tone: "danger",
          title: "Model output was not changed.",
          lines: [redactCliErrorMessage(error instanceof Error ? error.message : String(error))],
          footer: "Reviewed authority and source data are unchanged.",
        };
        continue;
      }
      accessNotice = nextMode === "semantic"
        ? {
            tone: "success",
            title: "Model responses now use Semantic metadata.",
            lines: [
              "Reviewed names, results, privacy outcomes, and evidence handles remain available.",
              "Exact digests, fingerprints, and query-audit hashes stay operator-only.",
            ],
            footer: "Local Ask uses this on its next question. Restart other long-lived MCP servers; no boundary review or activation is required.",
          }
        : {
            tone: "warning",
            title: "Model responses now include Exact diagnostic metadata.",
            lines: [
              "Model-facing clients can receive Runner digests, fingerprints, and query-audit hashes.",
              "Press O again to return to Semantic output.",
            ],
            footer: "Local Ask uses this on its next question. Restart other long-lived MCP servers; reviewed data authority is unchanged.",
          };
      continue;
    }
    if (selected.action === "rename") {
      const result = await interactiveBoundaryRename({
        projectRoot: input.projectRoot,
        session: input.session,
      });
      if (result !== 0) return result;
      continue;
    }
    if (selected.action === "limits") {
      const result = await interactiveBoundaryLimitsReview({
        projectRoot: input.projectRoot,
        schemaInspector: input.schemaInspector,
        session: input.session,
      });
      if (result !== 0) return result;
      continue;
    }
    if (selected.action === "privacy_all") {
      const result = await interactiveBoundaryMinimumCohortReview({
        projectRoot: input.projectRoot,
        schemaInspector: input.schemaInspector,
        session: input.session,
        focusedAccess: input.initialView === "access",
      });
      if (result === "review") {
        if (input.initialView === "access") {
          const activationResult = await confirmActivateAndKeepAccessOpen(accessActivationInput);
          if (activationResult !== 0) return activationResult;
        }
        continue;
      }
      if (result !== "back" && result !== 0) return result;
      continue;
    }
    if (selected.action === "create") {
      const requestedName = await input.session.promptText(
        "New boundary name: ",
      );
      if (!requestedName) {
        process.stdout.write("New boundary cancelled. Nothing was saved or activated.\n");
        continue;
      }
      const name = requestedName.trim().toLowerCase();
      if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) {
        process.stdout.write([
          "Boundary was not created.",
          "Use 1-64 letters, numbers, dots, dashes, or underscores; start with a letter.",
          "You are still in boundary review. Active authority and Ask access are unchanged.",
          "",
        ].join("\n"));
        continue;
      }
      if (name !== requestedName.trim()) {
        process.stdout.write(`Using lower-case boundary name "${name}".\n`);
      }
      const startingResources = (await listBoundaryResourceReviews(input.projectRoot))
        .map((resource) => ({
          ...resource,
          candidate_boundary_name: name,
          active: false,
          included: false,
          pending_decisions: [],
          risk_count: resource.blockers.length,
        }))
        .sort((left, right) =>
          Number(left.first_table_startable === false) - Number(right.first_table_startable === false)
          || Number(left.status !== "draft_read") - Number(right.status !== "draft_read")
          || right.risk_count - left.risk_count
          || left.resource_id.localeCompare(right.resource_id));
      if (!startingResources.some((resource) =>
        resource.first_table_startable !== false
        && (resource.status === "draft_read" || resource.inline_resolution_available === true))) {
        process.stdout.write([
          "Boundary was not created because no inspected table can safely start it alone.",
          "Start from a directly scoped table. Derived tables and Shared references can be added after the new boundary exists, with their own reviewed path or acknowledgement.",
          "",
        ].join("\n"));
        continue;
      }
      const startingSelection = await input.session.chooseResource(
        startingResources,
        undefined,
        { initialView: "access", startingBoundaryName: name },
      );
      if (!startingSelection || !("resource_id" in startingSelection)) {
        process.stdout.write("New boundary cancelled. Nothing was saved or activated.\n");
        continue;
      }
      const startingSummary = startingResources.find((resource) =>
        resource.resource_id === startingSelection.resource_id);
      if (startingSummary?.first_table_startable === false) {
        process.stdout.write([
          `${startingSelection.resource_id} cannot be the first table in this boundary.`,
          `${startingSummary.first_table_guidance ?? "Add its directly scoped ancestor first."}.`,
          startingSummary.first_table_scope_kind === "shared_reference"
            ? "The no-per-tenant-rows acknowledgement is reviewed separately for every boundary and will be offered when you add this table."
            : `Its required scope is derived through ${startingSummary.first_table_scope_label ?? "a mandatory reviewed relationship path"}.`,
          "No table review was started, and nothing was saved or activated.",
          "",
        ].join("\n"));
        continue;
      }
      let startingView = await inspectBoundaryResourceReview(
        input.projectRoot,
        startingSelection.resource_id,
      );
      if (!startingView.generated_candidate) {
        const resolved = await resolveBlockedBoundaryResource({
          projectRoot: input.projectRoot,
          view: startingView,
          schemaInspector: input.schemaInspector,
          session: input.session,
          include: false,
        });
        if (resolved === "back" || !resolved) {
          process.stdout.write("New boundary cancelled. Nothing was saved or activated.\n");
          continue;
        }
        startingView = resolved;
        context = await loadBoundaryReviewContext(input.projectRoot);
      }
      let progress;
      try {
        progress = await createSavedBoundary({
          expectedAuthoring: context.bundle.mutation_bindings.authoring,
          projectRoot: input.projectRoot,
          draft: context.draft,
          currentCandidate: context.candidate,
          ...(context.progress ? { currentProgress: context.progress } : {}),
          name,
          resourceId: startingSelection.resource_id,
          actor: localInteractiveActor(),
        });
      } catch (error) {
        process.stdout.write([
          `Boundary was not created: ${redactCliErrorMessage(
            error instanceof Error ? error.message : String(error),
          )}`,
          "You are still in boundary review. Active authority and Ask access are unchanged.",
          "",
        ].join("\n"));
        continue;
      }
      process.stdout.write([
        `Created disabled boundary "${progress.candidate.pack.name}" with ${startingSelection.resource_id}.`,
        "Authority activated: no",
        "Review this table's column access now; activation remains a separate exact review.",
        "",
      ].join("\n"));
      startAtBoundaryList = false;
      startingView = await inspectBoundaryResourceReview(
        input.projectRoot,
        startingSelection.resource_id,
      );
      const editResult = await interactiveBoundaryResourceReview({
        projectRoot: input.projectRoot,
        resourceId: startingSelection.resource_id,
        view: startingView,
        schemaInspector: input.schemaInspector,
        session: input.session,
        focusedAccess: true,
      });
      if (editResult === "review") {
        const activationResult = await confirmActivateAndKeepAccessOpen(accessActivationInput);
        if (activationResult !== 0) return activationResult;
        continue;
      }
      if (editResult !== "back" && editResult !== 0) return editResult;
      continue;
    }
    if (selected.action === "switch") {
      await switchSavedBoundary({
        expectedAuthoring: context.bundle.mutation_bindings.authoring,
        projectRoot: input.projectRoot,
        draft: context.draft,
        currentCandidate: context.candidate,
        ...(context.progress ? { currentProgress: context.progress } : {}),
        name: selected.boundary_name,
      });
      process.stdout.write(
        `Opened saved boundary "${selected.boundary_name}" for editing. Active Explore authority did not change.\n`,
      );
      selectedResourceId = undefined;
      continue;
    }
    if (selected.action === "delete") {
      const accepted = await input.session.confirm(
        `Delete saved disabled boundary "${selected.boundary_name}"?`,
        { defaultValue: false },
      );
      if (!accepted) {
        process.stdout.write("Boundary deletion cancelled. Nothing changed.\n");
        continue;
      }
      let result: Awaited<ReturnType<typeof deleteSavedBoundary>>;
      try {
        result = await deleteSavedBoundary({
          expectedAuthoring: context.bundle.mutation_bindings.authoring,
          projectRoot: input.projectRoot,
          draft: context.draft,
          currentCandidate: context.candidate,
          ...(context.progress ? { currentProgress: context.progress } : {}),
          name: selected.boundary_name,
        });
      } catch (error) {
        process.stdout.write([
          `Boundary was not deleted: ${redactCliErrorMessage(
            error instanceof Error ? error.message : String(error),
          )}`,
          "You are still in boundary review. Active authority and source data are unchanged.",
          "",
        ].join("\n"));
        continue;
      }
      process.stdout.write([
        `Deleted saved disabled boundary "${selected.boundary_name}".`,
        `Selected boundary: ${result.selected_name}`,
        "Active Explore authority changed: no",
        "",
      ].join("\n"));
      await deleteAskIntentCheckPreference(input.projectRoot, selected.boundary_name);
      continue;
    }
    if (selected.action === "confirm") {
      if (input.initialView === "access") {
        const activationResult = await confirmActivateAndKeepAccessOpen(accessActivationInput);
        if (activationResult !== 0) return activationResult;
        continue;
      }
      const context = await loadBoundaryReviewContext(input.projectRoot);
      const reviewed = await confirmBoundaryReviewInteractively({
        projectRoot: input.projectRoot,
        context,
        session: input.session,
      });
      if (reviewed.context.bundle.outstanding_decision_ids.length === 0) {
        return boundaryActivateCommand(
          [
            "--project-root", input.projectRoot,
            ...(reviewed.actor ? ["--actor", reviewed.actor] : []),
          ],
          input.schemaInspector,
          input.session,
          input.activationHandoff,
        );
      }
      process.stdout.write(await formatBoundaryReviewSummary(reviewed.context.bundle, input.projectRoot));
      return 0;
    }
    if (selected.action === "disable") {
      const result = await boundaryDisableCommand(
        ["--project-root", input.projectRoot, "--name", selected.boundary_name],
        input.session,
        { keepAccessOpen: input.initialView === "access" },
      );
      if (result !== 0 || input.initialView !== "access") return result;
      const remaining = await loadActivatedExplorationBoundaries(input.projectRoot).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        },
      );
      process.stdout.write(remaining.length
        ? `You are still in /access. Ask will use ${remaining.length} remaining active ${remaining.length === 1 ? "boundary" : "boundaries"} when you leave.\n\n`
        : "No active boundary. Stay in /access and highlight a reviewed boundary, then press C to enable Ask.\n\n");
      deferredActivationHandoff = undefined;
      startAtBoundaryList = true;
      continue;
    }
    if (!("resource_id" in selected)) {
      throw new Error("Boundary review returned an unsupported interactive action.");
    }
    selectedResourceId = selected.resource_id;
    // The boundary list is the entry point for /access, not the destination
    // for Back from a table's column editor. Resume at this boundary's table
    // list after any table-level action.
    startAtBoundaryList = false;
    const view = await inspectBoundaryResourceReview(input.projectRoot, selected.resource_id);
    if (selected.action === "metadata") {
      await interactiveReviewedMetadataReview({
        projectRoot: input.projectRoot,
        resourceId: selected.resource_id,
        view,
        schemaInspector: input.schemaInspector,
        session: input.session,
      });
      continue;
    }
    if (selected.action === "privacy") {
      const result = await interactiveMinimumCohortReview({
        projectRoot: input.projectRoot,
        resourceId: selected.resource_id,
        view,
        schemaInspector: input.schemaInspector,
        session: input.session,
        focusedAccess: input.initialView === "access",
      });
      if (result === "review") {
        if (input.initialView === "access") {
          const activationResult = await confirmActivateAndKeepAccessOpen(accessActivationInput);
          if (activationResult !== 0) return activationResult;
        }
        continue;
      }
      if (result !== "back" && result !== 0) return result;
      continue;
    }
    if (selected.action === "relationships") {
      const result = await interactiveReviewedRelationshipPathReview({
        projectRoot: input.projectRoot,
        resourceId: selected.resource_id,
        view,
        schemaInspector: input.schemaInspector,
        session: input.session,
      });
      if (result !== 0) return result;
      continue;
    }
    if (selected.action === "analytics") {
      const result = await interactiveReviewedAnalyticsReview({
        projectRoot: input.projectRoot,
        resourceId: selected.resource_id,
        schemaInspector: input.schemaInspector,
        session: input.session,
      });
      if (result !== 0) return result;
      continue;
    }
    if (selected.action === "signoff") {
      await confirmBoundaryResourceInteractively({
        projectRoot: input.projectRoot,
        context,
        resourceId: selected.resource_id,
        session: input.session,
      });
      continue;
    }
    if (selected.action === "add") {
      const result = await interactiveBoundaryResourceAddition({
        projectRoot: input.projectRoot,
        view,
        schemaInspector: input.schemaInspector,
        session: input.session,
        focusedAccess: input.initialView === "access",
      });
      if (typeof result === "object") {
        accessNotice = result;
        continue;
      }
      if (result === "review") {
        if (input.initialView === "access") {
          const activationResult = await confirmActivateAndKeepAccessOpen(accessActivationInput);
          if (activationResult !== 0) return activationResult;
        }
        continue;
      }
      if (result !== "back" && result !== 0) return result;
      continue;
    }
    if (selected.action === "remove") {
      const result = await interactiveBoundaryResourceRemoval({
        projectRoot: input.projectRoot,
        view,
        schemaInspector: input.schemaInspector,
        session: input.session,
        focusedAccess: input.initialView === "access",
      });
      if (typeof result !== "number") {
        accessNotice = result;
        continue;
      }
      if (result !== 0) return result;
      continue;
    }
    const result = await interactiveBoundaryResourceReview({
      projectRoot: input.projectRoot,
      resourceId: selected.resource_id,
      view,
      schemaInspector: input.schemaInspector,
      session: input.session,
      focusedAccess: input.initialView === "access",
    });
    if (result === "review") {
      if (input.initialView === "access") {
        const activationResult = await confirmActivateAndKeepAccessOpen(accessActivationInput);
        if (activationResult !== 0) return activationResult;
      }
      continue;
    }
    if (result !== "back" && result !== 0) return result;
  }
}

export async function promptBoundaryMappingModel(
  session: Pick<BoundaryReviewInteractiveSession, "promptText"> & Partial<Pick<BoundaryReviewInteractiveSession, "chooseOption">>,
  currentModel?: ActionModelSuggestionSession,
  dependencies: BoundaryModelDiscoveryDependencies = {},
): Promise<ActionModelSuggestionSession | undefined> {
  const defaultBaseUrl = "http://127.0.0.1:11434/v1";
  const discoverModels = dependencies.discoverModels ?? discoverOpenAiCompatibleModels;
  const discoverHostedModels = dependencies.discoverHostedModels ?? discoverHostedProviderModels;
  const env = dependencies.env ?? process.env;
  if (currentModel) {
    const currentLabel = boundaryModelLabel(currentModel);
    const choices = [
      {
        value: "current",
        label: `Use ${currentLabel}`,
        detail: "Select this exact configured model, then review metadata egress before any request.",
      },
      {
        value: "change_model",
        label: `Change the model for ${currentModel.provider}`,
        detail: `Keeps the current provider and credential source; current model is ${currentModel.model}.`,
      },
      {
        value: "change_provider",
        label: "Choose another provider",
        detail: "Select OpenAI, Anthropic, OpenRouter, or a detected loopback model, then review its exact setup.",
      },
    ];
    let selected: "current" | "change_model" | "change_provider" | undefined;
    if (session.chooseOption) {
      selected = await session.chooseOption(
          "MODEL FOR BOUNDARY DRAFTING",
          choices,
          {
            initialValue: "current",
            requireExplicitSelection: true,
            context: [
              "Choose the exact model/provider for this job; Runner does not select one for you.",
              "The choice affects only this untrusted drafting request. No model can activate either Boundary.",
            ],
          },
        ) as typeof selected;
    } else {
      const answer = await session.promptText("Choice (1-3)", {
        context: [
          "MODEL FOR BOUNDARY DRAFTING",
          `1  Use ${currentLabel}`,
          `2  Change the model for ${currentModel.provider}`,
          "3  Choose another provider",
          "Choose explicitly; blank input does not select a model or provider.",
        ],
      });
      if (answer === undefined) return undefined;
      selected = ({
        "1": "current",
        "2": "change_model",
        "3": "change_provider",
      } as const)[answer.trim() as "1" | "2" | "3"];
      if (selected === undefined) {
        throw new Error("Choose 1, 2, or 3; Runner does not select a model or provider implicitly.");
      }
    }
    if (selected === undefined) return undefined;
    if (selected === "current") return currentModel;
    if (selected === "change_model") {
      const available = currentModel.provider === "openai_compatible"
        ? await discoverModels(currentModel.baseUrl ?? defaultBaseUrl).catch(() => [])
        : await discoverHostedModels({
            provider: currentModel.provider,
            apiKey: currentModel.apiKey
              ?? env[currentModel.apiKeyEnv ?? defaultProviderKeyEnv(currentModel.provider)]
              ?? "",
          }).catch(() => []);
      const model = await chooseBoundaryDraftingModel({
        session,
        provider: currentModel.provider,
        currentModel: currentModel.model,
        available,
      });
      return model ? { ...currentModel, model } : undefined;
    }
  }
  const detectedModels = await discoverModels(defaultBaseUrl).catch(() => []);
  const openAiReady = Boolean(env.OPENAI_API_KEY?.trim());
  const anthropicReady = Boolean(env.ANTHROPIC_API_KEY?.trim());
  const openRouterReady = Boolean(env.OPENROUTER_API_KEY?.trim());
  let providerChoice: string;
  if (session.chooseOption) {
    const detectedModel = detectedModels[0];
    const selected = await session.chooseOption(
      "CHOOSE A MODEL FOR BOUNDARY DRAFTING",
      [
        ...(detectedModel
          ? [{
              value: "detected_local",
              label: `Local Ollama ${detectedModel}  [detected]`,
              detail: "Uses the bounded loopback endpoint; no API key or extra setup prompt.",
            }]
          : []),
        {
          value: "openai",
          label: `OpenAI${openAiReady ? "  [ready]" : ""}`,
          detail: openAiReady ? "Uses OPENAI_API_KEY without printing or persisting its value." : "Requires an API key environment variable.",
        },
        {
          value: "anthropic",
          label: `Anthropic${anthropicReady ? "  [ready]" : ""}`,
          detail: anthropicReady ? "Uses ANTHROPIC_API_KEY without printing or persisting its value." : "Requires an API key environment variable.",
        },
        {
          value: "openrouter",
          label: `OpenRouter${openRouterReady ? "  [ready]" : ""}`,
          detail: `Uses OPENROUTER_API_KEY. Requests go through ${OPENROUTER_EGRESS}.`,
        },
        {
          value: "openai_compatible",
          label: detectedModel ? "Another local OpenAI-compatible endpoint" : "Local OpenAI-compatible endpoint",
          detail: "Runner lists model names only from a loopback endpoint.",
        },
      ],
      {
        requireExplicitSelection: true,
        context: [
          "Choose the provider explicitly; Runner does not select one from detected credentials or local models.",
          "The model receives reviewed structural metadata only after your egress confirmation.",
          "Its result is an untrusted draft. Runner revalidates every exact identifier, operation, bound, and policy.",
        ],
      },
    );
    if (selected === undefined) return undefined;
    if (selected === "detected_local") {
      const model = await chooseBoundaryDraftingModel({
        session,
        provider: "openai_compatible",
        currentModel: detectedModel!,
        available: detectedModels,
      });
      if (!model) return undefined;
      return {
        provider: "openai_compatible",
        model,
        baseUrl: defaultBaseUrl,
      };
    }
    providerChoice = selected;
  } else {
    const providerText = await session.promptText(
      "Provider (1-4)",
      {
        context: [
          "CHOOSE A MODEL FOR BOUNDARY DRAFTING",
          "1  OpenAI",
          "2  Anthropic",
          `3  Local OpenAI-compatible endpoint${detectedModels[0] ? ` (detected ${detectedModels[0]})` : ""}`,
          "4  OpenRouter",
          "",
          "The provider maps structural metadata to an untrusted proposal. Runner validates every exact identifier and operation.",
        ],
      },
    );
    if (providerText === undefined) return undefined;
    providerChoice = providerText.trim().toLowerCase();
  }
  const provider = providerChoice === "1" || providerChoice === "openai"
    ? "openai"
    : providerChoice === "2" || providerChoice === "anthropic"
      ? "anthropic"
      : providerChoice === "3" || providerChoice === "local" || providerChoice === "openai_compatible"
        ? "openai_compatible"
        : providerChoice === "4" ? "openrouter" : providerChoice;
  if (provider !== "openai" && provider !== "anthropic" && provider !== "openrouter" && provider !== "openai_compatible") {
    throw new Error("Provider must be openai, anthropic, openrouter, or openai_compatible.");
  }

  if (provider === "openai_compatible") {
    const baseText = await session.promptText(
      `Local model endpoint [${defaultBaseUrl}]`,
      {
        context: [
          "LOCAL MODEL",
          "Runner will inspect this loopback endpoint for installed model names. Blank Enter uses Ollama's default endpoint.",
          "No API key is required for the loopback path.",
        ],
      },
    );
    if (baseText === undefined) return undefined;
    const baseUrl = baseText.trim() || defaultBaseUrl;
    const modelsAtEndpoint = baseUrl === defaultBaseUrl
      ? detectedModels
      : await discoverModels(baseUrl).catch(() => []);
    const defaultModel = modelsAtEndpoint[0] ?? "llama3.2";
    const model = await chooseBoundaryDraftingModel({
      session,
      provider,
      currentModel: defaultModel,
      available: modelsAtEndpoint,
    });
    if (!model) return undefined;
    return {
      provider,
      model,
      baseUrl,
    };
  }

  const defaultModel = defaultHostedModel(provider);
  const keyDefault = defaultProviderKeyEnv(provider);
  const keyText = await session.promptText(`API key environment variable [${keyDefault}]`);
  if (keyText === undefined) return undefined;
  const keyEnv = keyText.trim() || keyDefault;
  const available = await discoverHostedModels({
    provider,
    apiKey: env[keyEnv] ?? "",
  }).catch(() => []);
  const model = await chooseBoundaryDraftingModel({
    session,
    provider,
    currentModel: defaultModel,
    available,
  });
  if (!model) return undefined;
  return {
    provider,
    model,
    apiKeyEnv: keyEnv,
  };
}

async function chooseBoundaryDraftingModel(input: {
  session: Pick<BoundaryReviewInteractiveSession, "promptText"> & Partial<Pick<BoundaryReviewInteractiveSession, "chooseOption">>;
  provider: ActionModelSuggestionSession["provider"];
  currentModel: string;
  available: string[];
}): Promise<string | undefined> {
  const models = [input.currentModel, ...input.available]
    .map((model) => model.trim())
    .filter((model, index, values) => model && values.indexOf(model) === index)
    .slice(0, 100);
  if (input.session.chooseOption && input.available.length) {
    const exactValue = "__exact_model_id__";
    const latestListed = input.available[0];
    const selected = await input.session.chooseOption(
      "MODEL FOR BOUNDARY DRAFTING",
      [
        ...models.map((model) => ({
          value: model,
          label: `${model}${model === input.currentModel && model === latestListed
            ? "  [current, latest listed]"
            : model === input.currentModel
              ? "  [current]"
              : model === latestListed
                ? "  [latest listed]"
                : ""}`,
          detail: model === input.currentModel
            ? "Keep the currently configured exact model."
            : `Available from ${input.provider === "openai_compatible" ? "the selected loopback endpoint" : `${input.provider}'s model catalog`}.`,
        })),
        {
          value: exactValue,
          label: "Advanced: enter an exact model ID",
          detail: "Use when a compatible model is not returned by provider discovery.",
        },
      ],
      {
        initialValue: input.currentModel,
        context: [
          "Use Up/Down and Enter. Runner lists only bounded compatible candidates returned by the selected provider.",
          "The choice affects drafting only and grants no Boundary authority.",
        ],
      },
    );
    if (selected === undefined) return undefined;
    if (selected !== exactValue) return selected;
  }
  const exact = await input.session.promptText(`Exact model ID [${input.currentModel}]`, {
    context: input.available.length
      ? ["ADVANCED MODEL ID", "Enter an exact compatible model ID, or leave blank to keep the current model."]
      : [
          "MODEL CATALOG UNAVAILABLE",
          "Runner could not list models from the selected provider. Enter an exact compatible model ID or keep the current model.",
        ],
  });
  return exact === undefined ? undefined : exact.trim() || input.currentModel;
}

function boundaryModelLabel(model: Pick<ActionModelSuggestionSession, "provider" | "model">): string {
  return `${model.provider}[${model.model}]`;
}

export function boundaryAuthoringResumeBinding(
  bundle: BoundaryReviewBundle,
): BoundaryAuthoringResumeBinding {
  return {
    boundary_name: bundle.candidate.pack.name,
    generation_lock_fingerprint: bundle.authority.generation_lock_fingerprint,
    schema_fingerprint: bundle.authority.schema_fingerprint,
    role_posture_fingerprint: bundle.authority.role_posture_fingerprint,
  };
}

function boundaryAuthoringResumeModelSession(
  saved: BoundaryAuthoringResumeState,
  current: ActionModelSuggestionSession | undefined,
  env: NodeJS.ProcessEnv,
): ActionModelSuggestionSession | undefined {
  if (current?.provider === saved.model.provider) {
    return { ...current, model: saved.model.name };
  }
  if (saved.model.provider === "openai" && env.OPENAI_API_KEY?.trim()) {
    return {
      provider: "openai",
      model: saved.model.name,
      apiKeyEnv: "OPENAI_API_KEY",
    };
  }
  if (saved.model.provider === "anthropic" && env.ANTHROPIC_API_KEY?.trim()) {
    return {
      provider: "anthropic",
      model: saved.model.name,
      apiKeyEnv: "ANTHROPIC_API_KEY",
    };
  }
  if (saved.model.provider === "openrouter" && env.OPENROUTER_API_KEY?.trim()) {
    return { provider: "openrouter", model: saved.model.name, apiKeyEnv: "OPENROUTER_API_KEY" };
  }
  // Custom loopback endpoints are deliberately not persisted. A matching
  // current session can resume them; otherwise the operator chooses again.
  return undefined;
}

function conciseBoundaryJobIntent(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69)}...`;
}

function formatBoundaryAuthoringStage(stage: BoundaryAuthoringResumeStage): string {
  return ({
    planning: "job planning",
    read_mapping: "Read mapping",
    action_drafting: "Action drafting",
    authority_review: "authority review",
    client_setup: "client connection setup",
  } as const)[stage];
}

function modelSafeBoundaryJobStateFacts(state: BoundaryJobCurrentState): string[] {
  const hasReusableState = state.read.authority !== "disabled"
    || state.read.exact_reusable_revision_count > 0
    || (state.read.resumable_draft_count ?? 0) > 0
    || state.actions.length > 0;
  if (!hasReusableState) return [];
  const readState = state.read.authority === "active"
    ? "active"
    : state.read.authority === "active_with_disabled_changes"
      ? "active with a newer disabled draft"
      : state.read.fully_reviewed
        ? "reviewed and disabled"
        : "disabled draft";
  const facts = [
    `Current Read Boundary ${state.read.boundary_name}: ${readState}; ${state.read.resource_ids.length} reviewed resource${state.read.resource_ids.length === 1 ? "" : "s"}.`,
  ];
  for (const action of state.actions.slice(0, 6)) {
    const identity = action.outcome ?? action.capability;
    const target = action.operation && action.resource
      ? `; ${action.operation.toUpperCase()} ${action.resource}`
      : "";
    facts.push(`Current Action ${identity}: ${action.authority}${target}.`);
  }
  if (state.actions.length > 6) {
    facts.push(`${state.actions.length - 6} additional reviewed Action outcome${state.actions.length - 6 === 1 ? " is" : "s are"} available in exact details.`);
  }
  facts.push("Trusted scope remains Runner-injected; approval history remains in Runner's proposal ledger.");
  return facts;
}

function modelSafePermissionFacts(lines: string[], maxLines = 20): string[] {
  return lines
    .map((line) => /^Excluded fields:/u.test(line) ? "Excluded fields stay unavailable; their names are in local operator details." : line)
    .map((line) => line
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
      .replace(/sha256:[a-f0-9]+/giu, "[operator-only digest]")
      .trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/(?:fingerprint|\bdigest\b|proposal hash|credential|password|api[_ -]?key|endpoint|database url|\bsql\b)/iu.test(line))
    .filter((line) => !/\b(?:tenant|principal)(?:[_ -]?id)?\b/iu.test(line))
    .slice(0, maxLines);
}

function boundaryAuthoringProviderDependencies(
  dependencies: AskProviderDependencies | undefined,
  chat: BoundaryAuthoringChat | undefined,
): AskProviderDependencies | undefined {
  if (!chat) return dependencies;
  return {
    ...dependencies,
    ...(chat.signal ? { signal: dependencies?.signal ? AbortSignal.any([dependencies.signal, chat.signal]) : chat.signal } : {}),
    onStream: (event) => {
      dependencies?.onStream?.(event);
      chat.providerStream(event);
    },
  };
}

function boundaryAuthoringModelSession(
  session: ActionModelSuggestionSession,
  chat: BoundaryAuthoringChat | undefined,
): ActionModelSuggestionSession {
  const dependencies = boundaryAuthoringProviderDependencies(session.dependencies, chat);
  return {
    ...session,
    ...(dependencies ? { dependencies } : {}),
  };
}

function isBoundaryAuthoringExplanationQuestion(value: string): boolean {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) return false;
  return /^(?:why\b|what\s+(?:does|do|is|are|will|would|happens?)\b|how\b|when\b|where\b|who\b|do\s+i\b|does\s+this\b|is\s+this\b|are\s+these\b|can\s+(?:i|you|runner|the model)\b|could\s+(?:i|you|runner|the model)\b|would\s+you\b|please\s+(?:explain|clarify)\b|explain\b|help\s+me\s+understand\b)/iu
    .test(normalized);
}

async function promptModelGuidedActionClarification(input: {
  question: string;
  session: BoundaryReviewInteractiveSession;
  modelSession: ActionModelSuggestionSession;
  authoringChat?: BoundaryAuthoringChat;
  narrator?: typeof narrateValidatedAuthoringStep;
}): Promise<string | undefined> {
  const context = [
    "MODEL QUESTION",
    "Answer only the business meaning. Runner resolves database keys, trusted scope, locks, SQL, and approval-ledger mechanics.",
    "You may ask why this decision is needed before answering. No authority or source data changes while it is open.",
  ];
  let answer = await input.session.promptText(input.question, { context });
  if (!input.authoringChat) return answer;

  const narrator = input.narrator ?? narrateValidatedAuthoringStep;
  let explanationTurns = 0;
  while (answer !== undefined && isBoundaryAuthoringExplanationQuestion(answer)) {
    if (explanationTurns >= 2) {
      input.authoringChat.checkpoint("Pending business decision unchanged", [
        "Two optional model explanations were used for this one decision.",
        "Answer the pending question, use /details, or press Esc to pause safely.",
      ], "warning");
      answer = input.authoringChat.readOperator
        ? await input.authoringChat.readOperator()
        : await input.session.promptText(input.question, { context });
      continue;
    }
    explanationTurns += 1;
    const operatorQuestion = answer.trim();
    const explanation = await input.authoringChat.progress(
      `${boundaryModelLabel(input.modelSession)} is answering your question`,
      () => narrator({
        session: input.modelSession,
        operatorMessage: operatorQuestion,
        validatedFacts: [
          `Pending business decision: ${input.question}`,
          "Runner needs an operator-owned business answer before it can validate the disabled Action draft.",
          "No answer has been recorded for this decision yet.",
          "The current Read and Action authority, approval posture, and source database are unchanged.",
          "Explain the reason for this question and its practical effect without inventing a value.",
        ],
        nextQuestion: input.question,
        egressAcknowledged: true,
      }),
    );
    if (explanation?.trim()) {
      await input.authoringChat.streamModel(explanation.trim().split(/\r?\n/u));
    } else {
      input.authoringChat.checkpoint("Model explanation unavailable", [
        "The pending business decision is unchanged. Use /details, answer it now, or press Esc to pause safely.",
      ], "warning");
    }
    answer = input.authoringChat.readOperator
      ? await input.authoringChat.readOperator()
      : await input.session.promptText(input.question, { context });
  }
  return answer;
}

function boundaryAuthoringProviderOptions(
  dependencies: AskProviderDependencies | undefined,
  chat: BoundaryAuthoringChat | undefined,
): { dependencies?: AskProviderDependencies } {
  const streamed = boundaryAuthoringProviderDependencies(dependencies, chat);
  return streamed ? { dependencies: streamed } : {};
}

async function showBoundaryAuthoringFailure(
  session: BoundaryReviewInteractiveSession,
  error: unknown,
  firstRun: boolean,
): Promise<"resume" | "manual" | "pause"> {
  const notice = boundaryModelAssistFailureNotice(error, firstRun);
  const details = [...notice.lines, ...(notice.footer ? [notice.footer] : [])];
  session.rememberDetails?.("SETUP FAILURE DETAILS", details);
  if (error instanceof AskError && error.code === "ASK_CANCELLED"
    || error instanceof Error && error.message === "ACTION_RULE_MODEL_DRAFT_CANCELLED") {
    session.present?.("Setup paused", ["Your saved work is available when you resume."], "warning");
    return "pause";
  }
  const summary = ["This setup step could not finish. Your saved job can be reopened without starting over.",
    ...notice.lines, "Recovery choices do not enable permissions or change customer data."];
  if (!session.chooseOption) {
    await showManualReadActivationBlocker(session, "Setup needs attention", summary);
    return "pause";
  }
  while (true) {
    const choice = await session.chooseOption("SETUP NEEDS ATTENTION", [
      { value: "resume", label: "Reopen saved setup", detail: "Retain your job and rules; retry only after resolving the reported prerequisite." },
      { value: "details", label: "Inspect the exact failure", detail: "Local diagnostics; no model request or permission change." },
      { value: "pause", label: "Save and continue later" },
      { value: "manual", label: "Open the manual editor" },
    ], { initialValue: "pause", reviewOnly: true, displayContext: true, context: summary });
    if (choice === "details") {
      await showManualReadActivationBlocker(session, "Setup failure details", details);
    } else return choice === "resume" || choice === "manual" ? choice : "pause";
  }
}

function boundaryModelAssistFailureNotice(
  error: unknown,
  firstRun: boolean,
): BoundaryAccessNotice {
  if (error instanceof AskError && error.code === "ASK_REQUIRED_TOOL_NOT_CALLED") {
    return {
      tone: "danger",
      title: "The selected model could not draft a structured Boundary.",
      lines: [
        "Runner discarded two prose responses because neither called the required bounded authoring tool.",
        "Use a larger local model with reliable tool calling, or open Agent job with W and select Runner-guided recommended draft.",
        "No model output was accepted.",
      ],
      footer: firstRun
        ? "Active authority and source data are unchanged. Open Agent job again with W or edit manually."
        : "Active authority and source data are unchanged.",
    };
  }
  if (error instanceof Error && error.message === "ACTION_RULE_MODEL_DRAFT_CANCELLED") {
    return { tone: "warning", title: "Boundary conversation paused.",
      lines: ["Saved disabled components and completed outcomes remain available. Active authority and source data are unchanged."],
      footer: "Open model drafting again and choose Resume the interrupted job." };
  }
  return {
    tone: "danger",
    title: "Agent job setup stopped safely.",
    lines: [redactCliErrorMessage(error instanceof Error ? error.message : String(error))],
    footer: firstRun
      ? "Active authority and source data are unchanged. Open Agent job again with W or edit manually."
      : "Active authority and source data are unchanged.",
  };
}

function withBoundaryModelProgress<T>(
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  return process.stderr.isTTY
    ? withTerminalProgress(process.stderr, message, operation)
    : operation();
}

async function promptReadBoundaryClarification(input: {
  session: BoundaryReviewInteractiveSession;
  model: ActionModelSuggestionSession;
  request: ModelReadClarificationRequest;
}): Promise<ModelReadClarificationDecision> {
  const exactTarget = `${input.request.resource}${input.request.field ? `.${input.request.field}` : ""}`;
  const answer = await input.session.promptText(input.request.question, {
    context: [
      "CLARIFY ONE REVIEWED NAME",
      `Exact reviewed metadata: ${exactTarget}`,
      `Why the model stopped: ${input.request.reason}`,
      `Your answer will be sent to ${boundaryModelLabel(input.model)} for one bounded remapping call.`,
      "Explain only the business meaning. Do not paste rows, credentials, personal data, or trusted tenant/principal values.",
      "Runner will validate the resulting exact plan and will not grant or activate authority.",
    ],
  });
  return answer?.trim()
    ? { state: "answered", answer: answer.trim() }
    : { state: "declined" };
}

async function promptReadBoundaryValueContext(input: {
  session: BoundaryReviewInteractiveSession;
  model: ActionModelSuggestionSession;
  request: ModelReadValueRequest;
}): Promise<ModelReadValueContextDecision> {
  const context = [
    `Exact reviewed field: ${input.request.resource}.${input.request.field}`,
    `Model reason: ${input.request.reason}`,
    `Model question: ${input.request.question}`,
    "Runner has not queried this field and will not sample rows automatically.",
    "Native ENUM and enforced CHECK allowlists are already structural metadata; observed row values need this separate decision.",
  ];
  const route = input.session.chooseOption
    ? await input.session.chooseOption("MODEL REQUESTED READ VALUE CONTEXT", [
        {
          value: "provide",
          label: "Provide exact values yourself",
          detail: "Runner previews what you type and asks again before one bounded model request.",
        },
        {
          value: "without",
          label: "Continue without observed values [recommended]",
          detail: "No source query or value egress; the model must use reviewed structural metadata only.",
        },
      ], { context, initialValue: "without" })
    : (await input.session.confirm(
        "Provide exact values yourself for one separately confirmed model request?",
        { context: ["MODEL REQUESTED READ VALUE CONTEXT", ...context], defaultValue: false },
      ))
      ? "provide"
      : "without";
  if (route !== "provide") return { state: "without_values" };

  let warning: string | undefined;
  while (true) {
    const raw = await input.session.promptText(
      `Exact ${input.request.field} values to provide (comma separated)`,
      {
        context: [
          "TYPE ONLY THE VALUES YOU APPROVE FOR EGRESS",
          `Field: ${input.request.resource}.${input.request.field}`,
          "Runner will not query the database. Only values typed here can enter the next model request.",
          "Do not paste credentials, tokens, personal data, or unrestricted row samples.",
          ...(warning ? [`Not accepted: ${warning}`] : []),
        ],
      },
    );
    if (raw === undefined) return { state: "without_values" };
    const values = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
    if (!values.length || values.length > 32 || values.some((value) => value.length > 200)) {
      warning = "enter 1 through 32 values, each at most 200 characters";
      continue;
    }
    if (JSON.stringify(values).length > 4_000) {
      warning = "the total approved value context must stay within 4,000 characters";
      continue;
    }
    if (values.some((value) => /(?:postgres(?:ql)?|mysql):\/\/|BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]+/i.test(value))) {
      warning = "the input appears to contain a credential or secret";
      continue;
    }
    const send = await input.session.confirm(
      `Send only these ${values.length} value${values.length === 1 ? "" : "s"} to ${boundaryModelLabel(input.model)} for one bounded Read mapping request?`,
      {
        context: [
          "CONFIRM READ VALUE EGRESS",
          `Field: ${input.request.resource}.${input.request.field}`,
          ...values.map((value) => `  ${value}`),
          "If the model uses a value, it may appear in the disabled workload proposal shown for review; it is not active authority until you confirm the boundary separately.",
          "Source query executed: no | authority granted: no | source database changed: no",
        ],
        defaultValue: false,
      },
    );
    return send
      ? {
          state: "provided",
          resource: input.request.resource,
          field: input.request.field,
          values,
          egressAcknowledged: true,
        }
      : { state: "without_values" };
  }
}

function recoverableBoundaryProviderFailure(error: unknown): BoundaryModelDraftFailure | undefined {
  if (!(error instanceof AskError)) return undefined;
  if (error.code === "ASK_REQUIRED_TOOL_NOT_CALLED") return { kind: "required_tool" };
  if (["ASK_PROVIDER_RESPONSE_INVALID", "ASK_TOOL_ARGUMENTS_INVALID"].includes(error.code)) {
    return { kind: "provider_format", reason: `${error.code}: ${redactCliErrorMessage(error.message)}` };
  }
  return undefined;
}

type BoundaryModelDraftFailure =
  | { kind: "required_tool" }
  | { kind: "provider_format"; reason: string }
  | { kind: "read_diagnostic"; diagnostics: ReadWorkloadDiagnostic[] }
  | { kind: "reviewed_grammar"; blockers: string[]; details?: string[] };

function recoverableActionModelDraftFailure(error: unknown): BoundaryModelDraftFailure | undefined {
  const providerFailure = recoverableBoundaryProviderFailure(error);
  if (providerFailure) return providerFailure;
  if (!(error instanceof Error)) return undefined;
  if (/^ACTION_SUGGESTION_(?:SET_)?NOT_SUBMITTED:/i.test(error.message)) {
    return { kind: "required_tool" };
  }
  const blocked = /^ACTION_SUGGESTION_(?:SET_)?BLOCKED:\s*(.*)$/is.exec(error.message);
  if (!blocked) return undefined;
  return {
    kind: "reviewed_grammar",
    blockers: [blocked[1]?.trim() || "The proposed action did not fit the reviewed Action Boundary grammar."],
  };
}

function recoverableActionRuleModelDraftFailure(error: unknown): BoundaryModelDraftFailure | undefined {
  const providerFailure = recoverableBoundaryProviderFailure(error);
  if (providerFailure) return providerFailure;
  if (!(error instanceof Error)) return undefined;
  if (/^ACTION_RULE_(?:AUTHORING_)?(?:NOT_SUBMITTED|CLARIFICATION_REQUIRED):/iu.test(error.message)) {
    return { kind: "required_tool" };
  }
  const blocked = /^(?:ACTION_RULE_[A-Z0-9_]+):\s*(.*)$/isu.exec(error.message);
  if (!blocked) return undefined;
  const exact = (blocked[1]?.trim() || "The verified outcome did not fit the reviewed Action Rule grammar.")
    .replace(/^(?:(?:ACTION_RULE_[A-Z0-9_]+):\s*)+/iu, "");
  const summary = actionRuleModelFailureSummary(exact);
  return {
    kind: "reviewed_grammar",
    blockers: [summary],
    ...(summary === exact ? {} : { details: [summary, `Exact local validation: ${exact}`] }),
  };
}

function actionRuleModelFailureSummary(message: string): string {
  const target = /reviewed\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s+(?:subject\s+)?row/iu.exec(message)?.[1]
    ?? /UPDATE\s+([A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_.:-]*)/iu.exec(message)?.[1];
  if (/multiple reviewed .* subject rows|TARGET_AMBIGUOUS/iu.test(message)) {
    return target
      ? `Runner found more than one reviewed ${target} row that could be changed and will not guess which business object the agent meant.`
      : "Runner found more than one reviewed row that could be changed and will not guess which business object the agent meant.";
  }
  if (/target_binding|subject target binding|which reviewed .* row .* update|TARGET_(?:INVALID|UNAVAILABLE)/iu.test(message)) {
    return target
      ? `Runner could not identify one exact reviewed ${target} row for the proposed change. No Action draft was saved.`
      : "Runner could not identify one exact reviewed row for the proposed change. No Action draft was saved.";
  }
  return message;
}

function recoverableReadModelDraftFailure(error: unknown): BoundaryModelDraftFailure | undefined {
  if (error instanceof ReadWorkloadDraftError) return { kind: "read_diagnostic", diagnostics: error.diagnostics };
  const providerFailure = recoverableBoundaryProviderFailure(error);
  if (providerFailure) return providerFailure;
  if (!(error instanceof Error)) return undefined;
  if (/^READ_WORKLOAD_NOT_SUBMITTED:/i.test(error.message)) return { kind: "required_tool" };
  if (/^READ_WORKLOAD_(?:ASSISTANCE_REQUEST_REPEATED|CLARIFICATION_DECLINED|CLARIFICATION_REQUIRED|OPAQUE_METADATA_CLARIFICATION_REQUIRED|VALUE_CONTEXT_REQUIRED):/i.test(error.message)) {
    return { kind: "reviewed_grammar", blockers: [error.message] };
  }
  return undefined;
}

async function promptRunnerGuidedModelFallback(input: {
  session: BoundaryReviewInteractiveSession;
  provider: ActionModelSuggestionSession["provider"];
  model: string;
  stage: "Read Boundary" | "Action Boundary";
  allowModelRetry?: boolean;
  allowRunnerFallback?: boolean;
  failure?: BoundaryModelDraftFailure;
}): Promise<"runner" | "retry" | "change_model" | "back"> {
  const grammarFailure = input.failure?.kind === "reviewed_grammar" ? input.failure : undefined;
  const providerFailure = input.failure?.kind === "provider_format" ? input.failure : undefined;
  const diagnostics = input.failure?.kind === "read_diagnostic" ? input.failure.diagnostics : undefined;
  const lastDiagnostic = diagnostics?.at(-1);
  const clarificationPaused = grammarFailure?.blockers.some((blocker) =>
    /^READ_WORKLOAD_CLARIFICATION_DECLINED:/iu.test(blocker));
  const title = `${input.stage.toUpperCase()} MODEL DRAFT FAILED`;
  const context = lastDiagnostic
    ? [
        lastDiagnostic.category === "validation"
          ? "Runner received the structured submission, but its Read validation rejected it."
          : lastDiagnostic.category === "provider_response"
            ? "Runner could not parse the provider response or its tool arguments."
            : lastDiagnostic.category === "provider_request"
              ? "The provider request did not complete. This is not a Read workload validation refusal."
              : "The response did not contain exactly the required Read authoring tool call.",
        ...lastDiagnostic.reasons.slice(0, 2).map((reason) => `Why: ${reason}`),
        "No model output became authority and no source query or write ran.",
        "Keep your job unchanged to retry. View failure details for each attempt.",
      ]
    : providerFailure
      ? [
          `${boundaryModelLabel(input)} returned a malformed response or tool arguments.`,
          providerFailure.reason,
          "No model output became authority and no source query or write ran.",
          "Retry the same job or choose another model; manual guidance remains optional.",
        ]
    : grammarFailure
    ? [
        clarificationPaused
          ? "Read drafting paused because the business clarification was left unanswered. No model draft was accepted."
          : `${boundaryModelLabel(input)} submitted a structured ${input.stage} draft, but Runner validation refused it.`,
        ...grammarFailure.blockers.slice(0, 4).map((blocker) => `Why: ${blocker}`),
        "The rejected draft was not saved or executed. No model output became authority and no source query or write ran.",
        "The deterministic path reuses this job and reviewed structural catalog; you still review the exact disabled draft.",
      ]
    : [
        `${boundaryModelLabel(input)} did not complete the required bounded ${input.stage} authoring tool submission.`,
        "Runner discarded the responses. No model output became authority and no source query or write ran.",
        "The deterministic path uses the same job and reviewed structural catalog; you still review the exact disabled draft.",
      ];
  const failureDetails = diagnostics
    ? [
        `Provider: ${boundaryModelLabel(input)}`,
        ...readWorkloadDiagnosticLines(diagnostics),
        diagnostics.some((diagnostic) => diagnostic.phase === "correction")
          ? "The internal correction did not complete a valid Read draft."
          : "No internal correction failure was recorded.",
        "No model output became authority and no source query or write ran. Existing active authority is unchanged.",
      ]
    : grammarFailure?.details
    ? [
        `${boundaryModelLabel(input)} submitted a structured ${input.stage} draft, but Runner validation refused it.`,
        ...grammarFailure.details,
        "The rejected draft was not saved or executed. No model output became authority and no source query or write ran.",
      ]
    : context;
  const detailsContext = input.stage === "Read Boundary"
    ? [...failureDetails, "Any saved disabled mapping catalog is Runner's intermediate metadata workspace, not an accepted model draft or active access."]
    : failureDetails;
  input.session.rememberDetails?.(title, detailsContext);
  if (input.session.chooseOption) {
    while (true) {
      const selected = await input.session.chooseOption(
        title,
        [
          ...(input.allowModelRetry
            ? [
                {
                  value: "retry",
                  label: `Retry once with ${boundaryModelLabel(input)}`,
                  detail: "Starts one additional bounded drafting attempt; the rejected draft remains discarded.",
                },
                {
                  value: "change_model",
                  label: "Choose another model and retry once",
                  detail: "Review the replacement model and its metadata egress before one additional bounded attempt.",
                },
              ]
            : []),
          {
            value: "details",
            label: `View why ${input.stage} drafting failed`,
            detail: "Shows the exact local failure stage and validation reason without another model request.",
          },
          ...(input.allowRunnerFallback === false
            ? []
            : [{
                value: "runner",
                label: "Continue without a model",
                detail: "Runner's deterministic path uses the same job and reviewed catalog; no further model requests.",
              }]),
          {
            value: "back",
            label: "Back to Agent job",
            detail: "The broad authoring catalog remains disabled; active authority is unchanged.",
          },
        ],
        {
          initialValue: input.allowModelRetry ? "retry" : "back",
          context,
        },
      );
      if (selected === "details") {
        input.session.present?.(`${input.stage.toUpperCase()} FAILURE DETAILS`, detailsContext, "danger");
        continue;
      }
      return selected === "runner" || selected === "retry" || selected === "change_model"
        ? selected
        : "back";
    }
  }
  if (input.allowRunnerFallback === false) return "back";
  const accepted = await input.session.confirm(
    "Continue this same job with Runner's deterministic recommended draft?",
    {
      defaultValue: true,
      context: [title, ...context],
    },
  );
  return accepted ? "runner" : "back";
}

function boundaryJobPlanningFailureReason(error: unknown): string {
  if (error instanceof BoundaryJobPlanningError) return planningDiagnosticLines(error.diagnostic).join("\n");
  if (error instanceof AskError && error.code === "ASK_REQUIRED_TOOL_NOT_CALLED") {
    return "The model did not submit the required typed Read/Action job plan.";
  }
  if (error instanceof Error && /^BOUNDARY_JOB_PLAN_INVALID:/iu.test(error.message)) {
    return "The model response did not match Runner's typed Read/Action planning contract.";
  }
  if (error instanceof Error) {
    return `Runner could not finish the planning step: ${redactCliErrorMessage(error.message).slice(0, 700)}`;
  }
  return "Runner could not finish the planning step. No new draft was saved.";
}

async function promptBoundaryJobPlanningFallback(input: {
  session: BoundaryReviewInteractiveSession;
  model: ActionModelSuggestionSession;
  allowAdditionalAttempt: boolean;
  failure?: unknown;
  unresolvedQuestion?: string;
}): Promise<"runner" | "retry" | "change_model" | "back"> {
  const title = "BOUNDARY JOB PLANNING DID NOT COMPLETE";
  const reason = input.unresolvedQuestion
    ? "The model still needs a business clarification before it can separate Read and Action work."
    : boundaryJobPlanningFailureReason(input.failure);
  const context = [
    `Boundary planning with ${boundaryModelLabel(input.model)} could not finish${input.failure instanceof BoundaryJobPlanningError && input.failure.diagnostic.attempts.length > 1 ? " after one correction" : ""}.`,
    reason,
    ...(input.unresolvedQuestion ? [`Unresolved question: ${input.unresolvedQuestion}`] : []),
    "Runner discarded the response before staging a mapping catalog or changing a Boundary draft.",
    "Active authority and source data are unchanged.",
  ];
  input.session.rememberDetails?.(title, context);
  if (input.session.chooseOption) {
    while (true) {
      const selected = await input.session.chooseOption(
        title,
        [
          {
            value: "runner",
            label: "Prepare a deterministic starting draft",
            detail: "Not an equivalent policy interpretation. Retain the attachment; unresolved requirements must still be checked before activation.",
          },
          ...(input.allowAdditionalAttempt
            ? [
                {
                  value: "retry",
                  label: `Retry once with ${boundaryModelLabel(input.model)}`,
                  detail: "Start one new bounded planning request; the rejected response stays discarded.",
                },
                {
                  value: "change_model",
                  label: "Choose another model and retry once",
                  detail: "Review replacement-model metadata egress before one new bounded planning request.",
                },
              ]
            : []),
          {
            value: "details",
            label: "View the local planning failure",
            detail: "Show the safe failure category without another model request or state change.",
          },
          {
            value: "back",
            label: "Pause this job",
            detail: "Keep every existing Read and Action Boundary exactly as it was.",
          },
        ],
        { initialValue: input.allowAdditionalAttempt ? "retry" : "back", context },
      );
      if (selected === "details") {
        input.session.present?.(title, context, "warning");
        continue;
      }
      return selected === "runner" || selected === "retry" || selected === "change_model"
        ? selected
        : "back";
    }
  }
  const accepted = await input.session.confirm(
    "Prepare a deterministic starting draft and recheck the full attached policy?",
    { defaultValue: false, context: [title, ...context] },
  );
  return accepted ? "runner" : "back";
}

type ReviewedJobPrincipalScope =
  | { kind: "direct"; value: string; label: string; confidence: "low" | "medium" | "high" }
  | { kind: "derived"; value: string; label: string; confidence: "catalog_proven" }
  | { kind: "postgres_rls"; value: string; label: string; confidence: "review_required" };

function jobRequestsPrincipalIsolation(intent: string): boolean {
  const normalized = intent.replace(/[_-]+/gu, " ");
  return /\b(?:my|mine)\b/iu.test(normalized)
    || /\b(?:their|his|her|its|user(?:'s)?|customer(?:'s)?|agent(?:'s)?|operator(?:'s)?)\s+own\b/iu.test(normalized)
    || /\bown\s+(?:account|profile|record|row|ticket|case|request|order|work|history|data|preference|setting)s?\b/iu.test(normalized)
    || /\bauthenticated\s+(?:user|customer|agent|operator|member|employee|dispatcher|principal)\b/iu.test(normalized)
    || /\bper\s+(?:user|customer|agent|operator|member|employee|dispatcher|principal)\b/iu.test(normalized);
}

function reviewedJobPrincipalScopeOptions(
  view: BoundaryResourceReviewView,
): ReviewedJobPrincipalScope[] {
  const fields = new Map(view.fields.map((field) => [field.name, field]));
  const direct = [...new Set(view.principal_key.candidates)]
    .filter((field) => fields.get(field)?.nullable === false)
    .map((field): ReviewedJobPrincipalScope => {
      const confidence = view.principal_key.alternatives_considered
        .find((candidate) => candidate.value === field)?.confidence ?? "low";
      return {
        kind: "direct",
        value: field,
        label: `column ${field} [${confidence}-confidence candidate]`,
        confidence,
      };
    });
  const derived = (view.derived_principal_scope?.candidates ?? []).map(
    (scope): ReviewedJobPrincipalScope => ({
      kind: "derived",
      value: scope.path_id,
      label: `catalog-proven mandatory path ${formatDerivedScopePath(scope)}`,
      confidence: "catalog_proven",
    }),
  );
  const postgresRls = (view.rls?.principal_setting_candidates ?? [])
    .filter((setting) => setting !== view.candidate?.rls_session?.tenant_setting)
    .map((setting): ReviewedJobPrincipalScope => ({
      kind: "postgres_rls",
      value: setting,
      label: `PostgreSQL RLS setting ${setting} [meaning requires review]`,
      confidence: "review_required",
    }));
  return [...direct, ...derived, ...postgresRls];
}

function briefPrincipalScopeLabel(scope: ReviewedJobPrincipalScope): string {
  if (scope.kind === "direct") return `${scope.value} (${scope.confidence} confidence)`;
  if (scope.kind === "postgres_rls") return `${scope.value} (PostgreSQL RLS)`;
  return `${scope.value} (catalog proven)`;
}

function hasReviewedJobPrincipalScope(view: BoundaryResourceReviewView): boolean {
  return Boolean(view.candidate && hasReviewedPrincipalScope(view.candidate));
}

function reconcileModelWorkloadScopeProjection(
  workload: ReadWorkloadSet,
  boundary: ExplorationBoundaryDraft,
): { workload: ReadWorkloadSet; removed: string[]; blockers: string[] } {
  if (workload.source.kind !== "model") return { workload, removed: [], blockers: [] };
  const resources = new Map(boundary.pack.resources.map((resource) => [resource.id, resource]));
  const removed: string[] = [];
  const blockers: string[] = [];
  const allowed = workload.allowed.map((entry) => {
    if (entry.plan.kind !== "rows" || typeof entry.plan.resource !== "string" || !Array.isArray(entry.plan.select)) {
      return entry;
    }
    const resource = resources.get(entry.plan.resource);
    if (!resource) return entry;
    const trustedScopeFields = new Set(
      [resource.tenant_key, resource.principal_key].filter((field): field is string => Boolean(field)),
    );
    const selected = entry.plan.select.filter((field): field is string => typeof field === "string");
    const retained = selected.filter((field) => !trustedScopeFields.has(field));
    if (retained.length === selected.length) return entry;
    if (retained.length === 0) {
      blockers.push(`${entry.id}: the row projection contains only trusted scope fields (${selected.join(", ")}); select customer-facing information instead.`);
      return entry;
    }
    for (const field of selected) {
      if (trustedScopeFields.has(field)) removed.push(`${entry.id}: ${resource.id}.${field}`);
    }
    return {
      ...entry,
      plan: {
        ...entry.plan,
        select: retained,
      },
    };
  });
  return removed.length
    ? { workload: normalizeReadWorkloadSet({ ...workload, allowed }), removed, blockers }
    : { workload, removed, blockers };
}

function exactReviewedPrincipalScopeAnswer(
  answer: string,
  options: ReviewedJobPrincipalScope[],
): ReviewedJobPrincipalScope | undefined {
  const normalized = answer.trim().replace(/[.)]+$/u, "").trim().toLowerCase();
  const numbered = /^(?:candidate\s+)?(\d+)$/u.exec(normalized);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    return Number.isSafeInteger(index) ? options[index] : undefined;
  }
  const matches = options.filter((option) => {
    const value = option.value.toLowerCase();
    return normalized === value
      || normalized === option.label.toLowerCase()
      || normalized === `column ${value}`
      || normalized === `path ${value}`;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

async function reviewJobPrincipalScopeWithModel(input: {
  resourceId: string;
  options: ReviewedJobPrincipalScope[];
  jobIntent: string;
  session: BoundaryReviewInteractiveSession;
  modelSession: ActionModelSuggestionSession;
  narrator: typeof narrateValidatedAuthoringStep;
  interpreter?: typeof interpretPrincipalScopeAnswer;
  authoringChat: BoundaryAuthoringChat;
}): Promise<{ handled: true; scope?: ReviewedJobPrincipalScope } | { handled: false }> {
  const candidateFacts = input.options.map((option, index) =>
    `Candidate ${index + 1}: ${option.label}`);
  const nextQuestion = input.options.length === 1
    ? input.options[0]!.kind === "postgres_rls"
      ? `Does ${input.options[0]!.value} carry the authenticated person's trusted identity for ${input.resourceId}?`
      : `Does ${input.options[0]!.label} identify the authenticated person who owns rows in ${input.resourceId}?`
    : [
        `Which candidate identifies the authenticated person who owns rows in ${input.resourceId}?`,
        ...candidateFacts,
        "Answer with the candidate number or exact reviewed name, or say none.",
      ].join("\n");
  const opening = await input.authoringChat.progress(
    `${boundaryModelLabel(input.modelSession)} is reviewing trusted user scope`,
    () => input.narrator({
      session: input.modelSession,
      operatorMessage: `Clarify the business meaning of the reviewed principal-scope candidates for ${input.resourceId}.`,
      validatedFacts: [
        `Own-row isolation is required by this job: ${input.jobIntent}`,
        ...candidateFacts,
        "These are exact live-catalog candidates, not authority.",
        "Runner will require an exact confirmation before changing the disabled draft.",
      ],
      nextQuestion,
      egressAcknowledged: true,
    }),
  );
  if (!opening) return { handled: false };

  const modelOptions: ModelPrincipalScopeOption[] = input.options.map((option, index) => ({
    id: `candidate_${index + 1}`,
    kind: option.kind,
    value: option.value,
    label: option.label,
  }));
  let question = opening;
  for (let clarification = 0; clarification < 2; clarification += 1) {
    const answer = await input.session.promptText(question, {
      context: [
        "MODEL QUESTION - TRUSTED USER/OWNER SCOPE",
        ...candidateFacts,
        "Answer in ordinary language. The model translates; Runner validates the exact choice.",
      ],
    });
    if (answer === undefined) return { handled: true };
    const exactSelection = exactReviewedPrincipalScopeAnswer(answer, input.options);
    let selected = exactSelection;
    let rationale = exactSelection
      ? `The operator selected Candidate ${input.options.indexOf(exactSelection) + 1} exactly.`
      : undefined;
    if (!selected) {
      const resolution = await input.authoringChat.progress(
        `${boundaryModelLabel(input.modelSession)} is interpreting the scope answer`,
        () => (input.interpreter ?? interpretPrincipalScopeAnswer)({
          session: input.modelSession,
          resourceId: input.resourceId,
          options: modelOptions,
          answer,
          egressAcknowledged: true,
        }),
      );
      if (resolution.state === "none") {
        input.authoringChat.rememberDetails("TRUSTED USER/OWNER SCOPE NOT SELECTED", [
          `Resource: ${input.resourceId}`,
          ...(resolution.rationale ? [`Model interpretation: ${resolution.rationale}`] : []),
          "No reviewed principal predicate was recorded.",
          "Agent authority changed: no",
          "Source database changed: no",
        ]);
        return { handled: true };
      }
      if (resolution.state === "clarification") {
        question = resolution.question;
        continue;
      }
      const selectedIndex = modelOptions.findIndex((option) => option.id === resolution.option_id);
      selected = input.options[selectedIndex];
      rationale = resolution.rationale;
      if (!selected) return { handled: false };
    }
    const summary = await input.authoringChat.progress(
      `${boundaryModelLabel(input.modelSession)} is summarizing the exact scope choice`,
      () => input.narrator({
        session: input.modelSession,
        operatorMessage: answer,
        validatedFacts: [
          `Runner resolved one exact candidate for ${input.resourceId}: ${selected.label}.`,
          ...(rationale ? [`Resolution: ${rationale}`] : []),
          "The value will come only from trusted Runner context, never model arguments.",
          "Recording it changes only the disabled draft; Read and Action authority remain off.",
        ],
        nextQuestion: "Should Runner record this exact trusted user/owner predicate in the disabled Boundary?",
        egressAcknowledged: true,
      }),
    );
    if (summary) await input.authoringChat.streamModel(summary.split(/\r?\n/u));
    const accepted = await input.session.confirm(
      `Record ${selected.label} as the exact trusted user/owner predicate for ${input.resourceId}?`,
      {
        defaultValue: false,
        context: [
          "REVIEW EXACT USER/OWNER SCOPE",
          `Resource: ${input.resourceId}`,
          `Exact predicate: ${selected.label}`,
          "Confirm only when trusted authenticated-principal context has this exact business meaning.",
          "This changes a disabled draft only. Agent authority and source data remain unchanged.",
        ],
      },
    );
    return accepted ? { handled: true, scope: selected } : { handled: true };
  }
  return { handled: true };
}

async function reviewJobPrincipalScopeForResources(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  jobIntent: string;
  resourceIds: Iterable<string>;
  modelSession?: ActionModelSuggestionSession;
  modelNarrator?: typeof narrateValidatedAuthoringStep;
  modelInterpreter?: typeof interpretPrincipalScopeAnswer;
  authoringChat?: BoundaryAuthoringChat;
}): Promise<{ state: "ready"; changed: boolean } | { state: "paused"; resources: string[] }> {
  const assertRunning = () => {
    if (input.authoringChat?.signal?.aborted || input.modelSession?.dependencies?.signal?.aborted) {
      throw new AskError("ASK_CANCELLED", "Boundary conversation paused.", 499);
    }
  };
  assertRunning();
  if (!jobRequestsPrincipalIsolation(input.jobIntent)) {
    return { state: "ready", changed: false };
  }
  const resourceIds = [...new Set(input.resourceIds)].sort();
  if (!resourceIds.length) return { state: "ready", changed: false };

  let changed = false;
  const savedDecisions: Array<{
    resourceId: string;
    scope: ReviewedJobPrincipalScope;
  }> = [];
  let savedReviewRevision: number | undefined;
  const reportSavedDecisions = (): void => {
    if (!savedDecisions.length) return;
    input.session.rememberDetails?.("TRUSTED USER/OWNER SCOPE SAVED", [
      ...savedDecisions.map(({ resourceId, scope }) => `${resourceId}: ${scope.label}`),
      ...(savedReviewRevision !== undefined
        ? [`Disabled Boundary revision: ${savedReviewRevision}`]
        : []),
      "Agent authority changed: no",
      "Source database changed: no",
    ]);
    input.session.present?.("TRUSTED USER/OWNER SCOPE SAVED", [
      `${savedDecisions.length} exact predicate${savedDecisions.length === 1 ? "" : "s"} recorded in the disabled draft.`,
      "Source-proven mandatory paths were carried forward without a second confirmation.",
      "The model cannot supply or change these trusted values.",
      "Agent authority remains off.",
    ], "success");
  };
  for (let pass = 0; pass < 4; pass += 1) {
    const views = await Promise.all(resourceIds.map((resourceId) =>
      inspectBoundaryResourceReview(input.projectRoot, resourceId)));
    assertRunning();
    const unresolved = views.filter((view) => !hasReviewedJobPrincipalScope(view));
    if (!unresolved.length) {
      reportSavedDecisions();
      return { state: "ready", changed };
    }

    const candidates = unresolved.map((view) => ({
      view,
      options: reviewedJobPrincipalScopeOptions(view),
    }));
    const reviewable = candidates.filter((entry) => entry.options.length > 0);
    if (!reviewable.length) {
      const blocked = unresolved.map((view) => view.resource_id).sort();
      reportSavedDecisions();
      const lines = [
        "This job promises rows belonging to the authenticated person, but Runner cannot prove a user/owner predicate for the selected resources.",
        ...blocked.map((resourceId) => `- ${resourceId}`),
        "Review a direct user/owner column or mandatory relationship path, then reopen Agent job. Tenant scope alone does not satisfy an own-row request.",
        "No additional model request occurred during this local scope check. No authority activation, source query, or source write occurred.",
      ];
      input.session.rememberDetails?.("PRINCIPAL SCOPE NEEDS REVIEW", lines);
      input.session.present?.("PRINCIPAL SCOPE NEEDS REVIEW", lines, "warning");
      return { state: "paused", resources: blocked };
    }

    const decisions: Array<{
      resourceId: string;
      scope: ReviewedJobPrincipalScope;
    }> = [];
    const conversationallyHandled = new Set<string>();
    if (input.modelSession && input.authoringChat) {
      const narrator = input.modelNarrator ?? narrateValidatedAuthoringStep;
      for (const entry of reviewable.filter(({ options }) =>
        options.length > 1 || options.some((option) => option.kind === "postgres_rls"))) {
        const reviewed = await reviewJobPrincipalScopeWithModel({
          resourceId: entry.view.resource_id,
          options: entry.options,
          jobIntent: input.jobIntent,
          session: input.session,
          modelSession: input.modelSession,
          narrator,
          ...(input.modelInterpreter ? { interpreter: input.modelInterpreter } : {}),
          authoringChat: input.authoringChat,
        });
        if (!reviewed.handled) continue;
        conversationallyHandled.add(entry.view.resource_id);
        if (!reviewed.scope) {
          reportSavedDecisions();
          return { state: "paused", resources: [entry.view.resource_id] };
        }
        decisions.push({
          resourceId: entry.view.resource_id,
          scope: reviewed.scope,
        });
      }
    }
    const remainingReviewable = reviewable.filter(({ view }) =>
      !conversationallyHandled.has(view.resource_id));
    const unique = remainingReviewable.filter((entry) => entry.options.length === 1);
    const ambiguous = remainingReviewable.filter((entry) => entry.options.length > 1);
    const automaticDerived = unique.filter(({ options }) =>
      options[0]!.confidence === "catalog_proven");
    const needsConfirmation = unique.filter(({ options }) =>
      options[0]!.confidence !== "catalog_proven");
    decisions.push(...automaticDerived.map(({ view, options }) => ({
      resourceId: view.resource_id,
      scope: options[0]!,
    })));
    if (needsConfirmation.length) {
      const exact = needsConfirmation.map(({ view, options }) =>
        `${view.resource_id}: ${options[0]!.label}`);
      const grouped = new Map<string, { scope: ReviewedJobPrincipalScope; resources: string[] }>();
      for (const { view, options } of needsConfirmation) {
        const scope = options[0]!;
        const key = `${scope.kind}:${scope.value}:${scope.confidence}`;
        const current = grouped.get(key);
        grouped.set(key, {
          scope,
          resources: [...(current?.resources ?? []), view.resource_id],
        });
      }
      input.session.rememberDetails?.("REVIEW USER/OWNER SCOPE", [
        "The job asks for rows belonging to the authenticated person.",
        ...exact,
        "Column names are candidates, not authorization proof. Runner supplies confirmed values outside model arguments.",
        "This changes only the disabled draft. Read and Action authority remain off.",
      ]);
      const directColumnNames = new Set(needsConfirmation.flatMap(({ options }) =>
        options[0]?.kind === "direct" ? [options[0].value] : []));
      const confirmationPrompt = directColumnNames.size === 1
        ? `For trusted user scope, does ${[...directColumnNames][0]} on these ${needsConfirmation.length} resources store the authenticated principal ID supplied by your application?`
        : `For trusted user scope, do these ${needsConfirmation.length} reviewed predicates identify the authenticated person who owns each row?`;
      const accepted = await input.session.confirm(
        confirmationPrompt,
        {
          defaultValue: needsConfirmation.every(({ options }) =>
            options[0]!.confidence === "high" || options[0]!.confidence === "catalog_proven"),
          context: [
            "REVIEW USER/OWNER SCOPE",
            ...[...grouped.values()].map(({ scope, resources }) =>
              resources.length === 1
                ? `${resources[0]} -> ${briefPrincipalScopeLabel(scope)}`
                : `${resources.length} resources -> ${briefPrincipalScopeLabel(scope)}`),
            "Choose Yes only when your application authenticates that principal ID and every listed column stores that same owner value.",
            "Default is No because schema names alone are not authorization proof.",
            "Runner injects the value; the model cannot. Draft only. Choose View exact Runner details for every resource.",
          ],
        },
      );
      if (!accepted) {
        reportSavedDecisions();
        const blocked = needsConfirmation.map(({ view }) => view.resource_id).sort();
        return { state: "paused", resources: blocked };
      }
      decisions.push(...needsConfirmation.map(({ view, options }) => ({
        resourceId: view.resource_id,
        scope: options[0]!,
      })));
    }
    for (const { view, options } of ambiguous) {
      const selected = await input.session.chooseOption?.(
        `CHOOSE USER/OWNER SCOPE - ${view.resource_id}`,
        [
          ...options.map((option, index) => ({
            value: `scope:${index}`,
            label: option.label,
            detail: "Runner binds this reviewed predicate from trusted context; the model never supplies it.",
          })),
          {
            value: "back",
            label: "Pause and review this resource manually",
            detail: "Do not guess. The disabled catalog and active authority remain unchanged.",
          },
        ],
        {
          initialValue: "back",
          requireExplicitSelection: true,
          context: [
            "AMBIGUOUS USER/OWNER SCOPE",
            `${view.resource_id} has more than one structurally plausible principal predicate.`,
            "Choose the exact business owner path, or pause. Runner will not infer one from a friendly name.",
          ],
        },
      );
      if (!selected || selected === "back") {
        reportSavedDecisions();
        return { state: "paused", resources: [view.resource_id] };
      }
      const index = Number(selected.slice("scope:".length));
      const scope = options[index];
      if (!scope) {
        reportSavedDecisions();
        return { state: "paused", resources: [view.resource_id] };
      }
      decisions.push({ resourceId: view.resource_id, scope });
    }

    if (!decisions.length) {
      const blocked = unresolved.map((view) => view.resource_id).sort();
      reportSavedDecisions();
      return { state: "paused", resources: blocked };
    }
    const actor = localInteractiveActor();
    const reason = "The reviewed job explicitly requires authenticated user/owner row isolation.";
    assertRunning();
    const preview = await prepareBoundaryReviewMutationBatch(
      input.projectRoot,
      decisions.map(({ resourceId, scope }): BoundaryResourceReviewRequest => ({
        resource_id: resourceId,
        ...(scope.kind === "direct"
          ? { principal_key: scope.value }
          : scope.kind === "derived"
            ? { principal_scope_path: scope.value }
            : { principal_rls_setting: scope.value }),
        actor,
        reason,
      })),
      input.schemaInspector,
    );
    assertRunning();
    // Once started, the atomic commit must finish before cancellation unwinds.
    const committed = await commitBoundaryReviewMutationBatch(input.projectRoot, preview);
    assertRunning();
    changed = true;
    savedDecisions.push(...decisions);
    savedReviewRevision = committed.review_revision;
  }

  const remaining = (await Promise.all(resourceIds.map((resourceId) =>
    inspectBoundaryResourceReview(input.projectRoot, resourceId))))
    .filter((view) => !hasReviewedJobPrincipalScope(view))
    .map((view) => view.resource_id)
    .sort();
  reportSavedDecisions();
  return remaining.length
    ? { state: "paused", resources: remaining }
    : { state: "ready", changed };
}

type InteractiveReadWorkloadAssistInput = {
  projectRoot: string;
  baseConfigPath?: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  modelAuthoringSession?: ActionModelSuggestionSession;
  modelReadWorkloadGenerator?: typeof generateModelReadWorkload;
  modelReadBoundaryRevisionGenerator?: typeof generateModelReadBoundaryRevision;
  modelBoundaryJobPlanner?: typeof planModelBoundaryJob;
  modelActionSuggestionGenerator?: typeof generateModelActionSuggestion;
  modelActionSuggestionSetGenerator?: typeof generateModelActionSuggestionSet;
  modelActionRuleGenerator?: typeof generateModelActionRuleDraft;
  modelAuthoringNarrator?: typeof narrateValidatedAuthoringStep;
  modelPrincipalScopeInterpreter?: typeof interpretPrincipalScopeAnswer;
  modelDiscovery?: BoundaryModelDiscoveryDependencies;
  actionProjectInspector?: typeof inspectActionProject;
  runDelegationActionReview?: typeof runActionControlPlane;
  boundaryAuthoringChatFactory?: BoundaryAuthoringChatFactory;
  completeReadReview?: (
    mode: "prepare_actions" | "activate",
    session?: BoundaryReviewInteractiveSession,
    options?: ReadBoundaryReviewOptions,
  ) => Promise<number>;
  jobFirst?: boolean;
  /** Internal one-shot continuation after an explicit saved-state transition. */
  continueSavedJob?: boolean;
  initialSavedReadRevision?: boolean;
};

type BoundaryAssistOutcome = {
  notice: BoundaryAccessNotice;
  activation_ready: boolean;
  handoff_ready: boolean;
  notice_presented?: boolean;
  navigation?: "boundary_list" | "manual_editor" | "pause" | "resume_agent_job";
};

type ReadBoundaryReviewDisposition = "activated" | "finish" | "manual_editor";

type ReadBoundaryReviewOptions = {
  businessSummary?: () => string[];
  deploymentReadiness?: () => Promise<{ summary: string[]; details: string[] }>;
  confirmedFieldMeanings?: (readDigest: string) => ReadonlySet<string>;
  privacyEvidence?: (boundary: ExplorationBoundaryDraft) => ReadPrivacyReview;
  sequenceSummary?: () => string[];
  executionPreparationNeeded?: () => boolean;
  prepareExecution?: () => Promise<void>;
  reviseWithModel?: (instruction?: string) => Promise<boolean>;
  /** Transfers review to a saved model conversation which owns the next review. */
  openModelRevision?: () => Promise<void>;
  reviewChanges?: () => ReviewSection | undefined;
  privateDependencies?: () => string[];
  onDisposition?: (disposition: ReadBoundaryReviewDisposition) => void;
  reviewRules?: () => Promise<boolean>;
  rulesSummary?: () => Promise<string[]>;
  beforeActivation?: () => Promise<boolean>;
  readiness?: () => Promise<{ ready: boolean; summary: string[]; privacy: boolean }>;
  resolveRequirements?: () => Promise<void>;
};

function boundaryAuthoringCancelled(error: unknown, chat?: BoundaryAuthoringChat): boolean {
  return chat?.signal?.aborted === true
    || error instanceof AskError && error.code === "ASK_CANCELLED"
    || error instanceof Error && error.message === "ACTION_RULE_MODEL_DRAFT_CANCELLED";
}

async function interactiveReadWorkloadAssist(
  input: InteractiveReadWorkloadAssistInput,
): Promise<BoundaryAssistOutcome> {
  const currentModel = input.modelAuthoringSession
    ?? conventionalModelAuthoringSession(process.env);
  const shouldOpenChat = input.jobFirst === true && (
    input.boundaryAuthoringChatFactory !== undefined
    || (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY)
  );
  const authoringChat = shouldOpenChat
    ? (input.boundaryAuthoringChatFactory ?? createBoundaryAuthoringChat)({
        ...(currentModel ? { modelLabel: boundaryModelLabel(currentModel) } : {}),
        ...(currentModel ? { modelSelectionOrigin: input.modelAuthoringSession
          ? "current session" as const : "only configured provider detected" as const } : {}),
      })
    : undefined;
  const session = authoringChat
    ? { ...input.session, ...authoringChat.session }
    : input.session;
  try {
    return await interactiveReadWorkloadAssistSession({
      ...input,
      session,
      currentModel,
      ...(authoringChat ? { authoringChat } : {}),
    });
  } catch (error) {
    if (!boundaryAuthoringCancelled(error, authoringChat)) throw error;
    const notice: BoundaryAccessNotice = { tone: "warning", title: "Boundary conversation paused.",
      lines: ["Existing authority is unchanged by interruption; saved steps are retained."],
      footer: "Resume this job to continue from its saved checkpoint." };
    await authoringChat?.streamCheckpoint(notice.title, notice.lines, "warning");
    return { notice, activation_ready: false, handoff_ready: false, navigation: "pause", notice_presented: Boolean(authoringChat) };
  } finally {
    authoringChat?.close();
  }
}

async function interactiveReadWorkloadAssistSession(input: InteractiveReadWorkloadAssistInput & {
  currentModel?: ActionModelSuggestionSession;
  authoringChat?: BoundaryAuthoringChat;
}): Promise<BoundaryAssistOutcome> {
  const currentModel = input.currentModel;
  const assertRunning = (error?: unknown) => {
    if (boundaryAuthoringCancelled(error, input.authoringChat)) throw new AskError("ASK_CANCELLED", "Boundary conversation paused.", 499);
  };
  const runWithProgress = async <T>(message: string, operation: () => Promise<T>): Promise<T> => {
    assertRunning();
    const result = await (input.authoringChat ? input.authoringChat.progress(message, operation) : withBoundaryModelProgress(message, operation));
    assertRunning();
    return result;
  };
  const writeRunner = (
    title: string,
    lines: string[],
    tone: "normal" | "success" | "warning" | "danger" = "normal",
  ): Promise<void> => {
    if (input.authoringChat) {
      return input.authoringChat.streamRunner(title, lines, tone);
    }
    process.stdout.write(["", title, ...lines, ""].join("\n"));
    return Promise.resolve();
  };
  const initialAuthoringContext = input.jobFirst && input.authoringChat
    ? await loadBoundaryReviewContext(input.projectRoot)
    : undefined;
  const initialReusableState = initialAuthoringContext
    ? await inspectBoundaryJobAuthoringState({
        projectRoot: input.projectRoot,
        context: initialAuthoringContext,
      })
    : undefined;
  const initialReviewedStateFacts = initialReusableState
    ? modelSafeBoundaryJobStateFacts(initialReusableState.current_state)
    : [];
  const resumeBinding: BoundaryAuthoringResumeBinding | undefined = initialAuthoringContext
    ? boundaryAuthoringResumeBinding(initialAuthoringContext.bundle)
    : undefined;
  let currentResumeBinding = resumeBinding;
  const loadedResume = resumeBinding
    ? await readBoundaryAuthoringResumeState(input.projectRoot, resumeBinding)
    : { status: "none" as const };
  const revalidateSavedJob = loadedResume.status === "stale"
    && loadedResume.value.binding.boundary_name === resumeBinding?.boundary_name;
  const availableResume = loadedResume.status === "ready" ? loadedResume.value
    : revalidateSavedJob && loadedResume.status === "stale" && resumeBinding
      ? revalidateBoundaryAuthoringResume(loadedResume.value, resumeBinding) : undefined;
  if (loadedResume.status === "stale" || loadedResume.status === "invalid") {
    input.authoringChat?.rememberDetails(
      loadedResume.status === "stale"
        ? "SAVED BOUNDARY JOB IS STALE"
        : "SAVED BOUNDARY JOB CANNOT BE RESUMED",
      [
      loadedResume.reason,
      loadedResume.status === "stale"
        ? "Saved business context can be revalidated, but old analyses, checkpoints and activation consent cannot be reused."
        : "Runner will not replay an invalid or integrity-changed model transcript.",
      "Starting a new model-guided job replaces only this unusable resume record; active authority remains unchanged.",
    ]);
  }
  let authoringConversation = input.authoringChat
    ? createModelAuthoringConversation()
    : undefined;
  type MappingMode = "model" | "cards" | "exact" | "intent_model" | "saved";
  let mode: MappingMode | undefined;
  let routeSelectedModel: ActionModelSuggestionSession | undefined;
  let preselectedMappingSession: ActionModelSuggestionSession | undefined;
  let modelEgressAcknowledged = false;
  let manualSelected = false;
  let resumeSelected = false;
  let editingSavedJob = false;
  let activeResume = availableResume;
  let resumeRead: BoundaryAuthoringResumeRead | undefined = availableResume?.read;
  let resumeReadIntent = availableResume?.read_intent;
  let pendingJobRevision = availableResume?.pending_job_revision;
  let pendingReadRevision = availableResume?.pending_read_revision;
  let privateReadMetadataDigest = availableResume?.private_read_metadata_digest;
  let pendingActionRemoval = availableResume?.pending_action_removal;
  let pendingActionRevision = availableResume?.pending_action_revision;
  let pendingActionAddition = availableResume?.pending_action_addition;
  let resumeAction: BoundaryAuthoringResumeAction | undefined = availableResume?.action;
  // Read edits and metadata recovery recompile saved outcomes, not an unfinished agenda.
  let retainedReadEdit: { action?: BoundaryAuthoringResumeAction; addition?: BoundaryAuthoringActionAddition } | undefined = pendingReadRevision
    ? { action: structuredClone(resumeAction), addition: structuredClone(pendingActionAddition) } : undefined;
  let deferUnfinishedActions = false;
  const retainedActionIsUnfinished = () => boundaryAuthoringActionIsUnfinished(retainedReadEdit?.action);
  let selectedResumeModel: ActionModelSuggestionSession | undefined;
  let intendedClient: AuthoringClientPlan | undefined;
  let jobIntent: string | undefined;
  let canonicalJobIntent: string | undefined;
  let resumePersistenceBlocked = false;
  let resumePersistenceFailure: string | undefined;
  const checkpointSaveFailure = (step: string) => new Error(`ACTION_CHECKPOINT_NOT_SAVED: ${step} could not be saved. ${resumePersistenceFailure ?? "Inspect local storage access and retry the saved job."} Existing drafts and authority are unchanged.`);
  const persistAuthoringResume = async (stage: BoundaryAuthoringResumeStage): Promise<void> => {
    assertRunning();
    if (!input.authoringChat
      || !currentResumeBinding
      || !jobIntent?.trim()
      || !selectedResumeModel
      || !modelEgressAcknowledged) return;
    currentResumeBinding = boundaryAuthoringResumeBinding(
      (await loadBoundaryReviewContext(input.projectRoot)).bundle,
    );
    try {
      const clientRead = stage === "client_setup"
        ? (await loadActivatedExplorationBoundaries(input.projectRoot)).find((boundary) => boundary.pack.name === currentResumeBinding!.boundary_name)
        : undefined;
      const clientActions = stage === "client_setup" ? await loadActiveActionRuleAuthority(input.projectRoot).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }) : undefined;
      activeResume = buildBoundaryAuthoringResumeState({
        binding: currentResumeBinding,
        stage: retainedActionIsUnfinished() && stage === "authority_review" && !pendingReadRevision
          ? "action_drafting" : stage,
        ...(clientRead ? { clientHandoff: { read_digest: clientRead.activation.digest,
          ...(clientActions ? { action_digest: clientActions.authority.action_boundary.digest } : {}),
        } } : {}),
        jobIntent: (canonicalJobIntent ?? jobIntent).trim(),
        provider: selectedResumeModel.provider,
        model: selectedResumeModel.model,
        ...(selectedResumeModel.provider === "openai_compatible"
          ? { metadataDestinationDigest: canonicalJsonDigest(authoringDestination(selectedResumeModel)) } : {}),
        conversation: authoringConversation?.turns,
        ...(intendedClient ? { intendedClient } : {}),
        ...(authoringConversation?.policySources?.snapshots.length ? { policySourceSession: authoringConversation.policySources.id } : {}),
        ...(resumeReadIntent ? { readIntent: resumeReadIntent } : {}),
        ...(pendingJobRevision ? { pendingJobRevision } : {}),
        ...(pendingReadRevision ? { pendingReadRevision } : {}),
        ...(privateReadMetadataDigest ? { privateReadMetadataDigest } : {}),
        ...(pendingActionRemoval ? { pendingActionRemoval } : {}),
        ...(pendingActionRevision ? { pendingActionRevision } : {}),
        ...((retainedReadEdit ? retainedReadEdit.addition : pendingActionAddition)
          ? { pendingActionAddition: retainedReadEdit ? retainedReadEdit.addition : pendingActionAddition } : {}),
        ...(resumeRead ? { read: resumeRead } : {}),
        ...((retainedReadEdit ? retainedReadEdit.action : resumeAction)
          ? { action: retainedReadEdit ? retainedReadEdit.action : resumeAction } : {}),
        ...(activeResume ? { previous: activeResume } : {}),
      });
      assertRunning();
      await writeBoundaryAuthoringResumeState(input.projectRoot, activeResume);
      resumePersistenceBlocked = false;
      resumePersistenceFailure = undefined;
    } catch (error) {
      assertRunning(error);
      activeResume = undefined;
      resumePersistenceFailure = redactCliErrorMessage(error instanceof Error ? error.message : String(error));
      if (resumePersistenceBlocked) return;
      resumePersistenceBlocked = true;
      input.authoringChat.rememberDetails("BOUNDARY JOB RESUME WAS NOT SAVED", [
        resumePersistenceFailure,
        "The current in-memory setup may continue, but Runner will not persist prohibited or invalid transcript material.",
        "No authority or source data changed.",
      ]);
    }
  };
  const conversationalJobChoices = [
    ...(availableResume
      ? [{
          value: "resume",
          label: revalidateSavedJob ? "Revalidate the saved job against the changed database  [recommended]" : "Resume the interrupted job  [recommended]",
          detail: revalidateSavedJob
            ? "Retain the business rules and saved drafts; recheck current structure with fresh metadata permission. Nothing activates."
            : `${availableResume.model.provider}[${availableResume.model.name}] from saved job · ${conciseBoundaryJobIntent(availableResume.job_intent)} · continue from ${formatBoundaryAuthoringStage(availableResume.stage)} · prior metadata permission retained`,
        }]
      : []),
    {
      value: "model",
      label: currentModel
        ? `${initialReviewedStateFacts.length || availableResume ? "Draft a change with" : "Start a new job with"} ${boundaryModelLabel(currentModel)}${availableResume ? "" : "  [recommended]"}`
        : `Choose a drafting model for a new job${availableResume ? "" : "  [recommended]"}`,
      detail: initialReviewedStateFacts.length || availableResume
        ? "Keep the saved rules and client choice. The model receives current Read and Action settings, then asks only what should change."
        : "Talk through the job; Runner validates every suggested Read and Action decision.",
    },
    ...(currentModel
      ? [{
          value: "choose_model",
          label: "Choose a different drafting model",
          detail: "Choose another provider or exact model before metadata egress review.",
        }]
      : []),
    {
      value: "cards",
      label: "Continue without a model",
      detail: "Runner prepares explainable exact plan cards from reviewed schema evidence.",
    },
    {
      value: "manual",
      label: "Open the manual Boundary editors",
      detail: "Review exact tables, fields, relationships, limits, and actions yourself.",
    },
    {
      value: "advanced",
      label: "Advanced inputs",
      detail: "Import exact plan JSON, question-intent JSON, or a saved analysis.",
    },
  ];
  let policySourceControls: ReturnType<typeof installPolicySourceCommands> | undefined;
  const confirmModelEgress = async (session: ActionModelSuggestionSession) => {
    const privateCondition = (await loadBoundaryReviewContext(input.projectRoot)).candidate.read_prerequisite;
    const privateDigest = privateCondition ? canonicalJsonDigest(privateCondition) : undefined;
    const exact = [
      `Provider: ${boundaryModelLabel(session)}`,
      ...(session.provider === "openai_compatible" ? [`Destination: ${authoringDestination(session)}`] : []),
      ...(session.provider === "openrouter" ? [`Destination: ${OPENROUTER_EGRESS}.`] : []),
      "Sends: the job you type, its read and proposal intents, and reviewed structural metadata.",
      "For verified Actions, structural metadata may include Runner-only field names, types, relationships, roles, and schema-declared ENUM/CHECK allowlists needed to draft private verification rules.",
      ...(privateCondition ? ["Existing private Read evidence is also included for policy review. Exact mapping (metadata and reviewed meaning only):",
        ...JSON.stringify(privateCondition, null, 2).split("\n"), `Private Read metadata fingerprint: ${privateDigest}`] : []),
      "Later in this same job, business-policy answers and reviewed-name clarifications you type may be sent for translation into an exact draft.",
      "Never sent automatically: rows, observed values, credentials, endpoint URLs, SQL, or trusted tenant/principal values.",
      "Runner-only field metadata is not added to model-facing Read authority and its row values remain private.",
      "Observed values require their own exact preview and permission. Model output remains untrusted and cannot activate, approve, apply, or write.",
      "Bounded requests: one short welcome, job planning, Read mapping, Action mapping, concise validated chat replies, and one correction only after a refusal.",
    ];
    input.authoringChat?.rememberDetails("MODEL METADATA EGRESS", exact);
    const accepted = await input.session.confirm(
      `Send this Boundary-authoring conversation and reviewed structural context to ${boundaryModelLabel(session)}?`,
      {
        defaultValue: false,
        context: [
          `Provider: ${boundaryModelLabel(session)}`,
          ...(session.provider === "openai_compatible" ? [`Destination: ${authoringDestination(session)}`] : []),
          ...(session.provider === "openrouter" ? [`Destination: ${OPENROUTER_EGRESS}.`] : []),
          "Sends: your job and business answers + reviewed structural metadata.",
          "Verified Actions may include private verification field names/types, but never their row values.",
          ...(privateCondition ? ["Includes the saved private access-check mapping. View exact Runner details to inspect its source, fields and reviewed meaning before allowing this model transfer."] : []),
          "Does not send: rows, observed values, SQL, credentials, or trusted identity values.",
          "Model suggestions remain untrusted. Choose View exact Runner details now for the complete egress record; later /details shows the latest validation.",
        ],
      },
    );
    if (!accepted) return accepted;
    if (canonicalJsonDigest((await loadBoundaryReviewContext(input.projectRoot)).candidate.read_prerequisite ?? null)
      !== canonicalJsonDigest(privateCondition ?? null)) throw new Error("PRIVATE_READ_METADATA_CHANGED: The private access mapping changed during permission review. Review the current mapping before sending it; nothing was transferred.");
    privateReadMetadataDigest = privateDigest;
    return policySourceControls ? policySourceControls.reviewTransfer(session) : true;
  };
  const installPermissionGuide = (session: ActionModelSuggestionSession) => {
    if (!input.authoringChat) return;
    const narrator = input.modelAuthoringNarrator ?? narrateValidatedAuthoringStep;
    const label = boundaryModelLabel(session);
    input.authoringChat.setPermissionGuide?.(async (request) => {
      const positiveChoice = request.choices[0]?.label
        .replace(/\s+\[(?:recommended|ready[^\]]*|available)[^\]]*\]/giu, "")
        .trim();
      const isActionActivation = /\bactivat\w*\b/iu.test(request.prompt) && /\b(?:action|proposal)\b/iu.test(request.prompt);
      const nextQuestion = isActionActivation
        ? "Enable these change requests under the reviewed eligibility and approval rules? Database execution is a separate decision."
        : positiveChoice && positiveChoice !== "Allow this exact step"
        ? `Would you like Runner to ${positiveChoice.charAt(0).toLowerCase()}${positiveChoice.slice(1)}?`
        : /\bactivate\b/iu.test(request.prompt)
          ? "Would you like Runner to activate this exact reviewed authority now?"
          : /\bapprove\b/iu.test(request.prompt)
            ? "Would you like Runner to approve this exact reviewed action now?"
            : /\bapply\b/iu.test(request.prompt)
              ? "Would you like Runner to apply this exact reviewed action now?"
              : "Would you like to allow this exact Runner permission now?";
      const safeContext = modelSafePermissionFacts(request.context);
      const safeChoices = modelSafePermissionFacts(
        request.choices.map((choice) => `Operator choice: ${choice.label}${choice.detail ? ` - ${choice.detail}` : ""}`),
      );
      return runWithProgress(
        request.operatorQuestion ? `Asking ${label}` : `${label} is explaining the permission`,
        () => narrator({
          session: boundaryAuthoringModelSession(session, input.authoringChat),
          operatorMessage: request.operatorQuestion
            ? `Operator question about the unchanged pending permission: ${request.operatorQuestion}`
            : "Explain this unchanged pending Runner permission before the operator decides.",
          validatedFacts: [
            `Pending gate: ${request.title}`,
            ...(/^Enable supervised source execution\b/iu.test(request.prompt)
              ? ["This is the separate execution-authorization gate itself. Allowing enables the reviewed execution policy; it does not start a worker. Do not describe another execution-authorization review as a later prerequisite. A running worker and successful receipt are still required for completion."] : []),
            ...(isActionActivation
              ? ["This Action activation enables reviewed change requests only, under their exact eligibility and automatic-versus-human approval rules. It does NOT enable database execution. Execution setup comes next when requested. Call this enabling change requests, not enabling a supervised operation. Automatic-approval limits do not limit human fallback."] : []),
            ...(request.choices.some((choice) => choice.value === "resolve")
              ? ["Activation is unavailable: unresolved policy requirements are mandatory, not recommendations. Explain the next business decision, never invite activation or claim these checks passed."] : []),
            ...safeContext,
            ...modelSafePermissionFacts(request.explanationContext ?? [], 256),
            ...safeChoices,
            "Trusted tenant and principal values remain Runner-injected and outside model arguments.",
            "Allowing changes only the exact authority in this gate; declining leaves current authority and source data unchanged.",
          ],
          ...(!request.operatorQuestion ? { nextQuestion } : {}),
          egressAcknowledged: true,
          responseStyle: request.operatorQuestion ? "inspection" : "permission",
          onFailure: request.onFailure,
        }),
      );
    });
  };

  if (input.continueSavedJob && !availableResume) {
    return boundaryAssistResult({ tone: "warning", title: "The saved missing-behavior request is unavailable.",
      lines: ["Runner did not start a new Action draft because the exact saved job could not be reloaded."],
      footer: "Reopen Boundary drafting and inspect the saved job; current authority is unchanged." });
  }
  if (input.initialSavedReadRevision && !availableResume) {
    return boundaryAssistResult({ tone: "warning", title: "The saved conversation needs recovery.",
      lines: ["The current access and action drafts are still saved, but their model conversation could not be restored.",
        "No new job or model request was started. Exact details and manual editing remain available."],
      footer: "Return to the saved review to inspect or restore the conversation." });
  }
  if (input.authoringChat && input.session.chooseOption) {
    let selected = input.continueSavedJob ? "resume" : input.initialSavedReadRevision ? "model" : await input.session.chooseOption(
      "START BOUNDARY DRAFTING",
      conversationalJobChoices,
      {
        initialValue: availableResume ? "resume" : "model",
        context: [
          "Choose how to draft this job. No choice grants Read, proposal, approval, apply, or write authority.",
          ...(loadedResume.status === "stale" || loadedResume.status === "invalid"
            ? [revalidateSavedJob
              ? "Database structure changed. Revalidate the saved business job; old validation and permission checkpoints will not be reused."
              : "A prior saved job cannot be resumed safely. Use /details for the exact reason; starting a new job replaces it."]
            : []),
        ],
      },
    );
    if (selected === undefined) return boundaryAssistResult(boundaryAssistBackNotice());
    if (selected === "advanced") {
      selected = await input.session.chooseOption(
        "ADVANCED BOUNDARY INPUT",
        [
          { value: "exact", label: "Exact read-workload JSON", detail: "Supply compiler-shaped representative plans directly." },
          { value: "intent_model", label: "Question-intent JSON plus model", detail: "Supply exact allowed and refused examples for model mapping." },
          { value: "saved", label: "Reopen a saved workload analysis", detail: "Continue a prior disabled analysis." },
        ],
        {
          initialValue: "saved",
          context: ["These paths import or resume disabled review artifacts. None activates authority."],
        },
      );
      if (selected === undefined) return boundaryAssistResult(boundaryAssistBackNotice());
    }
    if (selected === "manual") {
      return boundaryAssistResult({
        tone: "success",
        title: "Manual Boundary setup selected.",
        lines: ["No model request was made and no disabled draft was changed."],
        footer: "Use the table list now. W reopens model-guided setup.",
      });
    }
    resumeSelected = selected === "resume";
    editingSavedJob = Boolean(availableResume
      && (selected === "model" || selected === "choose_model"));
    if (resumeSelected && availableResume) {
      authoringConversation = createModelAuthoringConversation(availableResume.conversation);
      canonicalJobIntent = availableResume.job_intent;
      jobIntent = availableResume.pending_job_revision ?? availableResume.job_intent;
      editingSavedJob = Boolean(availableResume.pending_job_revision);
      intendedClient = availableResume.intended_client;
      activeResume = availableResume;
      resumeRead = availableResume.read;
      resumeReadIntent = availableResume.read_intent;
      resumeAction = availableResume.action;
      pendingActionAddition = availableResume.pending_action_addition;
    } else if (selected === "model" || selected === "choose_model") {
      // Keep exact component identities while classifying the edit. Only an
      // explicit new mapping replaces them. Retaining a checkpoint does not
      // replay it: Action authoring revalidates its exact context before use.
      authoringConversation = createModelAuthoringConversation(editingSavedJob ? availableResume!.conversation : undefined);
      if (editingSavedJob) intendedClient = availableResume!.intended_client;
      canonicalJobIntent = editingSavedJob ? availableResume!.job_intent : undefined;
      activeResume = editingSavedJob ? availableResume : undefined;
      resumeRead = editingSavedJob ? availableResume!.read : undefined;
      resumeReadIntent = editingSavedJob ? availableResume!.read_intent : undefined;
      resumeAction = editingSavedJob ? availableResume!.action : undefined;
      retainedReadEdit = undefined;
      pendingReadRevision = undefined;
      pendingJobRevision = undefined;
      pendingActionRemoval = undefined;
      pendingActionRevision = undefined;
      pendingActionAddition = undefined;
    }
    mode = selected === "choose_model" || resumeSelected ? "model" : selected as MappingMode;
    if (mode === "model") {
      routeSelectedModel = (resumeSelected || input.initialSavedReadRevision) && availableResume
        ? boundaryAuthoringResumeModelSession(availableResume, currentModel, input.modelDiscovery?.env ?? process.env)
          ?? await promptBoundaryMappingModel(input.session, currentModel, input.modelDiscovery)
        : selected === "choose_model" || !currentModel
          ? await promptBoundaryMappingModel(input.session, currentModel, input.modelDiscovery)
          : { ...currentModel };
      if (!routeSelectedModel) return boundaryAssistResult(boundaryAssistBackNotice());
      selectedResumeModel = routeSelectedModel;
      input.authoringChat.setModel(boundaryModelLabel(routeSelectedModel));
      preselectedMappingSession = {
        ...routeSelectedModel,
        ...(authoringConversation ? { conversation: authoringConversation } : {}),
      };
      const reusingExactSavedConsent = resumeSelected
        && !revalidateSavedJob
        && availableResume !== undefined
        && routeSelectedModel.provider === availableResume.model.provider
        && routeSelectedModel.model === availableResume.model.name
        && (routeSelectedModel.provider !== "openai_compatible"
          || availableResume.metadata_destination_digest === canonicalJsonDigest(authoringDestination(routeSelectedModel)))
        && (initialAuthoringContext?.candidate.read_prerequisite
          ? availableResume.private_read_metadata_digest === canonicalJsonDigest(initialAuthoringContext.candidate.read_prerequisite)
          : availableResume.private_read_metadata_digest === undefined);
      if (reusingExactSavedConsent) {
        modelEgressAcknowledged = true;
        input.authoringChat.rememberDetails("MODEL METADATA EGRESS", [
          `Provider: ${boundaryModelLabel(routeSelectedModel)}`,
          "Reusing the explicit metadata permission saved with this interrupted job.",
          "The permission is bound to this provider/model and the unchanged Boundary generation, schema, and database-role posture.",
          "Starting a new job, changing the model, or changing reviewed database authority requires a new permission.",
          "Never sent automatically: rows, observed values, credentials, endpoint URLs, SQL, or trusted tenant/principal values.",
          "Model output remains untrusted and cannot activate, approve, apply, or write.",
        ]);
      }
      while (!modelEgressAcknowledged) {
        modelEgressAcknowledged = await confirmModelEgress(preselectedMappingSession) === true;
        if (modelEgressAcknowledged) break;
        const recovery = await input.session.chooseOption(
          "MODEL REQUEST NOT STARTED",
          [
            { value: "runner", label: "Continue without a model  [recommended]", detail: "Prepare exact plan cards from reviewed schema evidence." },
            { value: "review", label: "Review the same permission again", detail: "No provider request starts unless you allow the exact egress." },
            { value: "change_model", label: "Choose another model", detail: "Keep this setup, then review the replacement provider." },
            { value: "back", label: "Pause setup", detail: "Keep active authority and source data unchanged." },
          ],
          {
            initialValue: "runner",
            context: ["Nothing was sent to a provider. Choose how to continue."],
          },
        );
        if (recovery === "runner") {
          mode = "cards";
          preselectedMappingSession = undefined;
          routeSelectedModel = undefined;
          selectedResumeModel = undefined;
          break;
        }
        if (recovery === "review") continue;
        if (recovery === "change_model") {
          const replacement = await promptBoundaryMappingModel(
            input.session,
            preselectedMappingSession,
            input.modelDiscovery,
          );
          if (!replacement) continue;
          routeSelectedModel = replacement;
          selectedResumeModel = replacement;
          preselectedMappingSession = {
            ...replacement,
            ...(authoringConversation ? { conversation: authoringConversation } : {}),
          };
          input.authoringChat.setModel(boundaryModelLabel(replacement));
          continue;
        }
        return boundaryAssistResult(boundaryAssistBackNotice(
          "Boundary setup paused. No provider request was made and no authority changed.",
        ));
      }
      if (modelEgressAcknowledged && preselectedMappingSession) {
        if (authoringConversation) {
          try {
            authoringConversation.policySources = (resumeSelected || editingSavedJob) && availableResume?.policy_source_session
              ? await loadPolicySources(input.projectRoot, availableResume.policy_source_session)
              : newPolicySourceSession();
          } catch (error) {
            input.authoringChat.checkpoint("Saved rules could not be restored", [
              redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
              "The saved drafts are preserved. Runner will not silently drop the source or reread its old path.",
            ], "warning");
            const recovery = await input.session.chooseOption("SAVED RULES UNAVAILABLE", [
              { value: "continue", label: "Continue reviewing the saved draft without the unavailable source", detail: "Source coverage is no longer reproducible. The existing draft and business rules stay saved; /attach selects a replacement with new consent." },
              { value: "pause", label: "Pause and restore the original protected snapshot" },
            ], { initialValue: "pause" });
            if (recovery !== "continue") return boundaryAssistResult(boundaryAssistBackNotice("Job paused with saved rules unavailable. No authority changed."));
            authoringConversation.policySources = newPolicySourceSession();
            await persistAuthoringResume(availableResume?.stage ?? "planning");
          }
          policySourceControls = installPolicySourceCommands({ root: input.projectRoot, chat: input.authoringChat, conversation: authoringConversation,
            hasDraft: () => Boolean(resumeRead),
            destination: () => selectedResumeModel ?? preselectedMappingSession!,
            onChange: () => persistAuthoringResume(activeResume?.stage ?? "planning") });
          if (!await policySourceControls.reviewTransfer(preselectedMappingSession)) {
            return boundaryAssistResult(boundaryAssistBackNotice("Rules transfer was declined. The saved source and draft are unchanged; resume with the approved model or review a replacement destination."));
          }
          input.authoringChat.checkpoint("Rules context", [authoringConversation.policySources.active
            ? "Restored the saved rules snapshot without rereading its original file. /rules views, replaces or removes it."
            : "Describe the job, paste your business rules, or use /attach ./rules.txt. /rules manages the selected text."]);
        }
        installPermissionGuide(preselectedMappingSession);
        if (resumeSelected && revalidateSavedJob) {
          rememberModelAuthoringTurn(authoringConversation, "Runner revalidation notice",
            "The database was rescanned. Revalidate this same saved business job against the current reviewed structure. Prior model validation claims and checkpoints are not current proof. Preserve the saved business rules and existing field restrictions; any necessary authority change requires review.");
        }
        const narrator = input.modelAuthoringNarrator ?? narrateValidatedAuthoringStep;
        const greeting = resumeSelected ? undefined : await runWithProgress(
          `${resumeSelected ? "Resuming" : "Starting"} ${boundaryModelLabel(preselectedMappingSession)}`,
          () => narrator({
            session: boundaryAuthoringModelSession(preselectedMappingSession!, input.authoringChat),
            operatorMessage: resumeSelected
              ? "Resume the saved model-guided Boundary job and its accepted business answers."
              : input.initialSavedReadRevision
                ? "Revise the saved read access. Keep the existing business job, actions, pending decisions and client choice. Ask only what access should change."
              : "Start a new model-guided job against the current reviewed Boundary state.",
            validatedFacts: resumeSelected && availableResume
              ? [
                  "The saved metadata permission is being reused for this unchanged provider, model, job, and reviewed database posture.",
                  `Saved job: ${availableResume.job_intent}`,
                  `Resume point: ${formatBoundaryAuthoringStage(availableResume.stage)}.`,
                  `${availableResume.conversation.length} bounded prior business turn${availableResume.conversation.length === 1 ? " was" : "s were"} restored.`,
                  "Current Read and Action authority remain unchanged until their separate operator confirmations.",
                ]
              : [
                  "Metadata egress for this selected provider was explicitly approved.",
                  ...(editingSavedJob && availableResume ? [
                    "The operator is changing the saved job. Its business conversation, rules snapshot and client choice are retained; replan requested work without replaying old component checkpoints or activation consent.",
                    `Saved job: ${availableResume.job_intent}`,
                  ] : ["Runner preserved the current reviewed Boundary state. This is a new conversation, not a resumed model transcript."]),
                  ...initialReviewedStateFacts,
                  "No new Read or Action authority was activated by starting this job.",
                  "Runner will validate every suggestion before the operator reviews authority.",
                ],
            nextQuestion: resumeSelected
              ? "I retained the saved job and will continue from its last incomplete step."
              : input.initialSavedReadRevision
                ? "What should people be able to see differently? Your business rules and pending decisions stay saved."
              : initialReviewedStateFacts.length
                ? "Your current settings are saved. What should stay the same, and what should change?"
                : "What should your assistant help people see or change?",
            egressAcknowledged: true,
            responseStyle: "opening",
          }),
        );
        if (greeting) {
          await input.authoringChat.streamModel(greeting.split(/\r?\n/u));
        } else if (!resumeSelected) {
          await input.authoringChat.streamCheckpoint("Model connected", [
            "Unsupported opening text was discarded; describe one job below",
          ], "warning");
        }
      }
    }
  }
  const jobPromptContext = [
    "SET UP ONE AGENT JOB",
    "Describe what the agent should answer and, if needed, what changes it may propose.",
    "Runner will prepare separate disabled Read and Action Boundary drafts. The model cannot activate either one.",
    `Maximum job description length: ${MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS} characters.`,
    "Example: Explain operational trends and propose one bounded follow-up action.",
    "",
    "Type M for full manual table and field setup. Esc pauses without changing authority.",
  ];
  let jobValidationContext: string[] = [];
  while (jobIntent === undefined) {
    jobIntent = await input.session.promptText(
      input.initialSavedReadRevision ? "What should change in the saved read access?" : "What job are you giving this agent?",
      { context: [...jobValidationContext, ...jobPromptContext] },
    );
    if (jobIntent === undefined) break;
    const characterCount = textCharacterCount(jobIntent.trim());
    if (characterCount <= MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS) break;
    const validationLines = [
      `Job description is ${characterCount} characters; maximum is ${MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS}.`,
      "Shorten it and submit again. No disabled Boundary draft was staged or changed.",
    ];
    input.session.rememberDetails?.("JOB DESCRIPTION TOO LONG", validationLines);
    input.session.present?.("JOB DESCRIPTION TOO LONG", validationLines, "warning");
    jobValidationContext = ["JOB DESCRIPTION TOO LONG", ...validationLines, ""];
    jobIntent = undefined;
  }
  if (jobIntent === undefined) return boundaryAssistResult(boundaryAssistBackNotice("Delegation setup closed."));
  if (input.jobFirst && /^(?:m|manual)$/i.test(jobIntent.trim())) {
    return boundaryAssistResult({
      tone: "success",
      title: "Manual Boundary setup selected.",
      lines: [
        "Use the table list to build the Read Boundary directly; press Y for Action Boundaries when ready.",
        "No model request was made and no authority changed.",
      ],
      footer: "W reopens one-job assisted setup at any time.",
    });
  }
  if (!jobIntent.trim()) {
    return boundaryAssistResult({
      tone: "warning",
      title: "Describe one agent job first.",
      lines: ["Runner uses the job to keep the read and proposal drafts together; it does not infer authority from this sentence."],
    });
  }
  const chooseUnspecifiedClient = async () => {
    if (!input.authoringChat || !selectedResumeModel || !input.session.chooseOption || intendedClient) return;
    const clientQuestion = "Which client will use this job? I will carry that choice through setup; you can decide later.";
    await input.authoringChat.streamModel([clientQuestion]);
    const choice = await input.session.chooseOption("CLIENT FOR THIS JOB", authoringClientChoices.map((entry) => ({ ...entry })),
      { initialValue: "later", reviewOnly: true, context: ["This selects a setup destination only. No configuration, identity, permissions or source data changes."] });
    intendedClient = isAuthoringClientPlan(choice) ? choice : "later";
    if (intendedClient !== "later") rememberModelAuthoringClarification(authoringConversation, clientQuestion, authoringClientLabel(intendedClient));
  };
  if (editingSavedJob) {
    pendingJobRevision = jobIntent.trim();
    if (!resumeSelected) rememberModelAuthoringTurn(authoringConversation, "Requested change to the saved job", pendingJobRevision);
  }
  await persistAuthoringResume("planning");
  if (!mode && input.session.chooseOption) {
    let selected = await input.session.chooseOption(
      input.jobFirst ? "MAP THE JOB TO REVIEWED STRUCTURE" : "HOW SHOULD RUNNER MAP THIS JOB?",
      input.jobFirst
        ? input.authoringChat
          ? conversationalJobChoices
          : [
            {
              value: "model",
              label: currentModel
                ? `Model-assisted with ${boundaryModelLabel(currentModel)}  [recommended]`
                : "Model-assisted with OpenAI, Anthropic, or a local model  [configure]",
              detail: currentModel
                ? "Use the displayed default or change its model/provider before the egress review. Runner validates the result."
                : "Runner validates the untrusted proposal; the model cannot activate authority.",
            },
            {
              value: "cards",
              label: currentModel
                ? "Runner-guided recommended draft  [no model]"
                : "Runner-guided recommended draft  [recommended; no model configured]",
              detail: "Runner proposes a small exact read set; review it once and edit only when needed.",
            },
            {
              value: "manual",
              label: "Full manual table and field setup",
              detail: "Open the exact schema editor without making a model request.",
            },
            {
              value: "exact",
              label: "Advanced exact read-workload JSON",
              detail: "Supply reviewed plan JSON directly.",
            },
            {
              value: "intent_model",
              label: "Advanced question-intent JSON plus model",
              detail: "Supply exact question intents for bounded model mapping.",
            },
            {
              value: "saved",
              label: "Reopen a saved workload analysis",
              detail: "Continue a prior disabled analysis against the current Boundary.",
            },
          ]
        : [
            {
              value: "cards",
              label: "Runner-guided recommended draft  [recommended; no model]",
              detail: "Runner proposes exact plan cards from the current disabled catalog.",
            },
            {
              value: "model",
              label: currentModel
                ? `Model-assisted with ${boundaryModelLabel(currentModel)}`
                : "Model-assisted with OpenAI, Anthropic, or a local model  [configure]",
              detail: "Metadata egress still requires explicit review; the result remains untrusted.",
            },
            {
              value: "exact",
              label: "Advanced exact read-workload JSON",
              detail: "Supply reviewed plan JSON directly.",
            },
            {
              value: "intent_model",
              label: "Advanced question-intent JSON plus model",
              detail: "Supply exact question intents for bounded model mapping.",
            },
            {
              value: "saved",
              label: "Reopen a saved workload analysis",
              detail: "Continue a prior disabled analysis against the current Boundary.",
            },
          ],
      {
        initialValue: input.authoringChat
          ? "model"
          : input.jobFirst && currentModel
            ? "model"
            : "cards",
        context: input.jobFirst
          ? [
              "A model receives only reviewed structural metadata after you approve egress.",
              "Use Up/Down to inspect a path; Enter selects only the highlighted path.",
            ]
          : [
              "Continue the same job against this disabled catalog. No choice activates authority.",
              "Use Up/Down to inspect a path; Enter selects only the highlighted path.",
            ],
      },
    );
    if (selected === undefined) return boundaryAssistResult(boundaryAssistBackNotice());
    if (selected === "advanced") {
      selected = await input.session.chooseOption(
        "ADVANCED BOUNDARY INPUT",
        [
          {
            value: "exact",
            label: "Exact read-workload JSON",
            detail: "Supply compiler-shaped representative plans directly.",
          },
          {
            value: "intent_model",
            label: "Question-intent JSON plus model",
            detail: "Supply exact allowed and refused question examples for bounded model mapping.",
          },
          {
            value: "saved",
            label: "Reopen a saved workload analysis",
            detail: "Continue a prior disabled analysis against the current Boundary.",
          },
        ],
        {
          initialValue: "saved",
          context: ["These paths are for repeatable imports and resumed reviews. None activates authority."],
        },
      );
      if (selected === undefined) return boundaryAssistResult(boundaryAssistBackNotice());
    }
    manualSelected = input.jobFirst === true && selected === "manual";
    if (!manualSelected) {
      if (selected === "choose_model") {
        mode = "model";
      } else {
        mode = selected as MappingMode;
        if (input.authoringChat && selected === "model" && currentModel) {
          routeSelectedModel = { ...currentModel };
        }
      }
    }
  } else if (!mode) {
    const choice = await input.session.promptText(
      input.jobFirst ? `Mapping method [${currentModel ? "1" : "2"}]` : "Choose 1-5",
      {
        context: input.jobFirst
          ? [
              "MAP THE JOB TO REVIEWED STRUCTURE",
              currentModel
                ? `1  Model-assisted with ${boundaryModelLabel(currentModel)}  [recommended]`
                : "1  Model-assisted with OpenAI, Anthropic, or a local model  [configure]",
              currentModel
                ? "2  Runner-guided recommended draft  [no model]"
                : "2  Runner-guided recommended draft  [recommended; no model configured]",
              "3  Full manual table and field setup",
              "4  Advanced exact read-workload JSON",
              "5  Advanced question-intent JSON plus model",
              "6  Reopen a saved workload analysis",
              "",
              "A model receives only reviewed structural metadata after you approve egress. It cannot activate authority.",
            ]
          : [
              "HOW SHOULD RUNNER MAP THIS JOB?",
              "1  Runner-guided cards (recommended; no model)",
              currentModel
                ? `2  Current ${boundaryModelLabel(currentModel)} model (one metadata-egress review)`
                : "2  Configure a model for bounded structural mapping",
              "3  Advanced: exact read-workload JSON",
              "4  Advanced: question-intent JSON plus model",
              "5  Reopen a saved workload analysis",
            ],
      },
    );
    if (choice === undefined) return boundaryAssistResult(boundaryAssistBackNotice());
    const normalizedChoice = choice.trim() || (input.jobFirst ? (currentModel ? "1" : "2") : "");
    manualSelected = input.jobFirst === true && normalizedChoice === "3";
    mode = input.jobFirst
      ? ({ "1": "model", "2": "cards", "4": "exact", "5": "intent_model", "6": "saved" } as const)[normalizedChoice as "1" | "2" | "4" | "5" | "6"]
      : ({ "1": "cards", "2": "model", "3": "exact", "4": "intent_model", "5": "saved" } as const)[normalizedChoice as "1" | "2" | "3" | "4" | "5"];
  }
  if (manualSelected) {
    return boundaryAssistResult({
      tone: "success",
      title: "Manual Boundary setup selected.",
      lines: ["No model request was made and no disabled draft was changed."],
      footer: "Use the table list now. W reopens one-job assisted setup.",
    });
  }
  if (!mode) {
    return boundaryAssistResult({
      tone: "warning",
      title: "Choose one Boundary Assist input mode.",
      lines: [input.session.chooseOption
        ? "Press W again, move to one mapping path, and press Enter."
        : input.jobFirst
        ? "Press W again, move to one mapping path, and press Enter."
        : "Press W again and enter a number from 1 through 5."],
    });
  }
  let context = await loadBoundaryReviewContext(input.projectRoot);
  let resumedCompletedRemoval = false;
  const reviewActionRemoval = async (outcome: string): Promise<ReturnType<typeof boundaryAssistResult>> => {
    try {
      const removal = await prepareSavedActionRuleRemoval(input.projectRoot, outcome,
        pendingActionRemoval?.outcome === outcome ? pendingActionRemoval : undefined);
      if (removal.mode === "deactivate") {
        pendingActionRemoval = { outcome, authority_name: removal.authorityName,
          draft_digest: removal.digest as `sha256:${string}`, mode: "deactivate" };
        await persistAuthoringResume("authority_review");
        const result = await reviewFinalActionRemoval({ projectRoot: input.projectRoot, removal, session: input.session });
        if (result.completed) {
          pendingActionRemoval = undefined;
          const previous = resumeAction ?? availableResume?.action;
          const completed = previous?.completed_outcomes ?? (previous?.outcome ? [previous.outcome] : []);
          const removedIndex = completed.indexOf(outcome);
          const intents = (previous?.intents ?? (previous ? [previous.intent] : []))
            .filter((_intent, index) => index !== removedIndex);
          const outcomes = completed.filter(value => value !== outcome);
          resumeAction = intents.length ? { intent: intents[0]!, intents, strategy: previous?.strategy,
            completed_outcomes: outcomes, ...(previous?.outcome !== outcome ? { outcome: previous?.outcome, checkpoint: previous?.checkpoint } : {}) }
            : undefined;
          await persistAuthoringResume("authority_review");
        }
        input.authoringChat?.checkpoint(result.notice.title, result.notice.lines ?? []);
        return { ...boundaryAssistResult(result.notice, false, false, Boolean(input.authoringChat)), navigation: "pause" };
      }
      if (!removal.alreadyRemoved) await writeActionRuleAuthorityDraftIfCurrent(input.projectRoot, removal.draft, removal.baseline);
      const previousAction = availableResume?.action;
      const retainedIntents = removal.retainedOutcomes.map(retained => {
        const index = previousAction?.completed_outcomes?.indexOf(retained) ?? -1;
        return (index >= 0 ? previousAction?.intents?.[index] : undefined)
          ?? removal.draft.reviews.find(review => review.outcome === retained)!.then;
      });
      resumeAction = { intent: retainedIntents[0]!, intents: retainedIntents, outcome: removal.retainedOutcomes[0],
        completed_outcomes: removal.retainedOutcomes, strategy: "rule_derived" };
      if (removal.completedActivation) {
        pendingActionRemoval = undefined;
        await persistAuthoringResume("authority_review");
        resumedCompletedRemoval = true;
        const notice = { tone: "success" as const, title: "The saved action removal is already active.", lines: [
          `No longer offered: ${outcome}. Retained: ${removal.retainedOutcomes.join(", ")}.`,
          "Runner verified the exact saved revision. No repeat activation or database change was performed.",
        ] };
        input.authoringChat?.checkpoint(notice.title, notice.lines);
        return boundaryAssistResult(notice);
      }
      pendingActionRemoval = { outcome, authority_name: removal.draft.authority.name, draft_digest: removal.draft.digest };
      await persistAuthoringResume("authority_review");
      const lines = [
        `After activation: ${outcome} will no longer be available for new requests or new execution.`,
        `Retained unchanged: ${removal.retainedOutcomes.join(", ")}. Read access and business conditions are unchanged.`,
        "The replacement is saved but not active. Earlier requests are not rewritten; already-dispatched changes may finish. Check their receipts before retrying.",
        "Execution permissions for the replacement require separate review. No database change ran.",
      ];
      input.authoringChat?.rememberDetails("ACTION REMOVAL REVIEW", lines);
      if (input.authoringChat) await input.authoringChat.streamCheckpoint("Action removal ready for review", lines);
      const notice = await reviewVerifiedActionAuthority({ projectRoot: input.projectRoot,
        boundaryName: removal.draft.authority.rules[0]!.read_boundary_name,
        session: input.session, draft: removal.draft, active: removal.active });
      const active = await readActionRuleAuthorityActivation(input.projectRoot);
      if (active?.digest === removal.draft.digest) pendingActionRemoval = undefined;
      await persistAuthoringResume("authority_review");
      return boundaryAssistResult(notice);
    } catch (error) {
      assertRunning(error);
      const detail = redactCliErrorMessage(error instanceof Error ? error.message : String(error));
      input.authoringChat?.rememberDetails("ACTION REMOVAL NEEDS REVIEW", [detail]);
      return boundaryAssistResult({ tone: "warning", title: "Action removal needs review.", lines: [detail],
        footer: "Saved work is preserved. Reopen the action review; no source change ran." });
    }
  };
  if (resumeSelected && pendingActionRemoval) {
    const result = await reviewActionRemoval(pendingActionRemoval.outcome);
    if (!resumedCompletedRemoval) return result;
  }
  let jobPlan: BoundaryJobPlan | undefined;
  let reusableState: BoundaryJobAuthoringState | undefined = initialReusableState;
  let reusedReadWorkload: ReadWorkloadView | undefined;
  let resumedReadWorkload: ReadWorkloadView | undefined;
  let reusingExactRead = false;
  let resumingDisabledRead = false;
  let revalidatedActionOutcomes: string[] | undefined;
  let mappedReadIntent = resumeReadIntent ?? jobIntent.trim();
  const resumePastPlanning = resumedCompletedRemoval || resumeSelected
    && availableResume !== undefined
    && availableResume.stage !== "planning"
    && (availableResume.stage !== "read_mapping"
      || Boolean(resumeReadIntent)
      || Boolean(resumeRead));
  // A rescan invalidates the old Read analysis and any partial model checkpoint,
  // but a completed semantic outcome remains an exact local identity to
  // recompile. Do not send that completed work back through the planner.
  const revalidatedCompletedOutcomes = revalidateSavedJob && resumeSelected
    && availableResume?.action?.strategy === "rule_derived"
    && availableResume.action.completed_outcomes?.length
    ? [...availableResume.action.completed_outcomes]
    : undefined;
  // A standalone unfinished agenda is not an inventory of the saved authority.
  // Recover exact stored outcomes after a rescan, including a previously failed
  // planning resume, without interpreting the unfinished request as their edit.
  const separatelySavedRevalidationOutcomes = resumeSelected && !pendingJobRevision
    && !pendingReadRevision && !pendingActionRevision && !pendingActionAddition && !pendingActionRemoval
    && !revalidatedCompletedOutcomes && !availableResume?.action?.completed_outcomes?.length
    && (revalidateSavedJob || availableResume?.stage === "planning")
    ? reusableState?.stale_action_outcomes ?? [] : [];
  const recoveringSeparatelySavedActions = separatelySavedRevalidationOutcomes.length > 0;
  if (recoveringSeparatelySavedActions) {
    retainedReadEdit = { action: structuredClone(resumeAction), addition: structuredClone(pendingActionAddition) };
  }
  const resumesCompletedActionsAfterRevalidation = Boolean(revalidatedCompletedOutcomes?.length) || recoveringSeparatelySavedActions;
  const pendingActionAdditionInstruction = (addition: BoundaryAuthoringActionAddition) =>
    `Add one new Action behavior for the attached policy requirement at source lines ${addition.source_ranges.map((range) => `${range.start}-${range.end}`).join(", ")}. Preserve the existing Read Boundary and every existing Action behavior.`;
  const pendingActionAdditionIsCurrent = () => {
    const source = activePolicySource(authoringConversation?.policySources);
    return Boolean(pendingActionAddition && source
      && source.digest === pendingActionAddition.policy_source_digest
      && pendingActionAddition.source_ranges.every((range) => range.end <= source.lines));
  };
  if (pendingActionAddition) {
    if (!pendingActionAdditionIsCurrent()) {
      return boundaryAssistResult({ tone: "warning", title: "The saved missing-behavior request needs its original policy snapshot.",
        lines: ["Runner did not plan or infer a new Action because its cited policy source changed or is unavailable.",
          "The existing Read Boundary and Action authority remain unchanged."],
        footer: "Restore the exact attached policy snapshot, then resume this saved job." });
    }
    pendingJobRevision ??= pendingActionAdditionInstruction(pendingActionAddition);
    jobIntent = pendingJobRevision;
  }
  const shouldPlanModelJob = input.jobFirst
    && !resumedCompletedRemoval
    && mode === "model"
    && preselectedMappingSession !== undefined
    && modelEgressAcknowledged
    && (!resumePastPlanning || resumesCompletedActionsAfterRevalidation || Boolean(pendingReadRevision))
    && (resumesCompletedActionsAfterRevalidation
      || input.modelBoundaryJobPlanner !== undefined
      || input.modelReadWorkloadGenerator === undefined);
  if (shouldPlanModelJob) {
    reusableState ??= await inspectBoundaryJobAuthoringState({
      projectRoot: input.projectRoot,
      context,
    });
    let planningModel = preselectedMappingSession!;
    let additionalAttemptUsed = false;
    while (true) {
      if (resumeSelected && pendingReadRevision) {
        jobPlan = { state: "planned", read_mode: "revise", action_mode: "reuse",
          summary: "Finish the saved access edit and revalidate unchanged actions.",
          correction_used: false, authority_granted: false, source_database_changed: false };
        break;
      }
      // Completed drafting has an exact local contract. A schema/role repair
      // requires revalidation of that contract, not another interpretation.
      if (recoveringSeparatelySavedActions || (revalidateSavedJob && resumeSelected && loadedResume.status === "stale"
        && (resumesCompletedActionsAfterRevalidation
          || ["authority_review", "client_setup"].includes(loadedResume.value.stage)))) {
        jobPlan = {
          state: "planned", read_mode: "reuse", action_mode: "reuse",
          summary: "Revalidate the saved business rules against the changed database.",
          correction_used: false, authority_granted: false, source_database_changed: false,
        };
        break;
      }
      const planningSession = boundaryAuthoringModelSession(planningModel, input.authoringChat);
      let clarificationAnswer: string | undefined;
      let planningFailure: unknown;
      jobPlan = undefined;
      try {
        const clarificationTranscript: string[] = [];
        for (let modelTurn = 0; modelTurn <= 2; modelTurn += 1) {
          jobPlan = await runWithProgress(
            clarificationTranscript.length ? "Updating the Boundary plan" : "Planning Read and Action work",
            () => (input.modelBoundaryJobPlanner ?? planModelBoundaryJob)({
              session: planningSession,
              jobIntent: jobIntent!.trim(),
              currentState: reusableState!.current_state,
              onDiagnostic: async (diagnostic) => {
                input.session.rememberDetails?.("BOUNDARY JOB PLANNING DIAGNOSTICS", planningDiagnosticLines(diagnostic));
                await saveBoundaryJobPlanningDiagnostic(input.projectRoot, diagnostic);
              },
              availableResourceIds: context.draft.pack.resources.map((resource) => resource.id),
              ...(clarificationTranscript.length
                ? { clarificationAnswer: clarificationTranscript.join("\n\n") }
                : {}),
              env: process.env,
              egressAcknowledged: true,
            }),
          );
          if (jobPlan.state === "planned") break;
          if (modelTurn >= 2) break;
          clarificationAnswer = await input.session.promptText(jobPlan.question, {
            context: [
              "MODEL QUESTION",
              "The answer is used only to classify this job. Runner still validates every exact Boundary decision.",
            ],
          });
          if (clarificationAnswer === undefined) {
            return boundaryAssistResult(boundaryAssistBackNotice(
              "Boundary planning paused before any disabled draft changed.",
            ));
          }
          rememberModelAuthoringTurn(
            authoringConversation,
            jobPlan.question,
            clarificationAnswer,
          );
          await persistAuthoringResume("planning");
          clarificationTranscript.push([
            `Model question: ${jobPlan.question}`,
            `Operator answer: ${clarificationAnswer}`,
          ].join("\n"));
        }
      } catch (error) {
        assertRunning(error);
        planningFailure = error;
      }
      if (jobPlan?.state === "planned") break;

      const recovery = await promptBoundaryJobPlanningFallback({
        session: input.session,
        model: planningModel,
        allowAdditionalAttempt: !additionalAttemptUsed,
        ...(planningFailure ? { failure: planningFailure } : {}),
        ...(jobPlan?.state === "clarification" ? { unresolvedQuestion: jobPlan.question } : {}),
      });
      if (recovery === "back") {
        return boundaryAssistResult(boundaryAssistBackNotice(
          "Boundary planning paused before any disabled draft changed. The rejected model response was discarded.",
        ));
      }
      if (recovery === "runner") {
        mode = "cards";
        routeSelectedModel = undefined;
        preselectedMappingSession = undefined;
        modelEgressAcknowledged = false;
        input.authoringChat?.setPermissionGuide?.(undefined);
        jobPlan = undefined;
        break;
      }
      if (recovery === "change_model") {
        const replacement = await promptBoundaryMappingModel(
          input.session,
          planningModel,
          input.modelDiscovery,
        );
        if (!replacement) continue;
        const replacementSession = {
          ...replacement,
          ...(authoringConversation ? { conversation: authoringConversation } : {}),
        };
        input.authoringChat?.setModel(boundaryModelLabel(replacementSession));
        input.authoringChat?.setPermissionGuide?.(undefined);
        const replacementAcknowledged = await confirmModelEgress(replacementSession);
        if (!replacementAcknowledged) {
          await input.authoringChat?.streamCheckpoint("Replacement model not started", [
            "Metadata egress was not approved; the same job and every Boundary remain unchanged",
          ], "warning");
          continue;
        }
        planningModel = replacementSession;
        routeSelectedModel = replacementSession;
        preselectedMappingSession = replacementSession;
        selectedResumeModel = replacementSession;
        modelEgressAcknowledged = true;
        installPermissionGuide(replacementSession);
        await persistAuthoringResume("planning");
      }
      additionalAttemptUsed = true;
    }
    if (jobPlan?.state === "planned") {
      // The selected public editor, not model classification, owns edit scope.
      if (input.initialSavedReadRevision) jobPlan = { ...jobPlan, action_mode: "reuse" };
      if (!intendedClient && isAuthoringClientPlan(jobPlan.intended_client)) intendedClient = jobPlan.intended_client;
      await chooseUnspecifiedClient();
      if (pendingActionAddition) {
        const actionCount = jobPlan.action_intents?.length ?? 1;
        if (!pendingActionAdditionIsCurrent()
          || jobPlan.read_mode !== "reuse"
          || jobPlan.action_mode !== "create"
          || jobPlan.action_strategy !== "rule_derived"
          || jobPlan.action_outcome !== undefined
          || actionCount !== 1) {
          await persistAuthoringResume("planning");
          return boundaryAssistResult({ tone: "warning", title: "The missing behavior was not planned as one new Action.",
            lines: ["Runner requires the existing Read Boundary to remain reused and exactly one new rule-derived Action to be drafted.",
              "No existing Action was revised, removed, activated, or replaced."],
            footer: "Resume this saved job to correct the bounded plan." });
        }
      }
      if (jobPlan.action_mode === "remove") {
        pendingJobRevision = undefined;
        jobIntent = availableResume?.job_intent ?? jobIntent;
        return reviewActionRemoval(jobPlan.action_outcome!);
      }
      // Editing saved access is an exact revision, even when the planner calls
      // an unreviewed partial mapping "create". Never commit a replacement
      // mapping before validating all of its saved Action dependencies.
      if (editingSavedJob && jobPlan.read_mode === "create"
        && (input.initialSavedReadRevision || jobPlan.action_mode === "reuse" || jobPlan.action_mode === "none")) {
        jobPlan = { ...jobPlan, read_mode: "revise", action_mode: "reuse" };
      }
      if (jobPlan.read_mode === "create") {
        resumeRead = undefined;
        pendingReadRevision = undefined;
      }
      if (jobPlan.read_mode === "revise") {
        let exact = reusableState.revisable_read_workload;
        if (!exact && availableResume && !revalidateSavedJob && (editingSavedJob || pendingReadRevision)) {
          context = await reloadReadReviewForModelRevision(input.projectRoot, context);
          // This binds an edit to the current disabled candidate, not an
          // operator signoff. Final Read review and activation remain separate.
          exact = await recordExactReadAuthorityAsReusableWorkload({ projectRoot: input.projectRoot,
            boundary: context.candidate, reviewRevision: context.progress?.revision ?? 1 });
        }
        if (!exact?.review || exact.review.candidate_digest !== context.bundle.candidate_digest) {
          return boundaryAssistResult({ tone: "warning", title: "The saved access review needs recovery.",
            lines: ["There is no matching exact review for the current draft. Your work and active permissions are unchanged."],
            footer: "Resume the saved review or inspect exact details. Runner has not started a replacement mapping." });
        }
        pendingReadRevision ??= jobIntent.trim();
        reusedReadWorkload = exact;
        reusingExactRead = true;
        reusableState.read_boundaries_by_digest.set(context.bundle.candidate_digest, context.candidate);
        resumeRead = { analysis_id: exact.analysis_id, analysis_digest: exact.analysis_digest };
        if (jobPlan.action_mode === "reuse" || jobPlan.action_mode === "none") {
          if (reusableState.current_state.actions.some((action) => action.kind !== "rule_derived")) {
            return boundaryAssistResult({ tone: "warning", title: "An older action needs dependency review.",
              lines: ["The requested access edit and existing actions are preserved. Review the older action's dependency before changing access."],
              footer: "No access, action authority or source data changed." });
          }
          revalidatedActionOutcomes = [...new Set(reusableState.current_state.actions
            .filter((action) => action.kind === "rule_derived" && action.outcome).map((action) => action.outcome!))];
          // Access-only edits retain the original business job and every saved
          // outcome. Recompile their unchanged AST, never regenerate their rules.
          jobIntent = availableResume?.job_intent ?? jobIntent;
          const savedAction = availableResume?.action;
          retainedReadEdit ??= { action: structuredClone(savedAction), addition: structuredClone(availableResume?.pending_action_addition) };
          const savedOutcomes = savedAction?.completed_outcomes ?? [];
          const savedIntents = savedAction?.intents ?? (savedAction ? [savedAction.intent] : []);
          const draftingIntents: string[] = [];
          for (const outcome of revalidatedActionOutcomes) {
            const baseline = await loadActionRuleRevisionBaseline({ projectRoot: input.projectRoot,
              boundaryName: context.candidate.pack.name, outcome, preserveVerificationFields: true,
              expectedReadDigest: reusableState.action_read_digest_by_outcome.get(outcome) });
            if (!baseline) throw new Error(`ACTION_RULE_REVISION_NOT_FOUND: ${outcome} has no exact saved revision. No access edit was saved.`);
            const index = savedOutcomes.indexOf(outcome);
            // This label is only for reviewing the unchanged compiled AST. It
            // never becomes a new intent or replaces the saved partial agenda.
            draftingIntents.push(index >= 0 && savedOutcomes.length <= savedIntents.length
              ? savedIntents[index]! : baseline.draft.review.then);
          }
          jobPlan = { ...jobPlan, read_mode: "reuse", action_mode: draftingIntents.length ? "revise" : "none",
            ...(draftingIntents.length ? { action_strategy: "rule_derived", action_intent: draftingIntents[0],
              action_intents: draftingIntents, action_outcome: revalidatedActionOutcomes[0] } : {}) };
        } else jobPlan = { ...jobPlan, read_mode: "reuse" };
      }
      if ((revalidateSavedJob || recoveringSeparatelySavedActions) && resumeSelected
        && (jobPlan.read_mode === "none" || jobPlan.read_mode === "reuse")
        && (jobPlan.action_mode === "none" || jobPlan.action_mode === "reuse")) {
        // Rebuild from the reconciled candidate, not the old serving revision.
        // Retained exact decisions need no intermediate activation screen:
        // finish Action rebuilding and policy reconciliation before final review.
        if (!input.completeReadReview) throw new Error("Rescanned authority requires exact Read review.");
        await input.authoringChat?.streamCheckpoint("Business rules retained", [
          "Checking the changed database and rebuilding dependent actions without changing their business conditions. Final permissions still require your review.",
        ]);
        if (!exactReadBoundaryIsFullyReviewed(context)
          && await input.completeReadReview("prepare_actions", input.session) !== 0) {
          return boundaryAssistResult(boundaryAssistBackNotice("Revalidation paused. Saved business rules and current authority are unchanged."));
        }
        context = await loadBoundaryReviewContext(input.projectRoot);
        if (!exactReadBoundaryIsFullyReviewed(context)) {
          return boundaryAssistResult(boundaryAssistBackNotice("The changed Read revision still needs review. The saved job is retained."));
        }
        reusedReadWorkload = await recordExactReadAuthorityAsReusableWorkload({ projectRoot: input.projectRoot,
          boundary: context.candidate, reviewRevision: context.progress!.revision });
        reusingExactRead = true;
        reusableState.read_boundaries_by_digest.set(explorationBoundaryCandidateDigest(context.candidate), context.candidate);
        revalidatedActionOutcomes = recoveringSeparatelySavedActions ? separatelySavedRevalidationOutcomes : revalidatedCompletedOutcomes
          ?? [...new Set(reusableState.current_state.actions
            .filter((action) => action.kind === "rule_derived" && action.outcome).map((action) => action.outcome!))];
        if (reusableState.current_state.actions.some((action) => action.kind !== "rule_derived")) {
          return boundaryAssistResult(boundaryAssistBackNotice("Read review saved. Legacy proposal authority needs its own dependency review; no Action was replaced."));
        }
        const savedRevalidationIntents: string[] = [];
        for (const outcome of revalidatedActionOutcomes) {
          const baseline = await loadActionRuleRevisionBaseline({
            projectRoot: input.projectRoot,
            boundaryName: context.candidate.pack.name,
            outcome,
          });
          if (!baseline) {
            return boundaryAssistResult({
              tone: "warning",
              title: "A saved Action outcome needs exact review.",
              lines: [
                `Runner could not find the exact reviewed Action revision for ${outcome}.`,
                "It did not replace, regenerate, or activate any Action authority. Source data is unchanged.",
              ],
              footer: "Reopen the saved Action review to select or prepare the exact outcome. Do not reset the project or re-enter the business job.",
            });
          }
          savedRevalidationIntents.push(baseline.draft.review.then);
        }
        const resumedActionIntents = recoveringSeparatelySavedActions ? savedRevalidationIntents : resumesCompletedActionsAfterRevalidation
          ? availableResume?.action?.intents ?? [availableResume!.action!.intent]
          : revalidatedActionOutcomes.map(() => jobIntent!.trim());
        jobPlan = { ...jobPlan, read_mode: "reuse", action_mode: revalidatedActionOutcomes.length ? "revise" : "none",
          ...(revalidatedActionOutcomes.length ? { action_strategy: "rule_derived", action_intent: jobIntent.trim(),
            action_intents: resumedActionIntents, action_outcome: revalidatedActionOutcomes[0] } : {}) };
        resumeRead = { analysis_id: reusedReadWorkload.analysis_id, analysis_digest: reusedReadWorkload.analysis_digest };
      }
      if (editingSavedJob && availableResume
        && (jobPlan.read_mode === "none" || jobPlan.read_mode === "reuse")
        && (jobPlan.action_mode === "none" || jobPlan.action_mode === "reuse")
        && !revalidatedActionOutcomes && !pendingReadRevision) {
        // A planner no-op does not withdraw an operator's edit or finish a
        // partial job. The planning checkpoint already retains both exactly.
        input.authoringChat?.rememberDetails("SAVED EDIT STILL PENDING", [jobPlan.summary,
          "The model proposed no change. The requested edit, earlier business answers and unfinished actions remain saved.",
          "No draft, activation, approval, execution or source data changed."]);
        return boundaryAssistResult({ tone: "warning", title: "No change was prepared.",
          lines: ["Your requested edit and unfinished work remain saved. Existing access and actions are unchanged."],
          footer: "Resume this saved edit to clarify it or retry with the model; you do not need to enter the job again." });
      }
      mappedReadIntent = jobPlan.read_intent ?? jobIntent.trim();
      resumeReadIntent = jobPlan.read_mode === "create" || jobPlan.read_mode === "revise"
        ? mappedReadIntent
        : undefined;
      resumeAction = retainedReadEdit ? retainedReadEdit.action : resumesCompletedActionsAfterRevalidation
        ? availableResume?.action
        : jobPlan.action_mode === "create" || jobPlan.action_mode === "revise"
          ? {
              intent: boundedDownstreamActionIntent(jobPlan.action_intent!, jobIntent.trim()),
              ...(jobPlan.action_intents ? { intents: jobPlan.action_intents } : {}),
              ...(jobPlan.action_outcome ? { outcome: jobPlan.action_outcome } : {}),
              ...(jobPlan.action_strategy ? { strategy: jobPlan.action_strategy } : {}),
            }
          : availableResume?.action;
      // The plan now owns the classified edit. Keep the business job stable for
      // mixed Read/Action revisions as well as access-only changes.
      if (!pendingActionAddition) pendingJobRevision = undefined;
      jobIntent = canonicalJobIntent ?? jobIntent;
      await persistAuthoringResume(
        jobPlan.read_mode === "create" || jobPlan.read_mode === "revise"
          ? "read_mapping"
          : jobPlan.action_mode === "create" || jobPlan.action_mode === "revise"
            ? "action_drafting"
            : "authority_review",
      );
      if ((jobPlan.read_mode === "none" || jobPlan.read_mode === "reuse")
        && (jobPlan.action_mode === "none" || jobPlan.action_mode === "reuse") && !revalidatedActionOutcomes && !pendingReadRevision) {
        if (input.authoringChat) await input.authoringChat.streamModel([jobPlan.summary]);
        const currentAuthority = formatCurrentBoundaryAuthoritySummary(reusableState.current_state);
        input.authoringChat?.rememberDetails("EXISTING BOUNDARY AUTHORITY", currentAuthority);
        if (!await clearBoundaryAuthoringResumeState(input.projectRoot)) {
          return boundaryAssistResult({ tone: "warning", title: "Unfinished work remains saved.",
            lines: ["No new change was planned. The saved job, unanswered business decisions and draft components remain pending."],
            footer: "Resume the saved job when its missing business decisions are available. Existing authority is unchanged." });
        }
        return boundaryAssistResult({
          tone: "success",
          title: "Existing Boundary authority kept unchanged.",
          lines: currentAuthority,
          footer: "No new draft, activation, approval, apply operation, or source write occurred.",
        });
      }
      input.authoringChat?.rememberDetails("BOUNDARY JOB ROUTE", [
        jobPlan.summary,
        `Read: ${jobPlan.read_mode}`,
        `Action: ${jobPlan.action_mode}${jobPlan.action_strategy ? ` (${jobPlan.action_strategy})` : ""}`,
        "This routing decision grants no authority and is superseded by the validated draft summary shown in the conversation.",
      ]);
      if (pendingActionAddition && jobPlan.read_mode === "reuse" && resumeRead && !reusedReadWorkload) {
        const retained = await readReadWorkloadAnalysis({
          projectRoot: input.projectRoot,
          analysisId: resumeRead.analysis_id,
          generatedBoundary: context.candidate,
        });
        if (retained.analysis_digest !== resumeRead.analysis_digest || !retained.review) {
          return boundaryAssistResult({
            tone: "warning",
            title: "The saved missing-behavior request needs its exact Read review.",
            lines: ["Runner could not reuse the Read analysis recorded with this job.",
              "It did not create, revise, activate, or replace an Action."],
            footer: "Restore or select the exact reviewed Read revision, then resume this same job.",
          });
        }
        reusedReadWorkload = retained;
        reusingExactRead = true;
      }
      if (jobPlan.read_mode === "reuse" && !reusedReadWorkload) {
        const reuseCandidates = reusableReadWorkloadsForJob(reusableState, jobPlan);
        reusedReadWorkload = await selectReusableReadWorkload({
          session: input.session,
          workloads: reuseCandidates,
        });
        if (!reusedReadWorkload?.review) {
          return boundaryAssistResult({
            tone: "warning",
            title: "No exact Read revision was selected.",
            lines: [
              "Runner did not replace, broaden, or activate the current Read Boundary.",
              "Choose one exact reviewed revision or ask the model to revise the Read Boundary instead.",
            ],
          });
        }
        reusingExactRead = true;
        input.authoringChat?.rememberDetails("EXISTING READ BOUNDARY REUSED", [
          `Boundary: ${context.candidate.pack.name}`,
          `Authority: ${reusableState.current_state.read.authority}`,
          `Resources: ${context.candidate.pack.resources.map((resource) => resource.id).join(", ")}`,
          `Review revision: ${reusedReadWorkload.review.review_revision}`,
          "Read candidate changed: no",
          "Source database changed: no",
        ]);
      } else if (jobPlan.read_mode === "resume") {
        resumedReadWorkload = await selectResumableReadWorkload({
          session: input.session,
          workloads: reusableState.resumable_read_workloads,
        });
        if (!resumedReadWorkload) {
          return boundaryAssistResult({
            tone: "warning",
            title: "No exact disabled Read mapping was selected.",
            lines: [
              "Runner did not remap, broaden, review, or activate the current Read Boundary.",
              "Reopen the same job to resume its mapped Read draft or ask the model to create a different one.",
            ],
          });
        }
        resumingDisabledRead = true;
        input.authoringChat?.rememberDetails("DISABLED READ MAPPING RESUMED", [
          `Boundary: ${context.candidate.pack.name}`,
          `Resources: ${resumedReadWorkload.analysis.candidate?.pack.resources.map((resource) => resource.id).join(", ") ?? "none"}`,
          `Read plans: ${resumedReadWorkload.analysis.coverage.allowed_supported}`,
          "Read candidate changed: no",
          "Read authority: disabled",
          "Source database changed: no",
        ]);
      }
    }
  }
  await chooseUnspecifiedClient();
  const promptedActionIntents = retainedReadEdit && jobPlan?.state === "planned"
    ? jobPlan.action_intents ?? []
    : resumePastPlanning
    ? resumeAction ? resumeAction.intents ?? [resumeAction.intent] : []
    : jobPlan?.state === "planned"
    ? jobPlan.action_mode === "create" || jobPlan.action_mode === "revise"
      ? jobPlan.action_intents ?? [boundedDownstreamActionIntent(jobPlan.action_intent!, jobIntent.trim())]
      : []
    : input.jobFirst
      ? input.authoringChat && mode === "model"
        ? jobAppearsToChangeState(jobIntent.trim()) ? [jobIntent.trim()] : []
        : await promptJobFirstActionIntents(input.session, jobIntent.trim())
      : await promptDelegationActionIntents(input.session);
  if (!promptedActionIntents) return boundaryAssistResult(boundaryAssistBackNotice("Delegation setup closed."));
  let actionIntents: string[] = promptedActionIntents;
  let ruleDerivedAction = actionIntents.length > 0
    && (jobPlan?.state === "planned"
      ? jobPlan.action_strategy === "rule_derived"
      : resumePastPlanning
        ? resumeAction?.strategy === "rule_derived" || resumeAction?.outcome !== undefined
        : false);
  if (input.jobFirst
    && mode !== "saved"
    && !reusingExactRead
    && !resumingDisabledRead
    && !resumePastPlanning) {
    const prepared = await prepareJobMappingCatalog({
      projectRoot: input.projectRoot,
      schemaInspector: input.schemaInspector,
      session: input.session,
      jobIntent: jobIntent.trim(),
      ...(input.authoringChat ? {
        write: (title, lines) => input.authoringChat!.rememberDetails(title, lines),
        progress: (message, operation) => input.authoringChat!.progress(message, operation),
      } : {}),
    });
    if (!prepared) {
      return boundaryAssistResult(boundaryAssistBackNotice(
        "Job mapping paused. No model request was made and active authority is unchanged.",
      ));
    }
    context = await loadBoundaryReviewContext(input.projectRoot);
    await persistAuthoringResume("read_mapping");
  }
  if (input.jobFirst && mode === "model" && resumePastPlanning
    && availableResume?.stage === "read_mapping" && !resumeRead) {
    const added = await runWithProgress("Checking saved record links", () =>
      refreshIncompleteReadMappingRelationships({ projectRoot: input.projectRoot, schemaInspector: input.schemaInspector }));
    if (added.length) {
      context = await loadBoundaryReviewContext(input.projectRoot);
      input.authoringChat?.rememberDetails("SAVED RECORD LINKS UPDATED", [
        ...added,
        "Only the unfinished mapping catalog changed. Field privacy and active authority are unchanged; the resulting access still requires review.",
      ]);
      await persistAuthoringResume("read_mapping");
    }
  }
  // Job-first setup has just turned the current candidate into the broad,
  // disabled mapping catalog. Use that exact reviewed revision so raised path
  // limits and newly proven scope paths are present during validation. The
  // resulting workload is minimized and revalidated before it replaces this
  // catalog; no authority is activated here.
  let mappingBoundary = context.candidate;
  if (reusingExactRead && reusedReadWorkload?.review) {
    const exactBoundary = reusedReadWorkload.review.candidate_digest === explorationBoundaryCandidateDigest(context.candidate)
      ? context.candidate
      : reusableState?.read_boundaries_by_digest.get(reusedReadWorkload.review.candidate_digest);
    if (!exactBoundary) {
      return boundaryAssistResult({
        tone: "warning",
        title: "The exact Read revision is no longer available.",
        lines: [
          "Runner refused to substitute the current editor draft for the selected serving or reviewed revision.",
          "No Read or Action authority and no source data changed.",
        ],
        footer: "Reopen Boundary drafting and choose a current exact revision.",
      });
    }
    mappingBoundary = exactBoundary;
  }
  let workload: ReadWorkloadView | undefined = reusedReadWorkload ?? resumedReadWorkload;
  if (resumePastPlanning && resumeRead) {
    const restored = await readReadWorkloadAnalysis({
      projectRoot: input.projectRoot,
      analysisId: resumeRead.analysis_id,
      generatedBoundary: mappingBoundary,
    });
    if (restored.analysis_digest !== resumeRead.analysis_digest) {
      throw new Error(
        "BOUNDARY_AUTHORING_RESUME_CHANGED: the saved Read analysis no longer matches this authoring checkpoint.",
      );
    }
    resumedReadWorkload = restored;
    if (availableResume?.stage === "authority_review" || restored.review) {
      reusingExactRead = true;
      resumingDisabledRead = false;
    } else {
      resumingDisabledRead = true;
    }
    workload = restored;
  }
  let preparedWorkload: ReadWorkloadSet | undefined;
  // A resumed, exact Read + rule-derived Action has already restored the
  // saved model destination and its consent above. Coverage must use that
  // same session before it can offer a cited missing behavior; otherwise a
  // completed draft would bypass attached-rule review and jump to activation.
  let modelAssistSession: ActionModelSuggestionSession | undefined = reusingExactRead
    && ruleDerivedAction
    && modelEgressAcknowledged
    && preselectedMappingSession
    ? boundaryAuthoringModelSession(preselectedMappingSession, input.authoringChat)
    : undefined;
  let modelInterviewSession: ActionModelSuggestionSession | undefined = modelAssistSession;
  let modelAssistRecord: DelegationModelAssist | undefined;
  let actionInspection: Awaited<ReturnType<typeof inspectActionProject>> | undefined;
  let semanticActionCatalog: BuiltActionRuleAuthoringCatalogV1 | undefined;
  let semanticActionModelResult: ModelActionRuleDraftResult | undefined;
  let semanticActionModelDraft: ActionRuleModelDraftV1 | undefined;
  const semanticActionDrafts: Array<{
    intent: string;
    result: ModelActionRuleDraftResult;
    catalog: BuiltActionRuleAuthoringCatalogV1;
    baseline?: ActionRuleModelDraftV1;
  }> = [];
  let semanticActionRevisionBaseline: ActionRuleModelDraftV1 | undefined;
  let semanticActionRevisionCatalog: ActionRuleCatalogV1 | undefined;
  let semanticActionAuthorityDraft: ActionRuleAuthorityDraftV1 | undefined;
  let semanticActionPublicationBaseline: ActionRuleAuthorityRevisionBaseline | undefined;
  const saveSemanticActionDraft = async (draft: ActionRuleAuthorityDraftV1): Promise<void> => {
    if (!semanticActionPublicationBaseline) throw new Error("ACTION_RULE_REVISION_BASELINE_MISSING: reload the saved job before saving Action rules.");
    semanticActionPublicationBaseline = await writeActionRuleAuthorityDraftIfCurrent(input.projectRoot, draft, semanticActionPublicationBaseline);
  };
  let semanticActionActivation: ActionRuleAuthorityActivationV1 | undefined;
  let semanticExecutionEnabled = false;
  const semanticExecutionRunCommands: string[] = [];
  const preMappedActions: Array<{
    intent: string;
    result: Awaited<ReturnType<typeof generateModelActionSuggestion>>;
  }> = [];
  const prepareRunnerGuidedWorkload = async (): Promise<ReadWorkloadView | undefined> => {
    const builtCards = buildReadWorkloadPlanCards(mappingBoundary);
    const cards = input.jobFirst
      ? rankReadWorkloadPlanCardsForJob(builtCards, jobIntent)
      : builtCards;
    if (!cards.length) {
      throw new Error("No reviewed question cards are available yet. Review at least one table or use Advanced exact JSON for a specific plan.");
    }
    const selectedIds = await selectRunnerGuidedReadCards({
      session: input.session,
      cards,
      jobIntent: input.jobFirst ? jobIntent.trim() : undefined,
    });
    if (selectedIds === undefined) return undefined;
    let exact = readWorkloadFromPlanCards({ cards, selectedIds });
    if (actionIntents.length) {
      actionInspection = await (input.actionProjectInspector ?? inspectActionProject)(
        input.projectRoot,
        process.env,
      );
      const actionCatalog = guidedActionOptionsFromCandidate({
        candidate: mappingBoundary,
        inspection: actionInspection,
      });
      const supportEntries = noModelActionSupportEntries({
        actionIntents,
        options: actionCatalog,
        existingIds: exact.allowed.map((entry) => entry.id),
      });
      if (supportEntries.length) {
        exact = normalizeReadWorkloadSet({
          ...exact,
          allowed: [...exact.allowed, ...supportEntries],
        });
      }
    }
    preparedWorkload = exact;
    const analysis = analyzeReadWorkloadSet({ workload: exact, generatedBoundary: mappingBoundary });
    return storeReadWorkloadAnalysis({
      projectRoot: input.projectRoot,
      generatedBoundary: mappingBoundary,
      source: exact.source,
      analysis,
    });
  };
  if (mode === "cards") {
    const guided = await prepareRunnerGuidedWorkload();
    if (!guided) return boundaryAssistResult(boundaryAssistBackNotice());
    workload = guided;
  } else if (mode === "exact") {
    const file = await input.session.promptText(
      "Exact workload JSON file",
    );
    if (file === undefined) return boundaryAssistResult(boundaryAssistBackNotice());
    if (!file.trim()) throw new Error("Choose one exact workload JSON file.");
    const exact = normalizeReadWorkloadSet(
      await readJsonFileWithLocation<unknown>(path.resolve(file.trim()), "read workload"),
    );
    if (exact.source?.kind !== "operator_exact_plan" && exact.source?.kind !== "plan_playground") {
      throw new Error("Exact workload import must declare source.kind=operator_exact_plan or plan_playground.");
    }
    preparedWorkload = exact;
    const analysis = analyzeReadWorkloadSet({ workload: exact, generatedBoundary: mappingBoundary });
    workload = await storeReadWorkloadAnalysis({
      projectRoot: input.projectRoot,
      generatedBoundary: mappingBoundary,
      source: exact.source,
      analysis,
    });
  } else if (mode === "model" || mode === "intent_model") {
    let intent: ReturnType<typeof parseReadWorkloadIntent> | undefined;
    if (workload) {
      // An exact reusable workload is already selected. The Action edit is not
      // a new Read question and must not be parsed or remapped as one.
    } else if (mode === "model" && input.jobFirst) {
      intent = parseReadWorkloadIntent({
        name: "delegation_reads",
        allowed_questions: [mappedReadIntent],
        forbidden_questions: [],
      });
    } else if (mode === "model") {
      const allowedQuestions = await promptReadWorkloadQuestions(
        input.session,
        "Question the agent must answer",
        true,
      );
      if (!allowedQuestions) return boundaryAssistResult(boundaryAssistBackNotice());
      const forbiddenQuestions = await promptReadWorkloadQuestions(
        input.session,
        "Question that must stay refused",
        false,
      );
      if (!forbiddenQuestions) return boundaryAssistResult(boundaryAssistBackNotice());
      intent = parseReadWorkloadIntent({
        name: "delegation_reads",
        allowed_questions: allowedQuestions,
        forbidden_questions: forbiddenQuestions,
      });
    } else {
      const file = await input.session.promptText(
        "Question intent JSON file (name, allowed_questions, forbidden_questions)",
      );
      if (file === undefined) return boundaryAssistResult(boundaryAssistBackNotice());
      if (!file.trim()) throw new Error("Choose one question intent JSON file.");
      intent = parseReadWorkloadIntent(
        await readJsonFileWithLocation<unknown>(path.resolve(file.trim()), "read workload intent"),
      );
    }
    const selectedModel = routeSelectedModel
      ?? await promptBoundaryMappingModel(input.session, currentModel, input.modelDiscovery);
    if (!selectedModel) return boundaryAssistResult(boundaryAssistBackNotice());
    selectedResumeModel = selectedModel;
    if (!routeSelectedModel) input.authoringChat?.setModel(boundaryModelLabel(selectedModel));
    let mappingSession: ActionModelSuggestionSession = preselectedMappingSession ?? {
        ...selectedModel,
        ...(authoringConversation ? { conversation: authoringConversation } : {}),
      };
    let acknowledged = modelEgressAcknowledged || await confirmModelEgress(mappingSession);
    while (!acknowledged) {
      if (!input.authoringChat || !input.session.chooseOption) {
        return boundaryAssistResult(boundaryAssistBackNotice("Model mapping was not started."));
      }
      const recovery = await input.session.chooseOption(
        "MODEL REQUEST NOT STARTED",
        [
          {
            value: "runner",
            label: "Continue this job without a model  [recommended]",
            detail: "Reuse the same disabled catalog and prepare explainable exact plan cards.",
          },
          {
            value: "review",
            label: "Review the same permission again",
            detail: "No request starts unless you approve the exact metadata egress shown above.",
          },
          {
            value: "change_model",
            label: "Choose another model",
            detail: "Keep the same job, then review the replacement model and its metadata egress.",
          },
          {
            value: "back",
            label: "Pause this job",
            detail: "Keep active authority unchanged and return to the access editor only by explicit choice.",
          },
        ],
        {
          initialValue: "runner",
          context: [
            "Runner sent nothing to the model. The same job and disabled structural catalog are still available.",
            "Choose how to continue; no source query, source write, or authority change has occurred.",
          ],
        },
      );
      if (recovery === "runner") {
        const guided = await prepareRunnerGuidedWorkload();
        if (!guided) return boundaryAssistResult(boundaryAssistBackNotice());
        workload = guided;
        break;
      }
      if (recovery === "review") {
        acknowledged = await confirmModelEgress(mappingSession);
        continue;
      }
      if (recovery === "change_model") {
        const replacement = await promptBoundaryMappingModel(
          input.session,
          mappingSession,
          input.modelDiscovery,
        );
        if (!replacement) {
          await input.authoringChat.streamCheckpoint("Model choice unchanged", [
            "No provider request was made. The same job is still waiting for a drafting path.",
          ], "warning");
          continue;
        }
        mappingSession = {
          ...replacement,
          ...(authoringConversation ? { conversation: authoringConversation } : {}),
        };
        input.authoringChat.setModel(boundaryModelLabel(mappingSession));
        selectedResumeModel = mappingSession;
        input.authoringChat.setPermissionGuide?.(undefined);
        acknowledged = await confirmModelEgress(mappingSession);
        modelEgressAcknowledged = acknowledged === true;
        if (acknowledged) await persistAuthoringResume("read_mapping");
        continue;
      }
      return boundaryAssistResult(boundaryAssistBackNotice(
        "Agent job paused by the operator. No provider request was made and no authority changed.",
      ));
    }
    if (acknowledged) {
      installPermissionGuide(mappingSession);
      modelAssistSession = boundaryAuthoringModelSession(mappingSession, input.authoringChat);
      modelInterviewSession = modelAssistSession;
      modelAssistRecord = {
        provider: mappingSession.provider,
        model: mappingSession.model,
        structural_metadata_egress_acknowledged: true,
      };
    }
    if (!workload
      || (resumingDisabledRead && actionIntents.length > 0)
      || (reusingExactRead && ruleDerivedAction)) {
    let mapped: Awaited<ReturnType<typeof generateModelReadWorkload>> | undefined;
    let operatorRetryUsed = false;
    const principalScopedRootResources: string[] | undefined = jobRequestsPrincipalIsolation(jobIntent.trim()) ? [] : undefined;
    if (principalScopedRootResources) {
      for (const resource of mappingBoundary.pack.resources) {
        const view = await inspectBoundaryResourceReview(input.projectRoot, resource.id);
        if (hasReviewedJobPrincipalScope(view) || reviewedJobPrincipalScopeOptions(view).length > 0) {
          principalScopedRootResources.push(resource.id);
        }
      }
    }
    while (!workload && !mapped) {
      if (!intent) throw new Error("A new Read mapping requires a reviewed Read intent.");
      let failure: BoundaryModelDraftFailure | undefined;
      try {
        mapped = await runWithProgress(
          "Mapping requested reads with the selected model",
          () => (input.modelReadWorkloadGenerator ?? generateModelReadWorkload)({
            name: intent.name,
            allowedQuestions: intent.allowed_questions,
            operatorNamingContext: jobIntent.trim(),
            forbiddenQuestions: intent.forbidden_questions,
            provider: mappingSession.provider,
            model: mappingSession.model,
            generatedBoundary: mappingBoundary,
            ...(principalScopedRootResources ? { principalScopedRootResources } : {}),
            ...(mappingSession.apiKey ? { apiKey: mappingSession.apiKey } : {}),
            ...(mappingSession.apiKeyEnv ? { apiKeyEnv: mappingSession.apiKeyEnv } : {}),
            ...(mappingSession.baseUrl ? { baseUrl: mappingSession.baseUrl } : {}),
            ...boundaryAuthoringProviderOptions(mappingSession.dependencies, input.authoringChat),
            ...(mappingSession.conversation ? { conversation: mappingSession.conversation } : {}),
            deferNarration: Boolean(input.authoringChat),
            egressAcknowledged: true,
            valueRequestHandler: (request) => promptReadBoundaryValueContext({
              session: input.session,
              model: mappingSession,
              request,
            }),
            clarificationHandler: async (request) => {
              const decision = await promptReadBoundaryClarification({
                session: input.session,
                model: mappingSession,
                request,
              });
              if (decision.state === "answered") {
                rememberModelAuthoringClarification(
                  authoringConversation,
                  request.question,
                  decision.answer,
                );
                await persistAuthoringResume("read_mapping");
              }
              return decision;
            },
          }),
        );
      } catch (error) {
        assertRunning(error);
        failure = recoverableReadModelDraftFailure(error);
        if (!failure) throw error;
      }
      if (mapped?.analysis.status === "blocked") {
        failure = mapped.diagnostics?.length ? { kind: "read_diagnostic", diagnostics: mapped.diagnostics } : {
          kind: "reviewed_grammar",
          blockers: mapped.analysis.blockers,
        };
      }
      if (!failure) break;

      const recovery = await promptRunnerGuidedModelFallback({
        session: input.session,
        provider: mappingSession.provider,
        model: mappingSession.model,
        stage: "Read Boundary",
        allowModelRetry: !operatorRetryUsed,
        failure,
      });
      if (recovery === "back") {
        return boundaryAssistResult(boundaryAssistBackNotice(
          "The refused model draft was discarded. Reopen Agent job to continue from the disabled authoring catalog.",
        ));
      }
      if (recovery === "runner") {
        const guided = await prepareRunnerGuidedWorkload();
        if (!guided) return boundaryAssistResult(boundaryAssistBackNotice());
        workload = guided;
        mapped = undefined;
        modelAssistSession = undefined;
        modelInterviewSession = undefined;
        modelAssistRecord = undefined;
        preMappedActions.length = 0;
        input.authoringChat?.setPermissionGuide?.(undefined);
        break;
      }

      operatorRetryUsed = true;
      mapped = undefined;
      if (recovery === "change_model") {
        const replacement = await promptBoundaryMappingModel(
          input.session,
          mappingSession,
          input.modelDiscovery,
        );
        if (!replacement) {
          return boundaryAssistResult(boundaryAssistBackNotice(
            "Model replacement was cancelled. The refused draft remains discarded and no authority changed.",
          ));
        }
        mappingSession = {
          ...replacement,
          ...(authoringConversation ? { conversation: authoringConversation } : {}),
        };
        input.authoringChat?.setModel(boundaryModelLabel(mappingSession));
        selectedResumeModel = mappingSession;
        input.authoringChat?.setPermissionGuide?.(undefined);
        const replacementAcknowledged = await confirmModelEgress(mappingSession);
        if (!replacementAcknowledged) {
          return boundaryAssistResult(boundaryAssistBackNotice(
            "Replacement-model egress was not approved. The refused draft remains discarded and no authority changed.",
          ));
        }
        installPermissionGuide(mappingSession);
        await persistAuthoringResume("read_mapping");
        modelAssistSession = boundaryAuthoringModelSession(mappingSession, input.authoringChat);
        modelInterviewSession = modelAssistSession;
        modelAssistRecord = {
          provider: mappingSession.provider,
          model: mappingSession.model,
          structural_metadata_egress_acknowledged: true,
        };
      }
    }
    if (mapped
      || (resumingDisabledRead && workload && actionIntents.length > 0)
      || (reusingExactRead && workload && ruleDerivedAction)) {
      const modelDraftMessages = mapped?.model_message ? [mapped.model_message] : [];
      let mappedWorkload = mapped?.workload
        ?? (resumingDisabledRead ? readWorkloadSetFromAnalysis(workload!, mappingBoundary) : undefined);
      let mappedAnalysis = mapped?.analysis ?? workload!.analysis;
      const representativeReadPlanCount = mappedWorkload?.allowed.length
        ?? representativeReadCoverage(workload!.analysis).total;
      let actionSupportPlanCount = 0;
      let exactModelDraftLines = mappedWorkload
        ? [
            `Read plans (${mappedWorkload.allowed.length})`,
            ...mappedWorkload.allowed.map((entry) => `- ${modelReadPlanSummary(entry.plan)}`),
          ]
        : resumingDisabledRead
          ? [
              `Resumed Read mapping (${representativeReadPlanCount} validated plan${representativeReadPlanCount === 1 ? "" : "s"})`,
              `Boundary: ${mappingBoundary.pack.name}; final review is still pending`,
            ]
          : [
            `Reused Read revision (${representativeReadPlanCount} reviewed plan${representativeReadPlanCount === 1 ? "" : "s"})`,
            `Boundary: ${mappingBoundary.pack.name} at ${explorationBoundaryCandidateDigest(mappingBoundary)}`,
          ];
      const readPrincipalScope = mappedWorkload ? await reviewJobPrincipalScopeForResources({
        projectRoot: input.projectRoot,
        schemaInspector: input.schemaInspector,
        session: input.session,
        jobIntent: jobIntent.trim(),
        resourceIds: mappedWorkload.allowed.flatMap((entry) => {
          const resource = entry.plan.resource;
          return typeof resource === "string" && resource ? [resource] : [];
        }),
        ...(modelAssistSession ? { modelSession: modelAssistSession } : {}),
        ...(input.modelAuthoringNarrator
          ? { modelNarrator: input.modelAuthoringNarrator }
          : {}),
        ...(input.modelPrincipalScopeInterpreter
          ? { modelInterpreter: input.modelPrincipalScopeInterpreter }
          : {}),
        ...(input.authoringChat ? { authoringChat: input.authoringChat } : {}),
      }) : { state: "ready" as const, changed: false, resources: [] };
      if (readPrincipalScope.state === "paused") {
        await persistAuthoringResume("read_mapping");
        return boundaryAssistResult({
          tone: "warning",
          title: "User/owner scope review paused this job.",
          lines: [
            `Still unresolved: ${readPrincipalScope.resources.join(", ")}`,
            "The job promises own-row access, so Runner will not save or activate a tenant-only substitute.",
            "The broad mapping catalog remains disabled and source data is unchanged.",
          ],
          footer: "Review the exact user/owner predicate, then reopen Agent job to resume this saved conversation and disabled catalog.",
        });
      }
      if (readPrincipalScope.changed) {
        context = await loadBoundaryReviewContext(input.projectRoot);
        mappingBoundary = context.candidate;
      }
      let scopeProjectionBlockers: string[] = [];
      if (mappedWorkload) {
        const reconciliation = reconcileModelWorkloadScopeProjection(mappedWorkload, mappingBoundary);
        scopeProjectionBlockers = reconciliation.blockers;
        mappedWorkload = reconciliation.workload;
        if (reconciliation.removed.length) {
          input.authoringChat?.rememberDetails("TRUSTED SCOPE KEPT OUT OF MODEL OUTPUT", [
            ...reconciliation.removed,
            "Runner removed only newly reviewed tenant/principal columns from model-generated row output.",
            "The same columns still constrain every row through trusted Runner context.",
          ]);
          exactModelDraftLines = [
            `Read plans (${mappedWorkload.allowed.length})`,
            ...mappedWorkload.allowed.map((entry) => `- ${modelReadPlanSummary(entry.plan)}`),
          ];
        }
      }
      // Provider analysis can predate catalog privacy changes, even without a new scope decision.
      if (mappedWorkload) {
        mappedAnalysis = analyzeReadWorkloadSet({
          workload: mappedWorkload,
          generatedBoundary: mappingBoundary,
        });
      }
      if (mappedAnalysis.status === "blocked" || scopeProjectionBlockers.length) {
        input.authoringChat?.rememberDetails("READ PLAN BLOCKED AFTER TRUSTED-SCOPE REVIEW", [
          ...mappedAnalysis.blockers,
          ...scopeProjectionBlockers,
          "The model-generated Read plan was not saved and Action drafting did not start.",
          "Trusted scope remains a Runner input; it is never converted into a model argument.",
        ]);
        return boundaryAssistResult({
          tone: "warning",
          title: "The Read plan needs one fresh mapping after trusted-scope review.",
          lines: [
            "Runner refused the stale model projection before Action drafting.",
            "No Read, proposal, approval, apply, or source-write authority changed.",
          ],
          footer: "Reopen Agent job to retry with the reviewed scope, choose another model, or continue with Runner's exact plan cards. Use /details for the blockers.",
        });
      }
      if (mappedWorkload && !workload) {
        workload = await storeReadWorkloadAnalysis({
          projectRoot: input.projectRoot,
          generatedBoundary: mappingBoundary,
          source: mappedWorkload.source,
          analysis: mappedAnalysis,
        });
      }
      if (workload) {
        resumeRead = {
          analysis_id: workload.analysis_id,
          analysis_digest: workload.analysis_digest,
        };
        await persistAuthoringResume(actionIntents.length ? "action_drafting" : "authority_review");
      }
      if (actionIntents.length) {
      actionInspection = await (input.actionProjectInspector ?? inspectActionProject)(
        input.projectRoot,
        process.env,
      );
      if (ruleDerivedAction) {
        semanticActionPublicationBaseline = await readActionRuleAuthorityRevisionBaseline(input.projectRoot);
        // Snapshot every retained outcome before saving a companion: rebinding
        // the first one can also advance other rules in the same authority file.
        const readRevisionBaselines = new Map<string, NonNullable<Awaited<ReturnType<typeof loadActionRuleRevisionBaseline>>>>();
        if (pendingReadRevision && reusableState) {
          for (const [outcome, expectedReadDigest] of reusableState.action_read_digest_by_outcome) {
            const baseline = await loadActionRuleRevisionBaseline({ projectRoot: input.projectRoot,
              boundaryName: context.candidate.pack.name, outcome, expectedReadDigest, preserveVerificationFields: true });
            if (!baseline) throw new Error(`ACTION_RULE_REVISION_NOT_FOUND: ${outcome} has no exact saved revision. No access edit was saved.`);
            readRevisionBaselines.set(outcome, baseline);
          }
        }
        let partialActionCheckpoint = (resumePastPlanning || resumesCompletedActionsAfterRevalidation) && !retainedReadEdit
          ? resumeAction?.checkpoint : undefined;
        const partialActionIndex = resumeAction?.completed_outcomes?.length ?? 0;
        semanticDraftLoop: for (let semanticIndex = 0; semanticIndex < actionIntents.length; semanticIndex += 1) {
        const semanticIntent = actionIntents[semanticIndex]!;
        semanticActionModelResult = undefined;
        semanticActionModelDraft = undefined;
        semanticActionRevisionBaseline = undefined;
        semanticActionRevisionCatalog = undefined;
        let resumedActivatedAt: string | undefined;
        let jointApprovalRepair = false;
        const resumedOutcome = resumePastPlanning && !retainedReadEdit
          ? resumeAction?.completed_outcomes?.[semanticIndex]
            ?? (availableResume?.stage === "authority_review" && semanticIndex === 0 ? resumeAction?.outcome : undefined)
          : undefined;
        if (resumedOutcome) {
          const resumedDraft = readRevisionBaselines.get(resumedOutcome) ?? await loadActionRuleRevisionBaseline({
            projectRoot: input.projectRoot,
            boundaryName: context.candidate.pack.name,
            outcome: resumedOutcome,
            preserveVerificationFields: true,
            ...(pendingReadRevision && reusableState?.action_read_digest_by_outcome.get(resumedOutcome)
              ? { expectedReadDigest: reusableState.action_read_digest_by_outcome.get(resumedOutcome) } : {}),
          });
          if (resumedDraft) {
            semanticActionModelDraft = resumedDraft.draft;
            semanticActionRevisionCatalog = resumedDraft.catalog;
            resumedActivatedAt = resumedDraft.activatedAt;
            try { assertJointApprovalLimitsPreserved([jobIntent.trim()], resumedDraft.draft.approval); }
            catch {
              jointApprovalRepair = true;
              semanticActionRevisionBaseline = resumedDraft.draft;
              semanticActionModelDraft = undefined;
            }
          }
        } else if (jobPlan?.state === "planned" && jobPlan.action_mode === "revise") {
          const selectedOutcome = revalidatedActionOutcomes
            ? revalidatedActionOutcomes[semanticIndex]
            : jobPlan.action_outcome ?? uniqueExistingSemanticOutcome(reusableState?.current_state.actions ?? []);
          if (!selectedOutcome && !revalidatedActionOutcomes) {
            throw new Error(
              "ACTION_RULE_REVISION_AMBIGUOUS: name the verified outcome to change, or ask the model to create a new outcome.",
            );
          }
          if (selectedOutcome) {
            const revisionBaseline = readRevisionBaselines.get(selectedOutcome) ?? await loadActionRuleRevisionBaseline({
              projectRoot: input.projectRoot,
              boundaryName: context.candidate.pack.name,
              outcome: selectedOutcome,
              ...(revalidatedActionOutcomes ? { preserveVerificationFields: true } : {}),
              ...(pendingReadRevision ? { preserveVerificationFields: true,
                expectedReadDigest: reusableState?.action_read_digest_by_outcome.get(selectedOutcome) } : {}),
            });
            if (!revisionBaseline) {
              throw new Error(
                `ACTION_RULE_REVISION_NOT_FOUND: ${selectedOutcome} has no exact reviewed revision linked to ${context.candidate.pack.name}.`,
              );
            }
            semanticActionRevisionBaseline = revisionBaseline.draft;
            if (revalidatedActionOutcomes) {
              // Compile unchanged business AST against freshly inspected structure.
              // Missing private resources/relationships fail; no old proof is copied.
              semanticActionModelDraft = revisionBaseline.draft;
              resumedActivatedAt = revisionBaseline.activatedAt;
            }
            semanticActionRevisionCatalog = revisionBaseline.catalog;
            input.authoringChat?.rememberDetails("EXISTING ACTION RULE BASELINE", [
              `Outcome: ${semanticActionRevisionBaseline.outcome}`,
              `Target: ${semanticActionRevisionBaseline.effect.operation.toUpperCase()} ${semanticActionRevisionBaseline.effect.target_resource}`,
              `WHEN: ${semanticActionRevisionBaseline.review.when}`,
              `THEN: ${semanticActionRevisionBaseline.review.then}`,
              `Approval: ${actionRuleDraftApprovalSummary(semanticActionRevisionBaseline)}`,
              "This exact revision remains unchanged while Runner prepares a disabled replacement.",
            ]);
          }
        }
        if (!semanticActionRevisionCatalog && reusingExactRead && !revalidatedActionOutcomes) {
          const savedAuthorities = [
            ...await listActionRuleAuthorityDrafts(input.projectRoot),
            await readActionRuleAuthorityActivation(input.projectRoot),
          ];
          const existing = savedAuthorities.find((authority) => authority
            && authority.authority.catalog.generation_lock_fingerprint === mappingBoundary.generation_lock_fingerprint
            && authority.authority.rules.some((entry) => entry.read_boundary_name === mappingBoundary.pack.name
              && entry.read_boundary_digest === explorationBoundaryCandidateDigest(mappingBoundary)));
          semanticActionRevisionCatalog = existing?.authority.catalog;
        }
        const retainedActionCatalogs = [
          ...(semanticActionRevisionCatalog ? [semanticActionRevisionCatalog] : []),
          ...semanticActionDrafts.map(entry => entry.catalog.catalog),
        ];
        for (let index = 0; index < retainedActionCatalogs.length; index += 1) {
          const catalog = retainedActionCatalogs[index]!;
          if (catalog.generation_lock_fingerprint === mappingBoundary.generation_lock_fingerprint) continue;
          retainedActionCatalogs[index] = rebuildActionCatalogAfterMetadataRefresh({
            catalog,
            previousLock: await loadGenerationLockSnapshot(input.projectRoot, catalog.generation_lock_fingerprint),
            nextLock: await loadGenerationLockSnapshot(input.projectRoot, mappingBoundary.generation_lock_fingerprint),
            nextBoundary: mappingBoundary,
            inspection: actionInspection,
          });
        }
        semanticActionRevisionCatalog = combineReviewedActionCatalogs(retainedActionCatalogs);
        semanticActionCatalog = buildActionRuleAuthoringCatalog({
          boundary: mappingBoundary,
          inspection: actionInspection,
          ...(semanticActionRevisionCatalog
            ? { retainedCatalog: semanticActionRevisionCatalog }
            : {}),
        });
        if (semanticActionModelDraft) {
          semanticActionModelResult = {
            state: "ready",
            compiled: compileActionRuleModelDraft({
              draft: semanticActionModelDraft,
              builtCatalog: semanticActionCatalog,
              readBoundary: mappingBoundary,
              readBoundaryDigest: explorationBoundaryCandidateDigest(mappingBoundary),
              ...(resumedActivatedAt ? { activatedAt: resumedActivatedAt } : {}),
            }),
            provider: mappingSession.provider,
            model: mappingSession.model,
            correction_used: false,
            clarification_count: 0,
            authority_granted: false,
            source_database_changed: false,
          };
          input.authoringChat?.rememberDetails("SAVED ACTION DRAFT RESUMED", [
            `Outcome: ${semanticActionModelDraft.outcome}`,
            `Target: ${semanticActionModelDraft.effect.operation.toUpperCase()} ${semanticActionModelDraft.effect.target_resource}`,
            "No model regeneration, authority change, or source write occurred.",
          ]);
        }
        let ruleSession = boundaryAuthoringModelSession(mappingSession, input.authoringChat);
        let actionRuleOperatorRetryUsed = false;
        let semanticScopeIssue: {
          kind: "paused" | "blocked";
          resources: string[];
          blockers?: string[];
        } | undefined;
        while (!semanticActionModelResult) {
          let failure: BoundaryModelDraftFailure | undefined;
          try {
            const revisionFocus = modelActionRuleRevisionFocus(
              semanticIntent,
              semanticActionRevisionBaseline,
            );
            semanticActionModelResult = await runWithProgress(
              revisionFocus === "approval"
                ? "Updating only the reviewed approval policy with the selected model"
                : `Preparing action ${semanticIndex + 1} of ${actionIntents.length}`,
              () => (input.modelActionRuleGenerator ?? generateModelActionRuleDraft)({
                session: ruleSession,
                intent: jointApprovalRepair ? "Revise only approval.shared_limits to preserve the original job's joint automatic-approval allowances across its actions. Keep every other component and policy setting unchanged." : semanticIntent,
                operatorJob: jobIntent.trim(),
                ...(jointApprovalRepair ? { approvalLimitsOnly: true } : {}),
                deferCompletionMessage: Boolean(activePolicySource(authoringConversation?.policySources)),
                reservedOutcomes: semanticActionDrafts.map((entry) => entry.result.compiled.rule.outcome),
                preparedDrafts: semanticActionDrafts.map((entry) => entry.result.compiled.draft),
                pendingIntents: actionIntents.slice(semanticIndex),
                builtCatalog: semanticActionCatalog!,
                ...(partialActionCheckpoint && semanticIndex === partialActionIndex
                  ? { checkpoint: partialActionCheckpoint, revalidateSavedComponents: true } : {}),
                onCheckpoint: async (checkpoint) => {
                  assertRunning();
                  resumeAction = { ...resumeAction, intent: actionIntents[0]!, intents: actionIntents, strategy: "rule_derived", checkpoint };
                  await persistAuthoringResume("action_drafting");
                  if (resumePersistenceBlocked) throw checkpointSaveFailure("The checkpoint");
                },
                readBoundary: mappingBoundary,
                readBoundaryDigest: explorationBoundaryCandidateDigest(mappingBoundary),
                ...(semanticActionRevisionBaseline
                  ? { existingDraft: semanticActionRevisionBaseline }
                  : {}),
                egressAcknowledged: true,
                env: process.env,
                reviewPrivateSource: async request => {
                  const prepared = await reviewPrivateActionSourceForModel({ request, inspection: actionInspection!,
                    session: input.session, modelLabel: boundaryModelLabel(ruleSession),
                    assertCurrent: async () => {
                      const fresh = await loadBoundaryReviewContext(input.projectRoot);
                      const lock = await loadGenerationLockSnapshot(input.projectRoot, request.context.readBoundary.generation_lock_fingerprint);
                      if (explorationBoundaryCandidateDigest(fresh.candidate) !== request.context.readBoundaryDigest
                        || lock.schema_fingerprint !== schemaFingerprintForInspection(actionInspection!)) {
                        throw new Error("ACTION_RULE_REVISION_STALE: The Read draft changed during private source review. Recheck the saved draft; no authority changed.");
                      }
                    },
                  });
                  if (prepared) semanticActionCatalog = prepared.builtCatalog;
                  return prepared;
                },
                prepareResources: async ({ resourceIds, principalScopeResourceIds, context: preparedContext }) => {
                  semanticActionCatalog = preparedContext.builtCatalog;
                  const retainedResources = new Set(
                    semanticActionRevisionCatalog?.resources.map((resource) => resource.name) ?? [],
                  );
                  const resourcesNeedingScopeReview = (principalScopeResourceIds ?? resourceIds).filter((resourceId) =>
                    !retainedResources.has(resourceId));
                  if (!resourcesNeedingScopeReview.length) {
                    return {
                      builtCatalog: semanticActionCatalog!,
                      readBoundary: mappingBoundary,
                      readBoundaryDigest: explorationBoundaryCandidateDigest(mappingBoundary),
                    };
                  }
                  const reviewed = await reviewJobPrincipalScopeForResources({
                    projectRoot: input.projectRoot,
                    schemaInspector: input.schemaInspector,
                    session: input.session,
                    jobIntent: jobIntent.trim(),
                    resourceIds: resourcesNeedingScopeReview,
                    modelSession: ruleSession,
                    ...(input.modelAuthoringNarrator
                      ? { modelNarrator: input.modelAuthoringNarrator }
                      : {}),
                    ...(input.modelPrincipalScopeInterpreter
                      ? { modelInterpreter: input.modelPrincipalScopeInterpreter }
                      : {}),
                    ...(input.authoringChat ? { authoringChat: input.authoringChat } : {}),
                  });
                  if (reviewed.state === "paused") {
                    semanticScopeIssue = {
                      kind: "paused",
                      resources: reviewed.resources,
                    };
                    throw new Error("ACTION_RULE_SCOPE_REVIEW_PAUSED");
                  }
                  if (reviewed.changed) {
                    context = await loadBoundaryReviewContext(input.projectRoot);
                    mappingBoundary = context.candidate;
                    if (!mappedWorkload) {
                      semanticScopeIssue = {
                        kind: "blocked",
                        resources: resourceIds,
                        blockers: [
                          "The reused Read revision does not include this newly reviewed user/owner scope change.",
                          "Revise the Read Boundary first, then retry this Action edit against its exact replacement revision.",
                        ],
                      };
                      throw new Error("ACTION_RULE_SCOPE_RECONCILIATION_BLOCKED");
                    }
                    const reconciliation = reconcileModelWorkloadScopeProjection(mappedWorkload, mappingBoundary);
                    mappedWorkload = reconciliation.workload;
                    mappedAnalysis = analyzeReadWorkloadSet({
                      workload: mappedWorkload,
                      generatedBoundary: mappingBoundary,
                    });
                    if (mappedAnalysis.status === "blocked") {
                      semanticScopeIssue = {
                        kind: "blocked",
                        resources: resourceIds,
                        blockers: mappedAnalysis.blockers,
                      };
                      throw new Error("ACTION_RULE_SCOPE_RECONCILIATION_BLOCKED");
                    }
                  }
                  semanticActionCatalog = buildActionRuleAuthoringCatalog({
                    boundary: mappingBoundary,
                    inspection: actionInspection!,
                    retainedCatalog: (await buildActionCatalogForSavedReadRevision({ projectRoot: input.projectRoot,
                      catalog: preparedContext.builtCatalog.catalog, nextBoundary: mappingBoundary, inspection: actionInspection! })).catalog,
                  });
                  return {
                    builtCatalog: semanticActionCatalog,
                    readBoundary: mappingBoundary,
                    readBoundaryDigest: explorationBoundaryCandidateDigest(mappingBoundary),
                  };
                },
                onRelationshipReview: (lines) => input.authoringChat?.rememberDetails("ACTION RELATIONSHIP REVIEW", lines),
                askClarification: async (question) => {
                  // This is the authoring model's own turn. Follow-up questions
                  // return to the same tool-enabled conversation, not a narrator.
                  let answer: string | undefined;
                  input.authoringChat?.rememberDetails("CURRENT ACTION QUESTION", [question,
                    "This question has not changed a saved draft. The model can prepare supported metadata relationships itself; source rows are not available here."]);
                  if (input.authoringChat?.readOperator) {
                    await input.authoringChat.streamModel(question.split(/\r?\n/u));
                    answer = await input.authoringChat.readOperator();
                  } else {
                    answer = await input.session.promptText(question, { context: ["MODEL QUESTION"] });
                  }
                  return answer;
                },
              }),
            );
          } catch (error) {
            assertRunning(error);
            if (error instanceof ActionAuthoringReadOnlyRequest) {
              retainedReadEdit ??= { action: structuredClone({ ...resumeAction, intent: actionIntents[0]!, intents: actionIntents }),
                addition: structuredClone(pendingActionAddition) };
              deferUnfinishedActions = true;
              actionIntents = semanticActionDrafts.map((entry) => entry.intent);
              partialActionCheckpoint = undefined;
              resumeAction = retainedReadEdit.action;
              semanticActionModelResult = semanticActionDrafts.at(-1)?.result;
              semanticActionModelDraft = semanticActionModelResult?.compiled.draft;
              ruleDerivedAction = semanticActionDrafts.length > 0;
              input.authoringChat?.checkpoint("Continuing to Read review", [
                "The unfinished Action request and its unanswered decisions remain saved for later. Existing saved drafts and active authority are unchanged.",
                ...(semanticActionDrafts.length ? [`${semanticActionDrafts.length} previously prepared Action draft(s) remain saved for separate review.`] : []),
              ]);
              await persistAuthoringResume("read_mapping");
              break semanticDraftLoop;
            }
            if (semanticScopeIssue) {
              const issue = semanticScopeIssue;
              return boundaryAssistResult({
                tone: "warning",
                title: issue.kind === "paused"
                  ? "User/owner scope review paused this job."
                  : "The Read plan needs one fresh mapping after trusted-scope review.",
                lines: issue.kind === "paused"
                  ? [
                      `Still unresolved: ${issue.resources.join(", ")}`,
                      "The semantic Action draft was discarded; no authority or source data changed.",
                    ]
                  : [
                      "Runner refused the stale model projection before saving Action authority.",
                      ...(issue.blockers ?? []),
                      "No Read, proposal, approval, apply, or source-write authority changed.",
                    ],
                footer: issue.kind === "paused"
                  ? "Review the exact user/owner predicate, then reopen Agent job. No tenant or principal value is required for authoring."
                  : "Reopen Agent job to retry with the reviewed scope. Use /details for the exact blockers.",
              });
            }
            failure = recoverableActionRuleModelDraftFailure(error);
            if (!failure) throw error;
          }
          if (!failure) break;
          const recovery = await promptRunnerGuidedModelFallback({
            session: input.session,
            provider: mappingSession.provider,
            model: mappingSession.model,
            stage: "Action Boundary",
            allowModelRetry: !actionRuleOperatorRetryUsed,
            allowRunnerFallback: false,
            failure,
          });
          if (recovery === "back") {
            return boundaryAssistResult(boundaryAssistBackNotice(
              "Verified Action drafting paused. The refused model output was discarded; the Read draft and active authority are unchanged.",
            ));
          }
          actionRuleOperatorRetryUsed = true;
          if (recovery === "change_model") {
            const replacement = await promptBoundaryMappingModel(
              input.session,
              mappingSession,
              input.modelDiscovery,
            );
            if (!replacement) {
              return boundaryAssistResult(boundaryAssistBackNotice(
                "Model replacement was cancelled. The refused verified Action draft remains discarded and no authority changed.",
              ));
            }
            const replacementSession = {
              ...replacement,
              ...(authoringConversation ? { conversation: authoringConversation } : {}),
            };
            input.authoringChat?.setModel(boundaryModelLabel(replacementSession));
            input.authoringChat?.setPermissionGuide?.(undefined);
            const replacementAcknowledged = await confirmModelEgress(replacementSession);
            if (!replacementAcknowledged) {
              return boundaryAssistResult(boundaryAssistBackNotice(
                "Replacement-model egress was not approved. The refused verified Action draft remains discarded and no authority changed.",
              ));
            }
            mappingSession = replacementSession;
            selectedResumeModel = replacementSession;
            modelAssistSession = boundaryAuthoringModelSession(mappingSession, input.authoringChat);
            modelInterviewSession = modelAssistSession;
            modelAssistRecord = {
              provider: mappingSession.provider,
              model: mappingSession.model,
              structural_metadata_egress_acknowledged: true,
            };
            installPermissionGuide(mappingSession);
            ruleSession = modelAssistSession;
            await persistAuthoringResume("action_drafting");
          }
        }
        if (!semanticActionModelResult) {
          throw new Error("ACTION_RULE_MODEL_DRAFT_INCOMPLETE: no validated semantic Action draft is available.");
        }
        if (semanticIndex === partialActionIndex) partialActionCheckpoint = undefined;
        const reopened = semanticActionModelResult.revision?.reopened_draft;
        const reopenedIndex = reopened
          ? semanticActionDrafts.findIndex((entry) => entry.result.compiled.rule.outcome === reopened.outcome)
          : -1;
        if (reopened) {
          const previous = semanticActionDrafts[reopenedIndex];
          if (!previous || canonicalJsonDigest(previous.result.compiled.draft) !== reopened.digest
            || semanticActionModelResult.compiled.rule.outcome !== reopened.outcome
            || !reopened.covered_intent_indexes.includes(0)
            || new Set(reopened.covered_intent_indexes).size !== reopened.covered_intent_indexes.length
            || reopened.covered_intent_indexes.some((index) => !Number.isInteger(index) || index < 0 || semanticIndex + index >= actionIntents.length)) {
            throw new Error("ACTION_RULE_REVISION_STALE: the selected prepared draft or job agenda changed. The saved revision is unchanged.");
          }
          semanticActionRevisionBaseline = previous.result.compiled.draft;
          semanticActionRevisionCatalog = previous.catalog.catalog;
        } else if (semanticActionDrafts.some((entry) => entry.result.compiled.rule.outcome === semanticActionModelResult!.compiled.rule.outcome)) {
          throw new Error("ACTION_OUTCOME_COLLISION: creation cannot replace an earlier outcome; reopen its exact disabled draft for revision.");
        }
        semanticActionModelDraft = semanticActionModelResult.compiled.draft;
        // Private verification records can inherit the subject's scope through
        // compiler-checked links. Own-row promises still cover every subject
        // and mutation target, never every referenced lookup table.
        const semanticResourceIds = [...new Set([
          ...semanticActionModelDraft.verification.resources.filter((resource) => resource.source.kind === "subject_ref").map((resource) => resource.resource),
          semanticActionModelDraft.effect.target_resource,
          ...(semanticActionModelDraft.effect.atomic_updates ?? []).map((effect) => effect.target_resource),
        ])].sort();
        const retainedRevisionResources = new Set(
          semanticActionRevisionCatalog?.resources.map((resource) => resource.name) ?? [],
        );
        const semanticResourcesNeedingScopeReview = semanticResourceIds.filter((resourceId) =>
          !retainedRevisionResources.has(resourceId));
        const actionPrincipalScope = semanticResourcesNeedingScopeReview.length
          ? await reviewJobPrincipalScopeForResources({
              projectRoot: input.projectRoot,
              schemaInspector: input.schemaInspector,
              session: input.session,
              jobIntent: jobIntent.trim(),
              resourceIds: semanticResourcesNeedingScopeReview,
              modelSession: ruleSession,
              ...(input.modelAuthoringNarrator
                ? { modelNarrator: input.modelAuthoringNarrator }
                : {}),
              ...(input.modelPrincipalScopeInterpreter
                ? { modelInterpreter: input.modelPrincipalScopeInterpreter }
                : {}),
              ...(input.authoringChat ? { authoringChat: input.authoringChat } : {}),
            })
          : { state: "ready" as const, changed: false };
        if (actionPrincipalScope.state === "paused") {
          return boundaryAssistResult({
            tone: "warning",
            title: "User/owner scope review paused this job.",
            lines: [
              `Still unresolved: ${actionPrincipalScope.resources.join(", ")}`,
              "The semantic Action draft was discarded; no authority or source data changed.",
            ],
            footer: "Review the exact user/owner predicate, then reopen Agent job. No tenant or principal value is required for authoring.",
          });
        }
        if (actionPrincipalScope.changed) {
          context = await loadBoundaryReviewContext(input.projectRoot);
          mappingBoundary = context.candidate;
          if (!mappedWorkload) {
            return boundaryAssistResult({
              tone: "warning",
              title: "This Action edit also needs a Read Boundary revision.",
              lines: [
                "Runner found a newly reviewed user/owner scope decision that is not present in the reused Read revision.",
                "The Action replacement was discarded; existing Read and Action authority remain unchanged.",
              ],
              footer: "Ask the model to revise both Boundaries in one job. No tenant or principal value is required for authoring.",
            });
          }
          const reconciliation = reconcileModelWorkloadScopeProjection(mappedWorkload, mappingBoundary);
          mappedWorkload = reconciliation.workload;
          mappedAnalysis = analyzeReadWorkloadSet({
            workload: mappedWorkload,
            generatedBoundary: mappingBoundary,
          });
          semanticActionCatalog = buildActionRuleAuthoringCatalog({
            boundary: mappingBoundary,
            inspection: actionInspection,
            retainedCatalog: (await buildActionCatalogForSavedReadRevision({ projectRoot: input.projectRoot,
              catalog: semanticActionModelResult.compiled.loaded.authority.catalog,
              nextBoundary: mappingBoundary, inspection: actionInspection })).catalog,
          });
          semanticActionModelResult = {
            ...semanticActionModelResult,
            compiled: compileActionRuleModelDraft({
              draft: semanticActionModelDraft,
              builtCatalog: semanticActionCatalog,
              readBoundary: mappingBoundary,
              readBoundaryDigest: explorationBoundaryCandidateDigest(mappingBoundary),
            }),
          };
        }
        const supportEntries = mappedWorkload ? semanticActionReadSupportEntries({
          compiled: semanticActionModelResult.compiled,
          catalog: semanticActionCatalog,
          existing: mappedWorkload.allowed,
        }) : [];
        if (mappedWorkload && supportEntries.length) {
          actionSupportPlanCount = supportEntries.length;
          mappedWorkload = normalizeReadWorkloadSet({
            ...mappedWorkload,
            allowed: [...mappedWorkload.allowed, ...supportEntries],
          });
          mappedAnalysis = analyzeReadWorkloadSet({
            workload: mappedWorkload,
            generatedBoundary: mappingBoundary,
          });
        }
        exactModelDraftLines.push(
          `Verified Action outcome (${semanticIndex + 1}/${actionIntents.length})`,
          ...semanticActionReviewLines(semanticActionModelResult.compiled).map((line) => `- ${line}`),
        );
        const preparedEntry = {
          intent: semanticIntent, result: semanticActionModelResult, catalog: semanticActionCatalog,
          ...(semanticActionRevisionBaseline ? { baseline: semanticActionRevisionBaseline } : {}),
        };
        if (resumedOutcome) {
          // Loading an earlier completed item must not erase the interrupted
          // next item's checkpoint before its provider has made any progress.
          semanticActionDrafts.push(preparedEntry);
          continue;
        }
        // Persist completed outcomes before starting another one. They remain
        // disabled and will all be rebound to the final reviewed Read revision.
        const saved = await actionRuleAuthorityDraftFromCompiled(input.projectRoot, semanticActionModelResult.compiled, undefined, {
          nextBoundary: mappingBoundary,
          inspection: actionInspection!,
          revalidateMetadata: true,
        });
        await saveSemanticActionDraft(saved);
        if (reopened) {
          const priorIntent = semanticActionDrafts[reopenedIndex]!.intent;
          semanticActionDrafts[reopenedIndex] = { ...preparedEntry, intent: priorIntent };
          const covered = new Set(reopened.covered_intent_indexes.map((index) => semanticIndex + index));
          const coveredIntents = actionIntents.filter((_intent, index) => covered.has(index));
          actionIntents = actionIntents.filter((_intent, index) => !covered.has(index));
          semanticIndex -= 1;
          const diff = semanticActionRevisionDiffLines(semanticActionRevisionBaseline!, semanticActionModelResult.compiled,
            semanticActionModelResult.revision?.changed_phases ?? []);
          input.authoringChat?.rememberDetails("SAME ACTION REVISED", [
            ...diff, "Covered by this same action:", ...coveredIntents,
            "Read dependency revalidation and separate Action/execution reviews follow. No authority or source data changed.",
          ]);
        } else {
          semanticActionDrafts.push(preparedEntry);
        }
        resumeAction = retainedReadEdit ? retainedReadEdit.action : {
          intent: actionIntents[0]!, intents: actionIntents, strategy: "rule_derived",
          completed_outcomes: semanticActionDrafts.map((entry) => entry.result.compiled.rule.outcome),
          ...(partialActionCheckpoint ? { checkpoint: partialActionCheckpoint } : {}),
        };
        await persistAuthoringResume("action_drafting");
        if (reopened) await input.authoringChat?.streamCheckpoint("One Action draft; policy clarification incorporated", [
          ...semanticActionRevisionDiffLines(semanticActionRevisionBaseline!, semanticActionModelResult.compiled,
            semanticActionModelResult.revision?.changed_phases ?? []),
          "The duplicate planning entries are resolved by this same action. Review activation next; execution remains separate.",
        ], "normal");
        }
      } else {
      if (!mappedWorkload) {
        throw new Error("ACTION_MODEL_REUSED_READ_UNSUPPORTED: caller-supplied Action drafting requires a newly mapped Read workload.");
      }
      let actionCatalog = guidedActionOptionsFromCandidate({
        candidate: mappingBoundary,
        inspection: actionInspection,
      });
      let actionMappingFellBack = false;
      let actionOperatorRetryUsed = false;
      while (!actionMappingFellBack) {
        preMappedActions.length = 0;
        let failure: BoundaryModelDraftFailure | undefined;
        try {
          if (input.jobFirst
            && (input.modelActionSuggestionSetGenerator || !input.modelActionSuggestionGenerator)) {
            const set = await runWithProgress(
              "Drafting Action Boundary suggestions with the selected model",
              () => (input.modelActionSuggestionSetGenerator ?? generateModelActionSuggestionSet)({
                jobIntent: jobIntent.trim(),
                provider: mappingSession.provider,
                model: mappingSession.model,
                options: actionCatalog,
                env: process.env,
                ...(mappingSession.apiKey ? { apiKey: mappingSession.apiKey } : {}),
                ...(mappingSession.apiKeyEnv ? { apiKeyEnv: mappingSession.apiKeyEnv } : {}),
                ...(mappingSession.baseUrl ? { baseUrl: mappingSession.baseUrl } : {}),
                ...boundaryAuthoringProviderOptions(mappingSession.dependencies, input.authoringChat),
                ...(mappingSession.conversation ? { conversation: mappingSession.conversation } : {}),
                deferNarration: Boolean(input.authoringChat),
                egressAcknowledged: true,
              }),
            );
            if (set.model_message) modelDraftMessages.push(set.model_message);
            actionIntents = set.assessments.map((assessment) => assessment.suggestion.intent);
            for (const assessment of set.assessments) {
              preMappedActions.push({
                intent: assessment.suggestion.intent,
                result: {
                  assessment,
                  provider: set.provider,
                  model: set.model,
                  authority_granted: false,
                  source_database_changed: false,
                },
              });
            }
          } else {
            for (const actionIntent of actionIntents) {
              const result = await runWithProgress(
                "Drafting one Action Boundary suggestion with the selected model",
                () => (input.modelActionSuggestionGenerator ?? generateModelActionSuggestion)({
                  intent: actionIntent,
                  provider: mappingSession.provider,
                  model: mappingSession.model,
                  options: actionCatalog,
                  env: process.env,
                  ...(mappingSession.apiKey ? { apiKey: mappingSession.apiKey } : {}),
                  ...(mappingSession.apiKeyEnv ? { apiKeyEnv: mappingSession.apiKeyEnv } : {}),
                  ...(mappingSession.baseUrl ? { baseUrl: mappingSession.baseUrl } : {}),
                  ...boundaryAuthoringProviderOptions(mappingSession.dependencies, input.authoringChat),
                  ...(mappingSession.conversation ? { conversation: mappingSession.conversation } : {}),
                  deferNarration: Boolean(input.authoringChat),
                  egressAcknowledged: true,
                }),
              );
              if (result.model_message) modelDraftMessages.push(result.model_message);
              preMappedActions.push({ intent: actionIntent, result });
            }
          }
        } catch (error) {
          assertRunning(error);
          failure = recoverableActionModelDraftFailure(error);
          if (!failure) throw error;
        }
        if (!failure) break;

        const recovery = await promptRunnerGuidedModelFallback({
          session: input.session,
          provider: mappingSession.provider,
          model: mappingSession.model,
          stage: "Action Boundary",
          allowModelRetry: !actionOperatorRetryUsed,
          failure,
        });
        if (recovery === "back") {
          return boundaryAssistResult(boundaryAssistBackNotice(
            "The Read draft was not saved because Action drafting was paused. The refused action draft was discarded and no authority changed.",
          ));
        }
        if (recovery === "runner") {
          actionMappingFellBack = true;
          modelAssistSession = undefined;
          modelInterviewSession = undefined;
          preMappedActions.length = 0;
          input.authoringChat?.setPermissionGuide?.(undefined);
          break;
        }

        actionOperatorRetryUsed = true;
        if (recovery === "change_model") {
          const replacement = await promptBoundaryMappingModel(
            input.session,
            mappingSession,
            input.modelDiscovery,
          );
          if (!replacement) {
            return boundaryAssistResult(boundaryAssistBackNotice(
              "Model replacement was cancelled. The refused action draft remains discarded and no authority changed.",
            ));
          }
          mappingSession = {
            ...replacement,
            ...(authoringConversation ? { conversation: authoringConversation } : {}),
          };
          input.authoringChat?.setModel(boundaryModelLabel(mappingSession));
          selectedResumeModel = mappingSession;
          input.authoringChat?.setPermissionGuide?.(undefined);
          const replacementAcknowledged = await confirmModelEgress(mappingSession);
          if (!replacementAcknowledged) {
            return boundaryAssistResult(boundaryAssistBackNotice(
              "Replacement-model egress was not approved. The refused action draft remains discarded and no authority changed.",
            ));
          }
          installPermissionGuide(mappingSession);
          modelAssistSession = boundaryAuthoringModelSession(mappingSession, input.authoringChat);
          modelInterviewSession = modelAssistSession;
          await persistAuthoringResume("action_drafting");
        }
      }
      const actionPrincipalScope = await reviewJobPrincipalScopeForResources({
        projectRoot: input.projectRoot,
        schemaInspector: input.schemaInspector,
        session: input.session,
        jobIntent: jobIntent.trim(),
        resourceIds: preMappedActions.flatMap(({ result }) => {
          const resource = result.assessment.suggestion.resource;
          return typeof resource === "string" && resource ? [resource] : [];
        }),
        ...(modelInterviewSession ? { modelSession: modelInterviewSession } : {}),
        ...(input.modelAuthoringNarrator
          ? { modelNarrator: input.modelAuthoringNarrator }
          : {}),
        ...(input.modelPrincipalScopeInterpreter
          ? { modelInterpreter: input.modelPrincipalScopeInterpreter }
          : {}),
        ...(input.authoringChat ? { authoringChat: input.authoringChat } : {}),
      });
      if (actionPrincipalScope.state === "paused") {
        await persistAuthoringResume("action_drafting");
        return boundaryAssistResult({
          tone: "warning",
          title: "User/owner scope review paused this job.",
          lines: [
            `Still unresolved: ${actionPrincipalScope.resources.join(", ")}`,
            "The requested Action would otherwise be tenant-only, which does not satisfy this own-row job.",
            "The refused Action draft was not saved or activated and source data is unchanged.",
          ],
          footer: "Review the exact user/owner predicate, then reopen Agent job to resume this saved conversation and disabled catalog.",
        });
      }
      if (actionPrincipalScope.changed) {
        context = await loadBoundaryReviewContext(input.projectRoot);
        mappingBoundary = context.candidate;
        const reconciliation = reconcileModelWorkloadScopeProjection(mappedWorkload, mappingBoundary);
        mappedWorkload = reconciliation.workload;
        mappedAnalysis = analyzeReadWorkloadSet({
          workload: mappedWorkload,
          generatedBoundary: mappingBoundary,
        });
        actionCatalog = guidedActionOptionsFromCandidate({
          candidate: mappingBoundary,
          inspection: actionInspection,
        });
      }
      if (preMappedActions.length) {
        const actionSummaries = preMappedActions.map(({ result }) => {
          const suggestion = result.assessment.suggestion;
          const fields = suggestion.fields?.length
            ? `; reviewed proposal fields ${suggestion.fields.join(", ")}`
            : "";
          const resource = actionCatalog.resources.find((candidate) => candidate.id === suggestion.resource);
          const scope = resource?.principal_key
            ? `; trusted scope ${resource.tenant_key} + ${resource.principal_key}`
            : resource?.principal_rls_setting
              ? `; trusted scope ${resource.tenant_key} + PostgreSQL RLS setting ${resource.principal_rls_setting}`
            : resource?.tenant_key
              ? `; trusted scope ${resource.tenant_key} only; no principal row limit configured`
              : resource?.organization_scope
                ? "; reviewed whole-organization scope; no principal row limit configured"
                : "";
          return `${(suggestion.operation ?? "propose").toUpperCase()} ${suggestion.resource ?? "reviewed target"}${fields}${scope}`;
        });
        exactModelDraftLines.push(
          `Action suggestions (${preMappedActions.length})`,
          ...actionSummaries.map((summary) => `- ${summary}`),
        );
      }
      const supportEntries: ReadWorkloadSet["allowed"] = [];
      if (actionMappingFellBack) {
        supportEntries.push(...noModelActionSupportEntries({
          actionIntents,
          options: actionCatalog,
          existingIds: mappedWorkload.allowed.map((entry) => entry.id),
        }));
      } else for (const [index, preMapped] of preMappedActions.entries()) {
        if (preMapped.result.assessment.status !== "suggested") continue;
        const result = preMapped.result;
        const suggestion = result.assessment.suggestion;
        const selectedFields = suggestion.operation === "delete"
          ? []
          : [...new Set(suggestion.fields ?? [])];
        supportEntries.push({
          id: uniqueWorkloadEntryId(
            `action_review_${index + 1}`,
            [...mappedWorkload.allowed, ...supportEntries].map((entry) => entry.id),
          ),
          description: `Review the exact fields required to ${suggestion.operation} ${suggestion.resource}.`,
          plan: selectedFields.length
            ? {
                kind: "rows",
                resource: suggestion.resource,
                select: selectedFields,
                limit: 1,
              }
            : {
                kind: "aggregate",
                resource: suggestion.resource,
                measures: [{ function: "count" }],
                top_n: 1,
              },
        });
      }
      if (supportEntries.length) {
        actionSupportPlanCount = supportEntries.length;
        mappedWorkload = normalizeReadWorkloadSet({
          ...mappedWorkload,
          allowed: [...mappedWorkload.allowed, ...supportEntries],
        });
        mappedAnalysis = analyzeReadWorkloadSet({
          workload: mappedWorkload,
          generatedBoundary: mappingBoundary,
        });
      }
      }
      }
      if (input.authoringChat) {
        const verificationDetails = [
          mappedAnalysis.status === "ready"
            ? `${representativeReadPlanCount} Read plan${representativeReadPlanCount === 1 ? "" : "s"} use reviewed identifiers and compiler-valid grammar`
            : "Read draft blocked; no candidate was accepted",
          ...(actionSupportPlanCount
            ? [`${actionSupportPlanCount} reviewed support plan${actionSupportPlanCount === 1 ? "" : "s"} added for exact Action review`]
            : []),
          ...(preMappedActions.length
            ? [`${preMappedActions.length} Action target${preMappedActions.length === 1 ? "" : "s"} and operation${preMappedActions.length === 1 ? "" : "s"} exist in the inspected catalog`]
            : []),
          actionIntents.length
            ? "Read and Action authority remain off"
            : "Read authority remains off",
        ];
        if (actionIntents.length && modelInterviewSession) {
          modelInterviewSession.openingValidatedFacts = [
            "Runner completed and validated the combined Read and Action draft for this job.",
            ...exactModelDraftLines,
            ...verificationDetails,
            "Summarize these validated facts as one coherent update before asking the next unresolved Action question.",
          ];
          modelInterviewSession.openingOperatorMessage = jobIntent.trim();
          modelInterviewSession.openingValidatedFactsConsumed = false;
        } else if (modelAssistSession) {
          const summarySession = modelAssistSession;
          const narrator = input.modelAuthoringNarrator ?? narrateValidatedAuthoringStep;
          const summary = await runWithProgress(
            `${boundaryModelLabel(summarySession)} is summarizing the validated Read draft`,
            () => narrator({
              session: summarySession,
              operatorMessage: jobIntent.trim(),
              validatedFacts: [
                "Runner completed and validated the Read draft for this job.",
                ...exactModelDraftLines,
                ...verificationDetails,
                "Summarize this as one concise update. Do not ask for another mapping decision.",
              ],
              nextQuestion: "Would you like to review this exact Read Boundary for activation?",
              egressAcknowledged: true,
            }),
          );
          if (summary) await input.authoringChat.streamModel(summary.split(/\r?\n/u));
          else await input.authoringChat.streamCheckpoint("Read draft validated; model summary unavailable", [
            `${representativeReadPlanCount} exact Read plan${representativeReadPlanCount === 1 ? "" : "s"} remain disabled`,
            "No authority or source data changed",
          ], "warning");
        } else if (modelDraftMessages.length) {
          await input.authoringChat.streamModel(modelDraftMessages.flatMap((message, index) => [
            ...(index > 0 ? [""] : []),
            ...message.split(/\r?\n/u),
          ]));
        } else {
          await input.authoringChat.streamCheckpoint("Draft validated; model summary unavailable", [
            `${representativeReadPlanCount} exact Read plan${representativeReadPlanCount === 1 ? "" : "s"} ${representativeReadPlanCount === 1 ? "remains" : "remain"} in the disabled draft`,
            ...(preMappedActions.length
              ? [`${preMappedActions.length} exact Action suggestion${preMappedActions.length === 1 ? " remains" : "s remain"} disabled`]
              : []),
            "No authority or source data changed",
          ], "warning");
        }
        input.authoringChat.rememberDetails("Validated model draft", [
          ...exactModelDraftLines,
          "",
          "Runner validation",
          ...verificationDetails,
        ]);
      }
      if (mappedWorkload) {
        preparedWorkload = mappedWorkload;
        workload = await storeReadWorkloadAnalysis({
          projectRoot: input.projectRoot,
          generatedBoundary: mappingBoundary,
          source: mappedWorkload.source,
          analysis: mappedAnalysis,
        });
        // Adding private Action-support atoms can produce a new minimized Read
        // candidate. That new exact analysis must go through the ordinary
        // commit path rather than borrowing the prior pending review record.
        if (resumingDisabledRead && !workload.review) resumingDisabledRead = false;
        resumeRead = {
          analysis_id: workload.analysis_id,
          analysis_digest: workload.analysis_digest,
        };
        await persistAuthoringResume(actionIntents.length ? "action_drafting" : "authority_review");
      }
    }
    }
  } else {
    const workloads = await listReadWorkloadAnalyses({
      projectRoot: input.projectRoot,
      generatedBoundary: mappingBoundary,
    });
    if (!workloads.length) {
      return boundaryAssistResult({
        tone: "warning",
        title: "No saved workload analyses are available.",
        lines: ["Press W and choose exact plans or optional model mapping first."],
      });
    }
    const selectedId = await input.session.promptText([
      "SAVED WORKLOAD ANALYSES",
      ...workloads.slice(0, 12).map((entry) =>
        `${entry.analysis_id}  [${entry.state}]  ${entry.analysis.workload_name}`),
      "Analysis ID",
    ].join("\n"));
    if (selectedId === undefined) return boundaryAssistResult(boundaryAssistBackNotice());
    workload = await readReadWorkloadAnalysis({
      projectRoot: input.projectRoot,
      analysisId: selectedId.trim(),
      generatedBoundary: mappingBoundary,
    });
  }
  if (!workload) {
    throw new Error("Boundary workload preparation ended without a reviewed workload.");
  }
  if (!reusingExactRead && !resumingDisabledRead && workload.state !== "ready") {
    return boundaryAssistResult({
      tone: "danger",
      title: `Workload ${workload.analysis.workload_name} is ${workload.state}.`,
      lines: workload.analysis.blockers.length
        ? workload.analysis.blockers.slice(0, 5)
        : [workload.stale_reason ?? "Re-run this workload against the current generated boundary."],
      footer: "Nothing was saved or activated.",
    });
  }
  const coverage = workload.analysis.coverage;
  const requestedReadCoverage = representativeReadCoverage(workload.analysis);
  const exposure = workload.analysis.exposure;
  let committed: {
    candidate_digest: `sha256:${string}`;
    review_revision: number;
    review: ReadWorkloadReview;
    authority_activated: false;
    source_database_changed: false;
  };
  if (reusingExactRead) {
    const currentDigest = explorationBoundaryCandidateDigest(mappingBoundary);
    if (!workload.review
      || workload.analysis.candidate_digest === undefined
      || workload.review.analyzed_candidate_digest !== workload.analysis.candidate_digest
      || workload.review.candidate_digest !== currentDigest) {
      return boundaryAssistResult({
        tone: "warning",
        title: "The saved Read revision changed before Action drafting.",
        lines: [
          "Runner will not reuse a stale or different Read Boundary revision.",
          "No Action draft, authority, or source data changed.",
        ],
        footer: "Reopen Agent job and review the current Read revision.",
      });
    }
    committed = {
      candidate_digest: currentDigest,
      review_revision: workload.review.review_revision,
      review: workload.review,
      authority_activated: false,
      source_database_changed: false,
    };
    await input.authoringChat?.streamCheckpoint("Existing Read Boundary retained", [
      `${mappingBoundary.pack.name} · ${reusableState?.active_read_digests.has(currentDigest) ? "active" : "reviewed disabled"}`,
      "No Read remapping, candidate mutation, or source query",
    ]);
  } else if (resumingDisabledRead) {
    context = await loadBoundaryReviewContext(input.projectRoot);
    const currentDigest = explorationBoundaryCandidateDigest(context.candidate);
    if (!workload.review
      || workload.analysis.candidate_digest === undefined
      || workload.review.analyzed_candidate_digest !== workload.analysis.candidate_digest
      || workload.review.candidate_digest !== currentDigest) {
      return boundaryAssistResult({
        tone: "warning",
        title: "The resumable Read mapping changed before Action drafting.",
        lines: [
          "Runner will not continue a stale or different disabled Read candidate.",
          "No Action draft, authority, or source data changed.",
        ],
        footer: "Reopen Agent job and map the current Read candidate again.",
      });
    }
    mappingBoundary = context.candidate;
    committed = {
      candidate_digest: currentDigest,
      review_revision: workload.review.review_revision,
      review: workload.review,
      authority_activated: false,
      source_database_changed: false,
    };
    await input.authoringChat?.streamCheckpoint("Disabled Read mapping resumed", [
      `${context.candidate.pack.name} · exact mapped draft; final review pending`,
      "No Read remapping, activation, or source query",
    ]);
  } else {
    const principalScope = await reviewJobPrincipalScopeForResources({
      projectRoot: input.projectRoot,
      schemaInspector: input.schemaInspector,
      session: input.session,
      jobIntent: jobIntent.trim(),
      resourceIds: workload.analysis.allowed.flatMap((entry) =>
        entry.authority_atoms.map((atom) => atom.root_resource)),
      ...(modelAssistSession ? { modelSession: modelAssistSession } : {}),
      ...(input.modelAuthoringNarrator
        ? { modelNarrator: input.modelAuthoringNarrator }
        : {}),
      ...(input.modelPrincipalScopeInterpreter
        ? { modelInterpreter: input.modelPrincipalScopeInterpreter }
        : {}),
      ...(input.authoringChat ? { authoringChat: input.authoringChat } : {}),
    });
    if (principalScope.state === "paused") {
      await persistAuthoringResume("read_mapping");
      return boundaryAssistResult({
        tone: "warning",
        title: "User/owner scope review paused this job.",
        lines: [
          `Still unresolved: ${principalScope.resources.join(", ")}`,
          "The job promises own-row access, so Runner will not save or activate a tenant-only substitute.",
          "The disabled mapping catalog remains available and source data is unchanged.",
        ],
        footer: "Review the exact user/owner predicate, then reopen Agent job to resume this saved conversation and disabled catalog.",
      });
    }
    if (principalScope.changed) {
      context = await loadBoundaryReviewContext(input.projectRoot);
      mappingBoundary = context.candidate;
      if (!preparedWorkload) {
        return boundaryAssistResult({
          tone: "warning",
          title: "Trusted user/owner scope was saved; re-run this workload analysis.",
          lines: [
            "The selected saved analysis predates the new principal predicate and is now stale.",
            "Runner will not reuse it without validating its exact plans against the revised disabled catalog.",
            "No authority was activated and source data is unchanged.",
          ],
          footer: "Reopen Agent job and choose exact questions, a model, or a current saved analysis.",
        });
      }
      const analysis = analyzeReadWorkloadSet({
        workload: preparedWorkload,
        generatedBoundary: mappingBoundary,
      });
      workload = await storeReadWorkloadAnalysis({
        projectRoot: input.projectRoot,
        generatedBoundary: mappingBoundary,
        source: preparedWorkload.source,
        analysis,
      });
      if (workload.state !== "ready") {
        return boundaryAssistResult({
          tone: "danger",
          title: "The exact workload no longer fits after user/owner scope review.",
          lines: workload.analysis.blockers.length
            ? workload.analysis.blockers.slice(0, 5)
            : ["Review the exact plans and trusted principal predicate before continuing."],
          footer: "Nothing was activated and source data is unchanged.",
        });
      }
    }
    const reasonDefault = `Compile representative workload ${workload.analysis.workload_name}.`;
    context = await loadBoundaryReviewContext(input.projectRoot);
    const preview = await prepareReadWorkloadCandidate({
      projectRoot: input.projectRoot,
      workload,
      actor: localInteractiveActor(),
      reason: reasonDefault,
      expectedBindings: context.bundle.mutation_bindings,
      schemaInspector: input.schemaInspector,
    });
    const savedRead = await commitReadWorkloadCandidate({
      projectRoot: input.projectRoot,
      preview,
    });
    committed = savedRead;
    context = await reloadReadReviewAfterCommit(input.projectRoot, savedRead);
    mappingBoundary = context.candidate;
  }
  if (actionIntents.length && !reusingExactRead) {
    if (!input.completeReadReview) {
      throw new Error(
        "DELEGATION_READ_REVIEW_REQUIRED: finish the exact Read Boundary review before preparing dependent proposal actions.",
      );
    }
    await writeRunner("READ CANDIDATE READY", [
      `${requestedReadCoverage.supported}/${requestedReadCoverage.total} requested read plans are supported.`,
      `${exposure.candidate_resources} resources | ${exposure.candidate_return_fields} return fields | `
        + `${exposure.candidate_relationships} relationships`,
      "Review the complete Read Boundary now. You may activate it or keep the exact review disabled while preparing actions.",
      "No proposal, approval, apply, or source-write authority is active.",
    ], "success");
    const reviewResult = await input.completeReadReview("prepare_actions", input.session);
    if (reviewResult !== 0) {
      throw new Error("DELEGATION_READ_REVIEW_INCOMPLETE: the exact Read Boundary review did not complete.");
    }
    const reviewed = await loadBoundaryReviewContext(input.projectRoot);
    if (!exactReadBoundaryIsFullyReviewed(reviewed)) {
      return boundaryAssistResult({
        tone: "warning",
        title: "Agent job setup paused at Read Boundary review.",
        lines: [
          `Read Boundary ${reviewed.candidate.pack.name} remains disabled and incomplete.`,
          "No Action Boundary was prepared, and no agent authority or source data changed.",
        ],
        footer: "Press W to start a new guided job against this preserved disabled Read draft, or edit it manually.",
      });
    }
    context = reviewed;
    mappingBoundary = reviewed.candidate;
  }
  const bindSemanticActionToRead = async (
    reviewedRead: ExplorationBoundaryDraft,
  ): Promise<CompiledActionRuleModelDraftV1> => {
    if (!semanticActionCatalog || !semanticActionModelDraft) {
      throw new Error("ACTION_RULE_MODEL_DRAFT_INCOMPLETE: no validated semantic Action draft is available.");
    }
    const exactReadDigest = explorationBoundaryCandidateDigest(reviewedRead);
    const entries = semanticActionDrafts.length ? semanticActionDrafts : [{
      intent: actionIntents[0]!, result: semanticActionModelResult!, catalog: semanticActionCatalog,
    }];
    let replacement = await readActionRuleAuthorityDraft(input.projectRoot, semanticActionModelResult!.compiled.loaded.authority.name);
    if (replacement && replacement.authority.catalog.generation_lock_fingerprint !== reviewedRead.generation_lock_fingerprint) {
      replacement = prepareActionRuleReadRevision({ existing: replacement,
        previousLock: await loadGenerationLockSnapshot(input.projectRoot, replacement.authority.catalog.generation_lock_fingerprint),
        nextLock: await loadGenerationLockSnapshot(input.projectRoot, reviewedRead.generation_lock_fingerprint),
        nextBoundary: reviewedRead, inspection: actionInspection!, revalidateMetadata: true });
    }
    const prepared: Array<{ entry: typeof entries[number]; catalog: BuiltActionRuleAuthoringCatalogV1; compiled: CompiledActionRuleModelDraftV1 }> = [];
    let latestCompiled: CompiledActionRuleModelDraftV1 | undefined;
    for (const entry of entries) {
    // Read-workload minimization intentionally removes resources that exist
    // only to support an Action target. Retain their already reviewed private
    // catalog authority while rebinding the Action draft to the exact final
    // Read revision. This must not make the Action-only resource model-readable.
    const catalog = await buildActionCatalogForSavedReadRevision({ projectRoot: input.projectRoot,
      catalog: entry.catalog.catalog, nextBoundary: reviewedRead, inspection: actionInspection! });
    const compiled = compileActionRuleModelDraft({
      draft: entry.result.compiled.draft,
      builtCatalog: catalog,
      readBoundary: reviewedRead,
      readBoundaryDigest: exactReadDigest,
      activatedAt: entry.result.compiled.loaded.authority.rules.find((rule) => rule.rule.outcome === entry.result.compiled.rule.outcome)?.activated_at,
    });
    replacement = await actionRuleAuthorityDraftFromCompiled(input.projectRoot, compiled, replacement, {
      nextBoundary: reviewedRead,
      inspection: actionInspection!,
    });
    prepared.push({ entry, catalog, compiled });
    latestCompiled = compiled;
    }
    await saveSemanticActionDraft(replacement!);
    semanticActionAuthorityDraft = replacement;
    for (const { entry, catalog, compiled } of prepared) {
      entry.catalog = catalog;
      entry.result = { ...entry.result, compiled };
      semanticActionModelResult = entry.result;
      semanticActionModelDraft = compiled.draft;
      semanticActionCatalog = catalog;
    }
    const completedOutcomes = entries.map((entry) => entry.result.compiled.rule.outcome);
    if (retainedReadEdit) {
      resumeAction = retainedReadEdit.action;
    } else if (pendingActionAddition) {
      const retained = pendingActionAddition.retained_action;
      const retainedIntents = retained.intents ?? [retained.intent];
      const retainedOutcomes = retained.completed_outcomes ?? [];
      if (new Set([...retainedOutcomes, ...completedOutcomes]).size !== retainedOutcomes.length + completedOutcomes.length
        || new Set([...retainedIntents, ...actionIntents]).size !== retainedIntents.length + actionIntents.length) {
        throw new Error("ACTION_ADDITION_IDENTITY_COLLISION: The planned Action duplicates a saved job identity. Existing authority is unchanged; revise the new behavior instead of merging it.");
      }
      resumeAction = {
        intent: retainedIntents[0]!,
        intents: [...retainedIntents, ...actionIntents],
        completed_outcomes: [...retainedOutcomes, ...completedOutcomes],
        outcome: latestCompiled!.rule.outcome,
        strategy: "rule_derived",
      };
      pendingActionAddition = undefined;
      pendingJobRevision = undefined;
    } else {
      resumeAction = {
        intent: actionIntents[0]!,
        intents: actionIntents,
        completed_outcomes: completedOutcomes,
        outcome: latestCompiled!.rule.outcome,
        strategy: "rule_derived",
      };
    }
    await persistAuthoringResume("authority_review");
    return latestCompiled!;
  };
  if (ruleDerivedAction) {
    const reviewedRead = reusingExactRead
      ? mappingBoundary
      : (await loadBoundaryReviewContext(input.projectRoot)).candidate;
    const compiled = await bindSemanticActionToRead(reviewedRead);
    const details = [
      ...(semanticActionRevisionBaseline
        ? [
            "REPLACEMENT OF EXISTING VERIFIED OUTCOME",
            ...semanticActionRevisionDiffLines(
              semanticActionRevisionBaseline,
              compiled,
              semanticActionModelResult?.revision?.changed_phases ?? [],
            ),
          ]
        : []),
      ...semanticActionReviewLines(compiled),
      ...semanticActionDrafts.filter((entry) => entry.result.compiled.rule.outcome !== compiled.rule.outcome)
        .flatMap((entry) => semanticActionReviewLines(entry.result.compiled)),
      `Read dependency: ${reviewedRead.pack.name} at this exact reviewed revision`,
      `Authority digest: ${semanticActionAuthorityDraft!.digest}`,
      "State: disabled",
      "Source database changed: no",
    ];
    input.authoringChat?.rememberDetails("VERIFIED ACTION OUTCOME", details);
    if (resumeSelected && availableResume?.stage === "authority_review" || activePolicySource(authoringConversation?.policySources)) {
      // The next missing decision, not a second recap, owns this model turn.
    } else if (input.authoringChat && semanticActionDrafts.length && semanticActionDrafts.every((entry) => entry.result.message?.trim())) {
      for (const entry of semanticActionDrafts) {
        await input.authoringChat.streamModel(entry.result.message!.trim().split(/\r?\n/u));
      }
    } else if (input.authoringChat && modelAssistSession) {
      const narrator = input.modelAuthoringNarrator ?? narrateValidatedAuthoringStep;
      const summary = await runWithProgress(
        `${boundaryModelLabel(modelAssistSession)} is summarizing the verified Action outcome`,
        () => narrator({
          session: modelAssistSession!,
          operatorMessage: jobIntent.trim(),
          validatedFacts: [
            semanticActionRevisionBaseline
              ? "Runner compiled and saved one disabled replacement for an existing semantic Action outcome. The prior active revision remains unchanged until separate activation."
              : `Runner compiled and saved ${semanticActionDrafts.length} disabled semantic Action outcome(s).`,
            ...(semanticActionRevisionBaseline
              ? semanticActionRevisionDiffLines(
                  semanticActionRevisionBaseline,
                  compiled,
                  semanticActionModelResult?.revision?.changed_phases ?? [],
                )
              : []),
            ...semanticActionDrafts.flatMap((entry) => semanticActionNarrationFacts(entry.result.compiled)),
            "The exact Read dependency, private verification fields, and derived effect are locked in the disabled draft.",
            "No proposal, approval, activation, apply operation, source query, or source write occurred.",
          ],
          nextQuestion: "The Read and verified Action authorities still require separate operator activation. Shall we review them now?",
          egressAcknowledged: true,
        }),
      );
      if (summary) await input.authoringChat.streamModel(summary.split(/\r?\n/u));
      if (semanticActionRevisionBaseline) {
        await input.authoringChat.streamCheckpoint(
          "Runner-validated Action change",
          semanticActionRevisionDiffLines(
            semanticActionRevisionBaseline,
            compiled,
            semanticActionModelResult?.revision?.changed_phases ?? [],
          ),
          "normal",
        );
      }
    } else {
      await writeRunner("VERIFIED ACTION OUTCOME READY", [
        `Outcome: ${compiled.rule.outcome}`,
        `${compiled.review.when} -> ${compiled.review.then}`,
        "Disabled draft only; no proposal, approval, apply operation, or source write occurred.",
      ], "success");
    }
  }
  const actionDrafts: Array<{
    intent: string;
    draft: Awaited<ReturnType<typeof guidedActionStatus>>["drafts"][number];
  }> = [];
  const runActionReview = input.runDelegationActionReview ?? runActionControlPlane;
  let resolvedActionInspection = actionInspection;
  if (actionIntents.length && !ruleDerivedAction) {
    const inspection = resolvedActionInspection ?? await (input.actionProjectInspector ?? inspectActionProject)(
      input.projectRoot,
      process.env,
    );
    resolvedActionInspection = inspection;
    for (const [actionIndex, actionIntent] of actionIntents.entries()) {
      const before = new Set((await guidedActionStatus(input.projectRoot)).drafts.map((draft) =>
        `${draft.capability}:${draft.contract_digest}`));
      let initialSuggestionId: string | undefined;
      if (modelAssistSession) {
        const options = await guidedActionOptions({
          projectRoot: input.projectRoot,
          inspection,
          boundaryName: context.candidate.pack.name,
          allowReviewedPending: true,
        });
        const preMapped = preMappedActions[actionIndex];
        const generated = preMapped?.intent === actionIntent
          ? preMapped.result
          : await (input.modelActionSuggestionGenerator ?? generateModelActionSuggestion)({
              intent: actionIntent,
              provider: modelAssistSession.provider,
              model: modelAssistSession.model,
              options,
              env: process.env,
              ...(modelAssistSession.apiKey ? { apiKey: modelAssistSession.apiKey } : {}),
              ...(modelAssistSession.apiKeyEnv ? { apiKeyEnv: modelAssistSession.apiKeyEnv } : {}),
              ...(modelAssistSession.baseUrl ? { baseUrl: modelAssistSession.baseUrl } : {}),
              ...(modelAssistSession.dependencies ? { dependencies: modelAssistSession.dependencies } : {}),
              ...(modelAssistSession.conversation ? { conversation: modelAssistSession.conversation } : {}),
              deferNarration: Boolean(input.authoringChat),
              egressAcknowledged: true,
            });
        const imported = await importActionSuggestion({
          projectRoot: input.projectRoot,
          value: generated.assessment.suggestion,
          options,
        });
        initialSuggestionId = imported.suggestion_id;
      }
      await runActionReview({
        projectRoot: input.projectRoot,
        boundaryName: context.candidate.pack.name,
        inspection,
        env: process.env,
        ...(initialSuggestionId ? { initialSuggestionId } : { initialIntent: actionIntent }),
        ...(modelInterviewSession ? { modelSuggestionSession: modelInterviewSession } : {}),
        ...(modelInterviewSession ? { modelInterviewEgressAcknowledged: true } : {}),
        ...(input.authoringChat ? { prompter: input.authoringChat.actionPrompter } : {}),
        prepareOnly: true,
        actionBoundaryJobIntent: jobIntent.trim(),
      });
      const created = (await guidedActionStatus(input.projectRoot)).drafts.find((draft) =>
        draft.boundary_name === context.candidate.pack.name
        && !before.has(`${draft.capability}:${draft.contract_digest}`));
      if (created) actionDrafts.push({ intent: actionIntent, draft: created });
    }
    await persistAuthoringResume("authority_review");
  }
  const writeCurrentDelegationDraft = () => writeDelegationDraft(
    input.projectRoot,
    buildDelegationDraft({
      jobIntent: jobIntent.trim(),
      boundaryName: context.candidate.pack.name,
      workload: workload!,
      review: committed.review,
      actionIntents,
      actionDrafts,
      ...(semanticActionAuthorityDraft && semanticActionModelResult
        ? {
            semanticActions: semanticActionDrafts.map((entry) => ({
              intent: entry.intent,
              outcome: entry.result.compiled.rule.outcome,
              action_boundary_name: semanticActionAuthorityDraft!.authority.action_boundary.name,
              authority_digest: semanticActionAuthorityDraft!.digest,
            })),
          }
        : {}),
      ...(modelAssistRecord ? { modelAssist: modelAssistRecord } : {}),
    }),
  );
  await writeCurrentDelegationDraft();
  let readBoundaryActive = await exactReadBoundaryIsActive({
    projectRoot: input.projectRoot,
    boundaryName: context.candidate.pack.name,
    candidateDigest: committed.candidate_digest,
  });
  let reviewNavigation: BoundaryAssistOutcome["navigation"];
  const canReviseReadWithModel = Boolean(
    input.authoringChat
    && modelAssistSession
    && actionDrafts.length === 0
    && (actionIntents.length === 0 || (semanticActionModelDraft && semanticActionCatalog)),
  );
  type RetainedReadRevisionRequest = {
    instruction: string;
    provenance: "guided" | "operator";
    privacyOnly: boolean;
    vocabularyOnly?: boolean;
    /** A real answer may justify a guided repair without making the repair text operator input. */
    interpretationInstruction?: string;
  };
  let failedReadRevision: RetainedReadRevisionRequest | undefined;
  let readRevisionRecovery: string[] = [];
  let latestReadRevisionDiff: ReviewSection | undefined;
  const reviseReadWithModel = canReviseReadWithModel
    ? async (guidedInstruction?: string, preparedRevision?: ModelReadBoundaryRevisionResult, options?: {
        interpretationInstruction?: string;
        vocabularyOnly?: boolean;
        operatorInstruction?: boolean;
        generalReadRestriction?: boolean;
      }): Promise<boolean> => {
        const chat = input.authoringChat!;
        const modelSession = modelAssistSession!;
        const narrator = input.modelAuthoringNarrator ?? narrateValidatedAuthoringStep;
        const revisionQuestion = [
          failedReadRevision
            ? "Your previous revision request is retained. Say retry to use it again, or describe what should change."
            : "What should change in this Read Boundary?",
        ].join(" ");
        const opening = guidedInstruction ? undefined : await runWithProgress(
          `${boundaryModelLabel(modelSession)} is preparing the Read revision question`,
          () => narrator({
            session: modelSession,
            operatorMessage: "Revise this exact Read Boundary without restating the job.",
            validatedFacts: [
              `The exact disabled Read Boundary ${context.candidate.pack.name} is available for revision.`,
              "Field exposure, reviewed operations, labels, existing relationship selections, privacy and bounded limits can change when requested.",
              "Existing resources can be excluded from Read when requested; resources cannot be added here. Trusted scope and the saved job remain unchanged.",
              ...(semanticActionModelDraft
                ? ["A dependent disabled Action draft exists and Runner will recompile it against the prospective Read revision before saving anything."]
                : []),
              "No authority is active because of this revision, and no source query or source write is available.",
            ],
            nextQuestion: revisionQuestion,
            egressAcknowledged: true,
          }),
        );
        if (opening?.trim()) {
          await chat.streamModel(opening.trim().split(/\r?\n/u));
        } else if (!preparedRevision && !guidedInstruction) {
          await chat.streamModel([revisionQuestion]);
        }

        const readModelAnswer = async (question: string): Promise<string | undefined> => {
          let answer = chat.readOperator
            ? await chat.readOperator()
            : await input.session.promptText(question);
          while (answer !== undefined && isBoundaryAuthoringExplanationQuestion(answer)) {
            const explanation = await runWithProgress(
              `${boundaryModelLabel(modelSession)} is answering your question`,
              () => narrator({
                session: modelSession,
                operatorMessage: answer!.trim(),
                validatedFacts: [
                  `Pending Read Boundary revision question: ${question}`,
                  "Runner can revise exact field exposure and reviewed policy settings in this step, but cannot change trusted scope or activate authority.",
                  "Runner-only fields may still support joins, opaque object references, trusted verification, and stale-write protection without returning their raw values to the model.",
                  "No revision or authority change has been saved yet.",
                ],
                nextQuestion: question,
                egressAcknowledged: true,
              }),
            );
            if (explanation?.trim()) await chat.streamModel(explanation.trim().split(/\r?\n/u));
            else chat.checkpoint("Model explanation unavailable", [
              "The pending Read revision is unchanged. Answer it, use /details, or press Esc to pause safely.",
            ], "warning");
            answer = chat.readOperator
              ? await chat.readOperator()
              : await input.session.promptText(question);
          }
          return answer;
        };

        const answer = guidedInstruction ?? await readModelAnswer(revisionQuestion);
        const retryingRetainedRequest = answer?.trim().toLowerCase() === "retry" && failedReadRevision;
        const request = retryingRetainedRequest
          ? failedReadRevision!
          : answer?.trim()
            ? {
                instruction: answer.trim(),
                provenance: guidedInstruction && !options?.operatorInstruction ? "guided" as const : "operator" as const,
                privacyOnly: Boolean(guidedInstruction) && !options?.vocabularyOnly && !options?.operatorInstruction && !options?.generalReadRestriction,
                ...(options?.vocabularyOnly ? { vocabularyOnly: true } : {}),
                ...(options?.interpretationInstruction?.trim()
                  ? { interpretationInstruction: options.interpretationInstruction.trim() }
                  : {}),
              }
            : undefined;
        if (!request) {
          chat.checkpoint("Read revision paused", [
            "The exact disabled Read and Action drafts are unchanged.",
          ], "warning");
          return false;
        }
        // Guided repair instructions are Runner orchestration, not a new
        // operator policy decision. The actual business answer is already saved.
        if (!preparedRevision && request.provenance === "operator" && !retryingRetainedRequest) {
          rememberModelAuthoringClarification(authoringConversation, revisionQuestion, request.instruction);
        }
        await persistAuthoringResume("authority_review");

        let readRevisionSaved = false;
        try {
          // Saving the companion Action draft advances the shared repository
          // epoch, not the Read revision. Start a new preview from that current
          // epoch only after proving the displayed Read and Action are unchanged.
          context = await reloadReadReviewForModelRevision(input.projectRoot, context, semanticActionAuthorityDraft);
          const previousGenerationLock = context.lock;
          const priorActionDraft = semanticActionModelResult
            ? await readActionRuleAuthorityDraft(input.projectRoot, semanticActionModelResult.compiled.loaded.authority.name) : undefined;
          const validateCandidate = (candidate: ExplorationBoundaryDraft, nextGenerationLock: GenerationLock) => {
            if (!semanticActionModelDraft || !semanticActionCatalog || !actionInspection) return;
            const entries = semanticActionDrafts.length ? semanticActionDrafts : [{
              catalog: semanticActionCatalog, result: semanticActionModelResult!,
            }];
            if (priorActionDraft) prepareActionRuleReadRevision({ existing: priorActionDraft,
              previousLock: previousGenerationLock, nextLock: nextGenerationLock, nextBoundary: candidate, inspection: actionInspection });
            for (const entry of entries) {
              const retainedCatalog = rebindActionCatalogForReadPolicyRevision({
                catalog: entry.catalog.catalog,
                previousLock: previousGenerationLock,
                nextLock: nextGenerationLock,
                nextBoundary: candidate,
              });
              const prospectiveCatalog = buildActionRuleAuthoringCatalog({
                boundary: candidate,
                inspection: actionInspection,
                retainedCatalog,
              });
              compileActionRuleModelDraft({
                draft: entry.result.compiled.draft,
                builtCatalog: prospectiveCatalog,
                readBoundary: candidate,
                readBoundaryDigest: explorationBoundaryCandidateDigest(candidate),
              });
            }
          };
          let validatedPreview: { revision: string; preview: ModelReadRevisionPreview } | undefined;
          const revisionKey = (revision: ModelReadBoundaryExposureRevisionInput["revision"]) =>
            canonicalJsonDigest({ changes: revision.changes, policy_changes: revision.policy_changes ?? [], read_prerequisite: revision.read_prerequisite ?? null,
              reviewed_relationship: revision.reviewed_relationship ?? null });
          const revision = preparedRevision ?? await runWithProgress(
            `${boundaryModelLabel(modelSession)} is drafting the exact field-exposure revision`,
            () => (input.modelReadBoundaryRevisionGenerator ?? generateModelReadBoundaryRevision)({
              instruction: request.instruction,
              provider: modelSession.provider,
              model: modelSession.model,
              boundary: context.candidate,
              ...(request.privacyOnly ? { privacyOnly: true } : {}),
              ...(request.vocabularyOnly ? { vocabularyOnly: true, operatorNamingContext: jobIntent.trim() } : {}),
              env: process.env,
              ...(modelSession.apiKey ? { apiKey: modelSession.apiKey } : {}),
              ...(modelSession.apiKeyEnv ? { apiKeyEnv: modelSession.apiKeyEnv } : {}),
              ...(modelSession.baseUrl ? { baseUrl: modelSession.baseUrl } : {}),
              ...(modelSession.dependencies ? { dependencies: modelSession.dependencies } : {}),
              ...(modelSession.conversation ? { conversation: modelSession.conversation } : {}),
              egressAcknowledged: true,
              validateRevision: async (revision) => {
                validatedPreview = undefined;
                if (!revision.changes.length && !revision.policy_changes?.length && !revision.read_prerequisite) return;
                const preview = await prepareModelReadBoundaryExposureRevision({
                  projectRoot: input.projectRoot,
                  schemaInspector: input.schemaInspector,
                  context,
                  revision,
                  validateCandidate,
                });
                validatedPreview = { revision: revisionKey(revision), preview };
              },
              reviewRelationship: async (request) => {
                const assertCurrent = async () => {
                  await reloadReadReviewForModelRevision(input.projectRoot, context, semanticActionAuthorityDraft);
                };
                chat.rememberDetails("READ RELATIONSHIP REVIEW", [request.reason,
                  `Requested connection: ${request.from_resource} -> ${request.to_resource}`,
                  "Runner will inspect generated paths locally. No source rows, new resources, independent access or activation."]);
                return reviewReadRelationship({ projectRoot: input.projectRoot, boundary: context.candidate,
                  generatedBoundary: context.draft, fromResource: request.from_resource, toResource: request.to_resource,
                  session: input.session, modelLabel: boundaryModelLabel(modelSession), assertCurrent });
              },
              reviewPrivatePrerequisite: async ({ reason }) => {
                const assertCurrent = async () => {
                  await reloadReadReviewForModelRevision(input.projectRoot, context, semanticActionAuthorityDraft);
                };
                await assertCurrent();
                const inspection = await input.schemaInspector({ engine: context.lock.engine,
                  databaseUrlEnv: context.lock.source_env, schema: context.lock.inspected_schema, env: process.env });
                // Retained private scope can prove identity roles without adding
                // its fields to Read authority or sending its catalog to a model.
                const retainedCatalogs = semanticActionDrafts.length
                  ? semanticActionDrafts.map(entry => entry.catalog.catalog)
                  : semanticActionCatalog ? [semanticActionCatalog.catalog] : [];
                const scopeBoundary = { ...context.candidate,
                  ...(retainedCatalogs.length ? { scopeEvidence: { retained_action_catalogs: retainedCatalogs } } : {}) };
                const approvedMetadata = await reviewReadPrerequisiteMetadata({ inspection, boundary: scopeBoundary,
                  session: input.session, modelLabel: boundaryModelLabel(modelSession), assertCurrent });
                if (!approvedMetadata) return undefined;
                const result = await generateModelReadPrerequisite({
                  instruction: request.instruction,
                  modelRationale: reason,
                  approvedBusinessClarifications: (authoringConversation?.turns ?? [])
                    .filter(turn => turn.kind === "clarification")
                    .map(turn => ({ question: turn.question, answer: turn.answer })),
                  boundary: scopeBoundary, inspection, approvedMetadata,
                  provider: modelSession.provider, model: modelSession.model, env: process.env,
                  ...(modelSession.apiKey ? { apiKey: modelSession.apiKey } : {}),
                  ...(modelSession.apiKeyEnv ? { apiKeyEnv: modelSession.apiKeyEnv } : {}),
                  ...(modelSession.baseUrl ? { baseUrl: modelSession.baseUrl } : {}),
                  ...(modelSession.dependencies ? { dependencies: modelSession.dependencies } : {}),
                  egressAcknowledged: true,
                  clarificationHandler: async (question) => {
                    await chat.streamModel([question.question]);
                    const answer = await readModelAnswer(question.question);
                    if (!answer?.trim()) return { state: "declined" as const };
                    validateReadPrerequisiteBusinessAnswer(answer);
                    rememberModelAuthoringClarification(authoringConversation, question.question, answer.trim());
                    await persistAuthoringResume("authority_review");
                    return { state: "answered" as const, answer: answer.trim() };
                  },
                  confirmSemanticSelection: mapping => reviewReadPrerequisiteSelection({
                    mapping, session: input.session, assertCurrent,
                    rememberAnswer: async (question, answer) => {
                      rememberModelAuthoringClarification(authoringConversation, question, answer);
                      await persistAuthoringResume("authority_review");
                    },
                  }),
                });
                await assertCurrent();
                if (result.state === "pending") {
                  chat.rememberDetails("PRIVATE ACCESS CONDITION PENDING", [result.reason, "Previous draft and active authority are unchanged."]);
                  return undefined;
                }
                privateReadMetadataDigest = canonicalJsonDigest(result.reviewed_read_prerequisite);
                await persistAuthoringResume("authority_review");
                if (resumePersistenceBlocked) throw new Error("READ_METADATA_PERMISSION_NOT_SAVED: Keep this edit pending; the exact private metadata permission could not be saved.");
                return result.reviewed_read_prerequisite;
              },
              clarificationHandler: async (request) => {
                chat.rememberDetails("READ EDIT QUESTION", [
                  request.question, request.reason,
                  `Read revision: ${explorationBoundaryCandidateDigest(context.candidate)}`,
                  "This question does not save access, change active permissions or read source rows.",
                ]);
                await chat.streamModel([request.question]);
                const answer = await readModelAnswer(request.question);
                if (answer === undefined || !answer.trim()) return { state: "declined" as const };
                rememberModelAuthoringClarification(authoringConversation, request.question, answer.trim());
                await persistAuthoringResume("authority_review");
                return { state: "answered" as const, answer: answer.trim() };
              },
            }),
          );
          const fields = revision.confirmed_fields ?? [];
          if (request.vocabularyOnly) assertVocabularyOnlyReadRevision(revision);
          if (fields.length && revision.checked_catalog_digest !== readBoundaryRevisionCatalog(context.candidate).digest) {
            throw new Error("The field interpretation belongs to another Read revision. The prior draft is preserved.");
          }
          const checkedInterpretationCatalog = (candidate: ExplorationBoundaryDraft) => {
            const checked = readBoundaryRevisionCatalog(candidate);
            if (fields.some((field) => {
              const current = checked.resources.find((resource) => resource.id === field.resource)?.fields.find((entry) => entry.id === field.field);
              return field.before !== field.after || current?.current_exposure !== field.after
                || field.model_operations === "none" && Boolean(current?.model_operations.length);
            })) {
              throw new Error("The unchanged interpretation did not identify matching field states in this exact draft. The prior draft is preserved.");
            }
            return checked;
          };
          const persistConfirmedInterpretation = async () => {
            const interpretationInstruction = request.provenance === "operator"
              ? request.instruction
              : request.interpretationInstruction;
            if (fields.length && interpretationInstruction && authoringConversation?.policySources) {
              const checked = checkedInterpretationCatalog(context.candidate);
              recordReadInterpretation(authoringConversation.policySources, { instruction: interpretationInstruction,
                read_digest: explorationBoundaryCandidateDigest(context.candidate), catalog_digest: checked.digest,
                checked_at: new Date().toISOString(), fields: fields.map((field) => ({ resource: field.resource, field: field.field, exposure: field.after })) });
              await savePolicySources(input.projectRoot, authoringConversation.policySources);
            }
          };
          checkedInterpretationCatalog(context.candidate);
          if (!revision.changes.length && !revision.policy_changes?.length && !revision.read_prerequisite) {
            if (!fields.length) throw new Error("The unchanged interpretation did not identify matching field states in this exact draft. The prior draft is preserved.");
            await persistConfirmedInterpretation();
            const confirmation = "Confirmed: the checked field settings already match your answer. No access change was needed; I will check the remaining rules next.";
            if (request.provenance === "operator") rememberModelAuthoringTurn(authoringConversation, request.instruction, confirmation);
            else if (request.interpretationInstruction) rememberModelAuthoringTurn(authoringConversation, request.interpretationInstruction, confirmation);
            failedReadRevision = undefined;
            readRevisionRecovery = [];
            pendingReadRevision = undefined;
            await persistAuthoringResume("authority_review");
            chat.rememberDetails("READ INTERPRETATION CONFIRMED", [
              ...fields.map((field) => `${field.resource}.${field.field}: ${formatReadBoundaryExposure(field.after)} (unchanged)`),
              `Exact Read revision: ${explorationBoundaryCandidateDigest(context.candidate)}`,
              "These checks confirm only the listed field states, not complete policy coverage. No authority or source data changed.",
            ]);
            await chat.streamModel([confirmation]);
            return true;
          }
          const expansionChanges = revision.changes.filter((change) =>
            change.after === "model_and_runner" && change.before !== "model_and_runner"
            || change.before === "kept_out" && change.after === "runner_only");
          const preparedPreview = validatedPreview?.revision === revisionKey(revision) ? validatedPreview.preview
            : await prepareModelReadBoundaryExposureRevision({ projectRoot: input.projectRoot, schemaInspector: input.schemaInspector,
              context, revision, validateCandidate });
          // A partially satisfied answer can also revise other settings. Retain
          // its meaning only if the exact confirmed states survive that revision.
          checkedInterpretationCatalog(preparedPreview.candidate);
          if (request.privacyOnly) {
            const counts = readRevisionDiff(context.candidate, preparedPreview.candidate).changeCounts!;
            if (counts.rawAdded || counts.analysisAdded || counts.selectionAdded) throw new Error("This privacy-only candidate requests new Read access. No changes were saved. Retry the narrow privacy correction; additional access must be reviewed as a separate requested change.");
          }
          let guidedRevisionReviewed = false;
          if (request.privacyOnly && !preparedRevision && !request.interpretationInstruction && input.session.chooseOption) {
            const diff = readRevisionDiff(context.candidate, preparedPreview.candidate, revision.changes);
            let accepted: string | undefined;
            do {
              accepted = await input.session.chooseOption("SAVE DISABLED PRIVACY REVISION", [
              { value: "save", label: "Save this disabled privacy revision" },
              { value: "details", label: "View exact privacy changes" },
              { value: "revise", label: "Change this privacy request with the model" },
              { value: "back", label: "Keep the current draft" },
            ], { initialValue: "back", context: diff.lines, reviewOnly: true, explainOnRequest: true,
              exactDetails: { title: "Privacy revision", summaryTitle: "PRIVACY CHANGES", lines: reviewSectionLines(diff), sections: diff.children } });
              if (accepted === "details") await input.session.showReviewDetails?.("Privacy revision", reviewSectionLines(diff));
            } while (accepted === "details");
            if (accepted === "revise") return reviseReadWithModel!();
            if (accepted !== "save") {
              chat.checkpoint("Privacy changes not saved", ["Your previous Read draft is unchanged. Returning to its activation review."]);
              return false;
            }
            guidedRevisionReviewed = true;
          }
          if (expansionChanges.length && !guidedRevisionReviewed) {
            const accepted = await input.session.confirm(
              `Save ${expansionChanges.length} new field access grant${expansionChanges.length === 1 ? "" : "s"} in this disabled draft?`,
              {
                defaultValue: false,
                context: [
                  "NEW FIELD ACCESS - REVIEW REQUIRED",
                  ...expansionChanges.map((change) =>
                    `${change.resource}.${change.field}: ${formatReadBoundaryExposure(change.before)} -> ${formatReadBoundaryExposure(change.after)}`),
                  "Kept-out to Runner-only adds private Runner access. Model + Runner allows model return. Neither becomes active until the separate Read activation.",
                  "Declining keeps the exact Read and Action drafts unchanged.",
                ],
              },
            );
            if (accepted !== true) {
              chat.checkpoint("Model-facing expansion not saved", [
                "The exact disabled Read and Action drafts are unchanged.",
              ], "warning");
              return false;
            }
          }

          const previousDigest = committed.candidate_digest;
          const previousCandidate = structuredClone(context.candidate);
          const revised = await applyModelReadBoundaryExposureRevision({
            projectRoot: input.projectRoot,
            schemaInspector: input.schemaInspector,
            context,
            revision,
            validateCandidate,
            preview: preparedPreview,
            onCommitted: () => { readRevisionSaved = true; },
          });
          readRevisionSaved = true;
          context = revised.context;
          latestReadRevisionDiff = readRevisionDiff(previousCandidate, context.candidate, revision.changes);
          await saveReadReviewDiff(input.projectRoot, context.bundle.candidate_digest, latestReadRevisionDiff).catch(() => {
            chat.checkpoint("Change history not persisted", ["The disabled revision is saved. Its exact diff remains available in this session."], "warning");
          });
          mappingBoundary = revised.context.candidate;
          workload = revised.workload;
          committed = revised.committed;
          resumeRead = {
            analysis_id: revised.workload.analysis_id,
            analysis_digest: revised.workload.analysis_digest,
          };
          if (semanticActionModelDraft && semanticActionCatalog) {
            await bindSemanticActionToRead(mappingBoundary);
          }
          await persistConfirmedInterpretation();
          await writeCurrentDelegationDraft();
          pendingReadRevision = undefined;
          await persistAuthoringResume("authority_review");
          readBoundaryActive = await exactReadBoundaryIsActive({
            projectRoot: input.projectRoot,
            boundaryName: context.candidate.pack.name,
            candidateDigest: committed.candidate_digest,
          });

          const exactChanges = [
            ...reviewSectionLines(latestReadRevisionDiff),
            ...(revision.policy_changes ?? []).flatMap((change) => Object.entries(change.settings).map(([key, value]) => `${change.resource} ${key}: ${JSON.stringify(value)}`)),
          ];
          chat.rememberDetails("READ BOUNDARY REVISION", [
            ...exactChanges,
            `Read digest changed: ${previousDigest} -> ${committed.candidate_digest}`,
            ...(semanticActionModelDraft
              ? ["Dependent Action revision: rebuilt and revalidated against the new exact Read digest"]
              : []),
            "Read authority: unchanged",
            "Action authority: unchanged",
            "Source query executed: no",
            "Source database changed: no",
          ]);
          const summary = preparedRevision || request.provenance === "guided" ? undefined : await runWithProgress(
            `${boundaryModelLabel(modelSession)} is summarizing the validated revision`,
            () => narrator({
              session: modelSession,
              operatorMessage: request.instruction,
              validatedFacts: [
                `Runner validated and saved ${revision.changes.length} exact field-exposure change${revision.changes.length === 1 ? "" : "s"} in the disabled Read draft.`,
                ...exactChanges,
                `${revision.changes.filter((change) => change.after === "runner_only").length} changed field${revision.changes.filter((change) => change.after === "runner_only").length === 1 ? " is" : "s are"} now Runner only.`,
                `${revision.changes.filter((change) => change.after === "kept_out").length} changed field${revision.changes.filter((change) => change.after === "kept_out").length === 1 ? " is" : "s are"} now kept out.`,
                ...(semanticActionModelDraft
                  ? ["Runner rebuilt and revalidated the dependent disabled Action revision against the new exact Read digest."]
                  : []),
                "No Read or Action authority was activated, and no source query or source write occurred.",
              ],
              nextQuestion: "",
              egressAcknowledged: true,
            }),
          );
          if (summary?.trim()) await chat.streamModel(summary.trim().split(/\r?\n/u));
          await chat.streamCheckpoint("Read revision validated", [
            ...(revision.reviewed_relationship ? ["Reviewed relationship restored in the disabled draft"] : []),
            `${revision.changes.length} field exposure change${revision.changes.length === 1 ? "" : "s"} · Read authority unchanged`,
            `${semanticActionModelDraft ? "Action dependency rebuilt · " : ""}source unchanged · /details shows the exact diff`,
          ]);
          failedReadRevision = undefined;
          readRevisionRecovery = [];
          return true;
        } catch (error) {
          assertRunning(error);
          failedReadRevision = request;
          const message = redactCliErrorMessage(error instanceof Error ? error.message : String(error));
          const failureTitle = readRevisionSaved ? "Read revision saved; review needs recovery" : "Read revision not saved";
          const preservedState = readRevisionSaved
            ? "The disabled Read revision was saved, but its review did not finish. Resume this job to validate the latest Action dependency before activation."
            : "The exact disabled Read and Action drafts are unchanged.";
          readRevisionRecovery = [
            `Before activation: ${failureTitle}. ${message}`,
            "Recovery: The pending rules remain saved. Ask the model about the correction or inspect exact details; no authority was activated.",
          ];
          chat.rememberDetails(readRevisionSaved ? failureTitle.toUpperCase() : "READ BOUNDARY REVISION NOT SAVED", [
            message,
            preservedState,
            "No authority, source query, or source write occurred.",
            `Retained revision request: ${request.instruction}`,
          ]);
          await chat.streamCheckpoint(failureTitle, [
            message,
            `${preservedState} /details shows the exact refusal`,
            "Choose Revise this Read Boundary again and say retry; your request is retained. You can also change the request or use the manual field editor.",
          ], "warning");
          return false;
        }
      }
    : undefined;
  if (pendingReadRevision) {
    if (!reviseReadWithModel || !await reviseReadWithModel(pendingReadRevision, undefined, { operatorInstruction: true })) {
      await persistAuthoringResume("authority_review");
      return boundaryAssistResult({ tone: "warning", title: "Your access edit is saved for recovery.",
        lines: ["The requested edit did not finish. Existing active permissions and customer data are unchanged."],
        footer: "Resume this job to retry the same edit. Exact details contain the reason; no new job or mapping is needed." });
    }
  }
  if (recoveringSeparatelySavedActions && retainedActionIsUnfinished()) {
    await persistAuthoringResume("action_drafting");
    await input.authoringChat?.streamCheckpoint("Saved changes rechecked; unfinished request retained", [
      `${separatelySavedRevalidationOutcomes.length} saved changes passed current metadata checks. Their business rules did not change.`,
      "The separate unfinished request is still pending, not implemented or granted. Any unresolved attached policy requirements still need review.",
      "No permission or source data changed. Review the prepared changes next, or pause this saved job.",
    ], "warning");
  }
  if (retainedActionIsUnfinished() && !recoveringSeparatelySavedActions && !deferUnfinishedActions) {
    await persistAuthoringResume("action_drafting");
    const notice: BoundaryAccessNotice = { tone: "success", title: "Access edit saved; continuing your unfinished action.",
      lines: ["Existing business rules and the unfinished action's saved components are retained.",
        "Runner will revalidate those components against the updated access settings. No permission or source data changed."] };
    await input.authoringChat?.streamCheckpoint(notice.title, notice.lines);
    return { ...boundaryAssistResult(notice, false, false, Boolean(input.authoringChat)), navigation: "resume_agent_job" };
  }
  const unmetExecutionEntries = () => semanticActionDrafts.filter((entry) =>
    explicitActionExecutionIntent([entry.intent]) === "automatic"
    && entry.result.compiled.effect_envelope.writeback.mode !== "direct_sql");
  const prepareRequestedExecution = async () => {
    // Compile all changed outcomes before saving; preserve the Read revision,
    // private facts, business rules and approval limits byte-for-byte.
    const prepared = unmetExecutionEntries().map((entry) => ({
      entry,
      compiled: compileActionRuleModelDraft({
        draft: { ...entry.result.compiled.draft, effect: { ...entry.result.compiled.draft.effect, writeback: "supervised" } },
        builtCatalog: entry.catalog,
        readBoundary: context.candidate,
        readBoundaryDigest: committed.candidate_digest,
      }),
    }));
    for (const { entry, compiled } of prepared) {
      const saved = await actionRuleAuthorityDraftFromCompiled(input.projectRoot, compiled, undefined, {
        nextBoundary: context.candidate,
        inspection: actionInspection!,
      });
      await saveSemanticActionDraft(saved);
      entry.result = { ...entry.result, compiled };
      semanticActionAuthorityDraft = saved;
    }
    if (prepared.length) {
      const current = semanticActionDrafts.at(-1)!;
      semanticActionModelResult = current.result;
      semanticActionModelDraft = current.result.compiled.draft;
      await persistAuthoringResume("authority_review");
      input.authoringChat?.rememberDetails("EXECUTION REVIEW PREPARED", [
        "Automatic completion: separate execution review pending; execution remains OFF.",
        "Business rules, approval limits and Read access are unchanged. Writer checks and your execution confirmation are still required.",
      ]);
    }
  };
  let policyAttemptKey: string | undefined;
  let policyReport: { key: string; report: PolicyCoverage } | undefined;
  let policyFailure: string | undefined;
  const ensurePolicyCoverage = async (force = false) => {
    const sources = authoringConversation?.policySources;
    const source = activePolicySource(sources);
    if (!source || !input.authoringChat || !modelAssistSession) return undefined;
    const draftRecord = policyCoverageDraft({ read: context.candidate, decisions: context.bundle.decisions,
      ...(actionInspection ? { source: { inspection: actionInspection, generationLock: context.lock } } : {}),
      actions: semanticActionDrafts.map((entry) => entry.result.compiled), authority: semanticActionAuthorityDraft });
    const authorityDigest = canonicalJsonDigest({ read: explorationBoundaryCandidateDigest(context.candidate),
      action: semanticActionAuthorityDraft?.digest ?? null });
    const key = canonicalJsonDigest({ source: source.digest, draft: draftRecord, messages: sources?.operator_messages ?? [],
      interpretations: sources?.read_interpretations ?? [] });
    if (!force && policyAttemptKey === undefined && sources?.coverage_context_digest === key && sources.coverage) {
      try {
        const report = parsePolicyCoverage({ passages: sources.coverage.passages }, source, draftRecord, sources.operator_messages ?? []);
        bindPolicyCoverage(sources, report, authorityDigest);
        policyReport = { key, report };
        policyAttemptKey = key;
      } catch { /* Recheck incompatible evidence, never replay stale readiness. */ }
    }
    if (force || policyAttemptKey !== key) {
      policyAttemptKey = key;
      try {
        const report = await runWithProgress("Checking attached rules against this exact draft", () => reviewPolicyCoverage({
          session: modelAssistSession!, source, draft: draftRecord,
          ...(sources?.coverage?.source_digest === source.digest ? { previousReport: sources.coverage } : {}),
        }));
        policyReport = { key, report };
        policyFailure = undefined;
        if (sources) {
          bindPolicyCoverage(sources, report, authorityDigest);
          sources.coverage_context_digest = key;
          await savePolicySources(input.projectRoot, sources);
        }
      } catch (error) {
        assertRunning(error);
        policyFailure = redactCliErrorMessage(error instanceof Error ? error.message : String(error));
        input.authoringChat.rememberDetails("RULES COVERAGE UNAVAILABLE", [policyFailure,
          "The draft and source snapshot remain saved. No rule was dropped and no authority was activated."]);
        input.authoringChat.checkpoint("Rules check needs a retry", [policyFailure,
          "The reviewed draft is saved. Continue with the model retries this check; exact details work without the provider."], "warning");
        policyReport = undefined;
      }
    }
    return { source, key, draftRecord, report: policyReport?.report };
  };
  const revisePolicyAction = async (entry: typeof semanticActionDrafts[number], instruction: string): Promise<boolean> => {
    const chat = input.authoringChat;
    if (!chat || !modelAssistSession || !input.session.chooseOption) return false;
    try {
      const before = entry.result.compiled;
      pendingActionRevision = prepareBoundaryActionRevision({
        outcome: before.rule.outcome, instruction, baseline_digest: canonicalJsonDigest(before.draft),
      }, pendingActionRevision);
      await persistAuthoringResume("authority_review");
      if (resumePersistenceBlocked) throw checkpointSaveFailure("The edit request");
      const revised = await runWithProgress("Reconciling this action with your saved rules", () => (input.modelActionRuleGenerator ?? generateModelActionRuleDraft)({
        session: modelAssistSession!, intent: pendingActionRevision!.instruction, existingDraft: before.draft,
        ...(pendingActionRevision!.checkpoint ? { checkpoint: pendingActionRevision!.checkpoint } : {}),
        onCheckpoint: async checkpoint => {
          pendingActionRevision = { ...pendingActionRevision!, checkpoint };
          await persistAuthoringResume("authority_review");
          if (resumePersistenceBlocked) throw checkpointSaveFailure("The edit checkpoint");
        },
        builtCatalog: entry.catalog, readBoundary: context.candidate, readBoundaryDigest: committed.candidate_digest,
        reviewPrivateSource: request => reviewPrivateActionSourceForModel({ request, inspection: actionInspection!,
          session: input.session, modelLabel: boundaryModelLabel(modelAssistSession!),
          assertCurrent: async () => {
            const fresh = await loadBoundaryReviewContext(input.projectRoot);
            const lock = await loadGenerationLockSnapshot(input.projectRoot, request.context.readBoundary.generation_lock_fingerprint);
            if (explorationBoundaryCandidateDigest(fresh.candidate) !== request.context.readBoundaryDigest
              || lock.schema_fingerprint !== schemaFingerprintForInspection(actionInspection!)) {
              throw new Error("ACTION_RULE_REVISION_STALE: The Read draft changed during private source review. Recheck the saved draft; no authority changed.");
            }
          },
        }),
        reservedOutcomes: semanticActionAuthorityDraft!.authority.rules.map((other) => other.rule.outcome)
          .filter((outcome) => outcome !== before.rule.outcome),
        egressAcknowledged: true, askClarification: async (question) => {
          await chat.streamModel([question]);
          const answer = await chat.readOperator?.();
          if (answer?.trim()) {
            rememberModelAuthoringClarification(authoringConversation, question, answer);
            await persistAuthoringResume("authority_review");
          }
          return answer;
        },
      }));
      if (revised.compiled.rule.outcome !== before.rule.outcome) throw new Error("The revision must preserve this exact outcome. No duplicate or active authority was changed.");
      if (canonicalJsonDigest(before.draft) === canonicalJsonDigest(revised.compiled.draft)) {
        pendingActionRevision = undefined;
        await persistAuthoringResume("authority_review");
        return false;
      }
      const diff = semanticActionRevisionDiffLines(before.draft, revised.compiled, revised.revision?.changed_phases ?? []);
      if (revised.message) await chat.streamModel(revised.message.split(/\r?\n/u));
      // The operator already requested this disabled revision. Validate and save
      // it here; enabling the replacement remains an explicit later decision.
      chat.rememberDetails("Exact Action revision", [
        ...diff, "Before:", ...JSON.stringify(before.draft, null, 2).split("\n"),
        "After:", ...JSON.stringify(revised.compiled.draft, null, 2).split("\n"),
      ]);
      const saved = await actionRuleAuthorityDraftFromCompiled(input.projectRoot, revised.compiled, undefined, {
        nextBoundary: context.candidate,
        inspection: actionInspection!,
      });
      const nextCatalog = buildActionRuleAuthoringCatalog({ boundary: context.candidate, inspection: actionInspection!, retainedCatalog: saved.authority.catalog });
      const revalidated = semanticActionDrafts.map(item => ({ item, result: item === entry ? revised : item.result,
        compiled: compileActionRuleModelDraft({ draft: item === entry ? revised.compiled.draft : item.result.compiled.draft,
          builtCatalog: nextCatalog, readBoundary: context.candidate, readBoundaryDigest: committed.candidate_digest }),
      }));
      await saveSemanticActionDraft(saved);
      for (const item of revalidated) {
        item.item.result = { ...item.result, compiled: item.compiled };
        item.item.catalog = nextCatalog;
      }
      semanticActionAuthorityDraft = saved;
      semanticActionModelResult = semanticActionDrafts.at(-1)!.result;
      semanticActionModelDraft = semanticActionModelResult.compiled.draft;
      await writeCurrentDelegationDraft();
      pendingActionRevision = undefined;
      await persistAuthoringResume("authority_review");
      chat.checkpoint("Draft updated", renderRunnerResultPanel({
        result: "Your requested change is saved for review.",
        checked: "The revised rules compile against the reviewed database information.",
        changed: "Only this draft. Other actions, active permissions and customer data are unchanged.",
        notChecked: "Live execution of a customer request.", next: "Review the updated settings. /details has the complete change.",
      }, terminalContentWidth(input.session.terminalColumns ?? process.stdout.columns) - 4));
      return true;
    } catch (error) {
      assertRunning(error);
      const diagnostic = redactCliErrorMessage(error instanceof Error ? error.message : String(error));
      chat.rememberDetails("ACTION REVISION NOT SAVED", [diagnostic, "The existing draft and active authority are unchanged."]);
      chat.checkpoint("Action revision needs attention", [diagnostic, "The draft is preserved. Continue with the model or inspect /details; no new job is needed."], "warning");
      return false;
    }
  };
  const inspectAttachedRules = async (current: NonNullable<Awaited<ReturnType<typeof ensurePolicyCoverage>>>) => {
    const chat = input.authoringChat!;
    if (!current.report) {
      await chat.session.showReviewDetails?.("RULES CHECK DETAILS", [
        `Rules: ${current.source.name} v${current.source.version}`,
        `Source fingerprint: ${current.source.digest}`,
        "The model's coverage check did not finish; this is not an accepted review.",
        policyFailure ?? "No valid coverage report was returned.",
        "The same draft and complete rules remain saved. Viewing this record makes no model request and changes no authority.",
        "Return to the pending review for one explicit bounded retry. /rules remains available to inspect the saved source.",
      ]);
    } else {
      const section = policyCoverageSection(current.source, current.report, current.draftRecord);
      if (chat.session.showReviewSections) await chat.session.showReviewSections(section.title, section.children ?? [section]);
      else await chat.session.showReviewDetails?.(section.title, reviewSectionLines(section));
    }
  };
  const reviewAttachedRules = async (inspect = false): Promise<boolean> => {
    if (!activePolicySource(authoringConversation?.policySources)) return true;
    if (!input.authoringChat || !modelAssistSession) return false;
    const current = await ensurePolicyCoverage();
    if (!current) return false;
    if (inspect) await inspectAttachedRules(current);
    else if (!policyReviewReadiness(current.source, current.report, authoringConversation?.policySources).ready) {
      await resolveRequirements(true);
    }
    const checked = await ensurePolicyCoverage();
    const ready = Boolean(checked && policyReviewReadiness(checked.source, checked.report, authoringConversation?.policySources).ready);
    return ready;
  };
  let actionAdditionQueued = false;
  const missingActionCanBeAdded = (passages: PolicyCoverage["passages"]) => passages.some((passage) =>
    passage.responsibility === "runner"
    && !referencesReadPolicy(passage)
    && !passage.field_checks?.length
    && !passage.counter_requirements?.length
    && !passage.application_obligations?.length
    && !passage.deployment_prerequisite
    && passage.draft_paths.some((pointer) => pointer === "/actions" || pointer === "/runner_evidence/actions"));
  const queueMissingAction = async (
    current: NonNullable<Awaited<ReturnType<typeof ensurePolicyCoverage>>>,
    passages: PolicyCoverage["passages"],
  ): Promise<boolean> => {
    const source = activePolicySource(authoringConversation?.policySources);
    if (!source || !resumeAction || source.digest !== current.source.digest || current.report?.source_digest !== source.digest) {
      input.authoringChat?.checkpoint("Missing behavior needs its saved policy context", [
        "Runner could not bind this request to the exact saved policy and existing Action identities.",
        "No new Action was inferred and all current authority remains unchanged.",
      ], "warning");
      return false;
    }
    const sourceRanges = [...new Map(passages.map((passage) => [`${passage.start}:${passage.end}`, {
      start: passage.start, end: passage.end,
    }])).values()];
    if (!sourceRanges.length || sourceRanges.some((range) => range.end > source.lines)) return false;
    const addition: BoundaryAuthoringActionAddition = {
      policy_source_digest: source.digest as `sha256:${string}`,
      source_ranges: sourceRanges,
      retained_action: structuredClone(resumeAction),
    };
    pendingActionAddition = addition;
    pendingJobRevision = pendingActionAdditionInstruction(addition);
    actionAdditionQueued = true;
    await persistAuthoringResume("planning");
    if (resumePersistenceBlocked) return false;
    input.authoringChat?.checkpoint("Missing behavior saved for planning", [
      `Cited policy source lines: ${sourceRanges.map((range) => `${range.start}-${range.end}`).join(", ")}.`,
      "Runner will continue this same job with one new disabled Action draft. Existing Read access and Actions remain unchanged until separate review.",
    ]);
    return true;
  };
  const selectPolicyAction = async (current: NonNullable<Awaited<ReturnType<typeof ensurePolicyCoverage>>>, passages: PolicyCoverage["passages"]) => {
    if (!current.report) return undefined;
    const targets = policyCoverageActionTargets({ report: current.report, draft: current.draftRecord, passages,
      editableOutcomes: semanticActionDrafts.map((entry) => entry.result.compiled.rule.outcome) });
    const includesRead = Boolean(reviseReadWithModel && passages.some(referencesReadPolicy));
    const canAddMissing = targets.referenced.length === 0 && missingActionCanBeAdded(passages);
    let outcome = targets.editable.length === 1 && !includesRead ? targets.editable[0] : undefined;
    if ((includesRead || targets.editable.length > 1 || canAddMissing) && input.session.chooseOption) {
      outcome = await input.session.chooseOption(includesRead ? "CHOOSE WHAT TO REVISE" : "CHOOSE THE ACTION TO REVISE", [
        ...(includesRead ? [{ value: "@read_requirement", label: "Who can see information", detail: "Resolve the Read part of this requirement; preserve all change rules and their approval limits." }] : []),
        ...targets.editable.map((value) => ({ value, label: value, detail: "Prepare a disabled revision of this exact outcome; preserve the other outcomes." })),
        ...(canAddMissing ? [{ value: "@add_missing", label: "Add missing behavior", detail: "Plan one new disabled Action from this cited policy requirement; preserve existing Read access and Actions." }] : []),
        { value: "back", label: "Keep these rules pending" },
      ], { initialValue: "back", reviewOnly: true, context: [
        includesRead ? "This requirement affects both access to information and permitted changes. Choose which part to resolve first; the other requirements stay pending."
          : canAddMissing ? "This cited requirement has no existing Action outcome. Add only one disabled Action from these exact policy lines; existing Read access and Actions stay unchanged."
          : "The coverage report references more than one outcome. References alone do not authorize revising every outcome.",
        ...passages.map((passage) => passage.interpretation),
      ] });
      if (!outcome || outcome === "back") {
        await persistAuthoringResume("authority_review");
        throw new AskError("ASK_CANCELLED", "Saved rules review paused; no further model check was requested.", 499);
      }
      if (outcome === "@read_requirement") return "read" as const;
      if (outcome === "@add_missing") return "add" as const;
    }
    if (!outcome || !targets.editable.includes(outcome)) {
      if (targets.referenced.length) input.authoringChat?.checkpoint("Action requirement still pending", [
        `Referenced outcomes: ${targets.referenced.join(", ")}.`,
        targets.editable.length ? "No Action revision was selected. The saved rules and current authority are unchanged."
          : "These outcomes are retained, not editable entries in this job. Recheck the report or explicitly reopen the named outcome for a separate disabled revision; no other Action was selected.",
      ], "warning");
      return undefined;
    }
    return semanticActionDrafts.find((entry) => entry.result.compiled.rule.outcome === outcome);
  };
  const reviseSharedReadRequirement = async (passages: PolicyCoverage["passages"], answer?: string) => {
    if (!reviseReadWithModel) return;
    const requiresCurrentStatePrerequisite = passages.some((passage) => passage.draft_paths.some((pointer) =>
      pointer === "/runner_evidence/runtime_contract/read_eligibility/configured_current_state_prerequisite"
      || pointer.startsWith("/runner_evidence/runtime_contract/read_eligibility/configured_current_state_prerequisite/")));
    const changed = await reviseReadWithModel([
      "The operator selected the Read part of this shared requirement. Resolve only who may see information, using the already supplied policy and answers. Preserve every Action rule, approval limit and execution intention; unresolved Action conditions remain pending.",
      ...passages.map(passage => `Source lines ${passage.start}-${passage.end}: ${passage.interpretation}`),
      ...(answer ? [`Operator clarification: ${answer}`] : []),
      ...(requiresCurrentStatePrerequisite
        ? ["For this separately required current-state access condition, request host-mediated private evidence review. Do not expose its rows, infer eligibility from authentication, or replace a missing Read condition with an Action predicate."]
        : ["Do not infer a separate current-state access condition from signed-in identity, current records, customer scope, field meaning, or privacy. Preserve any already reviewed condition unchanged."]),
    ].join("\n"), undefined, { generalReadRestriction: true });
    if (changed) await ensurePolicyCoverage();
  };
  let automaticPrivacyAttempt: string | undefined;
  let modelPrivacyRepairAttempt: string | undefined;
  let modelActionRepairAttempt: string | undefined;
  const reconcileKnownPrivacy = async (clarifiedFields?: ReadonlySet<string>) => {
    const current = await ensurePolicyCoverage();
    if (!current?.report || !reviseReadWithModel || automaticPrivacyAttempt === current.key) return;
    const changes = knownPolicyPrivacyReductions({ report: current.report, read: context.candidate,
      clarifiedFields,
      actions: semanticActionDrafts.map((entry) => entry.result.compiled) });
    if (!changes.length) return;
    automaticPrivacyAttempt = current.key;
    const repaired = await reviseReadWithModel("Apply the attached policy's established privacy restrictions; retain all existing exclusions and business-facing fields.", {
      changes, provider: modelAssistSession!.provider, model: modelAssistSession!.model,
      model_exposure_expansions: 0, correction_used: false, authority_granted: false,
      source_query_executed: false, explore_budget_consumed: false, source_database_changed: false,
    });
    if (repaired) {
      const checked = await ensurePolicyCoverage();
      // One mechanical repair per candidate; no recursive rewriting until a
      // model claims success. Remaining contradictions stay blocking.
      automaticPrivacyAttempt = checked?.key;
    }
  };
  const resolveRequirements = async (explicitRetry = false) => {
    if (explicitRetry) { modelPrivacyRepairAttempt = undefined; modelActionRepairAttempt = undefined; }
    const chat = input.authoringChat;
    if (!chat?.readOperator || !modelAssistSession) return;
    let current = await ensurePolicyCoverage();
    let retriedCoverage = false;
    // Choosing Resolve authorizes this bounded recheck. Do not ask the user to
    // navigate a second retry screen for the same operation.
    if (!current?.report && explicitRetry) {
      current = await ensurePolicyCoverage(true);
      retriedCoverage = true;
    }
    if (!current?.report) {
      chat.checkpoint("Rules check could not finish", [
        policyFailure ?? "No valid coverage result was returned.",
        "Retry is available from Continue with the model. The exact draft and rules remain saved; /details has diagnostics.",
      ], "warning");
      return;
    }
    await reconcileKnownPrivacy();
    current = await ensurePolicyCoverage();
    if (!current?.report) return;
    let pending = policyReadinessItems(current.report, authoringConversation?.policySources).filter((item) => item.blocksReview);
    if (pending.some((item) => item.passages.some(isMechanicalApprovalCounterPassage))) {
      // Counter references need mechanical reconciliation, not a new business
      // choice or a rule edit based on an untrusted model's grouping claim.
      if (explicitRetry && !retriedCoverage) {
        current = await ensurePolicyCoverage(true);
        if (!current?.report) return;
        pending = policyReadinessItems(current.report, authoringConversation?.policySources).filter((item) => item.blocksReview);
      }
      const counters = pending.flatMap((item) => item.passages.filter(isMechanicalApprovalCounterPassage));
      if (counters.length) {
        chat.rememberDetails("APPROVAL COUNTER REVIEW PENDING", counters.flatMap((passage) => [
          `Source lines ${passage.start}-${passage.end}: ${passage.interpretation}`, passage.next_step ?? "",
        ]));
        pending = actionablePolicyRequirements(pending);
        if (!pending.length) chat.checkpoint("Approval counter evidence needs reconciliation", [
          "The report still disputes the prepared counter selectors. Limit IDs are diagnostic labels, not separate pools.",
          "No business answer or Action edit is inferred from that claim. Inspect the exact rules and selector evidence, retry the bounded check, or pause this saved job.",
        ], "warning");
        if (!pending.length) return;
      }
    }
    if (!pending.length) return;
    pending = prioritizePolicyRepairs(pending);
    // A cited /actions requirement with no existing semantic outcome is not a
    // revision of a retained rule and does not need a made-up clarification.
    // Let the exact target resolver offer its bounded create route before the
    // generic mechanical-repair branch. It still refuses any association,
    // counter, field, Read, deployment, or application requirement.
    const missingAction = pending.find((item) => missingActionCanBeAdded(item.passages));
    if (missingAction) {
      const entry = await selectPolicyAction(current, missingAction.passages);
      if (entry === "add") await queueMissingAction(current, missingAction.passages);
      return;
    }
    let business = pending.find((item) => item.kind === "business_decision");
    if (business) {
      // Group independent Read privacy meanings into one answer/revision. Do
      // not accidentally route unrelated Action decisions through that editor.
      const privacyQuestion = (item: typeof business) => item?.passages.every((passage) =>
        passage.field_checks?.length && passage.field_checks.every((field) => field.expectation === "private"));
      if (privacyQuestion(business)) {
        const group = pending.filter((item) => item.kind === "business_decision" && privacyQuestion(item)).slice(0, 3);
        business = { ...business, title: group.map((item) => item.title).join("; "), passages: group.flatMap((item) => item.passages) };
      }
      const exactQuestions = [...new Set(business.passages.map((passage) => passage.next_step ?? passage.interpretation))];
      chat.rememberDetails("PENDING BUSINESS DECISION", [business.title, ...exactQuestions,
        "The saved draft is unchanged. Answering clarifies meaning; any permission change is validated separately."]);
      const question = await (input.modelAuthoringNarrator ?? narrateValidatedAuthoringStep)({
        session: modelAssistSession, operatorMessage: "Ask only these unresolved business choices together, with their purpose and suggested answers; do not repeat the saved action summary.",
        validatedFacts: business.passages.map((passage) => passage.interpretation),
        nextQuestion: exactQuestions.join("\n"), responseStyle: "business_questions", egressAcknowledged: true,
      }).catch(() => undefined);
      const questions = question ? question.split(/\r?\n/u) : exactQuestions;
      await chat.streamModel(questions);
      let answer = await chat.readOperator();
      let explanationTurns = 0;
      while (answer?.trim() && isBoundaryAuthoringExplanationQuestion(answer)) {
        if (explanationTurns++ >= 2) {
          chat.checkpoint("Business decision still pending", ["Answer the question, inspect /details, or press Esc to pause. No setting has changed."]);
          answer = await chat.readOperator();
          continue;
        }
        const explanation = await (input.modelAuthoringNarrator ?? narrateValidatedAuthoringStep)({
          session: modelAssistSession, operatorMessage: answer, egressAcknowledged: true,
          validatedFacts: business.passages.map((passage) => passage.interpretation),
          nextQuestion: questions.join("\n"),
        }).catch(() => undefined);
        if (explanation) await chat.streamModel(explanation.split(/\r?\n/u));
        else chat.checkpoint("Explanation unavailable", ["The pending question is unchanged. Exact details remain available; answer it or pause safely."], "warning");
        answer = await chat.readOperator();
      }
      if (!answer?.trim()) return;
      rememberModelAuthoringClarification(authoringConversation, questions.join("\n"), answer.trim());
      await persistAuthoringResume("authority_review");
      if (reviseReadWithModel && (business.passages.every(isReadOnlyPolicyPassage)
        || business.passages.some((passage) => passage.field_checks?.some((field) => field.expectation === "private")))) {
        await reviseReadWithModel([
          "Resolve only this Read requirement in the disabled draft, using the operator's answer. Preserve customer-facing information unless its restriction is requested. Existing related-only access can remove independent queries without adding scope or private Action grants.",
          ...exactQuestions, `Operator answer: ${answer.trim()}`,
          "Preserve every existing exclusion and Read-selection grant, business-facing information, all Action rules and execution intent. Do not add access.",
        ].join("\n"), undefined, { interpretationInstruction: answer.trim(),
          generalReadRestriction: !business.passages.some((passage) => passage.field_checks?.length) });
      } else {
        const entry = await selectPolicyAction(current, business.passages);
        if (entry === "read") await reviseSharedReadRequirement(business.passages, answer.trim());
        else if (entry === "add") {
          await queueMissingAction(current, business.passages);
          return;
        }
        else if (entry) await revisePolicyAction(entry, [
            "Apply this clarified business requirement to the same disabled action. Preserve other rules and execution intent.",
            ...exactQuestions, `Operator answer: ${answer.trim()}`,
          ].join("\n"));
      }
      await ensurePolicyCoverage();
      // Recheck the actual candidate, not merely whether the answer sounds compliant.
      await reconcileKnownPrivacy();
      return;
    }
    const clientItems = pending.filter((item) => item.kind === "deployment_prerequisite"
      && item.passages.every((passage) => passage.application_obligations?.length));
    if (clientItems.length && input.session.chooseOption) {
      const passages = clientItems.flatMap((item) => item.passages);
      const clientFacts = authoringClientSetupFacts(intendedClient);
      chat.rememberDetails("CLIENT SETUP PLAN", clientFacts);
      const selectedClient = intendedClient && intendedClient !== "later";
      if (!selectedClient) await chat.streamModel([
        ...(intendedClient && intendedClient !== "later" ? [clientFacts[0]!] : []),
        `Your client needs to ${[...new Set(passages.flatMap((passage) => passage.application_obligations ?? []))]
          .map((duty) => duty === "customer_selection" ? "capture the user's selected record and requested change"
            : "show whether the request is awaiting review, approved, waiting for execution, blocked, or completed with a receipt").join(" and ")}.`,
        "Will your client handle this? Assignment is not verification; test the integration before customer use. Runner keeps enforcing the database rules.",
        ...(intendedClient && intendedClient !== "later" ? ["Next, after authority review: generated client configuration, trusted test identity, and a connection check. /details explains the setup and behavior checks."] : []),
      ]);
      const choice = selectedClient ? "assign" : await input.session.chooseOption("CLIENT INTEGRATION RESPONSIBILITIES", [
        { value: "assign", label: intendedClient && intendedClient !== "later" ? `Use ${authoringClientLabel(intendedClient)} for these client duties` : "My client application will handle these responsibilities", detail: "Record the assignment for this exact draft; keep client verification outstanding." },
        { value: "ask", label: "Ask the model about the integration" },
        { value: "back", label: "Keep this decision pending" },
      ], { initialValue: "back", reviewOnly: true, explainOnRequest: true,
        context: [...clientFacts, ...passages.flatMap((passage) => [passage.topic ?? "Client responsibility", passage.next_step ?? passage.interpretation])],
      });
      if (choice === "ask") {
        await chat.streamModel(["What would you like to know about the client integration?"]);
        const question = await chat.readOperator();
        if (question?.trim()) {
          const response = await (input.modelAuthoringNarrator ?? narrateValidatedAuthoringStep)({
            session: modelAssistSession, operatorMessage: question, egressAcknowledged: true,
            validatedFacts: [...clientFacts, ...passages.map((passage) => passage.interpretation)],
            nextQuestion: "Do you want to assign these integration duties to your client, or leave them pending?",
          }).catch(() => undefined);
          if (response) await chat.streamModel(response.split(/\r?\n/u));
          else chat.checkpoint("Integration explanation unavailable", ["Exact responsibilities remain visible. The decision is unchanged; retry or inspect /details."], "warning");
        }
        return;
      }
      if (choice !== "assign") return;
      const sources = authoringConversation?.policySources;
      if (!sources) return;
      sources.application_assignments = [
        ...(sources.application_assignments ?? []).filter((entry) => entry.source_digest === current!.report!.source_digest
          && entry.draft_digest === current!.report!.draft_digest
          && !passages.some((passage) => passage.start === entry.start && passage.end === entry.end)),
        ...passages.map((passage) => ({ source_digest: current!.report!.source_digest, draft_digest: current!.report!.draft_digest,
          start: passage.start, end: passage.end, obligations: [...passage.application_obligations!],
          assigned_at: new Date().toISOString(), owner: "client_application" as const, verified: false as const })),
      ];
      await savePolicySources(input.projectRoot, sources);
      await persistAuthoringResume("authority_review");
      if (!selectedClient) chat.checkpoint("Client responsibilities recorded", ["Assigned, not verified. Check these behaviors before customer use. No database permissions or rules changed."]);
      else chat.rememberDetails("CLIENT SETUP PLAN", [...clientFacts,
        "The already selected client is assigned record selection and request-status display. These behaviors are not yet verified; no database permissions changed."]);
      return;
    }
    let item = pending[0]!;
    if (item.kind === "mechanical_correction") {
      if (reviseReadWithModel && item.passages.every(isReadOnlyPolicyPassage)
        && !item.passages.some((passage) => passage.field_checks?.length)) {
        if (modelPrivacyRepairAttempt === current.key) return;
        modelPrivacyRepairAttempt = current.key;
        const changed = await reviseReadWithModel([
          "Implement this already supplied Read restriction in the disabled draft. Do not ask the operator to debug generated permissions.",
          ...item.passages.map((passage) => `Source lines ${passage.start}-${passage.end}: ${passage.interpretation}`),
          "Use existing reviewed paths and narrowing settings. For a required current-state access condition, request the supported host-mediated private evidence review; do not expose that source or infer the fact from authentication. To allow related information only through permitted customer records, remove independent queries with relationship_only=true, retaining the reviewed customer-scoped root paths. Preserve all fields, exclusions, trusted scope and Action rules, limits and execution intent. Explain missing paths or evidence instead of inventing access.",
        ].join("\n"), undefined, { generalReadRestriction: true });
        // An unchanged or refused repair is not evidence that the report is
        // correct. Reconcile once against the same exact draft, never mark it
        // resolved merely because the revision model declined to change it.
        const checked = await ensurePolicyCoverage(!changed);
        modelPrivacyRepairAttempt = checked?.key;
        return;
      }
      if (reviseReadWithModel
        && item.passages.some((passage) => passage.field_checks?.some((field) => field.expectation === "private"))) {
        // Evidence may cite Action dependencies, but a Read privacy mismatch is
        // not an Action edit. Coverage already used its bounded recheck, so
        // repair the identified mismatch instead of repeating that model call.
        if (modelPrivacyRepairAttempt === current.key) return;
        modelPrivacyRepairAttempt = current.key;
        await reviseReadWithModel([
          "Resolve only this established Read privacy mismatch using the approved source and recorded operator answers.",
          ...item.passages.map((passage) => `Source lines ${passage.start}-${passage.end}: ${passage.interpretation}`),
          "Preserve confirmed customer-facing dates, existing exclusions and Read selection, all Action rules, approval limits and execution intent. Do not add access. Ask only if a new business meaning is genuinely unresolved.",
        ].join("\n"));
        await ensurePolicyCoverage();
        return;
      }
      if (!retriedCoverage) await ensurePolicyCoverage(true);
      await reconcileKnownPrivacy();
      const checked = await ensurePolicyCoverage();
      if (!checked?.report) return;
      const next = policyReadinessItems(checked.report, authoringConversation?.policySources)
        .find((entry) => entry.blocksReview && entry.title === item.title);
      if (!next || next.passages.some(isMechanicalApprovalCounterPassage)) return;
      current = checked;
      item = next;
      if (modelActionRepairAttempt === current.key) return;
      modelActionRepairAttempt = current.key;
      const entry = await selectPolicyAction(current, item.passages);
      if (entry === "read") {
        await reviseSharedReadRequirement(item.passages);
      } else if (entry === "add") {
        await queueMissingAction(current, item.passages);
      } else if (entry) {
        await revisePolicyAction(entry, [
          "Implement this already supplied business requirement in the same disabled action. Do not ask the operator to repair generated permissions or repeat consent for a draft change.",
          ...item.passages.map((passage) => `Recorded requirement at lines ${passage.start}-${passage.end}: ${passage.interpretation}`),
          ...item.passages.flatMap((passage) => (passage.counter_requirements ?? []).map((check) =>
            `Validated current history filter at ${check.path}: ${JSON.stringify(check.current_capability)}. The source-required filter is ${JSON.stringify(check.required_capability)}. Revise that existing limit's capability selector, preserving its maximum, window, trusted scope and all unrelated limits. Never rename diagnostic IDs as a substitute.`)),
          "Preserve all other rules, approval limits and requested execution. If success requires changing and consuming related records together, use supported atomic_updates; do not replace consumption with plan mismatch or split requests. If an exact version-guarded field or relationship is unavailable, explain that concrete prerequisite. Activation and writer authorization remain separate.",
        ].join("\n"));
        const rechecked = await ensurePolicyCoverage();
        modelActionRepairAttempt = rechecked?.key;
      }
      return;
    }
    chat.rememberDetails(item.title, item.passages.flatMap((passage) => [
      `Source lines ${passage.start}-${passage.end}: ${passage.interpretation}`, passage.next_step ?? "",
    ]));
    // Work in the same draft: diagnose a concrete blocker in chat and offer a
    // bounded revision, instead of sending the operator through evidence menus.
    const explanation = await (input.modelAuthoringNarrator ?? narrateValidatedAuthoringStep)({
      session: modelAssistSession, operatorMessage: "Help resolve this saved requirement without repeating the job.",
      validatedFacts: item.passages.map((passage) => passage.interpretation),
      nextQuestion: item.nextStep, egressAcknowledged: true,
    }).catch(() => undefined);
    await chat.streamModel(explanation?.trim().split(/\r?\n/u) ?? [item.title, item.nextStep]);
    const answer = await chat.readOperator();
    if (!answer?.trim()) return;
    rememberModelAuthoringClarification(authoringConversation, item.nextStep, answer.trim());
    await persistAuthoringResume("authority_review");
    if (isBoundaryAuthoringExplanationQuestion(answer)) return;
    if (reviseReadWithModel && item.passages.every(isReadOnlyPolicyPassage)) {
      const changed = await reviseReadWithModel([
        "Resolve this required Read condition using the operator's source explanation. Preserve the original policy, visible information, trusted scope and all Action rules.",
        ...item.passages.map((passage) => `Source lines ${passage.start}-${passage.end}: ${passage.interpretation}`),
        `Operator clarification: ${answer}`,
        "For current eligibility before every read, request host-mediated private evidence review. If the source or supported enforcement is missing, keep setup pending; do not substitute authentication or an Action predicate.",
      ].join("\n"), undefined, { interpretationInstruction: answer.trim(), generalReadRestriction: true });
      if (changed) await ensurePolicyCoverage();
      return;
    }
    const entry = await selectPolicyAction(current, item.passages);
    if (entry === "read") {
      await reviseSharedReadRequirement(item.passages, answer.trim());
      return;
    }
    if (entry === "add") {
      await queueMissingAction(current, item.passages);
      return;
    }
    const changed = entry && await revisePolicyAction(entry, [
        "Resolve this source requirement in the same disabled action. Preserve all other business rules, approval limits and requested execution.",
        ...item.passages.map((passage) => `Source lines ${passage.start}-${passage.end}: ${passage.interpretation}`),
        `Operator clarification: ${answer}`,
      ].join("\n"));
    if (changed) await ensurePolicyCoverage();
  };
  const reviewActiveActionRules = async (): Promise<boolean> => {
    if (!activePolicySource(authoringConversation?.policySources)) return true;
    while (true) {
      const current = await ensurePolicyCoverage();
      if (!current) return false;
      const readiness = policyReviewReadiness(current.source, current.report, authoringConversation?.policySources);
      if (readiness.ready) return true;
      if (!input.session.chooseOption) return false;
      const choice = await input.session.chooseOption("FINISH ATTACHED RULES REVIEW", [
        { value: "resolve", label: current.report ? "Continue with the model" : "Retry the rules check",
          detail: "One bounded reconciliation of this saved draft. No activation while requirements remain unresolved." },
        { value: "details", label: "Inspect the saved rules check", detail: "Exact evidence and available diagnostics; no model request." },
        { value: "pause", label: "Pause this saved job", detail: "Keep current authority unchanged and resume from this review later." },
      ], { initialValue: "pause", reviewOnly: true, displayContext: true, context: [
        ...readiness.summary, ...(!current.report && policyFailure ? [policyFailure] : []),
        "Each coverage check allows at most two review attempts; provider requests time out after 120 seconds. Esc pauses safely.",
      ] });
      if (choice === "details") await inspectAttachedRules(current);
      else if (choice === "resolve") await resolveRequirements(true);
      else return false;
    }
  };
  const pauseAttachedRules = async (): Promise<BoundaryAssistOutcome> => {
    await persistAuthoringResume("authority_review");
    const notice: BoundaryAccessNotice = { tone: "warning", title: "Attached rules review paused.",
      lines: ["The draft, complete rules and available check evidence remain saved. Existing authority and source data are unchanged."],
      footer: "Resume this saved job to continue its guided rules review." };
    input.authoringChat?.checkpoint(notice.title, notice.lines, "warning");
    return { ...boundaryAssistResult(notice, false, false, Boolean(input.authoringChat)), navigation: "pause" };
  };
  if (!readBoundaryActive && reviseReadWithModel) {
    const gaps = exploreBoundaryVocabularyGaps(context.candidate.pack.resources);
    if (gaps.length) await reviseReadWithModel([
      "Finish the missing reviewed vocabulary in this same disabled draft before activation.",
      "Resolve only opaque model-facing names that currently lack a reviewed label or description in the catalog.",
      "Use the operator's already supplied business meanings and retained answers to add concise labels/descriptions. Ask only if a meaning is genuinely missing. Do not ask the operator to navigate a manual editor.",
      "This is a metadata-only repair: preserve all field exposure, operations, exclusions, trusted scope, Action business rules, shared approval limits and execution intent. No authority is activated by this repair.",
    ].join("\n"), undefined, { vocabularyOnly: true });
  }
  if (pendingActionRevision) {
    const entry = semanticActionDrafts.find(item => item.result.compiled.rule.outcome === pendingActionRevision!.outcome);
    if (!entry) {
      input.authoringChat?.checkpoint("Saved edit needs its original action", [
        "The draft being edited is no longer in this job. Your request is retained; no other action will be substituted.",
      ], "warning");
      return pauseAttachedRules();
    }
    await revisePolicyAction(entry, pendingActionRevision.instruction);
    if (pendingActionRevision) return pauseAttachedRules();
  }
  // Preparing the explicitly requested disabled configuration is mechanical.
  // It must precede coverage, not look like an unmet business requirement.
  try { await prepareRequestedExecution(); }
  catch (error) {
    input.authoringChat?.checkpoint("Execution preparation needs attention", [
      redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
      "Execution is not enabled. The authority review keeps this requirement pending.",
    ], "warning");
  }
  await reconcileKnownPrivacy();
  // Do not let a complete, cited but unbound Action requirement fall through
  // to Read activation. This is the only create recovery: the coverage report
  // must be current, the target resolver must find no existing outcome, and
  // the operator explicitly selects the bounded draft route.
  const citedMissingAction = await ensurePolicyCoverage();
  if (citedMissingAction?.report) {
    const item = policyReadinessItems(citedMissingAction.report, authoringConversation?.policySources)
      .find((candidate) => candidate.blocksReview && missingActionCanBeAdded(candidate.passages));
    if (item) {
      const entry = await selectPolicyAction(citedMissingAction, item.passages);
      if (entry === "add") await queueMissingAction(citedMissingAction, item.passages);
    }
  }
  const continueActionAddition = (): BoundaryAssistOutcome => {
    const notice: BoundaryAccessNotice = { tone: "warning", title: "Planning one cited Action behavior.",
      lines: ["The cited policy request is saved with this same job. Existing Read access and Action authority are unchanged."],
      footer: "Runner will continue to plan and review one disabled Action; activation remains separate." };
    return { ...boundaryAssistResult(notice, false, false, Boolean(input.authoringChat)), navigation: "resume_agent_job" };
  };
  if (actionAdditionQueued) return continueActionAddition();
  // Keep genuine questions in the current conversation. Stop on no progress,
  // refusal or a failed provider check; never spin until a model says ready.
  for (let step = 0; step < 4; step++) {
    const before = await ensurePolicyCoverage();
    if (!before?.report || policyReviewReadiness(before.source, before.report, authoringConversation?.policySources).ready) break;
    const previous = canonicalJsonDigest({ key: before.key, report: before.report,
      assignments: authoringConversation?.policySources?.application_assignments ?? [] });
    await resolveRequirements();
    if (actionAdditionQueued) return continueActionAddition();
    const after = await ensurePolicyCoverage();
    if (!after?.report || previous === canonicalJsonDigest({ key: after.key, report: after.report,
      assignments: authoringConversation?.policySources?.application_assignments ?? [] })) break;
  }
  const modelGuidedReadReviewReady = Boolean(input.authoringChat && modelAssistRecord);
  let writerPreflight: { key: string; summary: string[]; details: string[] } | undefined;
  const draftWriterReadiness = async () => {
    if (!semanticActionAuthorityDraft || !semanticActionDrafts.some((entry) => entry.result.compiled.effect_envelope.writeback.mode === "direct_sql")) return { summary: [], details: [] };
    const key = canonicalJsonDigest({ draft: semanticActionAuthorityDraft.digest, read: context.bundle.candidate_digest,
      credential: process.env.SYNAPSOR_DATABASE_WRITE_URL ?? null });
    if (writerPreflight?.key === key) return writerPreflight;
    try {
      const needsOtherRead = semanticActionAuthorityDraft.authority.rules.some((rule) =>
        rule.read_boundary_name !== context.candidate.pack.name && rule.effect_envelope.writeback.mode === "direct_sql"
          && rule.effect_envelope.writeback.supervised_worker === "allowed");
      const otherReads = needsOtherRead ? (await loadActivatedExplorationBoundaries(input.projectRoot))
        .filter((read) => read.pack.name !== context.candidate.pack.name)
        .map((read) => ({ pack: read.pack, digest: read.activation.digest })) : [];
      const checked = await inspectDraftSemanticWriter({ draft: semanticActionAuthorityDraft,
        reads: [...otherReads, { pack: context.candidate.pack, digest: context.bundle.candidate_digest }],
        engine: context.lock.engine, readUrlEnv: context.lock.source_env, inspect: input.schemaInspector });
      if (!checked) return { summary: [], details: [] };
      if (checked.rls_issues.length) {
        writerPreflight = { key,
          summary: ["Database filtering needs administrator review before these changes can be used. Execution setup provides exact requirements and a recheck; saved rules and current authority stay unchanged."],
          details: checked.rls_issues.map(issue => `${issue.relation}: ${issue.reason}`) };
      } else if (checked.collection_issues.length) {
        writerPreflight = { key,
          summary: ["A required check is not ready: Runner cannot prove the complete set of related customer records used for absence or totals. Review the collection check in exact details and refresh the database review. The saved policy stays intact; adding writer grants alone may not resolve this."],
          details: checked.collection_issues.map(issue => `${issue.relation}: ${issue.reason}`) };
      } else if (checked.writer_status === "not_checked") {
        writerPreflight = { key,
          summary: ["Automatic completion needs a write connection. The saved rules can be reviewed now; execution setup can prepare exact administrator instructions from the read connection, or check an existing writer. Nothing will run until that separate check and your approval."],
          details: [`Inspected metadata through ${checked.inspected_connection_env}; no writer was checked.`,
            "Structural draft support is not proof of database privileges.",
            ...(checked.plan ? ["DRAFT WRITER REQUIREMENTS (no grants executed)", JSON.stringify(checked.plan, null, 2)] : [])] };
      } else if (!checked.assessment.ok) {
        const problem = new SemanticWriterPostureError(checked.assessment, "SYNAPSOR_DATABASE_WRITE_URL", checked.plan);
        writerPreflight = { key,
          summary: ["Execution prerequisite: the configured writer cannot safely complete these changes. An administrator must prepare a dedicated writer; execution setup offers the exact handoff and a recheck without reauthoring. Reads and proposals can still be reviewed."],
          details: [...problem.problem.details, ...(checked.plan ? ["", "DRAFT WRITER GRANTS (administrator review only)", writerProvisioningSql(checked.plan)] : [])] };
      } else writerPreflight = { key,
        summary: ["Writer preflight: configured permissions match the combined draft requirements. The selected per-outcome writer is rechecked during separate execution review; execution is not enabled."],
        details: ["Metadata-only draft writer check passed; no source rows read or changed.",
          `Action revision: ${checked.action_digest}`, `Writer posture: ${checked.assessment.fingerprint}`,
          JSON.stringify(checked.assessment.required_relations, null, 2)] };
    } catch (error) {
      const problem = executionSetupProblem(error);
      writerPreflight = { key, summary: [`Execution prerequisite: ${problem.summary} Read and proposal review can continue; execution remains a separate decision.`], details: problem.details };
    }
    return writerPreflight;
  };
  const preparedSemanticAction = Boolean(semanticActionAuthorityDraft);
  if ((actionDrafts.length || preparedSemanticAction || modelGuidedReadReviewReady)
    && !readBoundaryActive
    && input.completeReadReview) {
    const nextReadReviewDetails = [
      `Read Boundary: ${context.candidate.pack.name}`,
      `Dependent Action drafts: ${actionDrafts.length + semanticActionDrafts.length}`,
      activePolicySource(authoringConversation?.policySources)
        ? "Structured draft prepared. Attached policy coverage and exact authority still need review."
        : retainedActionIsUnfinished()
          ? "These prepared changes are ready for review. The separate unfinished request remains pending; this is not the complete job."
          : "The job draft is complete. Review the exact Read authority now; activation remains your decision.",
      ...(actionDrafts.length || preparedSemanticAction
        ? ["After Read activation, Runner opens each rehearsed Action Boundary revision for its own separate confirmation."]
        : ["This read-only job has no Action Boundary draft. Declining keeps the reviewed Read draft disabled."]),
    ];
    if (input.authoringChat) input.authoringChat.rememberDetails("NEXT AUTHORITY REVIEW - READ BOUNDARY", nextReadReviewDetails);
    else await writeRunner("NEXT AUTHORITY REVIEW - READ BOUNDARY", nextReadReviewDetails);
    const reviewResult = await input.completeReadReview("activate", input.session, {
      businessSummary: () => [...readRevisionRecovery,
        ...semanticActionDrafts.flatMap((entry) => semanticActionBusinessReviewLines(entry.result.compiled, context.candidate))],
      deploymentReadiness: draftWriterReadiness,
      sequenceSummary: () => {
        const automatic = semanticActionDrafts.filter((entry) => entry.result.compiled.effect_envelope.writeback.mode === "direct_sql");
        const missing = unmetExecutionEntries();
        return [
          ...(missing.length
            ? ["UNMET REQUEST: automatic completion is not configured. This draft would only propose changes. Choose Prepare requested automatic execution to retain the rules and prepare a separate execution review."]
            : []),
          `Next: Read review${semanticActionDrafts.length || actionDrafts.length ? " -> Action review" : ""}${automatic.length || missing.length ? ` -> execution review (${missing.length ? "configuration missing" : "prepared, not enabled; worker required"})` : ""} -> ${intendedClient && intendedClient !== "later" ? `${authoringClientLabel(intendedClient)} configuration and launch check` : "client setup"}.`,
          ...(automatic.length || missing.length ? ["Still needed: separately verify and authorize the selected writer during execution setup. Automatic completion also requires trusted runtime identity and a running worker; neither is proved by this Read review."] : []),
        ];
      },
      executionPreparationNeeded: () => unmetExecutionEntries().length > 0,
      confirmedFieldMeanings: (digest) => confirmedReadFieldMeanings(authoringConversation?.policySources, digest),
      privacyEvidence: (boundary) => readPrivacyReview({ boundary, session: authoringConversation?.policySources,
        ...(policyReport && policyReport.key === policyAttemptKey ? { coverage: { report: policyReport.report,
          draft: policyCoverageDraft({ read: context.candidate, decisions: context.bundle.decisions,
            ...(actionInspection ? { source: { inspection: actionInspection, generationLock: context.lock } } : {}),
            actions: semanticActionDrafts.map((entry) => entry.result.compiled), authority: semanticActionAuthorityDraft }) } } : {}),
      }),
      prepareExecution: prepareRequestedExecution,
      ...(reviseReadWithModel ? { reviseWithModel: reviseReadWithModel } : {}),
      reviewChanges: () => latestReadRevisionDiff,
      beforeActivation: reviewAttachedRules,
      ...(activePolicySource(authoringConversation?.policySources) ? { reviewRules: () => reviewAttachedRules(true),
        resolveRequirements: () => resolveRequirements(true),
        readiness: async () => {
          const current = await ensurePolicyCoverage();
          return current ? policyReviewReadiness(current.source, current.report, authoringConversation?.policySources) : { ready: true, privacy: false, summary: [] };
        },
        rulesSummary: async () => {
          const current = await ensurePolicyCoverage();
          return current ? policyCoverageSummary(current.source, current.report) : [];
        },
      } : {}),
      privateDependencies: () => semanticActionDrafts.length
        ? ["Private Action verification is separate from model-facing Read operations. This draft remains subject to separate Action and execution review.",
          ...(writerPreflight?.details ?? []),
          ...semanticActionDrafts.flatMap((entry) => [entry.result.compiled.draft.outcome,
            ...JSON.stringify(entry.result.compiled.draft, null, 2).split("\n")])]
        : ["No dependent semantic Action draft is attached to this review."],
      onDisposition: (disposition) => {
        reviewNavigation = disposition === "manual_editor" ? "manual_editor" : "boundary_list";
      },
    });
    if (reviewResult !== 0) {
      throw new Error("DELEGATION_READ_ACTIVATION_REVIEW_INCOMPLETE: the final Read Boundary review did not complete.");
    }
    readBoundaryActive = await exactReadBoundaryIsActive({
      projectRoot: input.projectRoot,
      boundaryName: context.candidate.pack.name,
      candidateDigest: committed.candidate_digest,
    });
  }
  if (readBoundaryActive && semanticActionAuthorityDraft && semanticActionModelResult) {
    if (!await reviewActiveActionRules()) return pauseAttachedRules();
    if (unmetExecutionEntries().length && input.session.chooseOption) {
      const choice = await input.session.chooseOption("AUTOMATIC COMPLETION IS NOT CONFIGURED", [
        { value: "prepare", label: "Prepare requested automatic execution", detail: "Keep the business rules and approval limits. Prepare a disabled replacement for separate Action and execution review; no writes." },
        { value: "later", label: "Keep execution unconfigured for now", detail: "The request remains unfinished and saved for resume. Approval alone is not completion." },
      ], { initialValue: "later" });
      if (choice === "prepare") {
        await prepareRequestedExecution();
        if (!await reviewActiveActionRules()) return pauseAttachedRules();
      }
    }
    const compiled = semanticActionModelResult.compiled;
    const revisionReview = semanticActionRevisionBaseline
      ? semanticActionRevisionDiffLines(
          semanticActionRevisionBaseline,
          compiled,
          semanticActionModelResult.revision?.changed_phases ?? [],
        )
      : [];
    const priorActivation = await readActionRuleAuthorityActivation(input.projectRoot);
    const requestImpact = await reviewActionRevisionImpact({ projectRoot: input.projectRoot,
      active: priorActivation, draft: semanticActionAuthorityDraft });
    const exactActiveAction = priorActivation?.digest === semanticActionAuthorityDraft.digest
      ? (await loadActiveActionRuleAuthority(input.projectRoot)).activation
      : undefined;
    const executionReReviewOutcomes = priorActivation
      ? executionReReviewOutcomesForActionActivation({ active: priorActivation, draft: semanticActionAuthorityDraft,
        execution: await readSemanticSupervisedExecutionState({ projectRoot: input.projectRoot }) })
      : [];
    const reviewedOutcomes = new Set(semanticActionDrafts.map((entry) => entry.result.compiled.rule.outcome));
    const retainedOutcomeCount = semanticActionAuthorityDraft.authority.rules.filter((entry) => !reviewedOutcomes.has(entry.rule.outcome)).length;
    const approveActivation = exactActiveAction || await (input.session.confirmActivation ?? input.session.confirm)(
      `Activate verified Action Boundary "${semanticActionAuthorityDraft.authority.action_boundary.name}" for ${semanticActionDrafts.map((entry) => entry.result.compiled.rule.outcome).join(", ")}?`,
      {
        exactDetails: { title: "EXACT ACTION BOUNDARY", summaryTitle: "ACTION REVIEW",
          sections: [...(requestImpact.length ? [{ id: "pending_requests", title: "Existing requests and rule replacement", lines: requestImpact }] : []),
            ...verifiedActionAuthoritySections(semanticActionAuthorityDraft,
              terminalContentWidth(input.session.terminalColumns ?? process.stdout.columns) - 2)],
          lines: [...requestImpact, ...verifiedActionAuthorityDetails(semanticActionAuthorityDraft,
            terminalContentWidth(input.session.terminalColumns ?? process.stdout.columns) - 2)] },
        context: [
          `This revision contains ${semanticActionAuthorityDraft.authority.rules.length} outcomes; ${retainedOutcomeCount} retained. View exact details > All reviewed outcomes lists all.`,
          ...(revisionReview.length ? ["REVIEWED REPLACEMENT", ...revisionReview, ""] : []),
          ...requestImpact.slice(0, 3),
          ...semanticActionDrafts.flatMap((entry) => [
            ...semanticActionActivationReviewLines(entry.result.compiled, context.candidate,
              terminalContentWidth(input.session.terminalColumns ?? process.stdout.columns) - 2),
          ]),
          ...(executionReReviewOutcomes.length ? [
            `EXECUTION RE-REVIEW AFTER ACTIVATION: ${executionReReviewOutcomes.join(", ")}.`,
            "This complete Action Boundary digest changes. Existing supervised execution for those outcomes will not carry forward; Runner will request separate writer review for each after proposal activation.",
          ] : []),
          "This gate activates proposal authority only. It does not approve, apply, or write source data.",
          "/details shows the exact immutable authority and digest.",
        ],
      },
    );
    if (approveActivation) {
      const activated = exactActiveAction ? { activation: exactActiveAction } : await activateSemanticActionRuntime({
        projectRoot: input.projectRoot,
        ...(input.baseConfigPath ? { baseConfigPath: input.baseConfigPath } : {}),
        draft: semanticActionAuthorityDraft,
        actor: localInteractiveActor(),
      });
      semanticActionActivation = activated.activation;
      if (!exactActiveAction) await input.authoringChat?.streamCheckpoint("Verified Action Boundary active", renderReviewFacts([
        ...semanticActionDrafts.map((entry): [string, string] => ["Action", `${entry.result.compiled.rule.outcome.split(".").at(-1)!.replaceAll("_", " ")} (${entry.result.compiled.rule.outcome})`]),
        ["Authority granted", "Submit reviewed proposals only (proposal authority only)"],
        ["Database execution", "Not enabled by this activation; separate execution review follows"],
        ["Customer data", "Unchanged"],
      ], terminalContentWidth(input.session.terminalColumns ?? process.stdout.columns) - 2), "success");
      const executionReviewOutcomes = [...new Set([
        ...executionReReviewOutcomes,
        ...activated.activation.authority.rules
          .filter((candidate) => candidate.effect_envelope.writeback.mode === "direct_sql"
            && candidate.effect_envelope.writeback.supervised_worker === "allowed")
          .map((candidate) => candidate.rule.outcome),
      ])];
      for (const outcome of executionReviewOutcomes) {
        const activeReads = await loadActivatedExplorationBoundaries(input.projectRoot);
        const currentExecution = await readSemanticSupervisedExecutionState({ projectRoot: input.projectRoot });
        const alreadyEnabled = currentExecution.enabled && currentExecution.policies.some((policy) =>
          policy.outcome === outcome
          && policy.action_boundary_digest === activated.activation.authority.action_boundary.digest);
        const executionNotice = alreadyEnabled ? undefined : await reviewSemanticSupervisedExecution({
          projectRoot: input.projectRoot,
          active: activated.activation,
          activeReads,
          outcome,
          session: input.session,
          env: process.env,
          inspectDatabaseFn: input.schemaInspector,
        });
        if (executionNotice) {
          semanticExecutionRunCommands.push(...executionNotice.lines.filter((line) => line.startsWith("Run: ")));
          const lines = [
            ...executionNotice.lines,
            ...(executionNotice.footer ? [executionNotice.footer] : []),
          ];
          if (input.authoringChat) {
            input.authoringChat.rememberDetails(executionNotice.title, lines);
            await input.authoringChat.streamCheckpoint(
              executionNotice.title,
              lines.filter((line) => !line.startsWith("Run: ")).slice(0, 1),
              executionNotice.tone,
            );
          } else {
            await writeRunner(executionNotice.title, lines, executionNotice.tone);
          }
        }
        const executionState = await readSemanticSupervisedExecutionState({
          projectRoot: input.projectRoot,
        });
        semanticExecutionEnabled = executionState.enabled
          && executionReviewOutcomes
            .every((outcome) => executionState.policies.some((policy) =>
              policy.outcome === outcome
              && policy.action_boundary_digest === activated.activation.authority.action_boundary.digest));
      }
    } else {
      await input.authoringChat?.streamCheckpoint("Verified Action Boundary kept disabled", [
        `${semanticActionDrafts.length} outcome(s) remain saved for later review`,
        "No proposal authority or source data changed",
      ], "warning");
    }
  }
  if (readBoundaryActive && actionDrafts.length) {
    const inspection = resolvedActionInspection ?? await (input.actionProjectInspector ?? inspectActionProject)(
      input.projectRoot,
      process.env,
    );
    for (const { draft } of actionDrafts) {
      await writeRunner("NEXT AUTHORITY REVIEW - ACTION BOUNDARY", [
        `Action: ${draft.capability}`,
        "Runner will show the exact proposal fields, bounds, policy, and rehearsal before asking for activation.",
        "Activating proposal authority still grants no approval or apply authority and performs no source write.",
      ]);
      await runActionReview({
        projectRoot: input.projectRoot,
        boundaryName: context.candidate.pack.name,
        inspection,
        env: process.env,
        initialDraftCapability: draft.capability,
        exitAfterInitialDraft: true,
        returnToAsk: false,
        suppressActivationSummary: Boolean(input.authoringChat),
        ...(modelInterviewSession ? { modelSuggestionSession: modelInterviewSession } : {}),
        ...(modelInterviewSession ? { modelInterviewEgressAcknowledged: true } : {}),
        ...(input.authoringChat ? { prompter: input.authoringChat.actionPrompter } : {}),
      });
    }
  }
  const finalActionStatus = await guidedActionStatus(input.projectRoot);
  const activeActionCapabilities = new Set(
    finalActionStatus.activations.map((activation) => activation.capability),
  );
  const preparedActionCount = ruleDerivedAction && semanticActionAuthorityDraft
    ? semanticActionDrafts.length
    : actionDrafts.length;
  const activatedPreparedActions = ruleDerivedAction
    ? semanticActionActivation ? semanticActionDrafts.length : 0
    : actionDrafts.filter(({ draft }) => activeActionCapabilities.has(draft.capability)).length;
  const allPreparedActionsActive = preparedActionCount > 0
    && activatedPreparedActions === preparedActionCount;
  const semanticExecutionMissing = unmetExecutionEntries().length > 0;
  const semanticExecutionRequested = semanticExecutionMissing || semanticActionDrafts.some((entry) => entry.result.compiled.effect_envelope.writeback.mode === "direct_sql");
  const proposalSetupComplete = readBoundaryActive
    && (actionIntents.length === 0 || allPreparedActionsActive);
  const setupComplete = proposalSetupComplete
    && !semanticExecutionMissing && (!semanticExecutionRequested || semanticExecutionEnabled);
  const activeActionBoundary = finalActionStatus.action_boundary.active;
  const currentActionBoundary = activeActionBoundary ?? finalActionStatus.action_boundary.draft;
  const semanticPolicy = semanticActionDrafts.some((entry) => entry.result.compiled.approval_class.mode === "policy");
  const deterministicPolicyActive = ruleDerivedAction
    ? Boolean(semanticActionActivation && semanticPolicy)
    : actionBoundaryHasDeterministicPolicy(activeActionBoundary, activeActionCapabilities);
  const preparedActionCapabilities = new Set(actionDrafts.map(({ draft }) => draft.capability));
  const deterministicPolicyPrepared = ruleDerivedAction
    ? Boolean(semanticActionAuthorityDraft && semanticPolicy)
    : actionBoundaryHasDeterministicPolicy(
        currentActionBoundary,
        new Set([...preparedActionCapabilities, ...activeActionCapabilities]),
      );
  const actionBoundaryName = semanticActionAuthorityDraft?.authority.action_boundary.name
    ?? currentActionBoundary?.name
    ?? "default_action_boundary";
  const authorityRows = [
    [
      "Read",
      context.candidate.pack.name,
      readBoundaryActive ? "ACTIVE" : "DRAFT",
      readBoundaryActive ? "Explore" : "None",
    ],
    ...(actionIntents.length
      ? [[
          "Action",
          actionBoundaryName,
          allPreparedActionsActive ? "ACTIVE" : "DRAFT",
          allPreparedActionsActive ? "Propose" : "None",
        ]]
      : [["Action", "Not requested", "OFF", "None"]]),
    [
      "Approval",
      deterministicPolicyPrepared ? "Deterministic policy" : "Human review",
      allPreparedActionsActive
        ? deterministicPolicyActive ? "ACTIVE" : "REQUIRED"
        : deterministicPolicyPrepared ? "DRAFT" : "OFF",
      "Cannot approve",
    ],
    [
      "Apply",
      semanticExecutionRequested ? "Supervised worker" : "Source writeback",
      semanticExecutionRequested
        ? semanticExecutionMissing ? "NOT CONFIGURED" : semanticExecutionEnabled ? "ENABLED" : "OFF"
        : "NOT ALLOWED",
      "Cannot apply",
    ],
  ];
  const finalTitle = setupComplete
    ? "BOUNDARIES ACTIVE; CONNECT CLIENT"
    : semanticExecutionMissing
      ? "AUTOMATIC COMPLETION NOT CONFIGURED"
    : proposalSetupComplete && semanticExecutionRequested
      ? "PROPOSALS ACTIVE; EXECUTION OFF"
      : "BOUNDARY DRAFTS SAVED";
  const finalNotice: BoundaryAccessNotice = {
    tone: setupComplete ? "success" : "warning",
    title: finalTitle,
    lines: [
      ...renderBoundaryMapTable(
        ["Layer", "Boundary / control", "State", "Agent can"],
        authorityRows,
        { widths: [8, 23, 12, 14], rowSeparators: false },
      ),
      `Validated job: ${requestedReadCoverage.supported}/${requestedReadCoverage.total} read plans | `
        + `${exposure.candidate_resources} resource${exposure.candidate_resources === 1 ? "" : "s"} | `
        + `${exposure.candidate_return_fields} model field${exposure.candidate_return_fields === 1 ? "" : "s"}`,
      ...(coverage.forbidden_total
        ? [`Deny checks: ${coverage.forbidden_denied}/${coverage.forbidden_total} remain refused`]
        : []),
      "Source database changed during setup: no.",
      ...semanticExecutionRunCommands,
    ],
    footer: setupComplete
      ? semanticExecutionRequested
        ? "Next: connect the client, then choose whether to start the reviewed worker. Until it runs, approved requests cannot complete automatically."
        : "Next: choose terminal Ask, local stdio MCP, or production HTTP MCP."
      : semanticExecutionMissing
        ? "Next: resume this job and choose Prepare requested automatic execution. Approval alone will not complete a change."
      : proposalSetupComplete && semanticExecutionRequested
        ? "Execution setup is paused. Choose Execution setup to retry, or connect a proposal-only client. No automatic completion is enabled."
      : readBoundaryActive
        ? "Next: review the remaining Action draft here or describe the change with the model route."
        : "Next: activate the Read draft when its exact authority is correct; Action remains separate.",
  };
  if (input.authoringChat) {
    input.authoringChat.rememberDetails(
      finalNotice.title,
      [...finalNotice.lines, ...(finalNotice.footer ? [finalNotice.footer] : [])],
    );
    const readState = readBoundaryActive ? "ACTIVE - agent may Explore" : "DRAFT - no agent access";
    const actionState = actionIntents.length === 0
      ? "not requested"
      : allPreparedActionsActive
        ? `ACTIVE - ${activatedPreparedActions} proposal action${activatedPreparedActions === 1 ? "" : "s"} reviewed in this job`
        : `DRAFT - ${preparedActionCount - activatedPreparedActions} action${preparedActionCount - activatedPreparedActions === 1 ? "" : "s"} not active`;
    if (!proposalSetupComplete) await input.authoringChat.streamCheckpoint(finalNotice.title, [
      `Read ${readState} · Action ${actionState}`,
      `Approval ${deterministicPolicyActive
        ? "deterministic policy with human fallback"
        : deterministicPolicyPrepared
          ? "deterministic policy draft with human fallback"
          : "human review"} · execution ${semanticExecutionRequested
            ? semanticExecutionMissing ? "not configured" : semanticExecutionEnabled ? "enabled; run worker" : "off"
            : "not allowed"} · source unchanged`,
      `${finalNotice.footer ?? "Continue from the Boundary screen."} · /details shows the exact authority record`,
    ], finalNotice.tone);
  }
  if (proposalSetupComplete) {
    await persistAuthoringResume("client_setup");
  } else {
    await persistAuthoringResume("authority_review");
  }
  return {
    ...boundaryAssistResult(
    finalNotice,
    actionIntents.length === 0 && !readBoundaryActive && !modelGuidedReadReviewReady,
    proposalSetupComplete,
    Boolean(input.authoringChat),
    ),
    ...(reviewNavigation ? { navigation: reviewNavigation } : {}),
  };
}

export function actionBoundaryHasDeterministicPolicy(
  boundary: {
    authority: {
      approval_policies: Array<{ capability: string; mode: string }>;
    };
  } | undefined,
  capabilities: ReadonlySet<string>,
): boolean {
  return Boolean(boundary?.authority.approval_policies.some(
    (policy) => policy.mode === "policy" && capabilities.has(policy.capability),
  ));
}

function boundedDownstreamActionIntent(plannedIntent: string, operatorJob: string): string {
  // Prefer the model's separated Action intent, but never let a planner output
  // exceed the same durable bound as the operator's reviewed job description.
  return [...plannedIntent].length <= MAX_BOUNDARY_ACTION_INTENT_CHARACTERS
    ? plannedIntent
    : operatorJob;
}

export function formatCurrentBoundaryAuthoritySummary(
  state: BoundaryJobCurrentState,
): string[] {
  const readState = state.read.authority === "active_with_disabled_changes"
    ? "ACTIVE + DRAFT"
    : state.read.authority === "active"
      ? "ACTIVE"
      : "DRAFT";
  const readAuthority = state.read.authority === "disabled"
    ? "No active Read"
    : `Explore ${state.read.resource_ids.length} reviewed resource${state.read.resource_ids.length === 1 ? "" : "s"}`;
  const rows = [
    ["Read", state.read.boundary_name, readState, readAuthority],
    ...(state.actions.length
      ? state.actions.map((action) => [
          "Action",
          action.capability,
          action.authority === "active" ? "ACTIVE" : "DRAFT",
          action.authority === "active"
            ? ["Propose", action.operation?.toUpperCase(), action.resource].filter(Boolean).join(" ")
            : "No active proposal",
        ])
      : [["Action", "None", "OFF", "None"]]),
  ];
  return [
    ...renderBoundaryMapTable(
      ["Type", "Boundary / action", "State", "Agent can"],
      rows,
      { widths: [7, 22, 16, 22], rowSeparators: false },
    ),
    `Read resources: ${state.read.resource_ids.length ? state.read.resource_ids.join(", ") : "none"}`,
    `Action capabilities: ${state.actions.length
      ? state.actions.map((action) => `${action.capability} (${action.authority})`).join(", ")
      : "none"}`,
    "Runner reused the exact local revisions; the model did not recreate or broaden them.",
    "Existing approval and apply posture: unchanged | source database changed: no",
  ];
}

async function promptDelegationActionIntents(
  session: BoundaryReviewInteractiveSession,
): Promise<string[] | undefined> {
  const intents: string[] = [];
  while (intents.length < 8) {
    const answer = await session.promptText(
      intents.length === 0
        ? "What may the agent propose? Leave blank for a read-only job."
        : `Another proposal action ${intents.length + 1} (blank when done)`,
    );
    if (answer === undefined) return undefined;
    const normalized = answer.trim().replace(/\s+/g, " ");
    if (!normalized) return intents;
    if (textCharacterCount(normalized) > MAX_BOUNDARY_ACTION_INTENT_CHARACTERS) {
      throw new Error(
        `Proposal action intents must be at most ${MAX_BOUNDARY_ACTION_INTENT_CHARACTERS} characters each.`,
      );
    }
    intents.push(normalized);
  }
  return intents;
}

function jobAppearsToChangeState(jobIntent: string): boolean {
  return /\b(?:propose|create|open|schedule|assign|update|change|close|cancel|approve|issue|send|record|mark|waive|refund|credit|delete|remove)\b/iu
    .test(jobIntent);
}

async function promptJobFirstActionIntents(
  session: BoundaryReviewInteractiveSession,
  jobIntent: string,
): Promise<string[] | undefined> {
  const appearsToChangeState = jobAppearsToChangeState(jobIntent);
  const prepareActions = await session.confirm(
    "Should this job include an Action Boundary for structured proposals?",
    {
      defaultValue: appearsToChangeState,
      context: [
        "READ AND ACTION BOUNDARIES",
        "Read Boundary: what the agent may inspect through Explore.",
        "Action Boundary: what structured change it may propose. Approval and apply remain separate.",
        appearsToChangeState
          ? "Runner noticed change-oriented language, so Action Boundary drafting is selected by default."
          : "Choose No for a read-only job. You can add Action Boundaries later with Y.",
      ],
    },
  );
  if (prepareActions === undefined) return undefined;
  return prepareActions ? [jobIntent] : [];
}

async function prepareJobMappingCatalog(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  jobIntent: string;
  write?: (
    title: string,
    lines: string[],
    tone?: "normal" | "success" | "warning" | "danger",
  ) => void | Promise<void>;
  progress?: <T>(message: string, operation: () => Promise<T>) => Promise<T>;
}): Promise<boolean> {
  const plan = await loadJobMappingCatalog(input.projectRoot);
  const acceptedShared: string[] = [];
  const relevantShared = plan.shared_reference_resources.filter((resource) =>
    jobExplicitlyNamesResource(input.jobIntent, resource.resource_id));
  const skippedSharedCount = plan.shared_reference_resources.length - relevantShared.length;
  if (relevantShared.length) {
    const reviewShared = await input.session.confirm(
      `Review ${relevantShared.length} job-matched shared-reference table${relevantShared.length === 1 ? "" : "s"} now?`,
      {
        defaultValue: false,
        context: [
          "OPTIONAL SHARED REFERENCES",
          ...relevantShared.slice(0, 6).map((resource) => `- ${resource.resource_id}`),
          ...(relevantShared.length > 6
            ? [`- and ${relevantShared.length - 6} more`]
            : []),
          "The job explicitly names this table concept. Choose No unless every tenant should receive the same reviewed rows.",
          "Choose Yes to review each business assertion separately; Runner cannot infer it from schema structure.",
        ],
      },
    );
    if (reviewShared === undefined) return false;
    if (reviewShared) {
      for (const resource of relevantShared) {
        const accepted = await input.session.confirm(
          `${resource.resource_id} has no per-tenant rows and may be treated as a shared reference?`,
          {
            defaultValue: false,
            context: [
              "SHARED REFERENCE REVIEW",
              `${resource.resource_id} has no tenant column and no proven path to tenant-owned rows.`,
              "Accept only when every tenant is meant to see the same reviewed rows.",
              "This records a disabled, boundary-specific decision; it does not activate access.",
            ],
          },
        );
        if (accepted === undefined) return false;
        if (accepted) acceptedShared.push(resource.resource_id);
      }
    }
  }
  const total = plan.direct_resources.length + plan.derived_resources.length + acceptedShared.length;
  const limitsChange = plan.current_limits.max_derived_scope_hops
      !== plan.proposed_limits.max_derived_scope_hops
    || plan.current_limits.max_analysis_relationship_hops
      !== plan.proposed_limits.max_analysis_relationship_hops;
  const applyCatalog = () => applyJobMappingCatalog({
    projectRoot: input.projectRoot,
    expectedPlanDigest: plan.plan_digest,
    expectedAuthoring: plan.authoring_binding,
    acceptedSharedResources: acceptedShared,
    actor: localInteractiveActor(),
    reason: "Prepare a complete disabled structural catalog for one-job Boundary mapping.",
    schemaInspector: input.schemaInspector,
  });
  if (!plan.direct_resources_to_include.length
    && !plan.derived_resources.length
    && !acceptedShared.length
    && !plan.unresolved_principal_fields_to_withhold.length
    && !limitsChange) {
    await applyCatalog();
    const lines = [
      `${plan.direct_resources.length} directly scoped table${plan.direct_resources.length === 1 ? " is" : "s are"} available for disabled job mapping.`,
      ...(skippedSharedCount
        ? [`${skippedSharedCount} unrelated optional shared-reference table${skippedSharedCount === 1 ? " was" : "s were"} skipped; use manual review if needed.`]
        : []),
      ...(plan.manual_resources.length ? [`${plan.manual_resources.length} table${plan.manual_resources.length === 1 ? " needs" : "s need"} manual scope review and will stay outside mapping.`] : []),
      "No authority was activated.",
    ];
    if (input.write) await input.write("MAPPING CATALOG READY", lines, "success");
    else process.stdout.write(["", "MAPPING CATALOG READY", ...lines, ""].join("\n"));
    return true;
  }
  const preparingLines = [
    `${plan.direct_resources.length} direct | ${plan.derived_resources.length} uniquely proven derived | ${acceptedShared.length} reviewed shared reference`,
    ...(plan.proposed_limits.max_derived_scope_hops > plan.current_limits.max_derived_scope_hops
      ? [`Derived-scope authoring depth ${plan.current_limits.max_derived_scope_hops} -> ${plan.proposed_limits.max_derived_scope_hops}`]
      : []),
    ...(plan.proposed_limits.max_analysis_relationship_hops > plan.current_limits.max_analysis_relationship_hops
      ? [`Analysis-path authoring depth ${plan.current_limits.max_analysis_relationship_hops} -> ${plan.proposed_limits.max_analysis_relationship_hops}`]
      : []),
    "Runner will immediately minimize this disabled intermediate to the reviewed job. No authority is active.",
  ];
  if (input.write) await input.write("PREPARING DISABLED MAPPING CATALOG", preparingLines);
  else process.stdout.write(["", "PREPARING DISABLED MAPPING CATALOG", ...preparingLines, ""].join("\n"));
  const applied = input.progress
    ? await input.progress("Preparing the disabled mapping catalog", applyCatalog)
    : await applyCatalog();
  const readyLines = [
    `${total} tables are available to the workload mapper${applied.review_revision ? ` in disabled revision ${applied.review_revision}` : ""}.`,
    ...(plan.manual_resources.length
      ? [`${plan.manual_resources.length} ambiguous or unresolved table${plan.manual_resources.length === 1 ? " remains" : "s remain"} outside mapping; use the manual editor to review them.`]
      : []),
    ...(skippedSharedCount
      ? [`${skippedSharedCount} unrelated optional shared-reference table${skippedSharedCount === 1 ? " remains" : "s remain"} outside mapping.`]
      : []),
    "No Read Boundary, Action Boundary, proposal, approval, or apply authority was activated.",
  ];
  if (input.write) await input.write("MAPPING CATALOG READY", readyLines, "success");
  else process.stdout.write(["", "MAPPING CATALOG READY", ...readyLines, ""].join("\n"));
  return true;
}

function jobExplicitlyNamesResource(jobIntent: string, resourceId: string): boolean {
  const table = resourceId.split(".").at(-1) ?? resourceId;
  const tableTokens = boundaryIntentTokens(table);
  if (!tableTokens.length) return false;
  const jobTokens = new Set(boundaryIntentTokens(jobIntent));
  return tableTokens.every((token) => jobTokens.has(token));
}

function boundaryIntentTokens(value: string): string[] {
  const raw = value.toLowerCase().replace(/[_./:-]+/gu, " ").match(/[a-z0-9]+/gu) ?? [];
  return [...new Set(raw.filter((token) => token.length > 1).map((token) =>
    token.endsWith("ies") && token.length > 4
      ? `${token.slice(0, -3)}y`
      : token.endsWith("s") && !token.endsWith("ss") && token.length > 3
        ? token.slice(0, -1)
        : token))];
}

async function promptReadWorkloadQuestions(
  session: BoundaryReviewInteractiveSession,
  label: string,
  required: boolean,
): Promise<string[] | undefined> {
  const questions: string[] = [];
  while (questions.length < 20) {
    const answer = await session.promptText(
      `${label} ${questions.length + 1}${questions.length === 0 && required
        ? " (required)"
        : " (blank when done)"}`,
    );
    if (answer === undefined) return undefined;
    const normalized = answer.trim();
    if (!normalized) {
      if (required && questions.length === 0) continue;
      return questions;
    }
    if (textCharacterCount(normalized) > MAX_BOUNDARY_READ_QUESTION_CHARACTERS) {
      throw new Error(
        `${label} questions must be at most ${MAX_BOUNDARY_READ_QUESTION_CHARACTERS} characters each.`,
      );
    }
    questions.push(normalized);
  }
  return questions;
}

function boundaryAssistBackNotice(detail = "Boundary Assist closed."): BoundaryAccessNotice {
  return {
    tone: "success",
    title: detail,
    lines: ["The selected disabled draft, active authority, and source database are unchanged."],
  };
}

function boundaryAssistResult(
  notice: BoundaryAccessNotice,
  activationReady = false,
  handoffReady = false,
  noticePresented = false,
): BoundaryAssistOutcome {
  return {
    notice,
    activation_ready: activationReady,
    handoff_ready: handoffReady,
    ...(noticePresented ? { notice_presented: true } : {}),
  };
}

function writeBoundaryAccessNotice(notice: BoundaryAccessNotice): void {
  process.stdout.write([
    "",
    notice.title,
    ...notice.lines,
    ...(notice.footer ? [notice.footer] : []),
    "",
  ].join("\n"));
}

async function exactReadBoundaryIsActive(input: {
  projectRoot: string;
  boundaryName: string;
  candidateDigest: `sha256:${string}`;
}): Promise<boolean> {
  try {
    const active = await loadActivatedExplorationBoundaries(input.projectRoot);
    return active.some((boundary) =>
      boundary.pack.name === input.boundaryName
      && boundary.activation.digest === input.candidateDigest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

type BoundaryJobAuthoringState = {
  current_state: BoundaryJobCurrentState;
  candidate_digest: `sha256:${string}`;
  reusable_read_workloads: ReadWorkloadView[];
  resumable_read_workloads: ReadWorkloadView[];
  revisable_read_workload?: ReadWorkloadView;
  read_boundaries_by_digest: Map<`sha256:${string}`, ExplorationBoundaryDraft>;
  active_read_digests: Set<`sha256:${string}`>;
  action_read_digest_by_outcome: Map<string, `sha256:${string}`>;
  stale_action_outcomes: string[];
};

async function inspectBoundaryJobAuthoringState(input: {
  projectRoot: string;
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
}): Promise<BoundaryJobAuthoringState> {
  const candidateDigest = explorationBoundaryCandidateDigest(input.context.candidate);
  const fullyReviewed = exactReadBoundaryIsFullyReviewed(input.context);
  let activeReadRevisions: Awaited<ReturnType<typeof loadActivatedExplorationBoundaries>> = [];
  try {
    activeReadRevisions = (await loadActivatedExplorationBoundaries(input.projectRoot))
      .filter((boundary) => boundary.pack.name === input.context.candidate.pack.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const workloads = await listReadWorkloadAnalyses({
    projectRoot: input.projectRoot,
    generatedBoundary: input.context.candidate,
  });
  const reusableDigests = new Set<`sha256:${string}`>(
    activeReadRevisions.map((boundary) => boundary.activation.digest),
  );
  if (fullyReviewed) reusableDigests.add(candidateDigest);
  const reusableReadWorkloads = workloads.filter((workload) => workload.review
      && workload.analysis.candidate_digest !== undefined
      && workload.review.analyzed_candidate_digest === workload.analysis.candidate_digest
      && reusableDigests.has(workload.review.candidate_digest));
  // A partial multi-action job can be signed off in the standalone Read
  // review before its original mapping reaches workload commit. Reuse that
  // exact signoff, not an assumed review of the earlier mapping analysis.
  if (fullyReviewed && input.context.progress?.candidate_digest === candidateDigest
    && input.context.candidate.pack.resources.length > 0
    && !reusableReadWorkloads.some((workload) =>
    workload.review?.candidate_digest === candidateDigest)) {
    reusableReadWorkloads.push(await recordExactReadAuthorityAsReusableWorkload({
      projectRoot: input.projectRoot,
      boundary: input.context.candidate,
      reviewRevision: input.context.progress.revision,
    }));
  }
  for (const active of activeReadRevisions) {
    if (reusableReadWorkloads.some((workload) =>
      workload.review?.candidate_digest === active.activation.digest)) continue;
    reusableReadWorkloads.push(await recordExactReadAuthorityAsReusableWorkload({
      projectRoot: input.projectRoot,
      boundary: explorationDraftFromActive(active),
      reviewRevision: Math.max(1, input.context.progress?.revision ?? 1),
    }));
  }
  const resumableReadWorkloads = fullyReviewed
    ? []
    : workloads.filter((workload) =>
        workload.analysis.status === "ready"
        && workload.analysis.candidate_digest !== undefined
        && workload.analysis.allowed.every((entry) => entry.plan_shape !== undefined)
        && workload.analysis.forbidden.every((entry) => entry.plan_shape !== undefined)
        && (workload.review
          ? workload.review.analyzed_candidate_digest === workload.analysis.candidate_digest
            && workload.review.candidate_digest === candidateDigest
          : workload.generated_boundary_digest === candidateDigest));
  const revisableReadWorkload = [...reusableReadWorkloads, ...resumableReadWorkloads].find((workload) =>
    workload.analysis.status === "ready" && workload.review?.candidate_digest === candidateDigest
      && workload.review.analyzed_candidate_digest === workload.analysis.candidate_digest);
  const exactReadActive = fullyReviewed && activeReadRevisions.some((boundary) =>
    boundary.activation.digest === candidateDigest);
  const readAuthority = exactReadActive
    ? "active" as const
    : activeReadRevisions.length
      ? "active_with_disabled_changes" as const
      : "disabled" as const;
  const actionStatus = await guidedActionStatus(input.projectRoot);
  const actions = new Map<string, BoundaryJobCurrentState["actions"][number]>();
  const actionReadDigestByOutcome = new Map<string, `sha256:${string}`>();
  const linkedReadDigests = new Set<`sha256:${string}`>([candidateDigest, ...reusableDigests]);
  for (const action of actionStatus.drafts) {
    if (action.boundary_name !== input.context.candidate.pack.name
      || !linkedReadDigests.has(action.boundary_digest)) continue;
    actions.set(`${action.capability}:disabled`, {
      capability: action.capability,
      kind: "discretionary",
      operation: action.operation,
      resource: action.resource,
      authority: "disabled",
    });
  }
  for (const action of actionStatus.activations) {
    if (action.boundary_name !== input.context.candidate.pack.name
      || !action.boundary_digest
      || !linkedReadDigests.has(action.boundary_digest)) continue;
    actions.set(`${action.capability}:active`, {
      capability: action.capability,
      kind: "discretionary",
      ...(action.operation ? { operation: action.operation } : {}),
      ...(action.resource ? { resource: action.resource } : {}),
      authority: "active",
    });
  }
  const semanticDrafts = (await listActionRuleAuthorityDrafts(input.projectRoot))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const semanticActivation = await readActionRuleAuthorityActivation(input.projectRoot);
  const staleActionOutcomes = new Set<string>();
  const inspectedOutcomes = new Set<string>();
  const selectedSemanticAuthorities = [...semanticDrafts,
    ...(semanticActivation && !semanticDrafts.some(draft => draft.authority.name === semanticActivation.authority.name)
      ? [semanticActivation] : [])];
  for (const saved of selectedSemanticAuthorities) {
    for (const source of saved.authority.rules) {
      if (source.read_boundary_name !== input.context.candidate.pack.name || inspectedOutcomes.has(source.rule.outcome)) continue;
      inspectedOutcomes.add(source.rule.outcome);
      if (saved.authority.catalog.generation_lock_fingerprint !== input.context.candidate.generation_lock_fingerprint) {
        staleActionOutcomes.add(source.rule.outcome);
      }
    }
  }
  for (const draft of semanticDrafts) {
    for (const rule of draft.authority.action_boundary.rules) {
      const source = draft.authority.rules.find((candidate) => candidate.rule.outcome === rule.outcome);
      if (!source
        || source.read_boundary_name !== input.context.candidate.pack.name
        || !linkedReadDigests.has(source.read_boundary_digest)) continue;
      if (!actionReadDigestByOutcome.has(rule.outcome)) actionReadDigestByOutcome.set(rule.outcome, source.read_boundary_digest);
      actions.set(`rule:${rule.outcome}:disabled:${draft.digest}`, {
        capability: "app.request_change",
        kind: "rule_derived",
        action_boundary_name: draft.authority.action_boundary.name,
        outcome: rule.outcome,
        operation: rule.operation,
        resource: rule.target_resource,
        authority: "disabled",
      });
    }
  }
  if (semanticActivation) {
    for (const rule of semanticActivation.authority.action_boundary.rules) {
      const source = semanticActivation.authority.rules.find((candidate) => candidate.rule.outcome === rule.outcome);
      if (!source
        || source.read_boundary_name !== input.context.candidate.pack.name
        || !linkedReadDigests.has(source.read_boundary_digest)) continue;
      if (!actionReadDigestByOutcome.has(rule.outcome)) actionReadDigestByOutcome.set(rule.outcome, source.read_boundary_digest);
      actions.set(`rule:${rule.outcome}:active:${semanticActivation.digest}`, {
        capability: "app.request_change",
        kind: "rule_derived",
        action_boundary_name: semanticActivation.authority.action_boundary.name,
        outcome: rule.outcome,
        operation: rule.operation,
        resource: rule.target_resource,
        authority: "active",
      });
    }
  }
  const readBoundariesByDigest = new Map<`sha256:${string}`, ExplorationBoundaryDraft>();
  if (fullyReviewed) readBoundariesByDigest.set(candidateDigest, structuredClone(input.context.candidate));
  for (const boundary of activeReadRevisions) {
    readBoundariesByDigest.set(boundary.activation.digest, explorationDraftFromActive(boundary));
  }
  const reusableResourceIds = [...new Set(reusableReadWorkloads.flatMap((workload) =>
    workload.analysis.candidate?.pack.resources.map((resource) => resource.id) ?? []))].sort();
  const activeResourceIds = [...new Set(activeReadRevisions.flatMap((boundary) =>
    boundary.pack.resources.map((resource) => resource.id)))].sort();
  return {
    candidate_digest: candidateDigest,
    reusable_read_workloads: reusableReadWorkloads,
    resumable_read_workloads: resumableReadWorkloads,
    revisable_read_workload: revisableReadWorkload,
    read_boundaries_by_digest: readBoundariesByDigest,
    active_read_digests: new Set(activeReadRevisions.map((boundary) => boundary.activation.digest)),
    action_read_digest_by_outcome: actionReadDigestByOutcome,
    stale_action_outcomes: [...staleActionOutcomes],
    current_state: {
      read: {
        boundary_name: input.context.candidate.pack.name,
        authority: readAuthority,
        fully_reviewed: fullyReviewed,
        revision_eligible: Boolean(revisableReadWorkload),
        resource_ids: reusableResourceIds.length
          ? reusableResourceIds
          : input.context.candidate.pack.resources.map((resource) => resource.id).sort(),
        ...(activeResourceIds.length ? { active_resource_ids: activeResourceIds } : {}),
        candidate_resource_ids: input.context.candidate.pack.resources.map((resource) => resource.id).sort(),
        exact_reusable_revision_count: reusableReadWorkloads.length,
        resumable_draft_count: resumableReadWorkloads.length,
        resumable_resource_ids: resumableReadWorkloads[0]?.analysis.candidate?.pack.resources
          .map((resource) => resource.id)
          .sort() ?? [],
      },
      actions: [...actions.values()].sort((left, right) =>
        left.capability.localeCompare(right.capability) || left.authority.localeCompare(right.authority)),
      control_plane: {
        trusted_scope: "runner_injected",
        approval_history: "runner_proposal_ledger",
        model_may_supply_scope_values: false,
        model_may_supply_approval_history: false,
      },
    },
  };
}

function explorationDraftFromActive(
  boundary: Awaited<ReturnType<typeof loadActivatedExplorationBoundaries>>[number],
): ExplorationBoundaryDraft {
  const { activation: _activation, ...authority } = structuredClone(boundary);
  return {
    ...authority,
    activation: "disabled_unreviewed",
    unresolved_decisions: [],
  };
}

async function recordExactReadAuthorityAsReusableWorkload(input: {
  projectRoot: string;
  boundary: ExplorationBoundaryDraft;
  reviewRevision: number;
}): Promise<ReadWorkloadView> {
  const candidateDigest = explorationBoundaryCandidateDigest(input.boundary);
  const operationFields = new Set<string>();
  for (const resource of input.boundary.pack.resources) {
    for (const field of [
      ...resource.selectable_fields,
      ...Object.keys(resource.filterable_fields),
      ...resource.sortable_fields,
      ...resource.groupable_fields,
      ...resource.aggregate_measures,
      ...(resource.presence_measure_fields ?? []),
      ...resource.count_distinct_fields,
      ...Object.keys(resource.time_bucket_fields),
    ]) operationFields.add(`${resource.id}.${field}`);
  }
  const source = { kind: "existing_capability" as const };
  const analysis = {
    schema_version: READ_WORKLOAD_ANALYSIS_VERSION,
    workload_digest: canonicalJsonDigest({
      kind: "existing_read_authority",
      boundary_name: input.boundary.pack.name,
      candidate_digest: candidateDigest,
    }),
    workload_name: `Exact reviewed Read Boundary ${input.boundary.pack.name}`,
    status: "ready" as const,
    allowed: [],
    forbidden: [],
    authority_atoms: [],
    candidate: structuredClone(input.boundary),
    candidate_digest: candidateDigest,
    coverage: {
      allowed_supported: 0,
      allowed_total: 0,
      forbidden_denied: 0,
      forbidden_total: 0,
    },
    exposure: {
      generated_resources: input.boundary.pack.resources.length,
      candidate_resources: input.boundary.pack.resources.length,
      generated_fields: input.boundary.pack.resources.reduce(
        (sum, resource) => sum + Object.keys(resource.field_types).length,
        0,
      ),
      candidate_return_fields: input.boundary.pack.resources.reduce(
        (sum, resource) => sum + resource.selectable_fields.length,
        0,
      ),
      candidate_operation_fields: operationFields.size,
      candidate_relationships: input.boundary.pack.resources.reduce(
        (sum, resource) => sum + resource.relationships.length,
        0,
      ),
    },
    blockers: [],
    authority_granted: false as const,
    source_query_executed: false as const,
    explore_budget_consumed: false as const,
    source_database_changed: false as const,
  };
  const stored = await storeReadWorkloadAnalysis({
    projectRoot: input.projectRoot,
    generatedBoundary: input.boundary,
    source,
    analysis,
  });
  const review = stored.review ?? await recordReadWorkloadReview({
    projectRoot: input.projectRoot,
    workload: stored,
    candidateDigest,
    reviewRevision: input.reviewRevision,
  });
  return {
    ...stored,
    state: "reviewed",
    review,
  };
}

type ModelReadRevisionPreview = BoundaryReviewMutationBatchPreview | BoundaryExactCandidateMutationPreview;

type ModelReadBoundaryExposureRevisionInput = {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
  revision: Pick<ModelReadBoundaryRevisionResult, "changes" | "policy_changes" | "read_prerequisite" | "reviewed_relationship">;
  validateCandidate?: (
    candidate: ExplorationBoundaryDraft,
    generationLock: GenerationLock,
  ) => void;
};

export async function reloadReadReviewForModelRevision(
  projectRoot: string,
  previous: Awaited<ReturnType<typeof loadBoundaryReviewContext>>,
  expectedAction?: ActionRuleAuthorityDraftV1,
): Promise<Awaited<ReturnType<typeof loadBoundaryReviewContext>>> {
  const current = await loadBoundaryReviewContext(projectRoot);
  const readIdentity = ({ authoring, ...bindings }: BoundaryReviewMutationBindings) => ({
    ...bindings,
    ...(authoring ? { authoring: { ...authoring, epoch: 0 } } : {}),
  });
  if (canonicalJsonDigest(readIdentity(previous.bundle.mutation_bindings))
    !== canonicalJsonDigest(readIdentity(current.bundle.mutation_bindings))) {
    throw new Error("READ_BOUNDARY_REVISION_CHANGED: The selected Read revision changed. Reopen its current review; your requested revision has not been applied.");
  }
  if (expectedAction && (await readActionRuleAuthorityDraft(projectRoot, expectedAction.authority.name))?.digest !== expectedAction.digest) {
    throw new Error("ACTION_BOUNDARY_REVISION_CHANGED: The dependent Action draft changed. Reopen the saved job to review its current rules; no Read revision was applied.");
  }
  return current;
}

export async function prepareModelReadBoundaryExposureRevision(
  input: ModelReadBoundaryExposureRevisionInput & { revision: { read_prerequisite?: undefined } },
): Promise<BoundaryReviewMutationBatchPreview>;
export async function prepareModelReadBoundaryExposureRevision(
  input: ModelReadBoundaryExposureRevisionInput,
): Promise<ModelReadRevisionPreview>;
export async function prepareModelReadBoundaryExposureRevision(
  input: ModelReadBoundaryExposureRevisionInput,
): Promise<ModelReadRevisionPreview> {
  const byResource = new Map<string, ModelReadBoundaryRevisionResult["changes"]>();
  const catalog = readBoundaryRevisionCatalog(input.context.candidate);
  const reviewedRelationship = input.revision.reviewed_relationship;
  const selectedRelationship = reviewedRelationship
    ? validateReviewedReadRelationship(reviewedRelationship, input.context.candidate, input.context.draft) : undefined;
  if (reviewedRelationship && selectedRelationship) {
    const resource = catalog.resources.find(resource => resource.id === reviewedRelationship.resource)!;
    resource.relationships.push(selectedRelationship.id);
  }
  const settings = new Map((input.revision.policy_changes ?? []).map((change) => {
    const resource = catalog.resources.find((candidate) => candidate.id === change.resource);
    if (!resource) throw new Error("READ_BOUNDARY_REVISION_RESOURCE_UNAVAILABLE");
    byResource.set(change.resource, []);
    return [change.resource, parseReadPolicySettings(change.settings, resource)] as const;
  }));
  for (const change of input.revision.changes) {
    if (settings.get(change.resource)?.exclude) {
      throw new Error(`Remove ${change.resource} from Read access without field-exposure edits for the same resource. The prior draft is unchanged.`);
    }
    const changes = byResource.get(change.resource) ?? [];
    changes.push(change);
    byResource.set(change.resource, changes);
  }
  const requests = [...byResource.entries()].map(([resourceId, changes]): BoundaryResourceReviewRequest => ({
    resource_id: resourceId,
    ...(changes.some((change) => change.after === "runner_only") ? (() => {
      const previous = input.context.candidate.pack.resources.find((resource) => resource.id === resourceId)!;
      return { filterable_fields: Object.keys(previous.filterable_fields), sortable_fields: previous.sortable_fields,
        groupable_fields: previous.groupable_fields, aggregate_measures: previous.aggregate_measures,
        count_distinct_fields: previous.count_distinct_fields, time_bucket_fields: Object.keys(previous.time_bucket_fields) };
    })() : {}),
    ...settings.get(resourceId),
    // Empty field lists are still explicit edits to the mutation API. A policy-
    // only change, especially resource removal, must not acquire those edits.
    ...(changes.length ? {
      keep_out_fields: changes.filter((change) => change.after === "kept_out").map((change) => change.field),
      withhold_from_model_fields: changes.filter((change) => change.after === "runner_only").map((change) => change.field),
      private_model_fields: changes.filter((change) => change.after === "runner_only" && change.model_operations !== "preserve_reviewed").map((change) => change.field),
      preserve_unselected_fields: changes.filter((change) => change.after === "runner_only"
        && change.before !== "kept_out"
        && !input.context.candidate.pack.resources.find((resource) => resource.id === resourceId)!.selectable_fields.includes(change.field)
        && !settings.get(resourceId)?.selectable_fields?.includes(change.field)).map((change) => change.field),
      allow_reviewed_fields: changes.filter((change) => change.after === "model_and_runner").map((change) => change.field),
    } : {}),
    actor: localInteractiveActor(),
    reason: "Applied an operator-requested, model-assisted field-exposure revision to the disabled Read Boundary.",
  }));
  const batchPreview = requests.length ? await prepareBoundaryReviewMutationBatch(
    input.projectRoot,
    requests,
    input.schemaInspector,
    input.context.bundle.mutation_bindings,
    input.revision.read_prerequisite,
  ) : undefined;
  const preview = batchPreview ?? (input.revision.read_prerequisite ? await prepareReadPrerequisiteRevision({
    projectRoot: input.projectRoot,
    previous: input.context.candidate,
    prerequisite: input.revision.read_prerequisite,
    bindings: input.context.bundle.mutation_bindings,
    actor: localInteractiveActor(),
    schemaInspector: input.schemaInspector,
  }) : undefined);
  if (!preview) throw new Error("The requested revision contains no changed fields, query settings or private access condition.");
  if (reviewedRelationship) assertReviewedReadRelationshipRetained(reviewedRelationship, preview.candidate);
  input.validateCandidate?.(preview.candidate, preview.build.lock);
  return preview;
}

export async function applyModelReadBoundaryExposureRevision(input: ModelReadBoundaryExposureRevisionInput & {
  preview?: ModelReadRevisionPreview;
  onCommitted?: () => void;
}): Promise<{
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
  workload: ReadWorkloadView;
  committed: {
    candidate_digest: `sha256:${string}`;
    review_revision: number;
    review: ReadWorkloadReview;
    authority_activated: false;
    source_database_changed: false;
  };
}> {
  const preview = input.preview ?? await prepareModelReadBoundaryExposureRevision(input);
  const mutation = preview.schema_version === "synapsor.boundary-exact-candidate-mutation-preview.v1"
    ? await commitExactBoundaryCandidateMutation(input.projectRoot, preview)
    : await commitBoundaryReviewMutationBatch(input.projectRoot, preview);
  input.onCommitted?.();
  const context = await reloadReadReviewAfterCommit(input.projectRoot, mutation);
  const workload = await recordExactReadAuthorityAsReusableWorkload({
    projectRoot: input.projectRoot,
    boundary: context.candidate,
    reviewRevision: mutation.review_revision,
  });
  if (!workload.review) {
    throw new Error("READ_BOUNDARY_REVISION_REVIEW_MISSING: the exact revised Read authority was not recorded.");
  }
  return {
    context,
    workload,
    committed: {
      candidate_digest: mutation.candidate_digest,
      review_revision: mutation.review_revision,
      review: workload.review,
      authority_activated: false,
      source_database_changed: false,
    },
  };
}

async function reloadReadReviewAfterCommit(projectRoot: string, mutation: {
  candidate_digest: `sha256:${string}`;
  review_revision: number;
  authoring_binding?: BoundaryReviewMutationBindings["authoring"];
}): Promise<Awaited<ReturnType<typeof loadBoundaryReviewContext>>> {
  const context = await loadBoundaryReviewContext(projectRoot);
  if (context.bundle.candidate_digest !== mutation.candidate_digest
    || context.bundle.mutation_bindings.review_revision !== mutation.review_revision
    || canonicalJsonDigest(context.bundle.mutation_bindings.authoring ?? null)
      !== canonicalJsonDigest(mutation.authoring_binding ?? null)) {
    throw new Error("READ_BOUNDARY_REVISION_CHANGED_AFTER_SAVE: The disabled Read revision was saved, but another update changed the selected review before continuation. Resume this job to review the current revision and revalidate its Action dependencies. No authority was activated.");
  }
  return context;
}

function formatReadBoundaryExposure(value: ReadBoundaryFieldExposure): string {
  if (value === "model_and_runner") return "Model + Runner";
  if (value === "runner_only") return "Runner only";
  return "Kept out";
}

async function selectReusableReadWorkload(input: {
  session: BoundaryReviewInteractiveSession;
  workloads: ReadWorkloadView[];
}): Promise<ReadWorkloadView | undefined> {
  if (input.workloads.length === 1) return input.workloads[0];
  if (!input.workloads.length) return undefined;
  if (input.session.chooseOption) {
    const selected = await input.session.chooseOption(
      "CHOOSE THE EXACT READ REVISION TO REUSE",
      input.workloads.map((workload) => ({
        value: workload.analysis_id,
        label: workload.analysis.workload_name,
        detail: `${workload.analysis.coverage.allowed_supported} reviewed plan${workload.analysis.coverage.allowed_supported === 1 ? "" : "s"} | revision ${workload.review!.review_revision} | ${workload.imported_at}`,
      })),
      {
        context: [
          "Several immutable analyses match the current reviewed Read Boundary exactly.",
          "Choose one local record for the delegation history. The Read Boundary itself is not changed.",
        ],
      },
    );
    return input.workloads.find((workload) => workload.analysis_id === selected);
  }
  const selected = await input.session.promptText("Exact saved Read analysis ID", {
    context: [
      "CHOOSE THE EXACT READ REVISION TO REUSE",
      ...input.workloads.map((workload) =>
        `${workload.analysis_id}  ${workload.analysis.workload_name}  revision ${workload.review!.review_revision}`),
    ],
  });
  return input.workloads.find((workload) => workload.analysis_id === selected?.trim());
}

function reusableReadWorkloadsForJob(
  state: BoundaryJobAuthoringState,
  plan: Extract<BoundaryJobPlan, { state: "planned" }>,
): ReadWorkloadView[] {
  const outcomeDigest = plan.action_outcome
    ? state.action_read_digest_by_outcome.get(plan.action_outcome)
    : undefined;
  const soleActiveDigest = state.active_read_digests.size === 1
    ? [...state.active_read_digests][0]
    : undefined;
  const preferredDigest = outcomeDigest
    ?? (plan.action_mode !== "none" ? soleActiveDigest : undefined);
  if (!preferredDigest) return state.reusable_read_workloads;
  const preferred = state.reusable_read_workloads.filter((workload) =>
    workload.review?.candidate_digest === preferredDigest);
  return preferred.length ? preferred : state.reusable_read_workloads;
}

async function selectResumableReadWorkload(input: {
  session: BoundaryReviewInteractiveSession;
  workloads: ReadWorkloadView[];
}): Promise<ReadWorkloadView | undefined> {
  if (input.workloads.length === 1) return input.workloads[0];
  if (!input.workloads.length) return undefined;
  if (input.session.chooseOption) {
    const selected = await input.session.chooseOption(
      "RESUME ONE EXACT DISABLED READ MAPPING",
      input.workloads.map((workload) => ({
        value: workload.analysis_id,
        label: workload.analysis.workload_name,
        detail: `${workload.analysis.coverage.allowed_supported} validated plan${workload.analysis.coverage.allowed_supported === 1 ? "" : "s"} | final Read review pending`,
      })),
      {
        context: [
          "These mappings were validated and saved before their model-guided Action step stopped.",
          "Resuming changes no authority and does not repeat Read mapping.",
        ],
      },
    );
    return input.workloads.find((workload) => workload.analysis_id === selected);
  }
  return input.workloads[0];
}

function readWorkloadSetFromAnalysis(
  workload: ReadWorkloadView,
  boundary: ExplorationBoundaryDraft,
): ReadWorkloadSet {
  const entries = (values: ReadWorkloadView["analysis"]["allowed"]) => values.map((entry) => {
    if (!entry.plan_shape) {
      throw new Error(
        `READ_WORKLOAD_RESUME_INVALID: ${entry.id} has no normalized plan shape and cannot be resumed safely.`,
      );
    }
    return {
      id: entry.id,
      description: entry.description,
      plan: rehydrateSanitizedReadWorkloadPlan(entry.plan_shape, boundary),
    };
  });
  return normalizeReadWorkloadSet({
    schema_version: "synapsor.read-workload-set.v1",
    name: workload.analysis.workload_name,
    allowed: entries(workload.analysis.allowed),
    forbidden: entries(workload.analysis.forbidden),
    source: structuredClone(workload.source),
  });
}

function exactReadBoundaryIsFullyReviewed(
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>,
): boolean {
  const confirmed = new Set(context.progress?.confirmed_decisions ?? []);
  return context.candidate.unresolved_decisions.every((decision) => confirmed.has(decision));
}

function uniqueWorkloadEntryId(base: string, existingIds: string[]): string {
  const existing = new Set(existingIds);
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`READ_WORKLOAD_ID_DUPLICATED: could not allocate a bounded id for ${base}.`);
}

async function selectRunnerGuidedReadCards(input: {
  session: BoundaryReviewInteractiveSession;
  cards: ReadWorkloadPlanCard[];
  jobIntent?: string;
}): Promise<string[] | undefined> {
  const recommendation = input.jobIntent
    ? recommendReadWorkloadPlanCardsForJob(input.cards, input.jobIntent)
    : { cards: [], matched_resource_count: 0, source: "reviewed_metadata" as const };
  const recommendedIds = recommendation.cards.map((card) => card.id);
  if (recommendedIds.length && input.session.chooseOption) {
    const decision = await input.session.chooseOption(
      "RUNNER-GUIDED READ DRAFT",
      [
        {
          value: "use",
          label: `Use these ${recommendedIds.length} exact question${recommendedIds.length === 1 ? "" : "s"}  [recommended]`,
          detail: "Saves a minimized disabled candidate; exact Read Boundary review is still next.",
        },
        {
          value: "edit",
          label: "Review or change exact questions",
          detail: "Open every compiler-valid card with Runner's matches already selected.",
        },
        { value: "back", label: "Back" },
      ],
      {
        initialValue: "use",
        context: [
          `Runner matched reviewed metadata across ${recommendation.matched_resource_count} resource${recommendation.matched_resource_count === 1 ? "" : "s"}. No model or source query ran.`,
          ...recommendation.cards.map((card) => `- ${card.title}`),
          "This is drafting assistance only. Nothing activates until the exact boundary review.",
        ],
      },
    );
    if (!decision || decision === "back") return undefined;
    if (decision === "use") return recommendedIds;
  }
  if (input.session.selectReadWorkloadCards) {
    return input.session.selectReadWorkloadCards(input.cards, {
      initialSelectedIds: recommendedIds,
      recommendationLabel: recommendedIds.length
        ? `Runner preselected ${recommendedIds.length} explainable match${recommendedIds.length === 1 ? "" : "es"}; review or change them.`
        : "Runner found no unique reviewed-metadata match. Select exact questions; no model or source query ran.",
    });
  }
  const selectedText = await input.session.promptText([
    "CHOOSE REPRESENTATIVE QUESTIONS",
    "Select every question the agent needs. This selects exact plan shapes; it does not activate access.",
    ...input.cards.map((card, index) =>
      `${index + 1}${recommendedIds.includes(card.id) ? "*" : " "} ${card.title}\n   ${card.detail}`),
    ...(recommendedIds.length
      ? ["Blank Enter uses the starred Runner recommendation."]
      : []),
    "Numbers (comma-separated; ranges allowed, for example 1,3-5)",
  ].join("\n"));
  if (selectedText === undefined) return undefined;
  if (!selectedText.trim() && recommendedIds.length) return recommendedIds;
  return parseReadWorkloadCardSelection(selectedText, input.cards.map((card) => card.id));
}

function semanticActionReadSupportEntries(input: {
  compiled: CompiledActionRuleModelDraftV1;
  catalog: BuiltActionRuleAuthoringCatalogV1;
  existing: ReadWorkloadSet["allowed"];
}): ReadWorkloadSet["allowed"] {
  const entries: ReadWorkloadSet["allowed"] = [];
  const existingRows = new Set(input.existing.flatMap((entry) =>
    entry.plan.kind === "rows" && typeof entry.plan.resource === "string"
      ? [entry.plan.resource]
      : []));
  const authoringByResource = new Map(
    input.catalog.authoring.resources.map((resource) => [resource.name, resource]),
  );
  for (const binding of input.compiled.draft.verification.resources) {
    if (binding.source.kind !== "subject_ref" || existingRows.has(binding.resource)) continue;
    const resource = authoringByResource.get(binding.resource);
    if (!resource) throw new Error(`ACTION_RULE_SUBJECT_RESOURCE_UNAVAILABLE: ${binding.resource}`);
    const visible = new Set(resource.fields
      .filter((field) => field.role === "model_visible")
      .map((field) => field.name));
    const selected = binding.fields.filter((field) => visible.has(field));
    const fallback = resource.fields
      .filter((field) => field.role === "model_visible")
      .map((field) => field.name);
    const fields = [...new Set(selected.length ? selected : fallback)].slice(0, 8);
    if (!fields.length) {
      throw new Error(
        `ACTION_RULE_SUBJECT_READ_REQUIRED: ${binding.resource} has no model-visible field for an opaque subject reference. Review one safe return field or use a non-subject rule shape.`,
      );
    }
    entries.push({
      id: uniqueWorkloadEntryId(
        `semantic_action_subject_${entries.length + 1}`,
        [...input.existing, ...entries].map((entry) => entry.id),
      ),
      description: `Return reviewed ${binding.resource} rows with opaque subject references for the verified Action outcome.`,
      plan: {
        kind: "rows",
        resource: binding.resource,
        select: fields,
        limit: 25,
      },
    });
    existingRows.add(binding.resource);
  }
  return entries;
}

function uniqueExistingSemanticOutcome(
  actions: BoundaryJobCurrentState["actions"],
): string | undefined {
  const outcomes = [...new Set(actions.flatMap((action) =>
    action.kind === "rule_derived" && action.outcome ? [action.outcome] : []))];
  return outcomes.length === 1 ? outcomes[0] : undefined;
}

async function loadActionRuleRevisionBaseline(input: {
  projectRoot: string;
  boundaryName: string;
  outcome: string;
  preserveVerificationFields?: boolean;
  expectedReadDigest?: `sha256:${string}`;
}): Promise<{
  draft: ActionRuleModelDraftV1;
  catalog: ActionRuleCatalogV1;
  activatedAt: string;
} | undefined> {
  const drafts = (await listActionRuleAuthorityDrafts(input.projectRoot))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const active = await readActionRuleAuthorityActivation(input.projectRoot);
  const existing = [...drafts, ...(active ? [active] : [])].find((candidate) =>
    candidate.authority.rules.some((rule) =>
      rule.rule.outcome === input.outcome
      && rule.read_boundary_name === input.boundaryName));
  if (!existing) return undefined;
  const sourceRule = existing.authority.rules.find((rule) => rule.rule.outcome === input.outcome)!;
  if (input.expectedReadDigest && sourceRule.read_boundary_digest !== input.expectedReadDigest) {
    throw new Error(`ACTION_RULE_REVISION_DEPENDENCY_CHANGED: ${input.outcome} no longer belongs to the selected Read dependency. Reopen the saved review; no replacement was saved.`);
  }
  const review = existing.reviews.find((candidate) => candidate.outcome === input.outcome);
  if (!review) {
    throw new Error(
      `ACTION_RULE_REVISION_INVALID: ${input.outcome} has no exact operator review record.`,
    );
  }
  const { outcome: _outcome, ...reviewMaterial } = review;
  return {
    draft: actionRuleModelDraftFromAuthority({
      authority: existing.authority,
      outcome: input.outcome,
      review: structuredClone(reviewMaterial),
      preserveVerificationFields: input.preserveVerificationFields,
    }),
    catalog: structuredClone(existing.authority.catalog),
    activatedAt: existing.authority.rules.find((rule) => rule.rule.outcome === input.outcome)!.activated_at,
  };
}

function semanticActionRevisionDiffLines(
  previous: ActionRuleModelDraftV1,
  next: CompiledActionRuleModelDraftV1,
  changedPhases: ReadonlyArray<"verification" | "effect" | "rule" | "approval">,
): string[] {
  const changes: string[] = [];
  const changed = new Set(changedPhases);
  const add = (label: string, before: string, after: string) => {
    if (before !== after) changes.push(`${label}: ${before} -> ${after}`);
  };
  if (changed.has("rule")) {
    add("Client title", previous.discovery?.title ?? "Default outcome label", next.draft.discovery?.title ?? "Default outcome label");
    add("Client description", previous.discovery?.summary ?? "Default outcome description", next.draft.discovery?.summary ?? "Default outcome description");
    add("Client search phrases", previous.discovery?.aliases?.join(", ") || "None", next.draft.discovery?.aliases?.join(", ") || "None");
    add("WHEN", previous.review.when, next.review.when);
    add("THEN", previous.review.then, next.review.then);
    add("Refuse", joinActionRuleReviewClauses(previous.review.refused), joinActionRuleReviewClauses(next.review.refused));
    if (!changed.has("approval")) {
      add("Human review", previous.review.human_review, next.review.human_review);
    }
  }
  if (changed.has("approval")) {
    const quorumOnly = previous.approval.required_approvals !== next.draft.approval.required_approvals
      && canonicalJsonDigest({ ...previous.approval, required_approvals: 0 })
        === canonicalJsonDigest({ ...next.draft.approval, required_approvals: 0 });
    if (quorumOnly) {
      add(
        previous.approval.mode === "policy" ? "Human fallback quorum" : "Human-review quorum",
        actionRuleHumanApprovalSummary(previous),
        actionRuleHumanApprovalSummary(next.draft),
      );
    } else {
      add("Approval policy", actionRuleDraftApprovalSummary(previous), actionRuleDraftApprovalSummary(next.draft));
    }
  }
  if (changed.has("verification")) {
    add(
      "Private facts",
      actionRuleDraftVerificationSummary(previous),
      actionRuleDraftVerificationSummary(next.draft),
    );
  }
  if (changed.has("effect")) {
    add(
      "Effect bounds",
      actionRuleDraftEffectBoundsSummary(previous),
      actionRuleDraftEffectBoundsSummary(next.draft),
    );
    add("Apply posture", previous.effect.writeback, next.draft.effect.writeback);
    add("Changes made together", JSON.stringify(previous.effect.atomic_updates ?? []), JSON.stringify(next.draft.effect.atomic_updates ?? []));
  }
  if (!changes.length && changedPhases.length) {
    changes.push(`Changed reviewed phase${changedPhases.length === 1 ? "" : "s"}: ${changedPhases.join(", ")}.`);
  }
  return [
    `Editing ${previous.outcome}; ${previous.effect.operation.toUpperCase()} ${previous.effect.target_resource} is unchanged.`,
    ...(changes.length ? changes : ["No semantic business-policy change was detected."]),
    "The prior active revision remains live until this disabled replacement is explicitly activated.",
  ];
}

function actionRuleDraftVerificationSummary(draft: ActionRuleModelDraftV1): string {
  return draft.verification.resources.map((resource) =>
    `${resource.binding}=${resource.resource}[${resource.fields.join(", ")}]`).join("; ");
}

function actionRuleDraftEffectBoundsSummary(draft: ActionRuleModelDraftV1): string {
  return draft.effect.allowed_fields.map((field) => [
    field.name,
    ...(field.minimum === undefined ? [] : [`min ${field.minimum}`]),
    ...(field.maximum === undefined ? [] : [`max ${field.maximum}`]),
    ...(field.values === undefined ? [] : [`values ${field.values.map(String).join("|")}`]),
  ].join(" ")).join("; ");
}

function actionRuleDraftApprovalSummary(draft: ActionRuleModelDraftV1): string {
  if (draft.approval.mode === "human") {
    return actionRuleHumanApprovalSummary(draft);
  }
  const predicate = draft.approval.auto_approve_when
    ? actionRuleBooleanSummary(draft.approval.auto_approve_when)
    : "no automatic predicate";
  const limits = draft.approval.shared_limits.length
    ? draft.approval.shared_limits.map(actionRuleSharedLimitSummary).join("; ")
    : "no circuit breakers";
  return `${predicate}; ${limits}; fallback ${actionRuleHumanApprovalSummary(draft)}`;
}

function actionRuleHumanApprovalSummary(draft: ActionRuleModelDraftV1): string {
  const count = draft.approval.required_approvals;
  return `${count} distinct ${draft.approval.required_role} ${count === 1 ? "approval" : "approvals"}`;
}

function joinActionRuleReviewClauses(clauses: readonly string[]): string {
  return clauses
    .map((clause) => clause.trim().replace(/[.!?;:,]+$/u, ""))
    .filter(Boolean)
    .map((clause) => `${clause}.`)
    .join(" ");
}

function semanticActionReviewLines(compiled: CompiledActionRuleModelDraftV1): string[] {
  const privateFacts = compiled.verification_boundary.resources.map((resource) =>
    `${resource.binding}: ${resource.resource} (${resource.fields
      .filter((field) => !field.model_visible)
      .map((field) => field.name)
      .join(", ") || "reviewed visible facts only"})`);
  const approval = compiled.approval_class.mode === "policy"
    ? `automatic only when the separate reviewed policy passes; otherwise ${compiled.approval_class.required_approvals} ${compiled.approval_class.required_role}`
    : `${compiled.approval_class.required_approvals} ${compiled.approval_class.required_role}`;
  const approvalRule = compiled.approval_class.rules.find((rule) => rule.outcome === compiled.rule.outcome);
  const automatic = compiled.approval_class.mode === "policy" && approvalRule?.auto_approve_when
    ? [
        actionRuleBooleanSummary(approvalRule.auto_approve_when),
        ...compiled.approval_class.shared_limits.map(actionRuleSharedLimitSummary),
      ].join("; ")
    : "none; eligible proposals require human review";
  return [
    `Outcome: ${compiled.rule.outcome}`,
    `Agent request: this outcome plus ${compiled.rule.subjects.length} opaque subject reference${compiled.rule.subjects.length === 1 ? "" : "s"}; no patch or trusted scope`,
    ...(compiled.draft.discovery ? [
      `Client title: ${compiled.draft.discovery.title}`,
      `Client description: ${compiled.draft.discovery.summary}`,
      `Client search phrases: ${compiled.draft.discovery.aliases?.join(", ") || "None"}`,
      "Client wording is public discovery metadata, not proof of this customer's eligibility.",
    ] : []),
    `Privately verifies: ${privateFacts.join("; ")}`,
    `WHEN: ${compiled.review.when}`,
    `THEN: ${compiled.review.then}`,
    `Refuse: ${joinActionRuleReviewClauses(compiled.review.refused)}`,
    `Human review: ${compiled.review.human_review}`,
    `Auto-approve: ${automatic}`,
    `Approval: ${approval}`,
    `Apply: ${compiled.effect_envelope.writeback.mode === "none" ? "proposal only; no source write" : "separately supervised; never model authority"}`,
    ...(compiled.rule.atomic_updates ? ["Atomic updates (all succeed or all roll back):",
      ...[compiled.rule.effect, ...compiled.rule.atomic_updates].map((effect) =>
        `${effect.target_resource} [${effect.target_binding}]: ${Object.entries(effect.set).map(([field, expression]) => `${field} = ${actionRuleScalarSummary(expression)}`).join("; ")}`)] : []),
    ...compiled.review.examples.map((example) =>
      `Example (${example.kind}): ${example.scenario} -> ${example.result}`),
  ];
}

function semanticActionNarrationFacts(compiled: CompiledActionRuleModelDraftV1): string[] {
  const approvalRule = compiled.approval_class.rules.find((rule) => rule.outcome === compiled.rule.outcome);
  const approval = compiled.approval_class.mode === "policy" && approvalRule?.auto_approve_when
    ? `Auto-approve only when ${actionRuleBooleanSummary(approvalRule.auto_approve_when)}; every miss or unknown result uses ${compiled.review.human_review}`
    : `Human review: ${compiled.review.human_review}`;
  return [
    `Outcome: ${compiled.rule.outcome}`,
    `WHEN: ${compiled.review.when}`,
    `THEN: ${compiled.review.then}`,
    `Refuse: ${joinActionRuleReviewClauses(compiled.review.refused)}`,
    approval,
    ...(compiled.rule.atomic_updates ? [`Confirmed atomic completion: ${1 + compiled.rule.atomic_updates.length} separately version-guarded records change together or all changes roll back. Exact effects: ${JSON.stringify([compiled.rule.effect, ...compiled.rule.atomic_updates])}.`] : []),
    `Apply posture: ${compiled.effect_envelope.writeback.mode === "none" ? "proposal only" : "separately supervised and currently off"}`,
  ];
}

export function semanticActionActivationReviewLines(compiled: CompiledActionRuleModelDraftV1, read: ExplorationBoundaryDraft, width: number): string[] {
  const business = semanticActionBusinessReviewLines(compiled, read);
  return renderRunnerResultPanel({
    result: business[0]!.replace(/^Change: /u, ""),
    checked: business.slice(1).filter((line) => !line.startsWith("Completion:")).join("\n"),
    changed: "Allow the assistant to submit requests under these rules. This decision does not execute a change.",
    decision: "Enable these reviewed requests, or keep the draft disabled.",
    notChecked: "Live customer completion and client behavior.",
    next: compiled.effect_envelope.writeback.mode === "none"
      ? "Connect your client. Automatic execution is not configured. /details shows every rule."
      : "Review the write connection and execution separately, then connect your client. /details shows every rule.",
  }, width);
}

/** Summarize the compiled conditions/effect, never model-authored review prose. */
export function semanticActionBusinessReviewLines(compiled: CompiledActionRuleModelDraftV1, read: ExplorationBoundaryDraft): string[] {
  const words = (value: string) => value.replaceAll("_", " ");
  const resources = new Map(read.pack.resources.map((resource) => [resource.id, resource]));
  const fieldNames = new Map<string, string>();
  for (const binding of compiled.verification_boundary.resources) {
    const resource = resources.get(binding.resource);
    for (const field of binding.fields) fieldNames.set(`${binding.binding}.${field.name}`,
      `${resource?.label ?? words(binding.binding)} ${resource?.field_metadata?.[field.name]?.label ?? words(field.name)}`);
  }
  const target = resources.get(compiled.rule.effect.target_resource);
  const targetBinding = compiled.verification_boundary.resources.find((entry) => entry.binding === compiled.effect_envelope.target_binding);
  let selectedBinding = targetBinding;
  const visited = new Set<string>();
  while (selectedBinding?.source.kind === "relationship" && !visited.has(selectedBinding.binding)) {
    visited.add(selectedBinding.binding);
    const fromBinding = selectedBinding.source.from_binding;
    selectedBinding = compiled.verification_boundary.resources.find((entry) => entry.binding === fromBinding);
  }
  const selectedName = selectedBinding && (resources.get(selectedBinding.resource)?.label ?? words(selectedBinding.binding));
  const changed = Object.entries(compiled.rule.effect.set).map(([field, value]) =>
    `${target?.field_metadata?.[field]?.label ?? words(field)} becomes ${actionRuleScalarSummary(value, fieldNames)}`);
  const expressions = Object.values(compiled.rule.effect.set);
  const sourceBindings = [...new Set(expressions.flatMap((value) => value.kind === "field" ? [value.binding] : []))];
  const sourceNames = sourceBindings.map((binding) => {
    const resource = compiled.verification_boundary.resources.find((entry) => entry.binding === binding)?.resource;
    return (resource && resources.get(resource)?.label) || words(binding);
  });
  const effect = sourceNames.length && expressions.every((value) => value.kind === "field")
    ? `terms come from verified ${sourceNames.join(" and ")} records`
    : changed.join("; ");
  const policy = compiled.approval_class;
  const automatic = policy.rules.find((rule) => rule.outcome === compiled.rule.outcome)?.auto_approve_when;
  const reviewers = `${policy.required_approvals} ${policy.required_approvals > 1 ? "distinct " : ""}${words(policy.required_role)} approval${policy.required_approvals === 1 ? "" : "s"}`;
  return [
    `Change: ${compiled.draft.discovery?.title ?? words(compiled.rule.outcome.split(".").at(-1)!)}. ${compiled.rule.effect.operation === "insert" ? "Create" : "Update"} one ${target?.label ?? words(target?.table ?? compiled.rule.effect.target_resource)} record; ${effect}.`,
    ...(compiled.rule.atomic_updates ? [
      ...compiled.rule.atomic_updates.map((effect) => {
        const related = resources.get(effect.target_resource);
        return `Also changes: ${related?.label ?? words(effect.target_resource.split(".").at(-1)!)} - ${Object.entries(effect.set).map(([field, value]) =>
          `${related?.field_metadata?.[field]?.label ?? words(field)} becomes ${actionRuleScalarSummary(value, fieldNames)}`).join("; ")}.`;
      }),
      "Saved together: every record is checked for intervening changes. All updates succeed in one transaction, or none are saved.",
    ] : []),
    ...(compiled.rule.effect.operation === "update" && selectedBinding?.source.kind === "subject_ref"
      ? [`Target: only ${targetBinding === selectedBinding ? `the selected ${selectedName} record` : `the record linked to the selected ${selectedName} through the reviewed relationship${visited.size > 1 ? "s" : ""}`}; Runner verifies that selection and its trusted scope before any change.`]
      : []),
    `Eligibility: ${actionRuleBooleanSummary(compiled.rule.require, fieldNames)}. Missing or failed eligibility checks are refused, not sent for human approval.`,
    policy.mode === "policy" && automatic
      ? `Approval: automatic ${actionRuleBooleanIsUnconditional(automatic) ? "for valid requests" : `only when ${actionRuleBooleanSummary(automatic, fieldNames)}`}; other valid requests, including limit overruns, require ${reviewers}.`
      : `Approval: every valid request requires ${reviewers}.`,
    ...(policy.mode === "policy" ? [`Approval limits: ${automaticApprovalBusinessSummary(compiled, read)}.`] : []),
    `Completion: ${compiled.effect_envelope.writeback.mode === "none" ? "proposal only; automatic execution is not configured" : "automatic execution is prepared for separate review, not enabled by this Read decision"}.`,
  ];
}

function actionRuleSharedLimitSummary(limit: ActionBoundarySharedLimitV1): string {
  const scope = {
    boundary: "Action Boundary",
    capability: "outcome",
    tenant: "trusted tenant",
    tenant_principal: "trusted tenant + principal",
    tenant_object: "trusted tenant + subject",
  }[limit.scope];
  const quantity = limit.kind === "count"
    ? `${limit.maximum} ${limit.maximum === 1 ? "approval" : "approvals"}`
    : `${limit.maximum} total ${limit.field ?? "reviewed value"}`;
  return `${quantity} per ${scope} / ${actionRuleDurationSummary(limit.window_seconds)}`;
}

function actionRuleBooleanIsUnconditional(expression: ActionRuleBooleanExpressionV1): boolean {
  if (expression.kind === "all") {
    return expression.expressions.every(actionRuleBooleanIsUnconditional);
  }
  if (expression.kind === "any") {
    return expression.expressions.some(actionRuleBooleanIsUnconditional);
  }
  if (expression.kind !== "compare" || expression.operator !== "eq") return false;
  return expression.left.kind === "literal"
    && expression.right.kind === "literal"
    && JSON.stringify(expression.left.value) === JSON.stringify(expression.right.value)
    && JSON.stringify(expression.left.value_type) === JSON.stringify(expression.right.value_type);
}

function actionRuleDurationSummary(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} seconds`;
}

function actionRuleBooleanSummary(expression: ActionRuleBooleanExpressionV1, fieldNames?: ReadonlyMap<string, string>): string {
  switch (expression.kind) {
    case "all":
      return expression.expressions.map((item) => `(${actionRuleBooleanSummary(item, fieldNames)})`).join(fieldNames ? " and " : " AND ");
    case "any":
      return expression.expressions.map((item) => `(${actionRuleBooleanSummary(item, fieldNames)})`).join(fieldNames ? " or " : " OR ");
    case "not":
      return `NOT (${actionRuleBooleanSummary(expression.expression, fieldNames)})`;
    case "compare":
      return `${actionRuleScalarSummary(expression.left, fieldNames)} ${fieldNames
        ? ({ eq: "matches", neq: "differs from", lt: "is less than", lte: "is at most", gt: "is greater than", gte: "is at least" })[expression.operator]
        : actionRuleComparisonSymbol(expression.operator)} ${actionRuleScalarSummary(expression.right, fieldNames)}`;
    case "null_check":
      return `${actionRuleScalarSummary(expression.value, fieldNames)} ${expression.operator === "is_null" ? "is null" : "is not null"}`;
    case "in":
      return `${actionRuleScalarSummary(expression.value, fieldNames)} is one of ${expression.values.map((value) => actionRuleScalarSummary(value, fieldNames)).join(", ")}`;
    case "exists":
      return `a reviewed ${expression.binding} row exists where ${actionRuleBooleanSummary(expression.where, fieldNames)}`;
  }
}

function actionRuleComparisonSymbol(operator: Extract<ActionRuleBooleanExpressionV1, { kind: "compare" }>["operator"]): string {
  return ({ eq: "=", neq: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" })[operator];
}

function actionRuleScalarSummary(expression: ActionRuleScalarExpressionV1, fieldNames?: ReadonlyMap<string, string>): string {
  switch (expression.kind) {
    case "input":
      return `reviewed business input ${expression.name}`;
    case "literal":
      return actionRuleLiteralSummary(expression.value, expression.value_type);
    case "trusted":
      return fieldNames && expression.binding === "transaction_time" ? "the current time" : `trusted ${expression.binding.replaceAll("_", " ")}`;
    case "field":
      return fieldNames?.get(`${expression.binding}.${expression.field}`) ?? `${expression.binding}.${expression.field}`;
    case "derived":
      return `derived ${expression.name}`;
    case "aggregate":
      return `${expression.operation}(${expression.binding}${expression.field ? `.${expression.field}` : ""}${expression.where ? ` where ${actionRuleBooleanSummary(expression.where, fieldNames)}` : ""})`;
    case "math":
      return `${expression.operation}(${expression.inputs.map((value) => actionRuleScalarSummary(value, fieldNames)).join(", ")})`;
    case "scale":
      return `${expression.operation}(${actionRuleScalarSummary(expression.input, fieldNames)}, ${expression.constant}; ${expression.rounding})`;
    case "clamp":
      return `clamp(${actionRuleScalarSummary(expression.input, fieldNames)}, ${actionRuleScalarSummary(expression.minimum, fieldNames)}, ${actionRuleScalarSummary(expression.maximum, fieldNames)})`;
    case "date_of":
      return `the UTC calendar day of ${actionRuleScalarSummary(expression.timestamp, fieldNames)}`;
    case "add_duration":
      return `${actionRuleScalarSummary(expression.timestamp, fieldNames)} + ${actionRuleDurationSummary(expression.seconds)}`;
  }
}

function actionRuleLiteralSummary(
  value: unknown,
  type: ActionRuleScalarTypeSpecV1,
): string {
  if (type.kind === "money_minor" && typeof value === "number") {
    return `${value} ${type.currency} minor units`;
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

async function actionRuleAuthorityDraftFromCompiled(
  projectRoot: string,
  compiled: CompiledActionRuleModelDraftV1,
  preparedExisting?: ActionRuleAuthorityDraftV1,
  readRevision?: { nextBoundary: ExplorationBoundaryDraft; inspection: SchemaInspection; revalidateMetadata?: boolean },
): Promise<ActionRuleAuthorityDraftV1> {
  const authority = compiled.loaded.authority;
  const createdAt = authority.rules[0]?.activated_at;
  if (!createdAt) throw new Error("ACTION_RULE_MODEL_DRAFT_INCOMPLETE: the compiled authority has no rule revision.");
  const incoming = buildActionRuleAuthorityDraft({
    name: authority.name,
    action_boundary_name: authority.action_boundary.name,
    catalog: authority.catalog,
    rules: authority.rules.map(({ activated_at: _activatedAt, ...source }) => source),
    approval_classes: authority.approval_classes,
    reviews: [{ outcome: compiled.rule.outcome, ...structuredClone(compiled.review) }],
    now: createdAt,
  });
  let existingDraft = preparedExisting ?? await readActionRuleAuthorityDraft(projectRoot, incoming.authority.name);
  if (readRevision) {
    const expectedReadDigest = explorationBoundaryCandidateDigest(readRevision.nextBoundary);
    if (incoming.authority.rules.some((rule) => rule.read_boundary_name !== readRevision.nextBoundary.pack.name
      || rule.read_boundary_digest !== expectedReadDigest)) {
      throw new Error("ACTION_RULE_REVISION_STALE: the compiled Action outcome is not bound to the exact current Read revision.");
    }
  }
  if (existingDraft && existingDraft.authority.catalog.generation_lock_fingerprint !== incoming.authority.catalog.generation_lock_fingerprint) {
    if (!readRevision || readRevision.nextBoundary.generation_lock_fingerprint !== incoming.authority.catalog.generation_lock_fingerprint) {
      throw new Error("ACTION_RULE_REVISION_STALE: a saved Action draft uses a different Read generation lock. Reopen the exact Read review before merging outcomes.");
    }
    existingDraft = await rebindStoredActionRuleAuthorityDraftForReadRevision({
      projectRoot,
      existing: existingDraft,
      nextBoundary: readRevision.nextBoundary,
      inspection: readRevision.inspection,
      revalidateMetadata: readRevision.revalidateMetadata,
    });
  }
  const active = existingDraft === undefined
    ? await readActionRuleAuthorityActivation(projectRoot)
    : undefined;
  if (active !== undefined && active.authority.name !== incoming.authority.name) {
    throw new Error(
      `ACTION_RULE_AUTHORITY_NAMESPACE_CONFLICT: active verified Action authority ${active.authority.name} must be explicitly deactivated before a different authority bundle can replace it.`,
    );
  }
  if (active && active.authority.catalog.generation_lock_fingerprint !== incoming.authority.catalog.generation_lock_fingerprint) {
    if (!readRevision || readRevision.nextBoundary.generation_lock_fingerprint !== incoming.authority.catalog.generation_lock_fingerprint) {
      throw new Error("ACTION_RULE_REVISION_STALE: active Action authority uses a different Read generation lock. Reopen the exact Read review before preparing a disabled replacement.");
    }
    existingDraft = await rebindActiveActionRuleAuthorityForReadRevision({
      projectRoot,
      active,
      nextBoundary: readRevision.nextBoundary,
      inspection: readRevision.inspection,
      revalidateMetadata: readRevision.revalidateMetadata,
    });
  }
  return mergeActionRuleAuthorityDraft({
    existing: existingDraft ?? active,
    incoming,
    now: createdAt,
  });
}

function noModelActionSupportEntries(input: {
  actionIntents: string[];
  options: Awaited<ReturnType<typeof guidedActionOptions>>;
  existingIds: string[];
}): ReadWorkloadSet["allowed"] {
  const entries: ReadWorkloadSet["allowed"] = [];
  for (const [index, intent] of input.actionIntents.entries()) {
    let preparation: ReturnType<typeof prepareQuickProposalAction>;
    try {
      preparation = prepareQuickProposalAction({ options: input.options, intent });
    } catch {
      // Action readiness belongs to the separate Action Boundary review. This
      // helper may preserve a proven target, but must not block that review.
      continue;
    }
    const resources = preparation.state === "ready"
      ? [preparation.action.resource]
      : preparation.selected.resource
        ? [preparation.selected.resource]
        : preparation.recommendations.resource
          ? [preparation.recommendations.resource]
          : preparation.decision.kind === "resource"
            ? preparation.decision.choices.map((choice) => choice.value).slice(0, 8)
            : [];
    for (const resource of [...new Set(resources)]) {
      const id = uniqueWorkloadEntryId(
        `action_review_${index + 1}`,
        [...input.existingIds, ...entries.map((entry) => entry.id)],
      );
      entries.push({
        id,
        description: `Review the exact fields required to propose a change to ${resource}.`,
        plan: {
          kind: "aggregate",
          resource,
          measures: [{ function: "count" }],
          top_n: 1,
        },
      });
    }
  }
  return entries;
}

function representativeReadCoverage(analysis: ReadWorkloadView["analysis"]): {
  supported: number;
  total: number;
} {
  const requested = analysis.allowed.filter((entry) =>
    !((entry.id.startsWith("action_review_")
      && entry.description.startsWith("Review the exact fields required to "))
      || entry.id.startsWith("semantic_action_subject_")));
  return {
    supported: requested.filter((entry) => entry.status === "supported").length,
    total: requested.length,
  };
}

function modelReadPlanSummary(plan: ReadWorkloadSet["allowed"][number]["plan"]): string {
  const resource = typeof plan.resource === "string" ? plan.resource : "reviewed resource";
  if (plan.kind === "rows") {
    const selected = Array.isArray(plan.select)
      ? plan.select.filter((field): field is string => typeof field === "string")
      : [];
    const related = Array.isArray(plan.related) ? plan.related.flatMap((entry) =>
      isCliRecord(entry) && typeof entry.relationship === "string" && Array.isArray(entry.select)
        ? entry.select.filter((field): field is string => typeof field === "string").map((field) => `${entry.relationship} -> ${field}`)
        : []) : [];
    return `${resource}: return ${[...selected, ...related].join(", ") || "reviewed rows"}`;
  }
  const dimensions = Array.isArray(plan.dimensions)
    ? plan.dimensions.flatMap((dimension) => {
        if (!isCliRecord(dimension) || typeof dimension.field !== "string") return [];
        return [typeof dimension.relationship === "string"
          ? `${dimension.relationship} -> ${dimension.field}`
          : dimension.field];
      })
    : [];
  const measures = Array.isArray(plan.measures)
    ? plan.measures.flatMap((measure) => {
        if (!isCliRecord(measure) || typeof measure.function !== "string") return [];
        return [typeof measure.field === "string" && measure.field
          ? `${measure.function}(${measure.field})`
          : `${measure.function}(*)`];
      })
    : [];
  const summary = [
    ...(dimensions.length ? [`group by ${dimensions.join(", ")}`] : []),
    ...measures,
  ].join("; ");
  return `${resource}: ${summary || "reviewed aggregate"}`;
}

function parseReadWorkloadCardSelection(input: string, ids: string[]): string[] {
  const normalized = input.trim().toLowerCase();
  if (normalized === "all") return [...ids];
  if (!normalized) {
    throw new Error("Choose at least one representative question number.");
  }
  const indexes = new Set<number>();
  for (const token of normalized.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start || end > ids.length) {
        throw new Error(`Question range ${token} is outside 1-${ids.length}.`);
      }
      for (let index = start; index <= end; index += 1) indexes.add(index - 1);
      continue;
    }
    if (!/^\d+$/.test(token)) {
      throw new Error(`Question selection ${token} is not a number or range.`);
    }
    const index = Number(token);
    if (index < 1 || index > ids.length) {
      throw new Error(`Question number ${index} is outside 1-${ids.length}.`);
    }
    indexes.add(index - 1);
  }
  return [...indexes].sort((left, right) => left - right).map((index) => ids[index]!);
}

async function interactiveBoundaryLimitsReview(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
}): Promise<number> {
  const context = await loadBoundaryReviewContext(input.projectRoot);
  const budgets = context.candidate.budgets;
  const options: Array<{
    key: keyof BoundaryResourceReviewRequest;
    label: string;
    current: number;
    minimum: number;
    maximum: number;
    unit: string;
    consequence: string;
  }> = [
    { key: "max_queries_per_session", label: "Query volume", current: budgets.max_queries_per_session, minimum: 1, maximum: 1_000, unit: "per rolling 24 hours", consequence: "throughput for one trusted scope" },
    { key: "rate_limit_per_minute", label: "Request rate", current: budgets.rate_limit_per_minute, minimum: 1, maximum: 120, unit: "per minute", consequence: "short-window throughput for one trusted scope" },
    { key: "max_rows", label: "Returned rows", current: budgets.max_rows, minimum: 1, maximum: EXPLORATION_BUDGET_REVIEW_CEILINGS.max_rows, unit: "rows", consequence: "maximum row-list result shape" },
    { key: "max_groups", label: "Aggregate groups", current: budgets.max_groups, minimum: budgets.max_top_n, maximum: EXPLORATION_BUDGET_REVIEW_CEILINGS.max_groups, unit: "groups", consequence: "maximum non-ranked aggregate result shape" },
    { key: "max_top_n", label: "Returned top N", current: budgets.max_top_n, minimum: 1, maximum: Math.min(EXPLORATION_BUDGET_REVIEW_CEILINGS.max_top_n, budgets.max_groups), unit: "groups", consequence: "maximum rows returned after suppression and ranking" },
    { key: "max_measures", label: "Measures", current: budgets.max_measures, minimum: 1, maximum: EXPLORATION_BUDGET_REVIEW_CEILINGS.max_measures, unit: "per aggregate", consequence: "maximum reviewed aggregate values in one plan" },
    { key: "max_dimensions", label: "Dimensions", current: budgets.max_dimensions, minimum: 1, maximum: EXPLORATION_BUDGET_REVIEW_CEILINGS.max_dimensions, unit: "per aggregate", consequence: "maximum reviewed grouping fields in one plan" },
    { key: "max_response_cells", label: "Response cells", current: budgets.max_response_cells, minimum: 1, maximum: EXPLORATION_BUDGET_REVIEW_CEILINGS.max_response_cells, unit: "cells", consequence: "per-response egress; rolling extracted-cell accounting remains separate" },
    { key: "max_response_bytes", label: "Response bytes", current: budgets.max_response_bytes, minimum: 1_024, maximum: EXPLORATION_BUDGET_REVIEW_CEILINGS.max_response_bytes, unit: "bytes", consequence: "serialized response bound" },
    { key: "statement_timeout_ms", label: "Statement timeout", current: budgets.statement_timeout_ms, minimum: 100, maximum: EXPLORATION_BUDGET_REVIEW_CEILINGS.statement_timeout_ms, unit: "milliseconds", consequence: "source execution deadline" },
    { key: "max_derived_scope_hops", label: "Derived-scope depth", current: budgets.max_derived_scope_hops ?? budgets.max_relationship_hops, minimum: 1, maximum: 3, unit: "proven hops", consequence: "mandatory tenant/principal scope traversal" },
    { key: "max_analysis_relationship_hops", label: "Analysis-path depth", current: budgets.max_analysis_relationship_hops ?? budgets.max_relationship_hops, minimum: 1, maximum: 3, unit: "proven hops", consequence: "reviewed many-to-one analysis traversal" },
  ];
  const limitMenu = [
    "BOUNDARY LIMITS",
    ...options.slice(0, 2).map((option, index) =>
      `${index + 1}  ${option.label.padEnd(22)} ${option.current} ${option.unit}`),
    `3  ${"Ranked candidate groups".padEnd(22)} ${budgets.max_ranked_groups ?? budgets.max_groups} groups`,
    ...options.slice(2).map((option, index) =>
      `${index + 4}  ${option.label.padEnd(22)} ${option.current} ${option.unit}`),
    "",
    "Throughput controls bound request volume. Shape controls bound one validated result.",
    "Relationship depth is capped at three catalog-proven many-to-one hops.",
    "These settings do not change small-group suppression, rolling extracted-cell accounting, or differencing protection.",
  ];
  const selected = await input.session.promptText(
    `Limit to review [1-${options.length + 1}; Esc returns]`,
    { context: limitMenu },
  );
  if (selected === undefined || !selected.trim()) {
    process.stdout.write("Returned to boundary review. No limit changed.\n");
    return 0;
  }
  if (selected.trim() === "3") return interactiveRankedGroupReview(input);
  const selectedNumber = Number(selected.trim());
  const option = Number.isSafeInteger(selectedNumber)
    ? selectedNumber < 3
      ? options[selectedNumber - 1]
      : options[selectedNumber - 2]
    : undefined;
  if (!option) {
    process.stdout.write(`Choose 1 through ${options.length + 1}. No limit changed.\n`);
    return 0;
  }
  const entered = await input.session.promptText(
    `${option.label} [${option.current}] (${option.minimum}-${option.maximum} ${option.unit})`,
    {
      context: [
        "BOUNDARY LIMITS",
        `Selected: ${option.label}`,
        `Current: ${option.current} ${option.unit}`,
        `Effect: ${option.consequence}`,
      ],
    },
  );
  if (entered === undefined) {
    process.stdout.write("Returned to boundary review. No limit changed.\n");
    return 0;
  }
  const value = entered.trim() ? Number(entered.trim()) : option.current;
  if (!Number.isSafeInteger(value) || value < option.minimum || value > option.maximum) {
    process.stdout.write([
      `Use an integer from ${option.minimum} through ${option.maximum}.`,
      "This reviewed setting cannot change suppression, extracted-cell, or differencing controls.",
      "No boundary setting changed.",
      "",
    ].join("\n"));
    return 0;
  }
  if (value === option.current) {
    process.stdout.write("The selected reviewed limit is unchanged.\n");
    return 0;
  }
  const accepted = await input.session.confirm(
    `Set ${option.label.toLowerCase()} to ${value} ${option.unit}? This changes ${option.consequence}.`,
    {
      defaultValue: true,
      context: [
        "REVIEW BOUNDARY LIMIT",
        `${option.label}: ${option.current} -> ${value} ${option.unit}`,
        "Suppression, extracted-cell accounting, and differencing protection do not change.",
        "This saves a disabled revision; active authority does not change yet.",
      ],
    },
  );
  if (!accepted) {
    process.stdout.write("The selected reviewed limit was not changed.\n");
    return 0;
  }
  const resourceId = context.candidate.pack.resources[0]?.id;
  if (!resourceId) throw new Error("A boundary needs one reviewed table before its limits can be changed.");
  const request = {
    resource_id: resourceId,
    [option.key]: value,
    actor: localInteractiveActor(),
    reason: `Reviewed ${option.label.toLowerCase()} for this boundary.`,
  } as BoundaryResourceReviewRequest;
  const preview = await prepareBoundaryResourceReviewMutation(
    input.projectRoot,
    request,
    input.schemaInspector,
  );
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Saved ${option.label.toLowerCase()} limit ${value} in disabled boundary revision ${committed.review_revision}.`,
    "Small-group suppression, extracted-cell, and differencing privacy controls are unchanged.",
    "Review and activate the boundary to apply this limit. Agent authority changed: no.",
    "",
  ].join("\n"));
  return 0;
}

async function interactiveRankedGroupReview(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
}): Promise<number> {
  const context = await loadBoundaryReviewContext(input.projectRoot);
  const current = context.candidate.budgets.max_ranked_groups
    ?? context.candidate.budgets.max_groups;
  const generatedMaximum = EXPLORATION_BUDGET_REVIEW_CEILINGS.max_ranked_groups
    ?? context.draft.budgets.max_ranked_groups
    ?? context.draft.budgets.max_groups;
  const entered = await input.session.promptText(
    `Ranked underlying groups [${current}] (${context.candidate.budgets.max_groups}-${generatedMaximum}): `,
    {
      context: [
        "BOUNDARY LIMITS - RANKED CANDIDATE GROUPS",
        `Current underlying-group limit: ${current}`,
        `Returned results remain capped at top ${context.candidate.budgets.max_top_n}.`,
        "Suppression runs before ranking; this setting does not weaken privacy controls.",
      ],
    },
  );
  if (entered === undefined) {
    process.stdout.write("Returned to boundary review. The ranked limit was not changed.\n");
    return 0;
  }
  const value = entered.trim() ? Number(entered.trim()) : current;
  if (!Number.isSafeInteger(value)
    || value < context.candidate.budgets.max_groups
    || value > generatedMaximum) {
    process.stdout.write([
      `Use an integer from ${context.candidate.budgets.max_groups} through ${generatedMaximum}.`,
      "This limit controls how many underlying groups a top/bottom query may consider; it does not change the returned top-N.",
      "No boundary setting changed.",
      "",
    ].join("\n"));
    return 0;
  }
  if (value === current) {
    process.stdout.write("The ranked aggregate limit is unchanged.\n");
    return 0;
  }
  const accepted = await input.session.confirm(
    `Allow ranked queries to consider at most ${value} underlying groups while returning at most ${context.candidate.budgets.max_top_n}?`,
    {
      defaultValue: true,
      context: [
        "REVIEW RANKED CANDIDATE LIMIT",
        `Underlying groups: ${current} -> ${value}`,
        `Returned top N: ${context.candidate.budgets.max_top_n} (unchanged)`,
        "Suppression, extracted-cell accounting, and differencing protection remain unchanged.",
      ],
    },
  );
  if (!accepted) {
    process.stdout.write("The ranked aggregate limit was not changed.\n");
    return 0;
  }
  const resourceId = context.candidate.pack.resources[0]?.id;
  if (!resourceId) throw new Error("A boundary needs one reviewed table before its ranked limit can be changed.");
  const preview = await prepareBoundaryResourceReviewMutation(
    input.projectRoot,
    {
      resource_id: resourceId,
      max_ranked_groups: value,
      actor: localInteractiveActor(),
      reason: "Reviewed the maximum underlying groups for bounded ranked aggregate queries.",
    },
    input.schemaInspector,
  );
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Saved ranked aggregate limit ${value} in disabled boundary revision ${committed.review_revision}.`,
    `Returned results remain capped at top ${context.candidate.budgets.max_top_n}.`,
    "Suppression runs before ranking. Agent authority changed: no.",
    "",
  ].join("\n"));
  return 0;
}

type ReviewedAnalyticsOperand = ExplorationDerivedBaseMeasure;

type ReviewedAnalyticsFieldChoice = {
  label: string;
  field: string;
  relationship?: string;
};

type ReviewedAnalyticsOperandChoice = {
  label: string;
  value: ReviewedAnalyticsOperand;
};

async function interactiveReviewedRelationshipPathReview(input: {
  projectRoot: string;
  resourceId: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
}): Promise<number> {
  if (!input.session.editRelationshipPaths) {
    process.stdout.write([
      "This terminal session cannot open the relationship-path editor.",
      `Use boundary review resource ${input.resourceId} --map --details to inspect scripted review IDs.`,
      "No change was made.",
      "",
    ].join("\n"));
    return 0;
  }
  const summary = (await listBoundaryResourceReviews(input.projectRoot)).find((resource) =>
    resource.resource_id === input.resourceId);
  if (!summary) {
    process.stdout.write(`${input.resourceId} is no longer present in the current boundary review. No change was made.\n\n`);
    return 0;
  }
  const selected = await input.session.editRelationshipPaths(input.view, summary);
  if (!selected || selected === "back") return 0;

  const generatedRelationship = input.view.generated_candidate?.relationships.find(
    (relationship) => relationship.id === selected.relationship_id,
  );
  if (!generatedRelationship) {
    process.stdout.write([
      `Relationship ${selected.relationship_id} is no longer available in the inspected catalog.`,
      "Rescan and review the current path proof. No change was made.",
      "",
    ].join("\n"));
    return 0;
  }
  const display = {
    source_resource: input.resourceId,
    target_resource: generatedRelationship.target_resource,
    links: generatedRelationship.proof?.links,
  };
  const pathLabel = formatRelationshipPath(display);
  const currentIds = new Set(input.view.candidate?.relationships.map((relationship) =>
    relationship.id) ?? []);
  const nextIds = new Set(currentIds);
  if (selected.action === "add") nextIds.add(selected.relationship_id);
  else nextIds.delete(selected.relationship_id);

  if (selected.action === "remove") {
    const confirmed = await input.session.confirm(
      `Remove the reviewed analysis path ${pathLabel} from the disabled boundary? Queries that need it will be refused after activation.`,
      {
        defaultValue: false,
        context: [
          "REMOVE REVIEWED ANALYSIS PATH",
          pathLabel,
          ...(formatRelationshipJoinColumns(display)
            ? [`via columns: ${formatRelationshipJoinColumns(display)}`]
            : []),
          `path ID: ${selected.relationship_id}`,
        ],
      },
    );
    if (!confirmed) {
      process.stdout.write("Relationship-path removal cancelled. No draft or active authority changed.\n\n");
      return 0;
    }
  }

  let unmatchedRows: "exclude" | "keep_null" | undefined;
  if (selected.action === "add" && generatedRelationship.nullable === true) {
    const unmatchedRowMenu = [
      "OPTIONAL RELATIONSHIP",
      `The path ${pathLabel} contains an optional relationship. Choose how unmatched root rows behave:`,
      "  1  Exclude unmatched rows from this analysis",
      "  2  Keep unmatched rows under an empty/null related value",
    ];
    const choice = await input.session.promptText(
      "Missing related rows [1-2; Esc returns]",
      { context: unmatchedRowMenu },
    );
    if (choice === undefined) {
      process.stdout.write("Relationship review cancelled. No draft or active authority changed.\n\n");
      return 0;
    }
    unmatchedRows = choice.trim() === "1"
      ? "exclude"
      : choice.trim() === "2"
        ? "keep_null"
        : undefined;
    if (!unmatchedRows) {
      process.stdout.write("Choose 1 or 2. No relationship decision was saved.\n\n");
      return 0;
    }
  }

  const reason = await requiredReviewedRelationshipReason(
    input.session,
    selected.action,
    pathLabel,
  );
  if (reason === undefined) {
    process.stdout.write("Relationship review cancelled. No draft or active authority changed.\n\n");
    return 0;
  }

  try {
    const preview = await prepareBoundaryResourceReviewMutation(input.projectRoot, {
      resource_id: input.resourceId,
      relationship_ids: [...nextIds].sort(),
      ...(unmatchedRows
        ? {
            nullable_relationship: {
              relationship_id: selected.relationship_id,
              unmatched_rows: unmatchedRows,
            },
          }
        : {}),
      actor: localInteractiveActor(),
      reason,
    }, input.schemaInspector);
    const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
    process.stdout.write([
      `${selected.action === "add" ? "Saved" : "Removed"} reviewed relationship path in disabled boundary revision ${committed.review_revision}:`,
      `  ${pathLabel}`,
      ...(formatRelationshipJoinColumns(display)
        ? [`  via columns: ${formatRelationshipJoinColumns(display)}`]
        : []),
      "Active authority changed: no",
      "Press C in /access to review and activate this exact boundary revision.",
      "",
    ].join("\n"));
  } catch (error) {
    process.stdout.write([
      `Relationship decision was not saved: ${redactCliErrorMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
      "You are still in /access. No draft decision was committed and no authority was activated.",
      "",
    ].join("\n"));
  }
  return 0;
}

async function requiredReviewedRelationshipReason(
  session: BoundaryReviewInteractiveSession,
  action: "add" | "remove",
  pathLabel: string,
): Promise<string | undefined> {
  while (true) {
    const reason = await session.promptText(
      `${action === "add" ? "Why may this exact relationship be used" : "Why should this relationship be removed"} (${pathLabel})? A concrete reason is required`,
    );
    if (reason === undefined) return undefined;
    if (reason.trim()) return reason.trim();
    process.stdout.write("A concrete relationship-review reason is required; no change was made.\n");
  }
}

async function interactiveReviewedAnalyticsReview(input: {
  projectRoot: string;
  resourceId: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
}): Promise<number> {
  const context = await loadBoundaryReviewContext(input.projectRoot);
  const resource = context.candidate.pack.resources.find((item) => item.id === input.resourceId);
  if (!resource) {
    process.stdout.write(`${input.resourceId} is not in this disabled boundary. No change was made.\n`);
    return 0;
  }
  const serverCompatibility = context.lock.database_server_version
    ? databaseServerCompatibility({
      engine: context.lock.engine,
      server_version: context.lock.database_server_version,
    })
    : undefined;
  const automaticBandsAvailable = context.lock.database_server_authority
    ? databaseGrammarFeatureAvailable(
      context.lock.database_server_authority,
      "automatic_numeric_bands",
    )
    : serverCompatibility?.authority
      ? databaseGrammarFeatureAvailable(
        serverCompatibility.authority,
        "automatic_numeric_bands",
      )
      : true;
  const analyticsMenu = [
    `REVIEWED ANALYTICS - ${input.resourceId}`,
    "These are human-reviewed limits. The AI can select only the choices shown by Runner; it cannot send formulas, bucket edges, or joins.",
    "1  Add a fixed numeric band",
    "2  Remove a fixed numeric band",
    automaticBandsAvailable
      ? "3  Enable automatic numeric bands"
      : `3  Automatic numeric bands unavailable on ${context.lock.database_server_version ?? "this database release"}`,
    "4  Disable automatic numeric bands",
    "5  Add a named ratio or per-unit metric",
    "6  Add a post-suppression calculation",
    "7  Add a safe child-count metric",
    "8  Remove a named reviewed metric",
  ];
  const entered = await input.session.promptText(
    "Choose 1-8; Esc returns without changes",
    { context: analyticsMenu },
  );
  if (entered === undefined || !entered.trim()) {
    process.stdout.write("Returned to boundary tables. No analytics setting changed.\n\n");
    return 0;
  }
  try {
    if (entered.trim() === "1") {
      return addReviewedNumericBand(input, context.candidate, resource);
    }
    if (entered.trim() === "2") {
      return removeReviewedNumericBand(input, resource);
    }
    if (entered.trim() === "3") {
      if (!automaticBandsAvailable) {
        process.stdout.write([
          `Automatic numeric bands are unavailable on ${context.lock.database_server_version ?? "this database release"}.`,
          "This database release lacks the window functions and common table expressions required for safe scoped edge computation.",
          "Fixed reviewed numeric bands and Runner-side post-suppression calculations remain available. No change was made.",
          "",
        ].join("\n"));
        return 0;
      }
      return addReviewedAutoBand(input, resource);
    }
    if (entered.trim() === "4") {
      return removeReviewedAutoBand(input, resource);
    }
    if (entered.trim() === "5") {
      return addReviewedDerivedMeasure(input, context.candidate, resource);
    }
    if (entered.trim() === "6") {
      return addReviewedPostAggregateMeasure(input, context.candidate, resource);
    }
    if (entered.trim() === "7") {
      return addReviewedChildCountMeasure(input, context.candidate, resource);
    }
    if (entered.trim() === "8") {
      return removeReviewedDerivedMeasure(input, resource);
    }
    process.stdout.write("Choose a number from 1 through 8. No analytics setting changed.\n\n");
    return 0;
  } catch (error) {
    process.stdout.write([
      `Analytics setting was not saved: ${redactCliErrorMessage(error instanceof Error ? error.message : String(error))}`,
      "You are still in /access. No authority was activated.",
      "",
    ].join("\n"));
    return 0;
  }
}

async function addReviewedAutoBand(
  input: Parameters<typeof interactiveReviewedAnalyticsReview>[0],
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): Promise<number> {
  const fields = [...resource.aggregate_measures].sort();
  if (!fields.length) {
    process.stdout.write(
      "No reviewed numeric measure field is available for automatic bands. No change was made.\n\n",
    );
    return 0;
  }
  const fieldMenu = [
    "AUTOMATIC NUMERIC BANDS",
    "Choose a numeric field. Runner computes bands from only the trusted scoped rows.",
    ...fields.map((field, index) => `  ${index + 1}  ${resource.id}.${field}`),
  ];
  const field = await chooseNumberedReviewOption(
    input.session,
    "Field number",
    fields,
    fieldMenu,
  );
  if (!field) return cancelledAnalyticsEdit();

  const methodMenu = [
    `AUTOMATIC BANDS - ${resource.id}.${field}`,
    "Band calculation:",
    "  1  Quantile (recommended) - near-equal group populations; ties stay together",
    "  2  Equal width - equal numeric ranges with a reviewer-set minimum width",
    "  3  Allow either method",
  ];
  const methodInput = await input.session.promptText("Method [1]", { context: methodMenu });
  if (methodInput === undefined) return cancelledAnalyticsEdit();
  const methodChoice = methodInput.trim() || "1";
  const methods: ExplorationAutoBandMethod[] = methodChoice === "1"
    ? ["quantile"]
    : methodChoice === "2"
      ? ["equal_width"]
      : methodChoice === "3"
        ? [...EXPLORATION_AUTO_BAND_METHODS]
        : [];
  if (!methods.length) throw new Error("Choose 1, 2, or 3 for the automatic band method.");

  const minBuckets = await reviewedAutoBandInteger(
    input.session,
    "Fewest buckets the AI may request",
    3,
  );
  if (minBuckets === undefined) return cancelledAnalyticsEdit();
  const maxBuckets = await reviewedAutoBandInteger(
    input.session,
    "Most buckets the AI may request",
    10,
  );
  if (maxBuckets === undefined) return cancelledAnalyticsEdit();
  if (minBuckets > maxBuckets) {
    throw new Error("The fewest bucket count cannot be greater than the most bucket count.");
  }

  let minBucketWidth: number | undefined;
  if (methods.includes("equal_width")) {
    minBucketWidth = await reviewedAutoBandPositiveNumber(
      input.session,
      "Smallest allowed numeric width for an equal-width bucket (required)",
    );
    if (minBucketWidth === undefined) return cancelledAnalyticsEdit();
  }

  const labelMenu = [
    `AUTOMATIC BANDS - ${resource.id}.${field}`,
    "Labels shown to the AI:",
    "  1  Ordinal (recommended) - Q1 of 5, Q2 of 5; no data-derived numbers",
    "  2  Rounded ranges - outward-rounded numeric ranges at a reviewer-set precision",
  ];
  const labelInput = await input.session.promptText("Label style [1]", { context: labelMenu });
  if (labelInput === undefined) return cancelledAnalyticsEdit();
  const labelStyle: ExplorationAutoBandLabelStyle = (labelInput.trim() || "1") === "1"
    ? "ordinal"
    : labelInput.trim() === "2"
      ? "rounded"
      : (() => { throw new Error("Choose 1 or 2 for the automatic band label style."); })();
  let labelRoundTo: number | undefined;
  if (labelStyle === "rounded") {
    labelRoundTo = await reviewedAutoBandPositiveNumber(
      input.session,
      "Round displayed range labels outward to this unit (required)",
    );
    if (labelRoundTo === undefined) return cancelledAnalyticsEdit();
  }

  const reason = await requiredReviewedAnalyticsReason(input.session);
  if (reason === undefined) return cancelledAnalyticsEdit();
  const preview = await prepareBoundaryResourceReviewMutation(input.projectRoot, {
    resource_id: input.resourceId,
    auto_band: {
      field,
      methods,
      min_buckets: minBuckets,
      max_buckets: maxBuckets,
      ...(minBucketWidth === undefined ? {} : { min_bucket_width: minBucketWidth }),
      label_style: labelStyle,
      ...(labelRoundTo === undefined ? {} : { label_round_to: labelRoundTo }),
    },
    actor: localInteractiveActor(),
    reason,
  }, input.schemaInspector);
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Saved automatic numeric bands for ${input.resourceId}.${field} in disabled boundary revision ${committed.review_revision}.`,
    `The AI may choose only ${methods.join(" or ")} and ${minBuckets}-${maxBuckets} buckets. It cannot choose or see raw edges.`,
    "Press C in /access to review and activate this exact boundary revision.",
    "",
  ].join("\n"));
  return 0;
}

async function removeReviewedAutoBand(
  input: Parameters<typeof interactiveReviewedAnalyticsReview>[0],
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): Promise<number> {
  const policies = resource.auto_bands ?? [];
  if (!policies.length) {
    process.stdout.write("This table has no automatic numeric bands to disable.\n\n");
    return 0;
  }
  const policyMenu = [
    "DISABLE AUTOMATIC NUMERIC BANDS",
    "Choose the automatic numeric-band policy to disable:",
    ...policies.map((policy, index) =>
      `  ${index + 1}  ${resource.id}.${policy.field} (${policy.methods.join(" or ")}; ${policy.min_buckets}-${policy.max_buckets} buckets)`),
  ];
  const selected = await chooseNumberedReviewOption(
    input.session,
    "Policy number",
    policies,
    policyMenu,
  );
  if (!selected) return cancelledAnalyticsEdit();
  const reason = await requiredReviewedAnalyticsReason(input.session);
  if (reason === undefined) return cancelledAnalyticsEdit();
  const preview = await prepareBoundaryResourceReviewMutation(input.projectRoot, {
    resource_id: input.resourceId,
    auto_band: { ...structuredClone(selected), remove: true },
    actor: localInteractiveActor(),
    reason,
  }, input.schemaInspector);
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Disabled automatic numeric bands for ${input.resourceId}.${selected.field} in boundary revision ${committed.review_revision}.`,
    "The field remains usable for its other reviewed operations. Press C in /access to activate this revision.",
    "",
  ].join("\n"));
  return 0;
}

async function reviewedAutoBandInteger(
  session: BoundaryReviewInteractiveSession,
  prompt: string,
  defaultValue: number,
): Promise<number | undefined> {
  const entered = await session.promptText(`${prompt} [${defaultValue}]`);
  if (entered === undefined) return undefined;
  const value = Number(entered.trim() || defaultValue);
  if (!Number.isSafeInteger(value) || value < MIN_AUTO_BAND_BUCKETS || value > MAX_AUTO_BAND_BUCKETS) {
    throw new Error(
      `Bucket counts must be whole numbers from ${MIN_AUTO_BAND_BUCKETS} through ${MAX_AUTO_BAND_BUCKETS}.`,
    );
  }
  return value;
}

async function reviewedAutoBandPositiveNumber(
  session: BoundaryReviewInteractiveSession,
  prompt: string,
): Promise<number | undefined> {
  const entered = await session.promptText(prompt);
  if (entered === undefined) return undefined;
  const value = Number(entered.trim());
  if (!entered.trim() || !Number.isFinite(value) || value <= 0) {
    throw new Error("Enter a positive finite number. No analytics setting was saved.");
  }
  return value;
}

async function addReviewedNumericBand(
  input: Parameters<typeof interactiveReviewedAnalyticsReview>[0],
  boundary: ExplorationBoundaryDraft,
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): Promise<number> {
  const fields = reviewedAnalyticsFieldChoices(boundary, resource);
  if (!fields.length) {
    process.stdout.write("No reviewed numeric measure field is available for a band. No change was made.\n\n");
    return 0;
  }
  const fieldMenu = [
    "FIXED NUMERIC BAND",
    "Choose the reviewed numeric field to group. Related fields include the exact reviewed path:",
    ...fields.map((item, index) => `  ${index + 1}  ${item.label}`),
  ];
  const selected = await chooseNumberedReviewOption(
    input.session,
    "Field number",
    fields,
    fieldMenu,
  );
  if (!selected) return cancelledAnalyticsEdit();
  const edgesInput = await input.session.promptText(
    "Ordered bucket edges, comma-separated (example: 1000, 5000)",
  );
  if (edgesInput === undefined) return cancelledAnalyticsEdit();
  const edges = edgesInput.split(",").map((value) => Number(value.trim()));
  if (!edgesInput.trim()
    || edges.length > 16
    || edges.some((value) => !Number.isFinite(value))
    || edges.some((value, index) => index > 0 && value <= edges[index - 1]!)) {
    throw new Error("Enter one through 16 finite numeric edges in strictly increasing order, separated by commas.");
  }
  const labelsInput = await input.session.promptText(
    `Bucket labels separated by | (${edges.length + 1} required, from lowest to highest)`,
  );
  if (labelsInput === undefined) return cancelledAnalyticsEdit();
  const bucketLabels = labelsInput.split("|").map((value) => value.trim());
  if (bucketLabels.length !== edges.length + 1
    || bucketLabels.some((value) => !value || value.length > 64)
    || new Set(bucketLabels).size !== bucketLabels.length
    || new TextEncoder().encode(JSON.stringify(bucketLabels)).byteLength > 2_048) {
    throw new Error(
      `Enter exactly ${edges.length + 1} unique, non-empty labels (64 characters each; 2 KB total).`,
    );
  }
  const suggestedName = reviewedAnalyticsIdentifier(
    `${selected.relationship ? `${selected.relationship}_` : ""}${selected.field}_band`,
  );
  const nameInput = await input.session.promptText(`Saved band name [${suggestedName}]`);
  if (nameInput === undefined) return cancelledAnalyticsEdit();
  const name = nameInput.trim() || suggestedName;
  const suggestedLabel = humanReviewedAnalyticsLabel(name);
  const labelInput = await input.session.promptText(`Plain-language label [${suggestedLabel}]`);
  if (labelInput === undefined) return cancelledAnalyticsEdit();
  const reason = await requiredReviewedAnalyticsReason(input.session);
  if (reason === undefined) return cancelledAnalyticsEdit();
  const preview = await prepareBoundaryResourceReviewMutation(input.projectRoot, {
    resource_id: input.resourceId,
    numeric_band: {
      name,
      label: labelInput.trim() || suggestedLabel,
      field: selected.field,
      ...(selected.relationship ? { relationship: selected.relationship } : {}),
      edges,
      bucket_labels: bucketLabels,
    },
    actor: localInteractiveActor(),
    reason,
  }, input.schemaInspector);
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Saved reviewed numeric band ${name} for ${input.resourceId} in disabled boundary revision ${committed.review_revision}.`,
    `Field: ${selected.label}; ${edges.length + 1} fixed buckets. The AI may select only the saved name.`,
    "Press C in /access to review and activate this exact boundary revision.",
    "",
  ].join("\n"));
  return 0;
}

async function removeReviewedNumericBand(
  input: Parameters<typeof interactiveReviewedAnalyticsReview>[0],
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): Promise<number> {
  const definitions = resource.numeric_bands ?? [];
  if (!definitions.length) {
    process.stdout.write("This table has no reviewed numeric bands to remove.\n\n");
    return 0;
  }
  const bandMenu = [
    "REMOVE FIXED NUMERIC BAND",
    "Choose the numeric band to remove:",
    ...definitions.map((item, index) => `  ${index + 1}  ${item.name} - ${item.label}`),
  ];
  const selected = await chooseNumberedReviewOption(
    input.session,
    "Band number",
    definitions,
    bandMenu,
  );
  if (!selected) return cancelledAnalyticsEdit();
  const reason = await requiredReviewedAnalyticsReason(input.session);
  if (reason === undefined) return cancelledAnalyticsEdit();
  const preview = await prepareBoundaryResourceReviewMutation(input.projectRoot, {
    resource_id: input.resourceId,
    numeric_band: { ...structuredClone(selected), remove: true },
    actor: localInteractiveActor(),
    reason,
  }, input.schemaInspector);
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Removed reviewed numeric band ${selected.name} in disabled boundary revision ${committed.review_revision}.`,
    "Press C in /access to review and activate this exact boundary revision.",
    "",
  ].join("\n"));
  return 0;
}

async function addReviewedDerivedMeasure(
  input: Parameters<typeof interactiveReviewedAnalyticsReview>[0],
  boundary: ExplorationBoundaryDraft,
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): Promise<number> {
  const choices = reviewedAnalyticsOperandChoices(boundary, resource);
  const numeratorMenu = [
    "NAMED RATIO OR PER-UNIT METRIC",
    "Choose the fixed numerator. Only existing reviewed aggregate permissions are listed:",
    ...choices.map((item, index) => `  ${index + 1}  ${item.label}`),
  ];
  const numerator = await chooseNumberedReviewOption(
    input.session,
    "Numerator number",
    choices,
    numeratorMenu,
  );
  if (!numerator) return cancelledAnalyticsEdit();
  const relationship = "relationship" in numerator.value ? numerator.value.relationship : undefined;
  const denominators = choices.filter((item) =>
    ("relationship" in item.value ? item.value.relationship : undefined) === relationship);
  const denominatorMenu = [
    "NAMED RATIO OR PER-UNIT METRIC",
    "Choose the fixed denominator. Both operands must use the same reviewed table path:",
    ...denominators.map((item, index) => `  ${index + 1}  ${item.label}`),
  ];
  const denominator = await chooseNumberedReviewOption(
    input.session,
    "Denominator number",
    denominators,
    denominatorMenu,
  );
  if (!denominator) return cancelledAnalyticsEdit();
  const resultMenu = [
    "NAMED RATIO OR PER-UNIT METRIC",
    "Choose the released result:",
    "  1  Ratio",
    "  2  Percentage (ratio x 100)",
    "  3  Per-unit average (SUM divided by COUNT or COUNT DISTINCT)",
  ];
  const shapeInput = await input.session.promptText("Shape number", { context: resultMenu });
  if (shapeInput === undefined) return cancelledAnalyticsEdit();
  const shape = ({ "1": "ratio", "2": "percentage", "3": "per_unit_average" } as const)[shapeInput.trim() as "1" | "2" | "3"];
  if (!shape) throw new Error("Choose shape 1, 2, or 3.");
  const suggestedName = reviewedAnalyticsIdentifier(
    shape === "percentage"
      ? `${reviewedOperandName(numerator.value)}_percentage`
      : `${reviewedOperandName(numerator.value)}_per_${reviewedOperandName(denominator.value)}`,
  );
  const nameInput = await input.session.promptText(`Saved measure name [${suggestedName}]`);
  if (nameInput === undefined) return cancelledAnalyticsEdit();
  const name = nameInput.trim() || suggestedName;
  const suggestedLabel = humanReviewedAnalyticsLabel(name);
  const labelInput = await input.session.promptText(`Plain-language label [${suggestedLabel}]`);
  if (labelInput === undefined) return cancelledAnalyticsEdit();
  const reason = await requiredReviewedAnalyticsReason(input.session);
  if (reason === undefined) return cancelledAnalyticsEdit();
  const preview = await prepareBoundaryResourceReviewMutation(input.projectRoot, {
    resource_id: input.resourceId,
    derived_measure: {
      name,
      label: labelInput.trim() || suggestedLabel,
      shape,
      numerator: structuredClone(numerator.value),
      denominator: structuredClone(denominator.value),
    },
    actor: localInteractiveActor(),
    reason,
  }, input.schemaInspector);
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Saved reviewed derived measure ${name} for ${input.resourceId} in disabled boundary revision ${committed.review_revision}.`,
    "The AI may select only this name; its operands and shape are fixed. Its effective minimum cohort is at least 5.",
    "Press C in /access to review and activate this exact boundary revision.",
    "",
  ].join("\n"));
  return 0;
}

async function removeReviewedDerivedMeasure(
  input: Parameters<typeof interactiveReviewedAnalyticsReview>[0],
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): Promise<number> {
  const definitions = resource.derived_measures ?? [];
  if (!definitions.length) {
    process.stdout.write("This table has no reviewed derived measures to remove.\n\n");
    return 0;
  }
  const measureMenu = [
    "REMOVE REVIEWED METRIC",
    "Choose the derived measure to remove:",
    ...definitions.map((item, index) => `  ${index + 1}  ${item.name} - ${item.label}`),
  ];
  const selected = await chooseNumberedReviewOption(
    input.session,
    "Measure number",
    definitions,
    measureMenu,
  );
  if (!selected) return cancelledAnalyticsEdit();
  const reason = await requiredReviewedAnalyticsReason(input.session);
  if (reason === undefined) return cancelledAnalyticsEdit();
  const preview = await prepareBoundaryResourceReviewMutation(input.projectRoot, {
    resource_id: input.resourceId,
    derived_measure: { ...structuredClone(selected), remove: true },
    actor: localInteractiveActor(),
    reason,
  }, input.schemaInspector);
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Removed reviewed derived measure ${selected.name} in disabled boundary revision ${committed.review_revision}.`,
    "Press C in /access to review and activate this exact boundary revision.",
    "",
  ].join("\n"));
  return 0;
}

async function addReviewedPostAggregateMeasure(
  input: Parameters<typeof interactiveReviewedAnalyticsReview>[0],
  boundary: ExplorationBoundaryDraft,
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): Promise<number> {
  const choices = reviewedAnalyticsOperandChoices(boundary, resource);
  const baseMenu = [
    "POST-SUPPRESSION CALCULATION",
    "Choose the reviewed base aggregate. Runner calculates only from groups that pass small-group privacy:",
    ...choices.map((item, index) => `  ${index + 1}  ${item.label}`),
  ];
  const base = await chooseNumberedReviewOption(
    input.session,
    "Base aggregate number",
    choices,
    baseMenu,
  );
  if (!base) return cancelledAnalyticsEdit();
  const calculationMenu = [
    "POST-SUPPRESSION CALCULATION",
    "Choose the fixed calculation:",
    "  1  Running total by time",
    "  2  Rank across released groups",
    "  3  Change from the previous time bucket",
    "  4  Percentage change from the previous time bucket",
    "  5  Moving average by time",
    "  6  Percentage of the released-group total",
    "",
    "Time calculations require a reviewed time bucket when asked. Rank and percentage of total require a reviewed group and no time bucket.",
  ];
  const operationInput = await input.session.promptText(
    "Calculation number",
    { context: calculationMenu },
  );
  if (operationInput === undefined) return cancelledAnalyticsEdit();
  const shape = ({
    "1": "running_total",
    "2": "rank",
    "3": "lag_absolute_change",
    "4": "lag_percentage_change",
    "5": "moving_average",
    "6": "share_of_released_total",
  } as const)[operationInput.trim() as "1" | "2" | "3" | "4" | "5" | "6"];
  if (!shape) throw new Error("Choose a calculation from 1 through 6.");
  let direction: "asc" | "desc" | undefined;
  if (shape === "rank") {
    const directionInput = await input.session.promptText("Rank direction: 1 highest first, 2 lowest first [1]");
    if (directionInput === undefined) return cancelledAnalyticsEdit();
    const choice = directionInput.trim() || "1";
    if (choice !== "1" && choice !== "2") throw new Error("Choose 1 for highest first or 2 for lowest first.");
    direction = choice === "1" ? "desc" : "asc";
  }
  let windowSize: number | undefined;
  if (shape === "moving_average") {
    const windowInput = await input.session.promptText("Number of time buckets in the moving window (2-12) [3]");
    if (windowInput === undefined) return cancelledAnalyticsEdit();
    windowSize = Number(windowInput.trim() || "3");
    if (!Number.isSafeInteger(windowSize) || windowSize < 2 || windowSize > 12) {
      throw new Error("Choose a whole-number moving window from 2 through 12.");
    }
  }
  const suggestedName = reviewedAnalyticsIdentifier(`${reviewedOperandName(base.value)}_${shape}`);
  const nameInput = await input.session.promptText(`Saved metric name [${suggestedName}]`);
  if (nameInput === undefined) return cancelledAnalyticsEdit();
  const name = nameInput.trim() || suggestedName;
  const suggestedLabel = humanReviewedAnalyticsLabel(name);
  const labelInput = await input.session.promptText(`Plain-language label [${suggestedLabel}]`);
  if (labelInput === undefined) return cancelledAnalyticsEdit();
  const reason = await requiredReviewedAnalyticsReason(input.session);
  if (reason === undefined) return cancelledAnalyticsEdit();
  const preview = await prepareBoundaryResourceReviewMutation(input.projectRoot, {
    resource_id: input.resourceId,
    derived_measure: {
      name,
      label: labelInput.trim() || suggestedLabel,
      shape,
      base_measure: structuredClone(base.value),
      ...(direction ? { direction } : {}),
      ...(windowSize !== undefined ? { window_size: windowSize } : {}),
    },
    actor: localInteractiveActor(),
    reason,
  }, input.schemaInspector);
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Saved reviewed ${humanReviewedAnalyticsLabel(shape).toLowerCase()} ${name} for ${input.resourceId} in disabled boundary revision ${committed.review_revision}.`,
    "Runner will calculate it only after small-group suppression. The AI may select only this saved name.",
    "Press C in /access to review and activate this exact boundary revision.",
    "",
  ].join("\n"));
  return 0;
}

type ReviewedChildCountChoice = {
  childResource: string;
  relationship: string;
  label: string;
};

async function addReviewedChildCountMeasure(
  input: Parameters<typeof interactiveReviewedAnalyticsReview>[0],
  boundary: ExplorationBoundaryDraft,
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): Promise<number> {
  const choices = reviewedChildCountChoices(boundary, resource);
  if (!choices.length) {
    process.stdout.write([
      "No safe child-count path is available for this table.",
      "Add and review a child table with one non-null many-to-one foreign key into this table, then return here.",
      "No change was made.",
      "",
    ].join("\n"));
    return 0;
  }
  const childMenu = [
    "SAFE CHILD-COUNT METRIC",
    "Choose the reviewed child relationship. Runner counts scoped child rows in a correlated subaggregate; it never performs a raw one-to-many join:",
    ...choices.map((item, index) => `  ${index + 1}  ${item.label}`),
  ];
  const selected = await chooseNumberedReviewOption(
    input.session,
    "Child relationship number",
    choices,
    childMenu,
  );
  if (!selected) return cancelledAnalyticsEdit();
  const resultMenu = [
    "SAFE CHILD-COUNT METRIC",
    "Choose the fixed result:",
    "  1  Total child rows across each released parent cohort",
    "  2  Average child rows per parent in each released cohort",
  ];
  const shapeInput = await input.session.promptText(
    "Result number [1]",
    { context: resultMenu },
  );
  if (shapeInput === undefined) return cancelledAnalyticsEdit();
  const shapeChoice = shapeInput.trim() || "1";
  if (shapeChoice !== "1" && shapeChoice !== "2") throw new Error("Choose 1 for total or 2 for average.");
  const shape = shapeChoice === "1" ? "child_count_total" : "child_count_average";
  const childName = selected.childResource.split(".").pop() ?? selected.childResource;
  const suggestedName = reviewedAnalyticsIdentifier(
    shape === "child_count_total" ? `${childName}_count` : `average_${childName}_per_parent`,
  );
  const nameInput = await input.session.promptText(`Saved metric name [${suggestedName}]`);
  if (nameInput === undefined) return cancelledAnalyticsEdit();
  const name = nameInput.trim() || suggestedName;
  const suggestedLabel = humanReviewedAnalyticsLabel(name);
  const labelInput = await input.session.promptText(`Plain-language label [${suggestedLabel}]`);
  if (labelInput === undefined) return cancelledAnalyticsEdit();
  const reason = await requiredReviewedAnalyticsReason(input.session);
  if (reason === undefined) return cancelledAnalyticsEdit();
  const preview = await prepareBoundaryResourceReviewMutation(input.projectRoot, {
    resource_id: input.resourceId,
    derived_measure: {
      name,
      label: labelInput.trim() || suggestedLabel,
      shape,
      child_resource: selected.childResource,
      relationship: selected.relationship,
    },
    actor: localInteractiveActor(),
    reason,
  }, input.schemaInspector);
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Saved reviewed child-count metric ${name} for ${input.resourceId} in disabled boundary revision ${committed.review_revision}.`,
    `Path: ${selected.label}. Child rows stay scoped; release requires at least 5 reviewed parent contributors.`,
    "The AI may select only this saved name. Press C in /access to review and activate this exact boundary revision.",
    "",
  ].join("\n"));
  return 0;
}

function reviewedChildCountChoices(
  boundary: ExplorationBoundaryDraft,
  root: ExplorationBoundaryDraft["pack"]["resources"][number],
): ReviewedChildCountChoice[] {
  const choices: ReviewedChildCountChoice[] = [];
  for (const child of boundary.pack.resources) {
    if (child.id === root.id) continue;
    const relationshipIds = new Set([
      ...child.relationships
        .filter((relationship) => relationship.target_resource === root.id && (relationship.path_depth ?? 1) === 1)
        .map((relationship) => relationship.id),
      ...[child.tenant_scope, child.principal_scope]
        .filter((scope) => scope?.ancestor_resource === root.id && scope.proof.links.length === 1)
        .map((scope) => scope!.path_id),
    ]);
    for (const relationship of relationshipIds) {
      try {
        const reviewed = resolveReviewedChildCountLink(root.id, {
          name: "candidate_child_count",
          label: "Candidate child count",
          shape: "child_count_total",
          child_resource: child.id,
          relationship,
        }, boundary.pack.resources, Boolean(boundary.organization_scope));
        const display = {
          source_resource: child.id,
          target_resource: root.id,
          links: [reviewed.link],
        };
        const joinColumns = formatRelationshipJoinColumns(display);
        choices.push({
          childResource: child.id,
          relationship,
          label: `${formatRelationshipPath(display)}` +
            `${joinColumns ? ` via ${joinColumns}` : ""} (path ID: ${relationship})`,
        });
      } catch {
        // Only catalog-proven, currently valid paths are offered.
      }
    }
  }
  return choices.sort((left, right) => left.label.localeCompare(right.label));
}

function reviewedAnalyticsFieldChoices(
  boundary: ExplorationBoundaryDraft,
  root: ExplorationBoundaryDraft["pack"]["resources"][number],
): ReviewedAnalyticsFieldChoice[] {
  const choices: ReviewedAnalyticsFieldChoice[] = root.aggregate_measures.map((field) => ({
    label: `${root.id}.${field}`,
    field,
  }));
  for (const relationship of root.relationships) {
    const target = boundary.pack.resources.find((item) => item.id === relationship.target_resource);
    if (!target) continue;
    const display = {
      source_resource: root.id,
      target_resource: target.id,
      links: relationship.proof?.links,
    };
    for (const field of target.aggregate_measures) {
      choices.push({
        label: `${formatRelationshipPath(display)}.${field} (path ID: ${relationship.id})`,
        field,
        relationship: relationship.id,
      });
    }
  }
  return choices;
}

function reviewedAnalyticsOperandChoices(
  boundary: ExplorationBoundaryDraft,
  root: ExplorationBoundaryDraft["pack"]["resources"][number],
): ReviewedAnalyticsOperandChoice[] {
  const choices: ReviewedAnalyticsOperandChoice[] = [{
    label: `COUNT rows in ${root.id}`,
    value: { function: "count" },
  }];
  const resources = [{
    resource: root,
    relationship: undefined as string | undefined,
    pathLabel: root.id,
  }, ...root.relationships.flatMap((relationship) => {
    const target = boundary.pack.resources.find((item) => item.id === relationship.target_resource);
    return target ? [{
      resource: target,
      relationship: relationship.id,
      pathLabel: formatRelationshipPath({
        source_resource: root.id,
        target_resource: target.id,
        links: relationship.proof?.links,
      }),
    }] : [];
  })];
  for (const item of resources) {
    for (const field of item.resource.aggregate_measures) {
      const reviewedFunctions = item.resource.aggregate_measure_functions?.[field] ?? ["sum", "avg"];
      for (const fn of (["sum", "avg"] as const).filter((candidate) => reviewedFunctions.includes(candidate))) {
        choices.push({
          label: `${fn.toUpperCase()} ${item.pathLabel}.${field}` +
            `${item.relationship ? ` (path ID: ${item.relationship})` : ""}`,
          value: { function: fn, field, ...(item.relationship ? { relationship: item.relationship } : {}) },
        });
      }
    }
    for (const field of item.resource.count_distinct_fields) {
      choices.push({
        label: `COUNT DISTINCT ${item.pathLabel}.${field}` +
          `${item.relationship ? ` (path ID: ${item.relationship})` : ""}`,
        value: { function: "count_distinct", field, ...(item.relationship ? { relationship: item.relationship } : {}) },
      });
    }
  }
  return choices;
}

async function chooseNumberedReviewOption<T>(
  session: BoundaryReviewInteractiveSession,
  prompt: string,
  options: T[],
  context: string[] = [],
): Promise<T | undefined> {
  const entered = await session.promptText(prompt, { context });
  if (entered === undefined) return undefined;
  const index = Number(entered.trim());
  if (!Number.isSafeInteger(index) || index < 1 || index > options.length) {
    throw new Error(`Choose a number from 1 through ${options.length}.`);
  }
  return options[index - 1];
}

async function requiredReviewedAnalyticsReason(
  session: BoundaryReviewInteractiveSession,
): Promise<string | undefined> {
  while (true) {
    const reason = await session.promptText(
      "Why is this fixed analytics definition appropriate for this boundary? A concrete reason is required",
    );
    if (reason === undefined) return undefined;
    if (reason.trim()) return reason.trim();
    process.stdout.write("A reason is required; no change was made.\n");
  }
}

function cancelledAnalyticsEdit(): 0 {
  process.stdout.write("Cancelled - no analytics setting changed. You are still in /access.\n\n");
  return 0;
}

function reviewedAnalyticsIdentifier(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const safe = /^[a-z_]/.test(normalized) ? normalized : `metric_${normalized}`;
  return (safe || "reviewed_metric").slice(0, 64);
}

function humanReviewedAnalyticsLabel(value: string): string {
  const words = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Reviewed metric";
}

function reviewedOperandName(value: ReviewedAnalyticsOperand): string {
  return reviewedAnalyticsIdentifier(
    value.function === "count"
      ? "rows"
      : `${value.relationship ? `${value.relationship}_` : ""}${value.field ?? value.function}`,
  );
}

async function interactiveBoundaryResourceAddition(input: {
  projectRoot: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess?: boolean;
}): Promise<number | "back" | "review" | BoundaryAccessNotice> {
  if (input.view.candidate) {
    return interactiveBoundaryResourceReview({
      projectRoot: input.projectRoot,
      resourceId: input.view.resource_id,
      view: input.view,
      schemaInspector: input.schemaInspector,
      session: input.session,
      focusedAccess: input.focusedAccess,
    });
  }
  if (!input.view.generated_candidate || requiresBoundarySpecificScopeReview(input.view)) {
    const resolved = await resolveBlockedBoundaryResource({
      projectRoot: input.projectRoot,
      view: input.view,
      schemaInspector: input.schemaInspector,
      session: input.session,
      include: true,
    });
    if (!resolved || resolved === "back") return "back";
    return interactiveBoundaryResourceReview({
      projectRoot: input.projectRoot,
      resourceId: input.view.resource_id,
      view: resolved,
      schemaInspector: input.schemaInspector,
      session: input.session,
      focusedAccess: input.focusedAccess,
    });
  }
  const actor = localInteractiveActor();
  let committed: Awaited<ReturnType<typeof commitBoundaryResourceReviewMutation>>;
  try {
    const preview = await prepareBoundaryResourceReviewMutation(
      input.projectRoot,
      {
        resource_id: input.view.resource_id,
        include: true,
        actor,
        reason: "Added explicitly to the disabled boundary before reviewing its column access.",
      },
      input.schemaInspector,
    );
    committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  } catch (error) {
    return blockedBoundaryAdditionNotice(input.view, error);
  }
  process.stdout.write(formatFocusedBoundaryEditSaved(
    input.view.resource_id,
    "added",
    committed.review_revision,
  ));

  const addedView = await inspectBoundaryResourceReview(input.projectRoot, input.view.resource_id);
  return interactiveBoundaryResourceReview({
    projectRoot: input.projectRoot,
    resourceId: input.view.resource_id,
    view: addedView,
    schemaInspector: input.schemaInspector,
    session: input.session,
    focusedAccess: input.focusedAccess,
  });
}

function requiresBoundarySpecificScopeReview(view: BoundaryResourceReviewView): boolean {
  return !view.candidate
    && Boolean(view.generated_candidate?.shared_reference_scope)
    && view.shared_reference_scope?.eligible === true;
}

function blockedBoundaryAdditionNotice(
  view: BoundaryResourceReviewView,
  error: unknown,
): BoundaryAccessNotice {
  const guidance = view.scope_resolution_guidance;
  const blockers = guidance?.why.length
    ? guidance.why
    : view.blockers.length
      ? view.blockers
      : [redactCliErrorMessage(error instanceof Error ? error.message : String(error))];
  return {
    tone: "danger",
    title: `${view.resource_id} was not added to the disabled draft.`,
    lines: [
      ...blockers.map((line) => `Why: ${line}`),
      ...(guidance?.remediation ?? []).map((line) => `Next: ${line}`),
    ],
    footer: "You are still in /access. Nothing was saved or activated.",
  };
}

async function resolveBlockedBoundaryResource(input: {
  projectRoot: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  include: boolean;
}): Promise<BoundaryResourceReviewView | "back" | undefined> {
  if (!input.session.resolveBlockedResource) {
    process.stdout.write([
      input.view.organization_scope
        ? `${input.view.resource_id} still needs a reviewed record ID. Whole-organization scope is already active; no tenant column is required.`
        : `${input.view.resource_id} still needs a reviewed record ID and tenant-isolation choice.`,
      `Run ${cliCommandName()} boundary review in a terminal to choose from database-inspected candidates.`,
      "Nothing was saved or activated.",
      "",
    ].join("\n"));
    return "back";
  }
  const resolution = await input.session.resolveBlockedResource(input.view);
  if (!resolution || resolution === "back") return resolution;
  const sharedReference = "shared_reference_scope" in resolution;
  const singleOrganization = "organization_scope" in resolution;
  let reason = singleOrganization
    ? "Selected database-inspected identity under the reviewed fixed whole-organization scope."
    : "Selected database-inspected identity and tenant isolation in local boundary review.";
  if (sharedReference) {
    while (true) {
      const answer = await input.session.promptText(
        [
          "SHARED REFERENCE REVIEW",
          `Table: ${input.view.resource_id}`,
          "Explain why this table contains the same rows for every tenant.",
          "A concrete reason is required; Enter alone does not save.",
          "Required reason",
        ].join("\n"),
      );
      if (answer === undefined) {
        process.stdout.write("Cancelled - no change was made.\n\n");
        return "back";
      }
      if (answer.trim()) {
        reason = answer.trim();
        break;
      }
      process.stdout.write("A reason is required; no change was made.\n");
    }
    const confirmed = await input.session.confirm(
      `Confirm ${input.view.resource_id} has no per-tenant rows and every tenant may receive the same reviewed rows?`,
      {
        defaultValue: false,
        context: [
          "SHARED REFERENCE REVIEW",
          `Table: ${input.view.resource_id}`,
          `Reviewer reason: ${reason}`,
          "This table will not receive a tenant predicate. Field, privacy, and budget controls still apply.",
        ],
      },
    );
    if (confirmed !== true) {
      process.stdout.write("Cancelled - no change was made.\n\n");
      return "back";
    }
  }
  try {
    const preview = await prepareBoundaryResourceReviewMutation(
      input.projectRoot,
      {
        resource_id: input.view.resource_id,
        ...(input.include ? { include: true } : {}),
        row_identity: resolution.row_identity,
        ...(resolution.tenant_key
          ? { tenant_key: resolution.tenant_key }
          : resolution.tenant_scope_path
            ? { tenant_scope_path: resolution.tenant_scope_path }
            : sharedReference
              ? { shared_reference_scope: SHARED_REFERENCE_ACKNOWLEDGEMENT }
              : {}),
        actor: localInteractiveActor(),
        reason,
      },
      input.schemaInspector,
    );
    const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
    const derivedTenantScope = resolution.tenant_scope_path
      ? input.view.derived_tenant_scope?.candidates.find((scope) =>
        scope.path_id === resolution.tenant_scope_path)
      : undefined;
    process.stdout.write([
      `Saved structural review for ${input.view.resource_id} in disabled boundary revision ${committed.review_revision}.`,
      `Record ID: ${resolution.row_identity}`,
      resolution.tenant_key
        ? `Tenant isolation: ${resolution.tenant_key} (direct column; trusted value stays outside model arguments)`
        : resolution.tenant_scope_path
          ? `Tenant isolation: ${derivedTenantScope
            ? formatDerivedScopePath(derivedTenantScope)
            : resolution.tenant_scope_path} (mandatory relationship path; trusted value stays outside model arguments)`
          : singleOrganization
            ? `Row scope: Whole organization ${input.view.organization_scope?.organization_id ?? "(reviewed)"} (no tenant column or tenant predicate required)`
            : "Row scope: Shared reference (no tenant predicate; field, privacy, and budget controls still apply)",
      "Agent authority activated: no",
      "Review column access next.",
      "",
    ].join("\n"));
    return inspectBoundaryResourceReview(input.projectRoot, input.view.resource_id);
  } catch (error) {
    process.stdout.write([
      `This table was not added: ${redactCliErrorMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
      "You are still in boundary review. Nothing was saved or activated.",
      "",
    ].join("\n"));
    return "back";
  }
}

async function confirmActivateAndKeepAccessOpen(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  activationHandoff?: BoundaryActivationHandoff;
  activationReviewNotice?: BoundaryReviewCommandOptions["activationReviewNotice"];
  prepareDependentActions?: boolean;
  reviewOptions?: ReadBoundaryReviewOptions;
}): Promise<number> {
  let result: number;
  while (true) {
    try {
      result = await confirmAndActivateFocusedBoundary({
        ...input,
        keepAccessOpen: true,
      });
      break;
    } catch (error) {
      const lines = [
        "Boundary activation did not complete.",
        redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
        "Any completed review remains saved. Inspect current authority before retrying an interrupted activation.",
        input.session.presentationMode === "conversation"
          ? "You are still in Boundary authoring. Correct the reported issue, then review the exact authority again."
          : "You are still in /access. Correct the reported issue, then press C to review and activate again.",
      ];
      if (input.session.presentationMode === "conversation" && input.session.chooseOption) {
        const diagnostic = lines.flatMap((line) => line.split(/\r?\n/u));
        input.session.rememberDetails?.("Read activation did not complete", diagnostic);
        let recovery: string | undefined;
        do {
          recovery = await input.session.chooseOption("READ ACTIVATION NEEDS ATTENTION", [
            { value: "retry", label: "Recheck and review the same draft", detail: "Retry after correcting the reported issue. Your exact activation confirmation is still required." },
            { value: "details", label: "Inspect the activation blocker", detail: "Local diagnostics and recovery steps; no provider request or authority change." },
            { value: "pause", label: "Pause this saved job", detail: "Keep all drafts and current authority. Resume without repeating the job." },
          ], { initialValue: "pause", reviewOnly: true, explainOnRequest: true, context: [
            lines[1]!.split(/\r?\n/u)[0]!,
            "The job is saved. Inspect the blocker or retry after correcting it; retrying does not replace an activation confirmation.",
          ] });
          if (recovery === "details") await input.session.showReviewDetails?.("Read activation blocker", diagnostic);
        } while (recovery === "details");
        if (recovery === "retry") continue;
        input.reviewOptions?.onDisposition?.("finish");
        return 0;
      }
      await showManualReadActivationBlocker(input.session, lines[0]!, lines.slice(1));
      return 0;
    }
  }
  if (result !== 0) return result;
  if (input.prepareDependentActions) return 0;
  if (input.session.presentationMode === "conversation") return 0;
  process.stdout.write([
    "/access is still open.",
    "Continue setting up this boundary, switch boundaries, or press Q/Esc when finished to return to Ask.",
    "",
  ].join("\n"));
  return 0;
}

async function showManualReadActivationBlocker(session: BoundaryReviewInteractiveSession, title: string, lines: string[]): Promise<void> {
  session.rememberDetails?.(title, lines);
  // Await acknowledgement before the alternate-screen editor can redraw.
  if (session.showReviewDetails) await session.showReviewDetails(title, lines);
  else {
    if (session.present) session.present(title, lines, "danger");
    else process.stdout.write([title, ...lines, ""].join("\n"));
    await session.promptText("Press Enter to return to the saved draft: ", { context: lines });
  }
}

async function confirmAndActivateFocusedBoundary(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  activationHandoff?: BoundaryActivationHandoff;
  activationReviewNotice?: BoundaryReviewCommandOptions["activationReviewNotice"];
  keepAccessOpen?: boolean;
  prepareDependentActions?: boolean;
  reviewOptions?: ReadBoundaryReviewOptions;
}): Promise<number> {
  let context = await loadBoundaryReviewContext(input.projectRoot);
  const boundaryLibrary = await synchronizeBoundaryLibrary({
    expectedAuthoring: context.bundle.mutation_bindings.authoring,
    projectRoot: input.projectRoot,
    draft: context.draft,
    currentCandidate: context.candidate,
    ...(context.progress ? { currentProgress: context.progress } : {}),
  });
  const selectedBoundary = boundaryLibrary.entries.find((entry) => entry.selected);
  if (selectedBoundary?.active && selectedBoundary.matches_active_digest) {
    process.stdout.write([
      `Boundary "${selectedBoundary.name}" has no access changes to review.`,
      "Reviewed authority and provider egress are unchanged.",
      input.keepAccessOpen
        ? "Continue reviewing access, or press Q/Esc when finished to return to Ask."
        : "Returning to Ask.",
      "",
    ].join("\n"));
    return 0;
  }
  if (!context.candidate.pack.resources.length) {
    throw new Error("A boundary must contain at least one reviewed table before activation.");
  }
  while (true) {
    const unresolvedRelationship = context.candidate.pack.resources
      .flatMap((resource) => resource.relationships.map((relationship) => ({
        resource: resource.id,
        relationship,
    })))
      .find(({ relationship }) => relationship.unmatched_rows === "review_required");
    if (!unresolvedRelationship) break;
    const relationshipDisplay = {
      source_resource: unresolvedRelationship.resource,
      target_resource: unresolvedRelationship.relationship.target_resource,
      links: unresolvedRelationship.relationship.proof?.links,
    };
    const joinColumns = formatRelationshipJoinColumns(relationshipDisplay);
    const relationshipChoiceContext = [
      "",
      "ONE RELATIONSHIP CHOICE",
      formatRelationshipPath(relationshipDisplay),
      ...(joinColumns ? [`via columns: ${joinColumns}`] : []),
      `path ID: ${unresolvedRelationship.relationship.id}`,
      "Some counted rows may not have a related record. This choice changes analytical totals.",
      "K  Keep the counted row and show an empty group value",
      "E  Exclude the counted row from analyses using this relationship",
    ];
    if (input.session.presentationMode !== "conversation") {
      process.stdout.write([...relationshipChoiceContext, ""].join("\n"));
    }
    let answer = "";
    while (!["k", "keep", "e", "exclude", "q", "quit"].includes(answer)) {
      const entered = await input.session.promptText(
        "Choose K or E (Q cancels): ",
        { context: relationshipChoiceContext },
      );
      if (entered === undefined) {
        answer = "q";
        break;
      }
      answer = entered.trim().toLowerCase();
    }
    if (answer === "q" || answer === "quit") {
      process.stdout.write([
        "The edited boundary remains disabled. Current agent authority is unchanged.",
        input.keepAccessOpen
          ? "Continue reviewing access, or press Q/Esc when finished to return to Ask."
          : `Resume: ${cliCommandName()} boundary review --access`,
        "",
      ].join("\n"));
      return 0;
    }
    const unmatchedRows = answer === "k" || answer === "keep" ? "keep_null" : "exclude";
    const preview = await prepareBoundaryResourceReviewMutation(
      input.projectRoot,
      {
        resource_id: unresolvedRelationship.resource,
        nullable_relationship: {
          relationship_id: unresolvedRelationship.relationship.id,
          unmatched_rows: unmatchedRows,
        },
        actor: localInteractiveActor(),
        reason: unmatchedRows === "keep_null"
          ? "Keep counted rows with no related record under an empty group in the focused access review."
          : "Exclude counted rows with no related record from analyses using this relationship in the focused access review.",
      },
      input.schemaInspector,
    );
    await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
    process.stdout.write(
      `Saved on the disabled boundary: unmatched rows will ${
        unmatchedRows === "keep_null" ? "remain under an empty group" : "be excluded"
      }.\n`,
    );
    context = await loadBoundaryReviewContext(input.projectRoot);
  }
  const conversation = input.session.presentationMode === "conversation";
  const activeBoundary = await loadActivatedExplorationBoundary(input.projectRoot, {
    name: context.candidate.pack.name,
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const replacingActive = activeBoundary !== undefined
    && activeBoundary.activation.digest !== context.bundle.candidate_digest;
  const authorityReduction = activeBoundary
    ? readBoundaryAuthorityReduction(activeBoundary.pack.resources, context.candidate.pack.resources)
    : { removedResources: [], removedGrants: [] };
  const authorityReplacementContext = replacingActive
    ? [
        "AUTHORITY REPLACEMENT",
        `Current Read Boundary: ACTIVE (${activeBoundary!.pack.resources.length} tables)`,
        `Candidate replacement: ${context.candidate.pack.resources.length} tables`,
        ...(authorityReduction.removedResources.length
          ? [`Removes active tables (${authorityReduction.removedResources.length}): ${authorityReduction.removedResources.join(", ")}`]
          : []),
        ...(authorityReduction.removedGrants.length
          ? [`Removes active field/operation grants (${authorityReduction.removedGrants.length}): ${summarizeAuthorityItems(authorityReduction.removedGrants)}`]
          : []),
        authorityReduction.removedResources.length || authorityReduction.removedGrants.length
          ? "Confirming replaces the active revision and removes the authority named above."
          : "Confirming replaces the active revision; no currently active table or field-operation grant is removed.",
        "Declining keeps the current active revision live and leaves this candidate disabled.",
      ]
    : [];
  const activationReview = formatFocusedBoundaryActivationReview(
    context.bundle,
    conversation ? false : process.stdout.isTTY === true && !("NO_COLOR" in process.env),
    true,
    conversation
      ? terminalContentWidth(input.session.terminalColumns ?? process.stdout.columns)
      : input.session.terminalColumns ?? process.stdout.columns ?? 100,
    conversation,
  );
  if (input.session.presentationMode !== "conversation") {
    process.stdout.write(activationReview);
  }
  const activationReviewNotice = input.activationReviewNotice?.({
    projectRoot: input.projectRoot,
    boundaryName: context.candidate.pack.name,
    boundaryDigest: context.bundle.candidate_digest,
  });
  if (activationReviewNotice && input.session.presentationMode !== "conversation") {
    process.stdout.write(
      activationReviewNotice.endsWith("\n")
        ? activationReviewNotice
        : `${activationReviewNotice}\n`,
    );
  }
  const activationContext = [
    ...activationReview.trimEnd().split("\n"),
    ...(authorityReplacementContext.length ? ["", ...authorityReplacementContext] : []),
    ...(activationReviewNotice ? activationReviewNotice.trimEnd().split("\n") : []),
  ];
  const readiness = await input.reviewOptions?.readiness?.();
  const deployment = await input.reviewOptions?.deploymentReadiness?.();
  activationContext.push(...(deployment?.summary ?? []));
  const privacy = input.reviewOptions?.privacyEvidence?.(context.candidate)
    ?? readPrivacyReview({ boundary: context.candidate, confirmedMeanings: input.reviewOptions?.confirmedFieldMeanings?.(context.bundle.candidate_digest) });
  const discoveryConcerns = readDiscoveryCompatibility(context.candidate, context.bundle.candidate_digest,
    await readOptionalExplorationDraft(input.projectRoot));
  const discoveryLines = readDiscoveryConcernLines(discoveryConcerns);
  activationContext.push(...(discoveryLines.length ? ["", ...discoveryLines] : ["Discovery compatibility: complete resource contracts fit the bounded MCP response."]));
  const conversationReviewContext = formatReadActivationDecisionSummary([
    ...(deployment?.summary ?? []),
    ...(discoveryConcerns.length ? ["Discovery compatibility: some exact resource contracts exceed the supported size. Revise this saved draft before activation; exact details list the affected resources and sizes."] : []),
    ...(readiness?.summary ?? await input.reviewOptions?.rulesSummary?.() ?? []),
    ...(input.reviewOptions?.sequenceSummary?.() ?? ["Sequence: this decision grants Read access only. Action approval and source execution require separate reviews."]),
    ...formatReadActivationBusinessSummary(context.bundle, undefined, privacy),
    ...(input.reviewOptions?.businessSummary?.() ?? []),
    ...authorityReplacementContext,
  ], terminalContentWidth(input.session.terminalColumns ?? process.stdout.columns));
  const changesForReview = input.reviewOptions?.reviewChanges?.()
    ?? await loadReadReviewDiff(input.projectRoot, context.bundle.candidate_digest)
    ?? (activeBoundary ? readRevisionDiff({ ...activeBoundary, activation: "disabled_unreviewed", unresolved_decisions: [] }, context.candidate) : undefined);
  if (conversation) {
    input.session.rememberDetails?.("Exact Read Boundary review", activationContext);
  }
  const actor = localInteractiveActor();
  if (input.prepareDependentActions) {
    let accepted: boolean | undefined;
    if (conversation) {
      // Retaining a validated Read revision as a disabled dependency grants no
      // authority. The model-led flow continues without presenting this local
      // draft write as though it were an activation permission.
      accepted = true;
    } else {
      accepted = await input.session.confirm(
        `Use this exact Read Boundary as the disabled dependency for its Action Boundary?`,
        {
          defaultValue: true,
          context: [
            ...(conversation ? [...activationContext, ""] : []),
            "CONTINUE TO ACTION BOUNDARY",
            `Read Boundary: ${context.candidate.pack.name}`,
            "Yes freezes this exact reviewed revision without granting read authority, then continues the same agent job.",
            "The final Read activation and Action activation remain separate confirmations after proposal rehearsal.",
            "No model, proposal, approval, apply, or source-write authority is granted here.",
          ],
        },
      );
    }
    if (accepted) {
      await saveReviewedDisabledBoundary({
        projectRoot: input.projectRoot,
        context,
        actor,
        reason: "Confirmed the complete exact Read Boundary as the disabled dependency for the linked Action Boundary.",
      });
      const reviewedLines = [
        `Read Boundary: ${context.candidate.pack.name}`,
        "Next: continue this same job into Action Boundary decisions.",
        "EXPLORE OFF | PROPOSE OFF | APPROVE OFF | APPLY OFF",
        "Source database changed: no",
      ];
      if (input.session.present) input.session.present("READ REVIEW COMPLETE - NOT ACTIVE", reviewedLines, "success");
      else process.stdout.write(["READ REVIEW COMPLETE - NOT ACTIVE", ...reviewedLines, ""].join("\n"));
      return 0;
    }
    const pausedLines = [
      "Agent job paused before Action Boundary setup.",
      "The Read Boundary remains disabled and incomplete. No authority or source data changed.",
    ];
    if (input.session.present) input.session.present("AGENT JOB PAUSED", pausedLines.slice(1), "warning");
    else process.stdout.write([...pausedLines, ""].join("\n"));
    return 0;
  }
  if (!conversation && discoveryConcerns.length) {
    await showManualReadActivationBlocker(input.session, "READ ACCESS IS NOT READY TO ACTIVATE", [
      "Review decisions remain saved, but the client cannot receive this complete access contract yet.",
      ...discoveryLines,
      "Return to the saved draft: W opens model-assisted revision; E opens the table and column editor.",
      "Keep required business access and private verification intact. C checks the revised contract again before offering activation.",
      "No authority was activated and no source records changed.",
    ]);
    return 0;
  }
  const activationPrompt = context.candidate.deployment_profile === "production"
    ? input.keepAccessOpen
      ? conversation
        ? `Activate "${context.candidate.pack.name}" for secured production HTTP Explore and continue this Boundary authoring conversation?`
        : `Activate "${context.candidate.pack.name}" exactly as shown for secured production HTTP Explore now? You will stay in /access.`
      : `Activate "${context.candidate.pack.name}" exactly as shown for secured production HTTP Explore?`
    : input.keepAccessOpen
      ? conversation
        ? `Activate "${context.candidate.pack.name}" for local read-only Explore and continue this Boundary authoring conversation?`
        : `Activate "${context.candidate.pack.name}" exactly as shown now? You will stay in /access.`
      : `Activate "${context.candidate.pack.name}" exactly as shown and continue to Ask?`;
  let accepted: boolean | undefined;
  let reviewDisposition: ReadBoundaryReviewDisposition | undefined;
  let saveReviewedDisabled = false;
  if (conversation && input.session.chooseOption) {
    let decided = false;
    while (!decided) {
      let choice = await input.session.chooseOption(
        readiness && !readiness.ready ? "FINISH BOUNDARY REVIEW" : replacingActive ? "REPLACE ACTIVE READ BOUNDARY" : "ACTIVATE READ BOUNDARY",
        [
          ...(discoveryConcerns.length ? [] : readiness && !readiness.ready ? [{ value: "resolve", label: readiness.privacy ? "Resolve required privacy decision with the model" : "Resolve required decisions with the model",
            detail: "Continue this saved draft; no activation is available while its requirements are unresolved." }] : [{
            value: "activate",
            label: replacingActive
              ? authorityReduction.removedResources.length
                ? `Replace active Read Boundary (removes ${authorityReduction.removedResources.length} table${authorityReduction.removedResources.length === 1 ? "" : "s"})`
                : authorityReduction.removedGrants.length
                  ? "Replace active Read Boundary (reduces reviewed access)"
                  : "Replace active Read Boundary with this reviewed revision"
              : "Activate this exact Read Boundary",
            detail: replacingActive
              ? "Replace the currently active Explore authority with only the candidate summarized above."
              : "Grant only the reviewed Explore authority summarized above.",
          }]),
          ...(input.reviewOptions?.executionPreparationNeeded?.()
            ? [{
                value: "prepare_execution",
                label: "Prepare requested automatic execution",
                detail: "Keep the business rule and approval limits; prepare disabled execution configuration for separate operator review. No writes.",
              }]
            : []),
          ...(input.reviewOptions?.reviseWithModel || input.reviewOptions?.openModelRevision
            ? [{
                value: "revise_model",
                label: input.reviewOptions.reviseWithModel ? "Revise this Read Boundary with the current model" : "Revise saved read access with a model",
                detail: "Keep this job and its saved actions, describe only the access change, then review the rebuilt disabled revisions.",
              }]
            : []),
          ...(privacy.findings.some((finding) => finding.status !== "business_meaning_checked") ? [{ value: "privacy_details", label: "Inspect privacy findings",
            detail: "See each unresolved field and exact evidence directly; no model request or draft change." }] : []),
          ...(discoveryConcerns.length ? [{ value: "discovery_details", label: "Inspect Discovery compatibility",
            detail: "Exact resource sizes, supported limits and recovery; no model request or authority change." }] : []),
          {
            value: "details",
            label: "View exact Read Boundary details",
            detail: "Show every reviewed field, allowlist, scope path, limit, and fingerprint.",
          },
          {
            value: "finish",
            label: replacingActive
              ? "Keep current active Read Boundary and finish"
              : "Keep Read Boundary disabled and finish",
            detail: replacingActive
              ? "The active revision stays live; save this replacement candidate and return to the Boundary list."
              : "Grant no Read authority; save this reviewed draft and return to the Boundary list.",
          },
          {
            value: "more_review",
            label: "More review options",
            detail: "Attached rules, privacy changes, and manual controls.",
          },
        ],
        {
          initialValue: readiness && !readiness.ready ? "resolve" : "finish",
          reviewOnly: readiness?.ready === false,
          explainOnRequest: true,
          context: conversationReviewContext,
          explanationContext: readPrivacyExplanationFacts(privacy),
          exactDetails: { title: "Exact Read Boundary review", lines: activationContext,
            sections: readBoundaryReviewSections({ boundary: context.candidate, digest: context.bundle.candidate_digest,
              changes: changesForReview, privateDependencies: input.reviewOptions?.privateDependencies?.(), privacy }) },
        },
      );
      if (choice === "more_review") {
        choice = await input.session.chooseOption("Review options", [
          ...(input.reviewOptions?.reviseWithModel ? [{ value: "privacy", label: "Change privacy with the model" }] : []),
          ...(input.reviewOptions?.reviewRules ? [{ value: "rules", label: "Review attached rules and unresolved decisions" }] : []),
          ...(privacy.findings.length ? [{ value: "privacy_details", label: "Inspect privacy findings and confirmed meanings" }] : []),
          { value: "manual_editor", label: "Open the manual Boundary editor" },
          { value: "back", label: "Back to the pending review" },
        ], { initialValue: "back", reviewOnly: true });
        if (!choice || choice === "back") continue;
      }
      if (choice === "resolve" && input.reviewOptions?.resolveRequirements) {
        await input.reviewOptions.resolveRequirements();
        return confirmAndActivateFocusedBoundary(input);
      }
      if (choice === "privacy_details") {
        const section = readBoundaryReviewSections({ boundary: context.candidate, digest: context.bundle.candidate_digest, privacy })[0]!;
        await input.session.showReviewDetails?.(section.title, section.lines);
        continue;
      }
      if (choice === "discovery_details") {
        await input.session.showReviewDetails?.("Discovery compatibility", discoveryLines);
        continue;
      }
      if (choice === "details") {
        if (input.session.showReviewDetails) await input.session.showReviewDetails("Exact Read Boundary review", activationContext);
        else {
          input.session.rememberDetails?.("Exact Read Boundary review", activationContext);
          if (input.session.showRememberedDetails) input.session.showRememberedDetails();
          else if (input.session.present) input.session.present("EXACT READ BOUNDARY DETAILS", activationContext, "normal");
          else process.stdout.write(`${activationContext.join("\n")}\n`);
        }
        continue;
      }
      if (choice === "rules" && input.reviewOptions?.reviewRules) { await input.reviewOptions.reviewRules(); return confirmAndActivateFocusedBoundary(input); }
      if (choice === "activate" && input.reviewOptions?.beforeActivation) {
        if (readiness && !readiness.ready) continue;
        if (!await input.reviewOptions.beforeActivation()) return confirmAndActivateFocusedBoundary(input);
        if ((await loadBoundaryReviewContext(input.projectRoot)).bundle.candidate_digest !== context.bundle.candidate_digest) return confirmAndActivateFocusedBoundary(input);
      }
      if (choice === "revise_model" && input.reviewOptions?.openModelRevision) {
        await input.reviewOptions.openModelRevision();
        return 0;
      }
      if ((choice === "revise_model" || choice === "privacy") && input.reviewOptions?.reviseWithModel) {
        const revised = await input.reviewOptions.reviseWithModel(choice === "privacy"
          ? "Reduce model disclosure of internal database IDs, established conflict/version guards and private approval controls. Preserve every existing exclusion and Read-selection grant: do not add private access. Preserve customer-facing references and benefits, business rules, approval limits and execution intent. Use structural roles and reviewed metadata, not name fragments alone; ask if meaning is ambiguous."
          : undefined);
        if (revised) return confirmAndActivateFocusedBoundary(input);
        continue;
      }
      if (choice === "prepare_execution" && input.reviewOptions?.prepareExecution) {
        try {
          await input.reviewOptions.prepareExecution();
          return confirmAndActivateFocusedBoundary(input);
        } catch (error) {
          const lines = [redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
            "Execution preparation is blocked for this exact draft. No execution authority was enabled. Revise the Action draft with the model or manual controls before retrying."];
          input.session.present?.("EXECUTION PREPARATION BLOCKED", lines, "danger");
        }
        continue;
      }
      accepted = choice === "activate";
      if (accepted && discoveryConcerns.length) continue;
      reviewDisposition = choice === "manual_editor" ? "manual_editor" : "finish";
      saveReviewedDisabled = choice === "finish";
      decided = true;
    }
  } else {
    accepted = input.keepAccessOpen && input.session.confirmActivation
      ? await input.session.confirmActivation(activationPrompt, { context: activationContext })
      : await input.session.confirm(activationPrompt, {
          defaultValue: input.keepAccessOpen !== true,
          context: activationContext,
        });
  }
  if (!accepted) {
    if (conversation) {
      if (saveReviewedDisabled) {
        await saveReviewedDisabledBoundary({
          projectRoot: input.projectRoot,
          context,
          actor,
          reason: replacingActive
            ? "Confirmed the complete exact replacement Read Boundary while keeping the current active revision live."
            : "Confirmed the complete exact Read Boundary while keeping read authority disabled.",
        });
      }
      input.reviewOptions?.onDisposition?.(reviewDisposition ?? "finish");
      input.session.present?.(
        replacingActive ? "ACTIVE READ BOUNDARY KEPT" : "READ BOUNDARY LEFT DISABLED",
        replacingActive
          ? [
              `Boundary: ${context.candidate.pack.name}`,
              `Current authority: ACTIVE (${activeBoundary!.pack.resources.length} tables)`,
              `The replacement candidate remains disabled. No Read authority or source data changed.${reviewDisposition === "manual_editor" ? " Opening the manual editor." : ""}`,
            ]
          : [
              `Boundary: ${context.candidate.pack.name}`,
              "No Read authority or source data changed.",
              reviewDisposition === "manual_editor"
                ? "The reviewed draft remains available in the manual Boundary editor."
                : "The reviewed draft remains saved. Returning to the Boundary list.",
            ],
        "warning",
      );
      return 0;
    }
    const keepReviewedDisabled = accepted === false
      && input.keepAccessOpen
      && input.session.confirmReviewedDisabled
      ? await input.session.confirmReviewedDisabled(
          `Keep "${context.candidate.pack.name}" fully reviewed but disabled so you can prepare dependent Safe Actions now?`,
          {
            context: [
              "READ BOUNDARY REVIEWED - ACTIVATION NOT CONFIRMED",
              `Boundary: ${context.candidate.pack.name}`,
              "Choose Yes to freeze this exact reviewed revision without granting read authority.",
              "Choose No or Esc to leave the review incomplete and return to /access.",
            ],
          },
        )
      : false;
    if (keepReviewedDisabled) {
      await saveReviewedDisabledBoundary({
        projectRoot: input.projectRoot,
        context,
        actor,
        reason: "Confirmed the complete exact boundary while keeping read authority disabled.",
      });
      const reviewedLines = [
        `Boundary: ${context.candidate.pack.name}`,
        "Agent read authority: unchanged",
        "Source database changed: no",
        "Press Y in /access to prepare and rehearse a proposal action against this exact pending revision, or C to activate reads.",
      ];
      if (input.session.present) input.session.present("READ REVIEW COMPLETE - NOT ACTIVE", reviewedLines, "success");
      else process.stdout.write(["READ REVIEW COMPLETE - NOT ACTIVE", ...reviewedLines, ""].join("\n"));
      return 0;
    }
    process.stdout.write([
      accepted === undefined
        ? "Activation confirmation was cancelled or unavailable. No change was made."
        : "Activation was declined. No change was made.",
      "The edited boundary remains disabled. Current agent authority is unchanged.",
      input.keepAccessOpen
        ? "Continue reviewing access, or press Q/Esc when finished to return to Ask."
        : `Resume: ${cliCommandName()} boundary review --access`,
      "",
    ].join("\n"));
    return 0;
  }
  const progress = createBoundaryReviewProgress({
    draft: context.draft,
    candidate: context.candidate,
    confirmedDecisions: context.candidate.unresolved_decisions,
    ...(context.progress ? { previous: context.progress } : {}),
    actor,
    reason: "Confirmed the complete exact boundary shown by the focused access editor.",
    revision: (context.progress?.revision ?? 0) + 1,
  });
  await saveBoundaryReviewSignoff(input.projectRoot, context, progress);
  const activationResult = await boundaryActivateCommand(
    [
      "--project-root", input.projectRoot,
      "--confirm", `ACTIVATE ${progress.candidate_digest}`,
      "--actor", actor,
    ],
    input.schemaInspector,
    input.session,
    input.activationHandoff,
  );
  if (activationResult === 0) input.reviewOptions?.onDisposition?.("activated");
  return activationResult;
}

type ReadBoundaryResource = ExplorationBoundaryDraft["pack"]["resources"][number];

function readBoundaryAuthorityReduction(
  activeResources: ReadBoundaryResource[],
  candidateResources: ReadBoundaryResource[],
): { removedResources: string[]; removedGrants: string[] } {
  const candidateById = new Map(candidateResources.map((resource) => [resource.id, resource]));
  const removedResources: string[] = [];
  const removedGrants: string[] = [];
  for (const active of activeResources) {
    const candidate = candidateById.get(active.id);
    if (!candidate) {
      removedResources.push(active.id);
      continue;
    }
    const candidateGrants = readBoundaryResourceGrantTokens(candidate);
    for (const [token, label] of readBoundaryResourceGrantTokens(active)) {
      if (!candidateGrants.has(token)) removedGrants.push(label);
    }
  }
  return {
    removedResources: removedResources.sort(),
    removedGrants: [...new Set(removedGrants)].sort(),
  };
}

function readBoundaryResourceGrantTokens(resource: ReadBoundaryResource): Map<string, string> {
  const grants = new Map<string, string>();
  const add = (token: string, label: string) => grants.set(token, label);
  for (const field of resource.selectable_fields) {
    add(`return:${field}`, `${resource.id}.${field} return`);
  }
  for (const field of resource.model_withheld_fields ?? []) {
    add(`runner_output:${field}`, `${resource.id}.${field} Runner-only output`);
  }
  for (const [field, operators] of Object.entries(resource.filterable_fields)) {
    for (const operator of operators) {
      add(`filter:${field}:${operator}`, `${resource.id}.${field} filter ${operator}`);
    }
  }
  for (const field of resource.sortable_fields) add(`sort:${field}`, `${resource.id}.${field} sort`);
  for (const field of resource.groupable_fields) add(`group:${field}`, `${resource.id}.${field} group`);
  for (const field of resource.aggregate_measures) add(`measure:${field}`, `${resource.id}.${field} measure`);
  for (const field of resource.presence_measure_fields ?? []) {
    add(`presence:${field}`, `${resource.id}.${field} presence measure`);
  }
  for (const field of resource.count_distinct_fields) {
    add(`distinct:${field}`, `${resource.id}.${field} distinct count`);
  }
  for (const [field, buckets] of Object.entries(resource.time_bucket_fields)) {
    for (const bucket of buckets) {
      add(`time:${field}:${bucket}`, `${resource.id}.${field} time bucket ${bucket}`);
    }
  }
  for (const relationship of resource.relationships) {
    add(`relationship:${relationship.id}`, `${resource.id} relationship ${relationship.id}`);
  }
  return grants;
}

function summarizeAuthorityItems(items: string[], maximum = 8): string {
  const shown = items.slice(0, maximum);
  return shown.join(", ") + (items.length > shown.length ? `, +${items.length - shown.length} more` : "");
}

async function saveReviewedDisabledBoundary(input: {
  projectRoot: string;
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
  actor: string;
  reason: string;
}): Promise<void> {
  const progress = createBoundaryReviewProgress({
    draft: input.context.draft,
    candidate: input.context.candidate,
    confirmedDecisions: input.context.candidate.unresolved_decisions,
    ...(input.context.progress ? { previous: input.context.progress } : {}),
    actor: input.actor,
    reason: input.reason,
    revision: (input.context.progress?.revision ?? 0) + 1,
  });
  await saveBoundaryReviewSignoff(input.projectRoot, input.context, progress);
}

function readBoundaryFieldOperationFlags(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
  field: string,
  unavailable: boolean,
): BoundaryMapFieldRow["operations"] {
  return {
    return_value: !unavailable && resource.selectable_fields.includes(field),
    filter: !unavailable && (resource.filterable_fields[field]?.length ?? 0) > 0,
    sort: !unavailable && resource.sortable_fields.includes(field),
    group: !unavailable && (
      resource.groupable_fields.includes(field)
      || (resource.numeric_bands ?? []).some((band) => band.field === field)
      || (resource.auto_bands ?? []).some((policy) => policy.field === field)
    ),
    measure: !unavailable && resource.aggregate_measures.includes(field),
    presence: !unavailable && (resource.presence_measure_fields ?? []).includes(field),
    distinct: !unavailable && resource.count_distinct_fields.includes(field),
    time: !unavailable && (resource.time_bucket_fields[field]?.length ?? 0) > 0,
  };
}

function readBoundaryFieldReviewNote(
  roles: string[],
  access: BoundaryMapFieldRow["access"],
): string | undefined {
  const labels: string[] = [];
  if (roles.includes("trusted_scope")) labels.push("trusted scope");
  if (roles.includes("record_identity")) labels.push("record identity");
  else if (roles.includes("internal_identifier_candidate")) labels.push("possible internal identifier");
  if (roles.includes("relationship_key")) labels.push("relationship key");
  if (roles.includes("conflict_or_version_guard")) labels.push("possible conflict/version guard");
  if (roles.includes("private_policy_candidate")) labels.push("possible private policy fact");
  const unique = [...new Set(labels)];
  if (!unique.length) return undefined;
  const roleSummary = unique.join(", ");
  if (access === "MODEL") {
    return `REVIEW: model-facing ${roleSummary}; prefer Runner only unless raw values are intentionally required by the agent`;
  }
  if (access === "RUNNER") {
    const opaqueReference = unique.some((label) =>
      label === "record identity" || label === "internal identifier");
    return `Runner-only ${roleSummary}${opaqueReference ? "; model uses opaque obj_* references" : ""}`;
  }
  return `Kept out ${roleSummary}; unavailable to model and Runner reads`;
}

function styleReadBoundaryFieldMatrix(
  lines: string[],
  theme: ReturnType<typeof terminalTheme>,
): string[] {
  return lines.map((line) => {
    if (/^\s*\+/u.test(line)) return theme.dim(line);
    if (/\|\s*(?:Field|Property)\s*\|/u.test(line)) return theme.bold(line);
    let styled = line
      .replace("Model + Runner", theme.visible("Model + Runner"))
      .replace("Runner only", theme.runnerOnly("Runner only"))
      .replace("Kept out", theme.keptOut("Kept out"));
    const reviewAt = styled.indexOf("REVIEW:");
    if (reviewAt >= 0) {
      styled = `${styled.slice(0, reviewAt)}${theme.warning(styled.slice(reviewAt))}`;
    }
    return styled;
  });
}

export function formatFocusedBoundaryActivationReview(
  bundle: BoundaryReviewBundle,
  color = false,
  brandStyle = false,
  columns = 100,
  includeCompleteRevision = false,
): string {
  const theme = terminalTheme(color, {
    brand: brandStyle,
  });
  const reviewWidth = Math.min(160, Math.max(40, columns || 100));
  const revisionCatalog = readBoundaryRevisionCatalog(bundle.candidate);
  const accessSections = bundle.candidate.pack.resources.flatMap((resource, index) => {
    const catalogResource = revisionCatalog.resources.find((candidate) => candidate.id === resource.id);
    const keptOut = new Set(resource.kept_out_fields);
    const runnerOnly = new Set(resource.model_withheld_fields ?? []);
    const fields = Object.keys(resource.field_types).sort();
    const fieldRows: BoundaryMapFieldRow[] = fields.map((field) => {
      const access: BoundaryMapFieldRow["access"] = keptOut.has(field)
        ? "KEPT"
        : runnerOnly.has(field)
          ? "RUNNER"
          : "MODEL";
      const roles = catalogResource?.fields.find((candidate) => candidate.id === field)?.roles ?? [];
      const note = readBoundaryFieldReviewNote(roles, access);
      return {
        field,
        data_type: resource.field_types[field] ?? "reviewed",
        access,
        operations: readBoundaryFieldOperationFlags(resource, field, access === "KEPT"),
        ...(note ? { note } : {}),
      };
    }).sort((left, right) => {
      const leftReview = left.access === "MODEL" && left.note?.startsWith("REVIEW:") ? 0 : 1;
      const rightReview = right.access === "MODEL" && right.note?.startsWith("REVIEW:") ? 0 : 1;
      return leftReview - rightReview || left.field.localeCompare(right.field);
    });
    const riskyModelFields = fieldRows.filter((row) =>
      row.access === "MODEL" && row.note?.startsWith("REVIEW:"));
    const relationships = resource.relationships.map((relationship) => {
      const path = { source_resource: resource.id, target_resource: relationship.target_resource,
        links: relationship.proof?.links };
      const columns = formatRelationshipJoinColumns(path);
      return `${relationship.id}: ${formatRelationshipPath(path)}${columns ? ` via ${columns}` : ""}; ${relationship.cardinality.replaceAll("_", "-")}; unmatched rows ${relationship.unmatched_rows}`;
    });
    const reviewedValues = Object.entries(resource.field_enums).map(
      ([field, values]) => `${field}: ${values.join(" | ")}`,
    );
    const numericGroupings = [
      ...(resource.numeric_bands ?? []).map((band) =>
        `${band.name}: ${band.bucket_labels.length} fixed buckets`),
      ...(resource.auto_bands ?? []).map((policy) =>
        `${policy.field}: automatic ${policy.methods.join(" or ")}, ${policy.min_buckets}-${policy.max_buckets} buckets, ${policy.label_style} labels`),
    ];
    const modelCount = fieldRows.filter((row) => row.access === "MODEL").length;
    const runnerCount = fieldRows.filter((row) => row.access === "RUNNER").length;
    const keptCount = fieldRows.filter((row) => row.access === "KEPT").length;
    const settingsWidth = reviewWidth - 2;
    const settingKeyWidth = Math.min(20, Math.max(14, Math.floor((settingsWidth - 7) * 0.24)));
    const settingValueWidth = Math.max(12, settingsWidth - 7 - settingKeyWidth);
    return [
      ...(index === 0 ? [] : [""]),
      theme.title(`READ TABLE ${index + 1}/${bundle.candidate.pack.resources.length}`),
      `${theme.bold("Resource:")} ${theme.scope(resource.label ? `${resource.label} (${resource.id})` : resource.id)}`,
      ...(resource.description ? [theme.dim(resource.description)] : []),
      `${theme.bold("Field access:")} ${theme.visible(`${modelCount} Model + Runner`)} | `
        + `${theme.runnerOnly(`${runnerCount} Runner only`)} | ${theme.keptOut(`${keptCount} Kept out`)}`,
      ...(riskyModelFields.length
        ? [theme.warning(
            `REVIEW BEFORE ACTIVATION: ${riskyModelFields.map((row) => row.field).join(", ")} `
              + `${riskyModelFields.length === 1 ? "is" : "are"} model-facing internal or policy control data.`,
          )]
        : []),
      ...styleReadBoundaryFieldMatrix(
        renderBoundaryMapFieldMatrix(fieldRows, { width: reviewWidth, indent: "  " }),
        theme,
      ),
      ...styleBoundaryReviewAsciiTable(renderBoundaryMapTable(
        ["REVIEWED SETTING", "VALUE"],
        [
          ["Value allowlists", reviewedValues.length ? reviewedValues.join("; ") : "None"],
          ["Model vocabulary", formatExploreVocabularyCoverage(resource)],
          ["Numeric grouping", numericGroupings.length ? numericGroupings.join("; ") : "None"],
          ["Reviewed links", relationships.length ? relationships.join(", ") : "None"],
        ],
        { widths: [settingKeyWidth, settingValueWidth], indent: "  ", rowSeparators: false },
      ), theme),
    ];
  });
  const directTenantKeys = [...new Set(bundle.candidate.pack.resources
    .map((resource) => resource.tenant_key)
    .filter((value): value is string => Boolean(value)))];
  const allTenantScopesDirect = bundle.candidate.pack.resources.every(
    (resource) => Boolean(resource.tenant_key),
  );
  const tenantBinding = bundle.candidate.organization_scope
    ? `fixed reviewed organization ${bundle.candidate.organization_scope.organization_id}`
    : bundle.candidate.trusted_context.provider === "http_claims"
    ? `verified JWT claim ${bundle.candidate.trusted_context.tenant_claim}`
    : bundle.candidate.trusted_context.database_role_tenant
      ? `database role ${bundle.candidate.trusted_context.database_role_tenant.setting}`
      : bundle.candidate.trusted_context.tenant_env;
  const principalScopes = bundle.candidate.pack.resources
    .filter(hasReviewedPrincipalScope)
    .map((resource) => resource.principal_key
      ? `${resource.id}.${resource.principal_key}`
      : resource.principal_scope
        ? `${resource.id} through ${formatDerivedScopePath(resource.principal_scope)}`
        : `${resource.id} through PostgreSQL RLS setting ${resource.rls_session!.principal_setting}`);
  const tenantScopeSummary = bundle.candidate.organization_scope
    ? `Single organization (${bundle.candidate.organization_scope.organization_id}); no tenant predicate is applied`
    : allTenantScopesDirect && directTenantKeys.length === 1
      ? `${directTenantKeys[0]} on every table via ${tenantBinding}`
      : bundle.candidate.pack.resources.map((resource) =>
        resource.shared_reference_scope
          ? `${resource.id} Shared reference (no tenant predicate)`
          : `${resource.id} ${reviewedTenantScopeLabel(resource)} via ${tenantBinding}`)
        .join("; ");
  const principalBinding = bundle.candidate.trusted_context.provider === "http_claims"
    ? `verified JWT claim ${bundle.candidate.trusted_context.principal_claim}`
    : bundle.candidate.trusted_context.principal_env;
  const principalScopeSummary = principalScopes.length
    ? `Row filtering required for ${principalScopes.join(", ")} via ${principalBinding}`
    : bundle.candidate.deployment_profile === "production"
      ? `Required for per-user privacy budgets via ${principalBinding}; no reviewed principal row column`
      : "Not required for this boundary";
  const limitKeyWidth = Math.min(22, Math.max(16, Math.floor((reviewWidth - 7) * 0.24)));
  const limitValueWidth = Math.max(12, reviewWidth - 7 - limitKeyWidth);
  const limitsTable = renderBoundaryMapTable(
    ["LIMIT", "REVIEWED VALUE"],
    [
      ["Tenant scope", tenantScopeSummary],
      ["Principal scope", principalScopeSummary],
      [
        "Small-group privacy",
        `Minimum group sizes: ${bundle.candidate.pack.resources.map(
          (resource) => `${resource.id}=${resource.minimum_cohort_size}${
            resource.minimum_cohort_overridden ? " (owner override)" : ""
          }`,
        ).join(", ")}`,
      ],
      [
        "Ranked aggregates",
        `Validate at most ${bundle.candidate.budgets.max_ranked_groups
          ?? bundle.candidate.budgets.max_groups} candidate groups, suppress small cohorts, ` +
        `then return at most top ${bundle.candidate.budgets.max_top_n}`,
      ],
      [
        "Query volume",
        `${bundle.candidate.budgets.max_queries_per_session} queries per trusted scope in a rolling 24-hour window; ` +
        `${bundle.candidate.budgets.rate_limit_per_minute} requests per minute`,
      ],
      [
        "Disclosure controls",
        `${bundle.candidate.budgets.max_extracted_cells_per_session} extracted cells and ` +
        `${bundle.candidate.budgets.max_differencing_queries} differencing variants per rolling 24-hour window`,
      ],
      [
        "Writes",
        bundle.candidate.deployment_profile === "production"
          ? "None - this boundary is read-only production Explore"
          : "None - this boundary is local read-only Explore",
      ],
    ],
    { widths: [limitKeyWidth, limitValueWidth], rowSeparators: false },
  );
  const lines = [
    "",
    theme.title("REVIEW EXACT BOUNDARY"),
    `${theme.bold("Boundary:")} ${theme.scope(bundle.candidate.pack.name)}`,
    theme.dim("This confirmation grants Read authority only. Runner rechecks the schema and read-only role before activation; Action and execution reviews stay separate."),
    "",
    ...boundaryMapOperationLegend().map((line) => theme.dim(line)),
    "",
    ...accessSections,
    "",
    theme.title("BOUNDARY-WIDE CONTROLS"),
    ...styleBoundaryReviewAsciiTable(limitsTable, theme),
    "",
    `${theme.bold("Exact fingerprint:")} ${theme.scope(bundle.candidate_digest)}`,
    theme.success("Source database changed: no. The model cannot perform this confirmation."),
    ...(includeCompleteRevision ? ["", theme.title("COMPLETE REVIEWED REVISION (JSON)"), ...JSON.stringify(bundle.candidate, null, 2).split("\n")] : []),
    "",
  ];
  return lines
    .flatMap((line) => /^\s*[+|]/u.test(line)
      ? [line]
      : wrapStyledTerminalLine(line, reviewWidth))
    .join("\n");
}

function styleBoundaryReviewAsciiTable(
  lines: string[],
  theme: ReturnType<typeof terminalTheme>,
): string[] {
  return lines.map((line, index) => {
    if (/^\s*\+/u.test(line)) return theme.dim(line);
    if (index === 1) return theme.bold(line);
    return theme.value(line);
  });
}

export function formatReadActivationBusinessSummary(bundle: BoundaryReviewBundle, confirmedMeanings: ReadonlySet<string> = new Set(), privacy?: ReadPrivacyReview): string[] {
  const resources = bundle.candidate.pack.resources;
  const excluded = resources.flatMap((resource) => resource.kept_out_fields);
  const sharedCount = resources.filter((resource) => resource.shared_reference_scope).length;
  const unscopedCount = resources.filter((resource) => !resource.shared_reference_scope && !hasReviewedCustomerReadEntry(bundle.candidate, resource.id)).length;
  const readable = resources.map((resource) => resource.label ?? resource.id.split(".").at(-1)!.replaceAll("_", " "));
  const fields = readBoundaryRevisionCatalog(bundle.candidate).resources.flatMap((resource) => resource.fields);
  const privateCount = fields.filter((field) => !field.raw_return && !field.model_operations.length).length;
  const analysisOnlyCount = fields.filter((field) => !field.raw_return && field.model_operations.length).length;
  return [
    bundle.candidate.organization_scope
      ? "Who: whole-organization access, not one customer's information."
      : unscopedCount === 0 && resources.length > sharedCount
        ? "Who: only this customer's permitted records within their account; identity comes from the trusted session, never agent arguments."
        : resources.length === sharedCount
          ? "Who: reviewed shared references, not customer-private records."
          : `Who: account isolation is enforced, but ${unscopedCount} non-shared resource(s) lack individual customer filtering. Inspect exact scope before activation.`,
    `Can read: ${readable.join(", ")}.`,
    ...(bundle.candidate.read_prerequisite ? ["Access condition: the reviewed current status is checked before every data query. Missing, inactive or expired evidence denies access; its status and dates stay private. Open Private access condition in exact details for the mapping."] : []),
    `Kept private: ${privateCount} fields unavailable for customer viewing and analysis, including ${excluded.length} excluded from Read. Exact details names every field and operation.`,
    ...(analysisOnlyCount ? [`Analysis without raw values: ${analysisOnlyCount} field${analysisOnlyCount === 1 ? " permits" : "s permit"} some analysis but not direct viewing. These are not fully private; exact details lists the allowed operations.`] : []),
    ...readPrivacySummary(privacy ?? readPrivacyReview({ boundary: bundle.candidate, confirmedMeanings })),
    ...(sharedCount ? [`Shared references: ${sharedCount} reviewed resource(s) are intentionally common across accounts; inspect exact scope.`] : []),
    "This approval: read access only. It approves no request and executes no database change.",
  ];
}

export function formatReadActivationDecisionSummary(lines: string[], columns: number): string[] {
  const pending = lines.filter((line) => /^(?:Client integration still unverified|Next|Sequence|Still needed):/u.test(line));
  const facts = lines.filter((line) => !pending.includes(line));
  const concern = (line: string) => /^(?:Before activation|UNMET REQUEST|Privacy decision|Discovery compatibility|Execution prerequisite):/u.test(line);
  facts.sort((a, b) => Number(concern(b)) - Number(concern(a)));
  if (pending.length) facts.push(`Still needed: ${pending.map((line) => line.slice(line.indexOf(":") + 1).trim()).join(" ")}`);
  const rows: Array<[string, string]> = [];
  const notes: string[] = [];
  for (const line of facts) {
    const colon = line.indexOf(":");
    if (colon > 0 && colon < 40) rows.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
    else notes.push(line);
  }
  return [...renderReviewFacts(rows, columns - 2), ...notes.flatMap((line) => wrapStyledTerminalLine(line, columns - 2))];
}

export function formatBoundaryChatReviewSummary(
  bundle: BoundaryReviewBundle,
): string[] {
  const resources = bundle.candidate.pack.resources;
  const namespaces = resources.map((resource) => {
    const separator = resource.id.lastIndexOf(".");
    return separator > 0 ? resource.id.slice(0, separator) : undefined;
  });
  const sharedNamespace = namespaces.length > 0
    && namespaces.every((namespace) => namespace === namespaces[0])
    ? namespaces[0]
    : undefined;
  const reviewedResources = resources.map((resource) => {
    const fields = Object.keys(resource.field_types);
    const keptOut = new Set(resource.kept_out_fields);
    const runnerOnly = new Set(resource.model_withheld_fields ?? []);
    const modelFields = fields.filter((field) => !keptOut.has(field) && !runnerOnly.has(field));
    const scope = bundle.candidate.organization_scope
      ? "organization"
      : resource.shared_reference_scope
        ? "shared"
        : hasReviewedPrincipalScope(resource)
          ? "tenant + principal"
          : "tenant";
    return {
      name: sharedNamespace ? resource.id.slice(sharedNamespace.length + 1) : resource.id,
      modelFields: String(modelFields.length),
      runnerOnly: String(runnerOnly.size),
      keptOut: String(resource.kept_out_fields.length),
      scope,
    };
  });
  const sharedScope = reviewedResources.length > 0
    && reviewedResources.every((resource) => resource.scope === reviewedResources[0]?.scope)
    ? reviewedResources[0]?.scope
    : undefined;
  const rows = reviewedResources.map((resource) => sharedScope
    ? [resource.name, resource.modelFields, resource.runnerOnly, resource.keptOut]
    : [resource.name, resource.modelFields, resource.runnerOnly, resource.keptOut, resource.scope]);
  const modelFieldCount = resources.reduce(
    (total, resource) => total + Object.keys(resource.field_types).filter(
      (field) => !resource.kept_out_fields.includes(field)
        && !(resource.model_withheld_fields ?? []).includes(field),
    ).length,
    0,
  );
  const runnerOnlyFieldCount = resources.reduce(
    (total, resource) => total + (resource.model_withheld_fields ?? []).length,
    0,
  );
  const keptOutFieldCount = resources.reduce(
    (total, resource) => total + resource.kept_out_fields.length,
    0,
  );
  const relationshipCount = resources.reduce(
    (total, resource) => total + resource.relationships.length,
    0,
  );
  const cohortSizes = [...new Set(resources.map((resource) => resource.minimum_cohort_size))]
    .sort((left, right) => left - right)
    .join(", ");
  return [
    `Boundary: ${bundle.candidate.pack.name} | REVIEWED DRAFT | AGENT ACCESS OFF`,
    ...(sharedNamespace ? [`Schema: ${sharedNamespace}`] : []),
    ...(sharedScope ? [`Trusted scope: ${sharedScope}`] : []),
    ...renderBoundaryMapTable(
      sharedScope
        ? ["Reviewed table", "Model", "Runner only", "Kept out"]
        : ["Reviewed table", "Model", "Runner only", "Kept out", "Trusted scope"],
      rows,
      sharedScope
        ? { widths: [24, 7, 11, 8], rowSeparators: false }
        : { widths: [18, 7, 9, 7, 13], rowSeparators: false },
    ),
    `Reviewed: ${modelFieldCount} model | ${runnerOnlyFieldCount} Runner only | `
      + `${keptOutFieldCount} kept out | ${relationshipCount} relationships`,
    `Privacy: groups >= ${cohortSizes || "n/a"} | ranked results <= ${bundle.candidate.budgets.max_top_n}`,
    `24h scope limit: ${bundle.candidate.budgets.max_queries_per_session} queries | `
      + `${bundle.candidate.budgets.max_extracted_cells_per_session} cells`,
    "Agent access: OFF | source writes: NONE | source database changed: no",
    "Exact fields, allowlists, paths, limits, and fingerprints remain available in Details.",
  ];
}

function styleReviewTable(lines: string[], theme: ReturnType<typeof terminalTheme>): string[] {
  const separator = lines[1] ?? "";
  const splitAt = separator.indexOf("  ");
  if (splitAt < 0) return lines.map((line, index) =>
    index === 0 ? theme.bold(line) : index === 1 ? theme.dim(line) : theme.value(line));
  let activeLabel = "";
  return lines.map((line, index) => {
    if (index === 0) {
      return `${theme.title(line.slice(0, splitAt))}  ${theme.bold(line.slice(splitAt + 2))}`;
    }
    if (index === 1) return theme.dim(line);
    if (!line.trim()) {
      activeLabel = "";
      return line;
    }
    const labelCell = line.slice(0, splitAt);
    const valueCell = line.slice(splitAt + 2);
    const label = labelCell.trim();
    if (label) activeLabel = label;
    return `${label ? theme.key(labelCell) : labelCell}  ${styleReviewValue(valueCell, activeLabel, theme)}`;
  });
}

function styleReviewValue(
  value: string,
  label: string,
  theme: ReturnType<typeof terminalTheme>,
): string {
  if (label === "Table" || label === "Tenant scope" || label === "Principal scope") {
    return theme.scope(value);
  }
  if (label === "Model + Runner") return theme.visible(value);
  if (label === "Runner only") return theme.runnerOnly(value);
  if (label === "Kept out") return theme.keptOut(value);
  if (label === "Value allowlists" || label === "Numeric grouping" || label === "Reviewed links") {
    return theme.relationship(value);
  }
  if (label === "Model vocabulary") {
    return value.includes("reviewed vocabulary required") ? theme.warning(value) : theme.success(value);
  }
  if (label === "Small-group privacy") return theme.warning(value);
  if (label === "Writes") return theme.success(value);
  return theme.value(value);
}

function localInteractiveActor(): string {
  const value = process.env.SYNAPSOR_OPERATOR_ID?.trim()
    || process.env.USER?.trim()
    || "local-developer";
  if (value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  return "local-developer";
}

async function interactiveBoundaryRename(input: {
  projectRoot: string;
  session: BoundaryReviewInteractiveSession;
}): Promise<number> {
  const context = await loadBoundaryReviewContext(input.projectRoot);
  const currentName = context.candidate.pack.name;
  const requestedName = await input.session.promptText(
    `Boundary name [${currentName}] (letters, numbers, dot, dash, underscore): `,
  );
  if (requestedName === undefined) {
    process.stdout.write("Returned to boundary review. The boundary name was not changed.\n");
    return 0;
  }
  const nextName = requestedName ? requestedName.trim().toLowerCase() : currentName;
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(nextName)) {
    process.stdout.write([
      "Boundary name was not changed.",
      "Use 1-64 letters, numbers, dots, dashes, or underscores; start with a letter.",
      "You are still in boundary review. Active authority and Ask access are unchanged.",
      "",
    ].join("\n"));
    return 0;
  }
  if (requestedName && nextName !== requestedName.trim()) {
    process.stdout.write(`Using lower-case boundary name "${nextName}".\n`);
  }
  if (nextName === currentName) {
    process.stdout.write("Boundary name was not changed. Nothing was saved or activated.\n");
    return 0;
  }
  const actor = await input.session.promptText("Human reviewer identity (audit label, not a password): ");
  if (!actor) {
    process.stdout.write("Returned to boundary review. The boundary name was not changed.\n");
    return 0;
  }
  const reason = await input.session.promptText("Reason for naming this boundary: ");
  if (!reason) {
    process.stdout.write([
      "Boundary name was not changed. A reviewer identity and reason are required.",
      "You are still in boundary review. Active authority and Ask access are unchanged.",
      "",
    ].join("\n"));
    return 0;
  }
  const candidate = structuredClone(context.candidate);
  candidate.pack.name = nextName;
  const reviewed = reviewExplorationBoundaryCandidate(context.draft, candidate);
  process.stdout.write([
    "",
    "DISABLED BOUNDARY NAME CHANGE",
    `  Before: ${currentName}`,
    `  After:  ${nextName}`,
    `  Tables retained: ${reviewed.candidate.pack.resources.length}`,
    `  Candidate fingerprint: ${reviewed.digest}`,
    "  Active authority changed: no",
    "  Source database changed: no",
    "",
  ].join("\n"));
  if (!await input.session.confirm(
    "Save this name on the disabled next boundary now?",
    { defaultValue: true },
  )) {
    process.stdout.write("Boundary name change discarded. Nothing was saved or activated.\n");
    return 0;
  }
  const progress = await renameSavedBoundary({
    expectedAuthoring: context.bundle.mutation_bindings.authoring,
    projectRoot: input.projectRoot,
    draft: context.draft,
    currentCandidate: context.candidate,
    ...(context.progress ? { currentProgress: context.progress } : {}),
    name: currentName,
    newName: nextName,
    actor,
    reason,
  });
  await renameAskIntentCheckPreference({
    projectRoot: input.projectRoot,
    previousName: currentName,
    nextName,
  });
  process.stdout.write([
    `Saved boundary name "${nextName}" in review revision ${progress.revision}.`,
    `Next boundary contains ${progress.candidate.pack.resources.length} ` +
      `${progress.candidate.pack.resources.length === 1 ? "table" : "tables"}.`,
    "Authority activated: no",
    `Next: ${cliCommandName()} boundary review`,
    "",
  ].join("\n"));
  return 0;
}

async function confirmBoundaryReviewInteractively(input: {
  projectRoot: string;
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
  session: BoundaryReviewInteractiveSession;
  actor?: string;
}): Promise<{
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
  actor?: string;
}> {
  const outstanding = input.context.bundle.decisions.filter((decision) => !decision.confirmed);
  if (!outstanding.length) {
    return { context: input.context, actor: input.actor };
  }
  const finalReview = formatBoundaryFinalReview(input.context.bundle);
  const finalReviewContext = finalReview.trimEnd().split("\n");
  if (input.session.presentationMode !== "conversation") process.stdout.write(finalReview);
  const actor = input.actor
    || await input.session.promptText(
      "Human reviewer identity (audit label, not a password): ",
      { context: finalReviewContext },
    );
  if (!actor) {
    process.stdout.write([
      "Returned to boundary review. No sign-offs were recorded.",
      "The disabled draft and current agent authority are unchanged.",
      "",
    ].join("\n"));
    return { context: input.context };
  }
  const confirmed = new Set(input.context.progress?.confirmed_decisions ?? []);
  let acceptedGroups = 0;
  const boundaryDecisions = outstanding.filter((decision) => !decision.resource_id);
  if (boundaryDecisions.length) {
    const settingsSignoff = formatBoundarySettingsSignoff(input.context.bundle);
    const settingsContext = settingsSignoff.trimEnd().split("\n");
    if (input.session.presentationMode !== "conversation") process.stdout.write(settingsSignoff);
    const accepted = await input.session.confirm(
      input.context.candidate.deployment_profile === "production"
        ? "Confirm these boundary-wide production HTTP and trusted JWT scope settings?"
        : "Confirm these boundary-wide local-authoring and trusted-scope settings?",
      { defaultValue: true, context: settingsContext },
    );
    if (accepted === undefined) {
      process.stdout.write("Returned to boundary review. No sign-offs were recorded.\n");
      return { context: input.context, actor };
    }
    if (accepted) {
      boundaryDecisions.forEach((decision) => confirmed.add(decision.decision));
      acceptedGroups += 1;
    }
  }
  for (const resource of input.context.candidate.pack.resources) {
    const decisions = outstanding.filter((decision) => decision.resource_id === resource.id);
    if (!decisions.length) continue;
    const resourceSignoff = formatBoundaryResourceSignoff(resource, decisions.length);
    const resourceContext = resourceSignoff.trimEnd().split("\n");
    if (input.session.presentationMode !== "conversation") process.stdout.write(resourceSignoff);
    const accepted = await input.session.confirm(
      `Sign off ${resource.id} exactly as shown?`,
      { defaultValue: true, context: resourceContext },
    );
    if (accepted === undefined) {
      process.stdout.write("Returned to boundary review. No sign-offs from this review were recorded.\n");
      return { context: input.context, actor };
    }
    if (accepted) {
      decisions.forEach((decision) => confirmed.add(decision.decision));
      acceptedGroups += 1;
    }
  }
  if (!acceptedGroups) {
    process.stdout.write([
      "No review sign-offs were recorded.",
      "The disabled draft remains unchanged and grants no agent access.",
      `Next: ${cliCommandName()} boundary review`,
      "",
    ].join("\n"));
    return { context: input.context, actor };
  }
  const progress = createBoundaryReviewProgress({
    draft: input.context.draft,
    candidate: input.context.candidate,
    confirmedDecisions: [...confirmed],
    previous: input.context.progress,
    actor,
    reason: "Confirmed through the grouped CLI boundary review shown to this operator.",
    revision: (input.context.progress?.revision ?? 0) + 1,
  });
  await saveBoundaryReviewSignoff(input.projectRoot, input.context, progress);
  return {
    context: await loadBoundaryReviewContext(input.projectRoot),
    actor,
  };
}

async function confirmBoundaryResourceInteractively(input: {
  projectRoot: string;
  resourceId: string;
  session: BoundaryReviewInteractiveSession;
  context?: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
}): Promise<Awaited<ReturnType<typeof loadBoundaryReviewContext>>> {
  const context = input.context ?? await loadBoundaryReviewContext(input.projectRoot);
  const resource = context.candidate.pack.resources.find(
    (candidate) => candidate.id === input.resourceId,
  );
  if (!resource) {
    throw new Error(
      `${input.resourceId} is not in the disabled next boundary; include it before signing it off.`,
    );
  }
  const outstanding = context.bundle.decisions.filter(
    (decision) => decision.resource_id === input.resourceId && !decision.confirmed,
  );
  if (!outstanding.length) {
    process.stdout.write([
      `${input.resourceId} is already signed off for the current disabled boundary fingerprint.`,
      "No authority or source data changed.",
      "",
    ].join("\n"));
    return context;
  }
  const resourceSignoff = formatBoundaryResourceSignoff(resource, outstanding.length);
  const resourceContext = resourceSignoff.trimEnd().split("\n");
  process.stdout.write(resourceSignoff);
  const actor = await input.session.promptText(
    "Human reviewer identity (audit label, not a password): ",
    { context: resourceContext },
  );
  if (!actor) {
    process.stdout.write([
      "Returned to boundary review. Table sign-off was not recorded.",
      "The disabled draft and current agent authority are unchanged.",
      "",
    ].join("\n"));
    return context;
  }
  if (!await input.session.confirm(
    `Sign off ${input.resourceId} exactly as shown?`,
    { defaultValue: true, context: resourceContext },
  )) {
    process.stdout.write([
      "Table sign-off was not recorded.",
      "The disabled draft remains unchanged and grants no agent access.",
      "",
    ].join("\n"));
    return context;
  }
  const progress = createBoundaryReviewProgress({
    draft: context.draft,
    candidate: context.candidate,
    confirmedDecisions: [
      ...(context.progress?.confirmed_decisions ?? []),
      ...outstanding.map((decision) => decision.decision),
    ],
    previous: context.progress,
    actor,
    reason: `Confirmed the grouped CLI review for ${input.resourceId}.`,
    revision: (context.progress?.revision ?? 0) + 1,
  });
  await saveBoundaryReviewSignoff(input.projectRoot, context, progress);
  const updated = await loadBoundaryReviewContext(input.projectRoot);
  const remaining = boundaryReviewOverview(updated.bundle);
  process.stdout.write([
    `Signed off ${input.resourceId}.`,
    `${outstanding.length} digest-bound ${outstanding.length === 1 ? "decision is" : "decisions are"} now recorded under one table sign-off.`,
    `Review left: ${formatReviewLeft(remaining)}.`,
    "Authority activated: no",
    `Next: ${cliCommandName()} boundary review`,
    "",
  ].join("\n"));
  return updated;
}

async function interactiveBoundaryResourceRemoval(input: {
  projectRoot: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess?: boolean;
}): Promise<number | BoundaryAccessNotice> {
  if (!input.view.candidate) {
    process.stdout.write(`${input.view.resource_id} is not included. Nothing was changed.\n`);
    return 0;
  }
  const actor = input.focusedAccess
    ? localInteractiveActor()
    : await input.session.promptText("Human reviewer identity (audit label, not a password): ");
  if (!actor) {
    process.stdout.write([
      "Returned to boundary review. Table removal was not saved.",
      "The disabled draft and current agent authority are unchanged.",
      "",
    ].join("\n"));
    return 0;
  }
  const reason = input.focusedAccess
    ? "Staged through the focused access editor; this exact boundary revision requires final human confirmation."
    : await input.session.promptText("Reason for removing this table from the boundary: ");
  if (!reason) {
    process.stdout.write([
      "Returned to boundary review. Table removal was not saved.",
      "The disabled draft and current agent authority are unchanged.",
      "",
    ].join("\n"));
    return 0;
  }
  const request: BoundaryResourceReviewRequest = {
    resource_id: input.view.resource_id,
    exclude: true,
    actor,
    reason,
  };
  let preview: BoundaryReviewMutationPreview;
  try {
    preview = await prepareBoundaryResourceReviewMutation(
      input.projectRoot,
      request,
      input.schemaInspector,
    );
  } catch (error) {
    if (!input.focusedAccess) throw error;
    return {
      tone: "danger",
      title: `REMOVE BLOCKED - ${input.view.resource_id}`,
      lines: redactCliErrorMessage(error instanceof Error ? error.message : String(error))
        .split("\n"),
      footer: "No draft or active authority changed. Resolve the dependency, then press R again.",
    };
  }
  if (!input.focusedAccess) {
    process.stdout.write(formatBoundaryMutationPreview(preview, input.view));
    if (!await input.session.confirm(
      "Save this table removal on the disabled next boundary now?",
      { defaultValue: true },
    )) {
      process.stdout.write("Table removal discarded. Nothing was saved or activated.\n");
      return 0;
    }
  }
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  const prunedRelationships = preview.resource_removal_impact?.pruned_relationships ?? [];
  process.stdout.write(input.focusedAccess
    ? formatFocusedBoundaryEditSaved(
      input.view.resource_id,
      "removed",
      committed.review_revision,
      prunedRelationships.map((relationship) =>
        `Related-data relationship removed from the disabled draft: ` +
        `${formatRelationshipPath({
          source_resource: relationship.resource_id,
          target_resource: relationship.target_resource,
        })} (path ID: ${relationship.relationship_id})`),
    )
    : formatBoundaryMutationCommit(
      input.projectRoot,
      committed.review_revision,
      committed.candidate_digest,
      actor,
    ));
  return 0;
}

async function interactiveBoundaryResourceReview(input: {
  projectRoot: string;
  resourceId: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess?: boolean;
  initialTiers?: Record<string, BoundaryFieldTier>;
}): Promise<number | "back" | "review"> {
  if (!input.view.candidate && !input.view.generated_candidate) {
    const resolved = await resolveBlockedBoundaryResource({
      projectRoot: input.projectRoot,
      view: input.view,
      schemaInspector: input.schemaInspector,
      session: input.session,
      include: true,
    });
    if (!resolved || resolved === "back") return "back";
    return interactiveBoundaryResourceReview({ ...input, view: resolved });
  }
  const selected = await input.session.editFieldTiers(input.view, {
    focusedAccess: input.focusedAccess === true,
    ...(input.initialTiers ? { initialTiers: input.initialTiers } : {}),
  });
  if (selected === "back") return "back";
  if (selected === "privacy") return interactiveMinimumCohortReview(input);
  if (isPrincipalFieldTierAction(selected)) {
    const principalResult = await interactiveBoundaryPrincipalReview({
      ...input,
      stagedTiers: selected.tiers,
    });
    if (principalResult === "saved") {
      const updatedView = await inspectBoundaryResourceReview(input.projectRoot, input.resourceId);
      return interactiveBoundaryResourceReview({
        ...input,
        view: updatedView,
        initialTiers: selected.tiers,
      });
    }
    if (principalResult === "columns") {
      return interactiveBoundaryResourceReview({ ...input, initialTiers: selected.tiers });
    }
    return principalResult;
  }
  if (isMetadataFieldTierAction(selected)) {
    const metadataResult = await interactiveReviewedMetadataReview({
      projectRoot: input.projectRoot,
      resourceId: input.resourceId,
      field: selected.field,
      view: input.view,
      schemaInspector: input.schemaInspector,
      session: input.session,
    });
    const updatedView = metadataResult === "saved"
      ? await inspectBoundaryResourceReview(input.projectRoot, input.resourceId)
      : input.view;
    return interactiveBoundaryResourceReview({
      ...input,
      view: updatedView,
      initialTiers: selected.tiers,
    });
  }
  if (isEnumFieldTierAction(selected)) {
    const enumResult = await interactiveBoundaryEnumReview({
      ...input,
      field: selected.field,
      stagedTiers: selected.tiers,
    });
    if (enumResult === "saved") {
      const updatedView = await inspectBoundaryResourceReview(input.projectRoot, input.resourceId);
      return interactiveBoundaryResourceReview({
        ...input,
        view: updatedView,
        initialTiers: undefined,
      });
    }
    if (enumResult === "columns") {
      return interactiveBoundaryResourceReview({
        ...input,
        initialTiers: selected.tiers,
      });
    }
    return enumResult;
  }
  if (isExactNumericGroupingFieldTierAction(selected)) {
    const exactResult = await interactiveExactNumericGroupingReview({
      ...input,
      field: selected.field,
      enabled: selected.enabled,
    });
    const updatedView = exactResult === "saved"
      ? await inspectBoundaryResourceReview(input.projectRoot, input.resourceId)
      : input.view;
    return interactiveBoundaryResourceReview({
      ...input,
      view: updatedView,
      initialTiers: selected.tiers,
    });
  }
  const operationRestore = isRestoreFieldOperationsAction(selected) ? selected : undefined;
  if (typeof selected === "string") {
    if (selected.startsWith("enum:")) {
      const enumResult = await interactiveBoundaryEnumReview({
        ...input,
        field: selected.slice("enum:".length),
      });
      if (enumResult === "saved") {
        const updatedView = await inspectBoundaryResourceReview(input.projectRoot, input.resourceId);
        return interactiveBoundaryResourceReview({ ...input, view: updatedView });
      }
      if (enumResult === "columns") return interactiveBoundaryResourceReview(input);
      return enumResult;
    }
    throw new Error(`Unsupported column review action: ${selected}.`);
  }
  if (!selected) {
    process.stdout.write("Cancelled - no column access change was made or activated.\n");
    return 0;
  }
  const selectedTiers = operationRestore
    ? operationRestore.tiers
    : selected as Record<string, BoundaryFieldTier>;
  const changed = operationRestore
    ? [{
        field: operationRestore.field,
        tier: currentBoundaryFieldTier(input.view, operationRestore.field),
      }]
    : changedFieldTiers(input.view, selectedTiers);
  const includeResource = !input.view.candidate && Boolean(input.view.generated_candidate);
  if (!changed.length && !includeResource) {
    if (input.focusedAccess) {
      process.stdout.write([
        `Unchanged: ${input.resourceId} already has the access levels shown; no change was made.`,
        "Agent authority is unchanged.",
        "",
      ].join("\n"));
      return "back";
    }
    await confirmBoundaryResourceInteractively({
      projectRoot: input.projectRoot,
      resourceId: input.resourceId,
      session: input.session,
    });
    return "back";
  }
  const explicitReasonRequired = input.focusedAccess
    && (Boolean(operationRestore) || focusedEditNeedsExplicitReason(input.view, changed));
  const trustedScopeChange = changed.some(({ field }) => {
    const candidate = input.view.candidate ?? input.view.generated_candidate;
    return field === candidate?.tenant_key || field === candidate?.principal_key;
  });
  const actor = input.focusedAccess
    ? localInteractiveActor()
    : await input.session.promptText("Human reviewer identity (audit label, not a password): ");
  if (!actor) {
    process.stdout.write([
      "Returned to column review. This access change was not saved.",
      "The disabled draft and current agent authority are unchanged.",
      "",
    ].join("\n"));
    return input.focusedAccess ? "back" : 0;
  }
  let reason: string | undefined;
  if (explicitReasonRequired) {
    const auditedChanges = changed.map(({ field, tier }) =>
      `${input.resourceId}.${field} -> ${focusedTierOutcome(tier)}`);
    const reviewedChangeLabel = operationRestore
      ? "analytical-operation"
      : trustedScopeChange
        ? "trusted-scope"
        : "sensitive-field";
    const accessReasonContext = [
      "REVIEW ACCESS CHANGE",
      `This widens ${reviewedChangeLabel} access:`,
      ...auditedChanges.map((change) => `  ${change}`),
      `Reviewer: ${actor}`,
      "A concrete reason is required before Runner can save this change.",
      "Pressing Enter with an empty reason will not apply the change.",
    ];
    process.stdout.write([...accessReasonContext, ""].join("\n"));
    const prompt = `Required reason for this ${reviewedChangeLabel} access change`;
    while (reason === undefined) {
      const entered = await input.session.promptText(
        `${prompt}: `,
        { context: accessReasonContext },
      );
      if (entered === undefined) {
        process.stdout.write(`Cancelled - no ${reviewedChangeLabel} access change was made.\n\n`);
        return input.focusedAccess ? "back" : 0;
      }
      if (!entered.trim()) {
        process.stdout.write([
          "Rejected: a concrete reason is required; no change was made.",
          "Enter the reason now, or press Esc to cancel.",
          "",
        ].join("\n"));
        continue;
      }
      reason = entered.trim();
    }
  } else {
    reason = input.focusedAccess
      ? "Staged through the focused access editor; this exact boundary revision requires final human confirmation."
      : await input.session.promptText("Reason for this access decision: ");
  }
  if (!reason) {
    process.stdout.write([
      "Returned to column review. This access change was not saved.",
      "The disabled draft and current agent authority are unchanged.",
      "",
    ].join("\n"));
    return input.focusedAccess ? "back" : 0;
  }
  const request: BoundaryResourceReviewRequest = {
    resource_id: input.resourceId,
    ...(includeResource ? { include: true } : {}),
    keep_out_fields: changed.filter((item) => item.tier === "kept_out").map((item) => item.field),
    withhold_from_model_fields: changed
      .filter((item) => item.tier === "withheld_from_model")
      .map((item) => item.field),
    allow_reviewed_fields: changed.filter((item) => item.tier === "visible").map((item) => item.field),
    actor,
    reason,
  };
  let preview: BoundaryReviewMutationPreview;
  try {
    preview = await prepareBoundaryResourceReviewMutation(
      input.projectRoot,
      request,
      input.schemaInspector,
    );
  } catch (error) {
    if (!input.focusedAccess) throw error;
    process.stdout.write([
      `Rejected: ${redactCliErrorMessage(error instanceof Error ? error.message : String(error))}`,
      "No boundary change was made or activated.",
      "",
    ].join("\n"));
    return "back";
  }
  if (!input.focusedAccess) {
    process.stdout.write(formatBoundaryMutationPreview(preview, input.view));
    if (!await input.session.confirm(
      "Save this disabled review decision now?",
      { defaultValue: true },
    )) {
      process.stdout.write("Review decision discarded. Nothing was saved or activated.\n");
      return 0;
    }
  }
  let committed: Awaited<ReturnType<typeof commitBoundaryResourceReviewMutation>>;
  try {
    committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  } catch (error) {
    if (!input.focusedAccess) throw error;
    process.stdout.write([
      `Rejected: ${redactCliErrorMessage(error instanceof Error ? error.message : String(error))}`,
      "No boundary change was made or activated.",
      "",
    ].join("\n"));
    return "back";
  }
  const restoredOperationFields = preview.semantic_diff.analytical_operation_changes
    .filter((change) => change.before.length === 0 && change.after.length > 0)
    .map((change) => ({ field: change.field }));
  const reviewedResource = preview.candidate.pack.resources.find(
    (resource) => resource.id === input.resourceId,
  );
  process.stdout.write(input.focusedAccess
    ? [
      formatFocusedBoundaryEditSaved(
        input.resourceId,
        includeResource ? "added" : "updated",
        committed.review_revision,
      ).trimEnd(),
      ...changed.map(({ field, tier }) =>
        `Recorded: ${input.resourceId}.${field} -> ${focusedTierOutcome(tier)}; actor=${actor}; reason=${JSON.stringify(reason)}`),
      ...(restoredOperationFields.length && reviewedResource
        ? [
          "Restored only the operations currently supported by the field's inspected type, reviewed value allowlist, and database grammar:",
          ...restoredOperationFields.map(({ field }) =>
            `  ${input.resourceId}.${field}: ${reviewedFieldOperationSummary(reviewedResource, field)}`),
          "These grants are staged, not active. Use M to inspect them or Advanced field operations to narrow them before activation.",
        ]
        : changed.some(({ tier }) => tier === "withheld_from_model")
        ? [
          "Access-level note: changing Model + Runner to Runner only preserves existing operation grants and changes only where raw values may appear.",
          "Review additional or narrower operations separately in Workbench Advanced field operations or with --group-fields, --measure-fields, or --count-distinct-fields.",
        ]
        : []),
      "",
    ].join("\n")
    : formatBoundaryMutationCommit(
      input.projectRoot,
      committed.review_revision,
      committed.candidate_digest,
      actor,
    ));
  return input.focusedAccess ? "back" : 0;
}

function isEnumFieldTierAction(value: unknown): value is {
  action: "enum";
  field: string;
  tiers: Record<string, BoundaryFieldTier>;
} {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { action?: unknown }).action === "enum"
    && typeof (value as { field?: unknown }).field === "string"
    && Boolean((value as { tiers?: unknown }).tiers)
    && typeof (value as { tiers?: unknown }).tiers === "object"
    && !Array.isArray((value as { tiers?: unknown }).tiers);
}

function isMetadataFieldTierAction(value: unknown): value is {
  action: "metadata";
  field: string;
  tiers: Record<string, BoundaryFieldTier>;
} {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { action?: unknown }).action === "metadata"
    && typeof (value as { field?: unknown }).field === "string"
    && Boolean((value as { tiers?: unknown }).tiers)
    && typeof (value as { tiers?: unknown }).tiers === "object"
    && !Array.isArray((value as { tiers?: unknown }).tiers);
}

function isRestoreFieldOperationsAction(value: unknown): value is {
  action: "restore_operations";
  field: string;
  tiers: Record<string, BoundaryFieldTier>;
} {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { action?: unknown }).action === "restore_operations"
    && typeof (value as { field?: unknown }).field === "string"
    && Boolean((value as { tiers?: unknown }).tiers)
    && typeof (value as { tiers?: unknown }).tiers === "object"
    && !Array.isArray((value as { tiers?: unknown }).tiers);
}

function isExactNumericGroupingFieldTierAction(value: unknown): value is {
  action: "exact_numeric_grouping";
  field: string;
  enabled: boolean;
  tiers: Record<string, BoundaryFieldTier>;
} {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { action?: unknown }).action === "exact_numeric_grouping"
    && typeof (value as { field?: unknown }).field === "string"
    && typeof (value as { enabled?: unknown }).enabled === "boolean"
    && Boolean((value as { tiers?: unknown }).tiers)
    && typeof (value as { tiers?: unknown }).tiers === "object"
    && !Array.isArray((value as { tiers?: unknown }).tiers);
}

async function interactiveExactNumericGroupingReview(input: {
  projectRoot: string;
  resourceId: string;
  field: string;
  enabled: boolean;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess?: boolean;
}): Promise<"saved" | "cancelled"> {
  const resource = input.view.candidate ?? input.view.generated_candidate;
  if (!resource) return "cancelled";
  const budgets = input.view.reviewed_budgets;
  const exactGroupingContext = [
    `${input.enabled ? "ENABLE" : "REMOVE"} EXACT GROUPS - ${input.resourceId}.${input.field}`,
    input.enabled
      ? "Exact scalar values will become a reviewed grouping dimension. This is separate from fixed or automatic numeric bands."
      : "The exact grouping grant will be removed from the disabled revision.",
    ...(input.enabled ? [
      `Privacy and shape remain enforced: minimum group ${resource.minimum_cohort_size}; `
        + `maximum ${budgets?.max_groups ?? "reviewed"} groups; top ${budgets?.max_top_n ?? "reviewed"}; `
        + `${budgets?.max_response_cells ?? "reviewed"} cells; ${budgets?.max_response_bytes ?? "reviewed"} bytes.`,
      `Execution remains bounded by ${budgets?.statement_timeout_ms ?? "the reviewed"} ms statement timeout and the reviewed rolling query budgets.`,
    ] : []),
    "This saves only a disabled revision. Current active Explore authority does not change until exact-digest activation.",
  ];
  process.stdout.write([...exactGroupingContext, ""].join("\n"));
  const actor = input.focusedAccess
    ? localInteractiveActor()
    : await input.session.promptText(
        "Human reviewer identity (audit label, not a password)",
        { context: exactGroupingContext },
      );
  if (!actor) return "cancelled";
  let reason: string | undefined;
  while (!reason) {
    const entered = await input.session.promptText(
      input.enabled
        ? "Required reason this field is a safe, meaningful exact grouping dimension"
        : "Required reason for removing exact grouping",
      { context: exactGroupingContext },
    );
    if (entered === undefined) return "cancelled";
    reason = entered.trim();
    if (!reason) {
      process.stdout.write("Rejected: a concrete reason is required; no change was made. Enter it now, or press Esc to cancel.\n");
    }
  }
  try {
    const preview = await prepareBoundaryResourceReviewMutation(
      input.projectRoot,
      {
        resource_id: input.resourceId,
        ...(input.enabled
          ? { allow_exact_numeric_grouping_fields: [input.field] }
          : { remove_exact_numeric_grouping_fields: [input.field] }),
        actor,
        reason,
      },
      input.schemaInspector,
    );
    if (!input.focusedAccess) {
      process.stdout.write(formatBoundaryMutationPreview(preview, input.view));
      const confirmed = await input.session.confirm(
        "Save this exact grouping decision in the disabled boundary?",
        { defaultValue: true },
      );
      if (!confirmed) return "cancelled";
    }
    const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
    process.stdout.write([
      `Recorded: ${input.resourceId}.${input.field} exact grouping ${input.enabled ? "enabled" : "removed"}.`,
      `Actor: ${actor}; reason: ${JSON.stringify(reason)}.`,
      `Saved in disabled boundary revision ${committed.review_revision}. Active authority changed: no.`,
      "Use C Review + activate before this decision reaches local or production HTTP Explore.",
      "",
    ].join("\n"));
    return "saved";
  } catch (error) {
    process.stdout.write([
      `Rejected: ${redactCliErrorMessage(error instanceof Error ? error.message : String(error))}`,
      "No exact grouping change was made or activated.",
      "",
    ].join("\n"));
    return "cancelled";
  }
}

async function interactiveReviewedMetadataReview(input: {
  projectRoot: string;
  resourceId: string;
  field?: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
}): Promise<"saved" | "unchanged" | "cancelled"> {
  const candidate = input.view.candidate ?? input.view.generated_candidate;
  if (!candidate) {
    process.stdout.write("Rejected: include and resolve this table before adding reviewed metadata. No change was made.\n\n");
    return "cancelled";
  }
  const current = input.field
    ? candidate.field_metadata?.[input.field]
    : candidate;
  const subject = input.field
    ? `${input.resourceId}.${input.field}`
    : input.resourceId;
  const metadataContext = [
    `REVIEWED NAME AND DESCRIPTION - ${subject}`,
    "This metadata helps people and AI clients understand the exact database id. It grants no data access.",
    "Plans must still use the exact id. Enter keeps the current value; type - to clear it; Esc cancels.",
    `Current label: ${current?.label ?? "None"}`,
    `Current description: ${current?.description ?? "None"}`,
  ];
  process.stdout.write([...metadataContext, ""].join("\n"));
  const labelInput = await input.session.promptText(
    "Label (maximum 64 characters)",
    { context: metadataContext },
  );
  if (labelInput === undefined) {
    process.stdout.write("Cancelled - no reviewed metadata change was made.\n\n");
    return "cancelled";
  }
  const descriptionInput = await input.session.promptText(
    "Description (maximum 280 characters)",
    {
      context: [
        ...metadataContext,
        `Proposed label: ${labelInput.trim() || current?.label || "None"}`,
      ],
    },
  );
  if (descriptionInput === undefined) {
    process.stdout.write("Cancelled - no reviewed metadata change was made.\n\n");
    return "cancelled";
  }
  const label = reviewedMetadataPromptValue(labelInput);
  const description = reviewedMetadataPromptValue(descriptionInput);
  const effectiveLabel = label === undefined ? current?.label : label ?? undefined;
  const effectiveDescription = description === undefined
    ? current?.description
    : description ?? undefined;
  if (effectiveLabel === current?.label && effectiveDescription === current?.description) {
    process.stdout.write(`Unchanged: ${subject} already has the reviewed metadata shown; no change was made.\n\n`);
    return "unchanged";
  }
  let reason: string | undefined;
  while (!reason) {
    const entered = await input.session.promptText(
      "Required reason for this reviewed metadata change",
      {
        context: [
          `REVIEWED NAME AND DESCRIPTION - ${subject}`,
          `Label: ${effectiveLabel ?? "None"}`,
          `Description: ${effectiveDescription ?? "None"}`,
          "Metadata grants no data access; this reason is stored with the disabled review decision.",
        ],
      },
    );
    if (entered === undefined) {
      process.stdout.write("Cancelled - no reviewed metadata change was made.\n\n");
      return "cancelled";
    }
    reason = entered.trim();
    if (!reason) {
      process.stdout.write("Rejected: a concrete reason is required; no change was made. Enter it now, or press Esc to cancel.\n");
    }
  }
  const actor = localInteractiveActor();
  const metadata = {
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
  };
  try {
    const preview = await prepareBoundaryResourceReviewMutation(
      input.projectRoot,
      {
        resource_id: input.resourceId,
        ...(input.field
          ? { field_metadata: [{ field: input.field, ...metadata }] }
          : { metadata }),
        actor,
        reason,
      },
      input.schemaInspector,
    );
    const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
    process.stdout.write([
      `Recorded: ${subject} -> label=${JSON.stringify(effectiveLabel ?? null)}, description=${JSON.stringify(effectiveDescription ?? null)}.`,
      `Actor: ${actor}; reason: ${JSON.stringify(reason)}.`,
      `Saved in disabled boundary revision ${committed.review_revision}. Agent authority changed: no.`,
      "Use C Review + activate before this metadata reaches an AI client.",
      "",
    ].join("\n"));
    return "saved";
  } catch (error) {
    process.stdout.write([
      `Rejected: ${redactCliErrorMessage(error instanceof Error ? error.message : String(error))}`,
      "No reviewed metadata change was made or activated.",
      "",
    ].join("\n"));
    return "cancelled";
  }
}

function reviewedMetadataPromptValue(value: string): string | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed === "-" ? null : trimmed;
}

function isPrincipalFieldTierAction(value: unknown): value is {
  action: "principal";
  tiers: Record<string, BoundaryFieldTier>;
} {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { action?: unknown }).action === "principal"
    && Boolean((value as { tiers?: unknown }).tiers)
    && typeof (value as { tiers?: unknown }).tiers === "object"
    && !Array.isArray((value as { tiers?: unknown }).tiers);
}

async function interactiveBoundaryPrincipalReview(input: {
  projectRoot: string;
  resourceId: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess?: boolean;
  stagedTiers: Record<string, BoundaryFieldTier>;
}): Promise<number | "columns" | "saved"> {
  const candidate = input.view.candidate ?? input.view.generated_candidate;
  if (!candidate) return "columns";
  const direct = input.view.fields
    .filter((field) => field.nullable === false && !/(?:bytea|blob|binary|varbinary|image)/i.test(field.data_type))
    .map((field) => ({
      kind: "direct" as const,
      value: field.name,
      label: `Direct column ${field.name}`,
    }));
  const derived = (input.view.derived_principal_scope?.candidates ?? []).map((scope) => ({
    kind: "derived" as const,
    value: scope.path_id,
    label: `Mandatory path ${formatDerivedScopePath(scope)}`,
  }));
  const rls = (input.view.rls?.principal_setting_candidates ?? []).map((setting) => ({
    kind: "postgres_rls" as const,
    value: setting,
    label: `PostgreSQL RLS setting ${setting}`,
  }));
  const options = [
    { kind: "none" as const, value: "", label: "No per-user row limit" },
    ...direct,
    ...derived,
    ...rls,
  ];
  const currentIndex = Math.max(0, options.findIndex((option) =>
    (option.kind === "direct" && option.value === candidate.principal_key)
    || (option.kind === "derived" && option.value === candidate.principal_scope?.path_id)
    || (option.kind === "postgres_rls"
      && option.value === candidate.rls_session?.principal_setting)
    || (option.kind === "none"
      && !candidate.principal_key
      && !candidate.principal_scope
      && !candidate.rls_session?.principal_setting)));
  const rowLimitMenu = [
    `USER/OWNER ROW LIMIT - ${input.resourceId}`,
    "Runner binds this value from trusted application context. The AI never supplies it.",
    "Choose one reviewed column/path, or explicitly keep no per-user row limit:",
    ...options.map((option, index) =>
      `  ${index + 1}  ${option.label}${index === currentIndex ? " [current]" : ""}`),
  ];
  process.stdout.write([...rowLimitMenu, ""].join("\n"));
  const selectedText = await input.session.promptText(
    `Choice number [${currentIndex + 1}]`,
    { context: rowLimitMenu },
  );
  if (selectedText === undefined) {
    process.stdout.write("Cancelled - no user/owner row-limit change was made.\n\n");
    return "columns";
  }
  const selectedIndex = Number(selectedText.trim() || String(currentIndex + 1)) - 1;
  const selected = options[selectedIndex];
  if (!selected || !Number.isSafeInteger(selectedIndex)) {
    process.stdout.write("Rejected: choose one of the listed numbers; no change was made.\n\n");
    return "columns";
  }
  if (selectedIndex === currentIndex) {
    process.stdout.write("Unchanged: this table already uses that user/owner row limit.\n\n");
    return "columns";
  }
  let reason: string | undefined;
  while (!reason) {
    const entered = await input.session.promptText(
      "Required reason for this trusted user/owner row-limit decision",
      {
        context: [
          `USER/OWNER ROW LIMIT - ${input.resourceId}`,
          `Current: ${options[currentIndex]?.label ?? "No per-user row limit"}`,
          `Proposed: ${selected.label}`,
          "Runner binds this value from trusted application context. The AI never supplies it.",
        ],
      },
    );
    if (entered === undefined) {
      process.stdout.write("Cancelled - no user/owner row-limit change was made.\n\n");
      return "columns";
    }
    reason = entered.trim();
    if (!reason) {
      process.stdout.write("Rejected: a concrete reason is required; no change was made. Enter it now, or press Esc to cancel.\n");
    }
  }
  const actor = localInteractiveActor();
  const request: BoundaryResourceReviewRequest = {
    resource_id: input.resourceId,
    ...(selected.kind === "direct"
      ? { principal_key: selected.value }
      : selected.kind === "derived"
        ? { principal_scope_path: selected.value }
        : selected.kind === "postgres_rls"
          ? { principal_rls_setting: selected.value }
          : {
              principal_key: null,
              principal_scope_path: null,
              principal_rls_setting: null,
            }),
    actor,
    reason,
  };
  try {
    const preview = await prepareBoundaryResourceReviewMutation(
      input.projectRoot,
      request,
      input.schemaInspector,
    );
    const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
    process.stdout.write([
      `Saved: ${input.resourceId} user/owner row limit -> ${selected.label}.`,
      `Actor: ${actor}; reason: ${JSON.stringify(reason)}.`,
      `Disabled boundary revision ${committed.review_revision}; agent authority is unchanged until C Review + activate.`,
      "Returning to this table's columns.",
      "",
    ].join("\n"));
    return "saved";
  } catch (error) {
    process.stdout.write([
      `Rejected: ${redactCliErrorMessage(error instanceof Error ? error.message : String(error))}`,
      "No boundary change was made or activated. Returning to this table's columns.",
      "",
    ].join("\n"));
    return "columns";
  }
}

async function interactiveBoundaryEnumReview(input: {
  projectRoot: string;
  resourceId: string;
  field: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess?: boolean;
  stagedTiers?: Record<string, BoundaryFieldTier>;
}): Promise<number | "columns" | "saved"> {
  const inspectedField = input.view.fields.find((field) => field.name === input.field);
  const schemaValues = inspectedField?.enum_values;
  const candidate = input.view.candidate ?? input.view.generated_candidate;
  if (!inspectedField || !schemaValues?.length || !candidate) {
    process.stdout.write(
      `Unchanged: ${input.resourceId}.${input.field} has no bounded database-declared value list to review.\n`,
    );
    return "columns";
  }
  if (!input.session.editFieldEnumValues) {
    throw new Error("This terminal session cannot edit reviewed categorical values.");
  }
  const selected = await input.session.editFieldEnumValues(input.view, input.field);
  if (selected === "back") return "columns";
  if (!selected) {
    process.stdout.write("Cancelled - no allowed-value change was made or activated.\n");
    return "columns";
  }
  const current = Object.hasOwn(candidate.field_enums, input.field)
    ? candidate.field_enums[input.field] ?? []
    : inspectedField.enum_review_override
      ? []
      : schemaValues;
  if (JSON.stringify(current) === JSON.stringify(selected)) {
    process.stdout.write([
      `Unchanged: ${input.resourceId}.${input.field} already uses these allowed values.`,
      "Agent authority is unchanged.",
      "",
    ].join("\n"));
    return "columns";
  }

  const changedTiers = input.stagedTiers
    ? changedFieldTiers(input.view, input.stagedTiers)
    : [];

  const actor = input.focusedAccess
    ? localInteractiveActor()
    : await input.session.promptText("Human reviewer identity (audit label, not a password): ");
  if (!actor) {
    process.stdout.write("Cancelled - no allowed-value change was made or activated.\n");
    return "columns";
  }
  const allowedValuesContext = [
    "REVIEW ALLOWED VALUES",
    `Reviewing allowed values for ${input.resourceId}.${input.field}.`,
    `Database-declared maximum: ${schemaValues.join(", ")}`,
    `Values to keep: ${selected.length ? selected.join(", ") : "none"}`,
    ...(changedTiers.length
      ? [
          "After you enter the required reason, these column access changes will be saved with the allowed-value review:",
          ...changedTiers.map(({ field, tier }) =>
            `  ${input.resourceId}.${field} -> ${focusedTierOutcome(tier)}`),
        ]
      : []),
    selected.length
      ? "Removed values will be refused before a source query, even if an AI guesses them."
      : "Keeping none disables filtering and grouping for this column; it does not enable free-text access.",
    `Reviewer: ${actor}`,
    "A concrete reason is required. Pressing Enter with an empty reason will not save the change.",
  ];
  process.stdout.write([...allowedValuesContext, ""].join("\n"));
  let reason: string | undefined;
  while (reason === undefined) {
    const entered = await input.session.promptText(
      "Required reason for this allowed-value change: ",
      { context: allowedValuesContext },
    );
    if (entered === undefined) {
      process.stdout.write("Cancelled - no allowed-value change was made or activated.\n");
      return "columns";
    }
    if (!entered.trim()) {
      process.stdout.write([
        "Rejected: a concrete reason is required; no change was made.",
        "Enter the reason now, or press Esc to cancel.",
        "",
      ].join("\n"));
      continue;
    }
    reason = entered.trim();
  }

  const preview = await prepareBoundaryResourceReviewMutation(
    input.projectRoot,
    {
      resource_id: input.resourceId,
      ...(!input.view.candidate && input.view.generated_candidate ? { include: true } : {}),
      keep_out_fields: changedTiers
        .filter((item) => item.tier === "kept_out")
        .map((item) => item.field),
      withhold_from_model_fields: changedTiers
        .filter((item) => item.tier === "withheld_from_model")
        .map((item) => item.field),
      allow_reviewed_fields: changedTiers
        .filter((item) => item.tier === "visible")
        .map((item) => item.field),
      field_enum: { field: input.field, values: selected },
      actor,
      reason,
    },
    input.schemaInspector,
  );
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Recorded: ${input.resourceId}.${input.field} allowed values -> ${selected.length ? selected.join(" | ") : "none (filtering and grouping disabled)"}.`,
    ...changedTiers.map(({ field, tier }) =>
      `Recorded: ${input.resourceId}.${field} -> ${focusedTierOutcome(tier)}.`),
    `Actor: ${actor}. Reason: ${reason}`,
    `Saved in disabled boundary revision ${committed.review_revision}. Agent authority changed: no.`,
    "The active Ask session keeps using the previous boundary until this revision is reviewed and activated.",
    "",
  ].join("\n"));
  return "saved";
}

async function interactiveMinimumCohortReview(input: {
  projectRoot: string;
  resourceId: string;
  view: BoundaryResourceReviewView;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess?: boolean;
}): Promise<number | "back" | "review"> {
  const candidate = input.view.candidate ?? input.view.generated_candidate;
  if (!candidate) return "back";
  const privacyContext = [
    `PRIVACY - ${input.resourceId}`,
    `Current minimum group size: ${candidate.minimum_cohort_size}`,
    "Runner hides aggregate groups with fewer rows than this number.",
    "Enter a whole number from 1 through 5. Use 1 to turn small-group suppression off.",
  ];
  process.stdout.write(["", ...privacyContext, ""].join("\n"));
  const enteredInput = await input.session.promptText(
    `New minimum group size [current ${candidate.minimum_cohort_size}]: `,
    { context: privacyContext },
  );
  if (enteredInput === undefined) return "back";
  const entered = enteredInput.trim().toLowerCase();
  if (!entered) return "back";
  const minimumCohort = entered === "off" || entered === "none" || entered === "0"
    ? 1
    : Number(entered);
  if (!Number.isSafeInteger(minimumCohort) || minimumCohort < 1 || minimumCohort > 5) {
    throw new Error(
      "Enter a whole number from 1 through 5. Use 1 to turn small-group suppression off.",
    );
  }
  if (minimumCohort === candidate.minimum_cohort_size) {
    process.stdout.write("The minimum group size is unchanged.\n");
    return "back";
  }
  const reasonInput = await input.session.promptText(
    `Reason for changing ${input.resourceId} from ${candidate.minimum_cohort_size} to ${minimumCohort} (recorded with this decision): `,
    {
      context: [
        `PRIVACY - ${input.resourceId}`,
        `Minimum group size: ${candidate.minimum_cohort_size} -> ${minimumCohort}`,
        minimumCohort === 1
          ? "Warning: small-group suppression will be off after activation."
          : `Groups with fewer than ${minimumCohort} rows will be hidden after activation.`,
      ],
    },
  );
  if (reasonInput === undefined) {
    process.stdout.write("Returned to column review. The minimum group size was not changed.\n");
    return "back";
  }
  const reason = reasonInput.trim();
  if (!reason) {
    throw new Error("Changing the minimum group size requires a concrete human reason.");
  }
  const privacyReviewContext = minimumCohort === 1
    ? [
        "REVIEW PRIVACY CHANGE",
        "New setting: minimum group size 1 (small-group suppression off).",
        "Consequence: aggregate output may contain a group with one person or record.",
        `Recorded reason: ${reason}`,
      ]
    : [
        "REVIEW PRIVACY CHANGE",
        `New setting: minimum group size ${minimumCohort}.`,
        `Groups with fewer than ${minimumCohort} rows will be hidden.`,
        `Recorded reason: ${reason}`,
      ];
  process.stdout.write(`${privacyReviewContext.slice(1).join("\n")}\n`);
  if (!await input.session.confirm(
    `Save this privacy change for ${input.resourceId}?`,
    { defaultValue: true, context: privacyReviewContext },
  )) {
    process.stdout.write("Privacy change discarded. Nothing was saved or activated.\n");
    return "back";
  }
  const preview = await prepareBoundaryResourceReviewMutation(
    input.projectRoot,
    {
      resource_id: input.resourceId,
      minimum_cohort_size: minimumCohort,
      actor: localInteractiveActor(),
      reason,
    },
    input.schemaInspector,
  );
  const committed = await commitBoundaryResourceReviewMutation(input.projectRoot, preview);
  process.stdout.write([
    `Saved minimum group size ${minimumCohort}${minimumCohort === 1 ? " (small-group suppression off)" : ""} in disabled boundary revision ${committed.review_revision}.`,
    "Agent authority changed: no.",
    "Ask does not use this minimum group size until the updated boundary is activated.",
    "",
  ].join("\n"));
  return input.focusedAccess
    ? offerImmediateBoundaryActivation(input.session)
    : 0;
}

async function interactiveBoundaryMinimumCohortReview(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  focusedAccess: boolean;
}): Promise<number | "back" | "review"> {
  const resources = (await listBoundaryResourceReviews(input.projectRoot))
    .filter((resource) => resource.included);
  if (!resources.length) {
    process.stdout.write("Add at least one table before setting boundary-wide privacy.\n");
    return "back";
  }
  const currentValues = [...new Set(resources.map((resource) =>
    resource.minimum_cohort_size ?? 5))].sort((left, right) => left - right);
  const currentLabel = currentValues.length === 1
    ? String(currentValues[0])
    : `mixed (${currentValues.join(", ")})`;
  const privacyContext = [
    `PRIVACY - ALL ${resources.length} TABLES IN THIS BOUNDARY`,
    `Current minimum group size: ${currentLabel}`,
    "Runner hides aggregate groups with fewer rows than the selected number.",
    "Enter a whole number from 1 through 5. Use 1 to turn small-group suppression off for every included table.",
  ];
  process.stdout.write(["", ...privacyContext, ""].join("\n"));
  const enteredInput = await input.session.promptText(
    `New minimum group size for all tables [current ${currentLabel}]: `,
    { context: privacyContext },
  );
  if (enteredInput === undefined) return "back";
  const entered = enteredInput.trim().toLowerCase();
  if (!entered) return "back";
  const minimumCohort = entered === "off" || entered === "none" || entered === "0"
    ? 1
    : Number(entered);
  if (!Number.isSafeInteger(minimumCohort) || minimumCohort < 1 || minimumCohort > 5) {
    throw new Error(
      "Enter a whole number from 1 through 5. Use 1 to turn small-group suppression off.",
    );
  }
  const changed = resources.filter((resource) =>
    (resource.minimum_cohort_size ?? 5) !== minimumCohort);
  if (!changed.length) {
    process.stdout.write(`Every table already uses minimum group size ${minimumCohort}.\n`);
    return "back";
  }
  const reasonInput = await input.session.promptText(
    `Reason for setting ${changed.length} table${changed.length === 1 ? "" : "s"} to minimum group size ${minimumCohort} (recorded with this decision): `,
    {
      context: [
        "BOUNDARY-WIDE PRIVACY",
        `Affected tables: ${changed.length}`,
        `Minimum group size: ${currentLabel} -> ${minimumCohort}`,
        minimumCohort === 1
          ? "Warning: small-group suppression will be off for every included table after activation."
          : `Groups with fewer than ${minimumCohort} rows will be hidden after activation.`,
      ],
    },
  );
  if (reasonInput === undefined) {
    process.stdout.write("Returned to boundary review. No minimum group size changed.\n");
    return "back";
  }
  const reason = reasonInput.trim();
  if (!reason) {
    throw new Error("Changing minimum group sizes requires a concrete human reason.");
  }
  const privacyReviewContext = minimumCohort === 1
    ? [
        "REVIEW BOUNDARY-WIDE PRIVACY CHANGE",
        "New setting: minimum group size 1 for every included table (small-group suppression off).",
        "Consequence: aggregate output may contain groups with one person or record.",
        `Recorded reason: ${reason}`,
      ]
    : [
        "REVIEW BOUNDARY-WIDE PRIVACY CHANGE",
        `New setting: minimum group size ${minimumCohort} for every included table.`,
        `Groups with fewer than ${minimumCohort} rows will be hidden.`,
        `Recorded reason: ${reason}`,
      ];
  process.stdout.write(`${privacyReviewContext.slice(1).join("\n")}\n`);
  if (!await input.session.confirm(
    `Save this privacy change for ${changed.length} table${changed.length === 1 ? "" : "s"}?`,
    { defaultValue: true, context: privacyReviewContext },
  )) {
    process.stdout.write("Boundary-wide privacy change discarded. Nothing was saved or activated.\n");
    return "back";
  }
  const actor = localInteractiveActor();
  const preview = await prepareBoundaryReviewMutationBatch(
    input.projectRoot,
    changed.map((resource) => ({
      resource_id: resource.resource_id,
      minimum_cohort_size: minimumCohort,
      actor,
      reason,
    })),
    input.schemaInspector,
  );
  const committed = await commitBoundaryReviewMutationBatch(input.projectRoot, preview);
  process.stdout.write([
    `Saved minimum group size ${minimumCohort}${minimumCohort === 1 ? " (small-group suppression off)" : ""} for ${changed.length} table${changed.length === 1 ? "" : "s"} in disabled boundary revision ${committed.review_revision}.`,
    "Agent authority changed: no.",
    "Ask does not use these minimum group sizes until the updated boundary is activated.",
    "",
  ].join("\n"));
  return input.focusedAccess
    ? offerImmediateBoundaryActivation(input.session)
    : 0;
}

async function offerImmediateBoundaryActivation(
  session: BoundaryReviewInteractiveSession,
): Promise<"back" | "review"> {
  const activate = await session.confirm(
    "Review and activate this boundary change now?",
    { defaultValue: true },
  );
  if (activate) return "review";
  process.stdout.write([
    "1 pending boundary change is not active.",
    "Existing Ask access, if any, continues to use the previous exact boundary revision.",
    "To activate it later: run /access, select this boundary, and press C (Review + activate).",
    "",
  ].join("\n"));
  return "back";
}

function focusedEditNeedsExplicitReason(
  view: BoundaryResourceReviewView,
  changed: Array<{ field: string; tier: BoundaryFieldTier }>,
): boolean {
  return changed.some(({ field, tier }) => {
    const previous = currentBoundaryFieldTier(view, field);
    const candidate = view.candidate ?? view.generated_candidate;
    if (field === candidate?.tenant_key || field === candidate?.principal_key) {
      return previous !== tier;
    }
    const sensitivity = view.fields.find((item) => item.name === field)?.sensitivity?.state;
    if (sensitivity === "structurally_low_risk") return false;
    return (previous === "kept_out" && tier !== "kept_out")
      || (previous === "withheld_from_model" && tier === "visible");
  });
}

function focusedTierOutcome(tier: BoundaryFieldTier): string {
  if (tier === "withheld_from_model") return "Runner only (withheld from model)";
  if (tier === "kept_out") return "Kept out";
  return "Model + Runner";
}

function formatFocusedBoundaryEditSaved(
  resourceId: string,
  action: "added" | "updated" | "removed",
  revision: number,
  notes: string[] = [],
): string {
  return [
    "",
    `Draft ${action}: ${resourceId}`,
    ...notes,
    `Saved in disabled boundary revision ${revision}. Agent authority changed: no.`,
    "Next: review and activate the complete boundary, or go back to keep editing.",
    "",
  ].join("\n");
}

function changedFieldTiers(
  view: BoundaryResourceReviewView,
  selected: Record<string, BoundaryFieldTier>,
): Array<{ field: string; tier: BoundaryFieldTier }> {
  return Object.entries(selected)
    .filter(([field, tier]) => currentBoundaryFieldTier(view, field) !== tier)
    .map(([field, tier]) => ({ field, tier }))
    .sort((left, right) => left.field.localeCompare(right.field));
}

function currentBoundaryFieldTier(
  view: BoundaryResourceReviewView,
  field: string,
): BoundaryFieldTier {
  const candidate = view.candidate ?? view.generated_candidate;
  return reviewedBoundaryFieldTier(candidate, field);
}

function reviewedFieldOperationSummary(
  resource: BoundaryReviewMutationPreview["candidate"]["pack"]["resources"][number],
  field: string,
): string {
  const operations: string[] = [];
  if (resource.selectable_fields.includes(field)) operations.push("return");
  const filters = resource.filterable_fields[field];
  if (filters?.length) operations.push(`filter(${filters.join("/")})`);
  if (resource.sortable_fields.includes(field)) operations.push("sort");
  if (resource.groupable_fields.includes(field)) operations.push("group");
  if (resource.aggregate_measures.includes(field)) operations.push("aggregate measure");
  if (resource.presence_measure_fields?.includes(field)) operations.push("presence measures");
  if (resource.count_distinct_fields.includes(field)) operations.push("count distinct");
  const buckets = resource.time_bucket_fields[field];
  if (buckets?.length) operations.push(`time(${buckets.join("/")})`);
  return operations.length ? operations.join(", ") : "no reviewed operation";
}

function boundaryRequestCommandArgs(
  projectRoot: string,
  request: BoundaryResourceReviewRequest,
): string[] {
  const args = [
    request.resource_id,
    "--project-root", projectRoot,
  ];
  if (request.include) args.push("--include");
  if (request.exclude) args.push("--exclude");
  if (request.metadata?.label !== undefined) {
    args.push("--label", request.metadata.label ?? "-");
  }
  if (request.metadata?.description !== undefined) {
    args.push("--description", request.metadata.description ?? "-");
  }
  for (const metadata of request.field_metadata ?? []) {
    if (metadata.label !== undefined) {
      args.push("--field-label", `${metadata.field}=${metadata.label ?? "-"}`);
    }
    if (metadata.description !== undefined) {
      args.push("--field-description", `${metadata.field}=${metadata.description ?? "-"}`);
    }
  }
  if (request.keep_out_fields?.length) args.push("--keep-out", request.keep_out_fields.join(","));
  if (request.withhold_from_model_fields?.length) {
    args.push("--withhold-from-model", request.withhold_from_model_fields.join(","));
  }
  if (request.allow_reviewed_fields?.length) {
    args.push("--allow-reviewed-field", request.allow_reviewed_fields.join(","));
  }
  args.push("--actor", request.actor, "--reason", request.reason);
  return args;
}

function reviewedMetadataFromArgs(args: string[]): {
  resource?: NonNullable<BoundaryResourceReviewRequest["metadata"]>;
  fields: NonNullable<BoundaryResourceReviewRequest["field_metadata"]>;
} {
  const resource: NonNullable<BoundaryResourceReviewRequest["metadata"]> = {};
  if (args.includes("--label")) {
    resource.label = reviewedMetadataFlagValue(args, "--label");
  }
  if (args.includes("--description")) {
    resource.description = reviewedMetadataFlagValue(args, "--description");
  }
  const byField = new Map<string, NonNullable<BoundaryResourceReviewRequest["field_metadata"]>[number]>();
  for (const [flag, property] of [
    ["--field-label", "label"],
    ["--field-description", "description"],
  ] as const) {
    for (const assignment of repeatedArgs(args, flag)) {
      const separator = assignment.indexOf("=");
      const field = assignment.slice(0, separator).trim();
      const rawValue = separator >= 0 ? assignment.slice(separator + 1).trim() : "";
      if (separator < 1 || !field || !rawValue) {
        throw new Error(`${flag} must use <field>=<text>; use <field>=- to clear it.`);
      }
      const current = byField.get(field) ?? { field };
      if (current[property] !== undefined) {
        throw new Error(`${flag} repeats ${field}; provide each field metadata value once.`);
      }
      current[property] = rawValue === "-" ? null : rawValue;
      byField.set(field, current);
    }
  }
  return {
    ...(Object.keys(resource).length ? { resource } : {}),
    fields: [...byField.values()].sort((left, right) => left.field.localeCompare(right.field)),
  };
}

function reviewedMetadataFlagValue(args: string[], flag: string): string | null {
  const raw = optionalArg(args, flag);
  if (raw === undefined || raw.startsWith("--") || !raw.trim()) {
    throw new Error(`${flag} requires text; use - to clear the reviewed value.`);
  }
  return raw.trim() === "-" ? null : raw.trim();
}

function boundaryResourceApplyCommand(args: string[]): string {
  const retained: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json" || arg === "--apply") continue;
    if (arg === "--confirm") {
      index += 1;
      continue;
    }
    retained.push(arg);
  }
  return [
    cliCommandName(),
    "boundary",
    "review",
    "resource",
    ...retained,
    "--apply",
  ].map(shellCommandToken).join(" ");
}

function shellCommandToken(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : shellQuote(value);
}

function formatBoundaryMutationCommit(
  projectRoot: string,
  revision: number,
  candidateDigest: string,
  actor: string,
): string {
  return [
    `Saved disabled boundary review revision ${revision}.`,
    `Candidate digest: ${candidateDigest}`,
    "Authority activated: no",
    "Source database changed: no",
    `Next: ${cliCommandName()} boundary review --confirm --project-root ${shellCommandToken(projectRoot)} --actor ${shellCommandToken(actor)}`,
    "",
  ].join("\n");
}


async function verifyBoundaryReviewMutationOperator(input: {
  args: string[];
  projectRoot: string;
  preview: Pick<
    BoundaryReviewMutationPreview | BoundaryReviewMutationBatchPreview,
    "decision_digest" | "bindings" | "candidate_digest"
      | "generated_contract_digest" | "candidate"
  >;
  expectedActor: string;
  reason: string;
}): Promise<{
  store?: ProposalStore;
  key?: string;
  governed?: GovernedReadEditDecision;
  decisionId: `sha256:${string}`;
  subject: string;
  provider: "signed_key" | "jwt_oidc";
}> {
  const resolvedProject = await resolveSynapsorProject(input.projectRoot, process.env);
  const configPath = optionalArg(input.args, "--config") ?? resolvedProject?.config_path;
  if (!configPath) {
    throw new Error("Noninteractive boundary review requires a discoverable Runner config or --config <path>.");
  }
  const config = await readRuntimeConfig(configPath);
  if (config.operator_identity?.provider !== "signed_key"
    && config.operator_identity?.provider !== "jwt_oidc") {
    throw new Error("Noninteractive boundary review requires configured signed_key or jwt_oidc operator identity.");
  }
  const requiredRole = optionalArg(input.args, "--required-role")?.trim();
  if (!requiredRole) {
    throw new Error("Noninteractive boundary review requires --required-role <reviewed-operator-role>.");
  }
  const now = new Date();
  const expiresAt = boundaryDecisionExpiry(optionalArg(input.args, "--expires-at"), now);
  const nonce = optionalArg(input.args, "--nonce")?.trim() || crypto.randomBytes(24).toString("base64url");
  if (!/^[A-Za-z0-9._~-]{16,200}$/.test(nonce)) {
    throw new Error("Boundary review nonce must contain 16-200 URL-safe non-secret characters.");
  }
  const envelope = {
    schema_version: "synapsor.boundary-review-operator-decision.v1",
    review_decision_digest: input.preview.decision_digest,
    before: input.preview.bindings,
    after_candidate_digest: input.preview.candidate_digest,
    generated_contract_digest: input.preview.generated_contract_digest,
    required_role: requiredRole,
    environment: input.preview.candidate.deployment_profile,
    issued_at: now.toISOString(),
    expires_at: expiresAt,
    nonce,
  };
  const decisionId = canonicalJsonDigest(envelope);
  const identity = await resolveOperatorIdentity({
    config: config.operator_identity as OperatorIdentityConfig,
    configPath,
    proposal: {
      proposal_id: `boundary_review_${input.preview.decision_digest.slice("sha256:".length, "sha256:".length + 24)}`,
      proposal_version: 1,
      proposal_hash: decisionId,
    },
    action: "boundary_review",
    reason: input.reason,
    actor: input.expectedActor,
    identity: optionalArg(input.args, "--identity"),
    privateKeyPath: optionalArg(input.args, "--identity-key"),
    requiredRole,
    now: now.toISOString(),
  });
  if (!identity.verified || identity.provider === "dev_env") {
    throw new Error("Noninteractive boundary-review identity was not cryptographically verified.");
  }
  if (identity.subject !== input.expectedActor) {
    throw new Error("The verified operator subject does not match the reviewer identity bound into this decision.");
  }
  await assertFreshOperatorProof(
    identity,
    config.operator_identity as OperatorIdentityConfig,
    configPath,
  );
  const configuredStorePath = path.resolve(path.dirname(path.resolve(configPath)), config.storage?.sqlite_path ?? ".synapsor/local.db");
  const storePath = optionalArg(input.args, "--config") ? configuredStorePath : resolvedProject?.store_path ?? configuredStorePath;
  const policyStore = await openProjectControlPolicies({ projectRoot: input.projectRoot, config, storePath });
  if (policyStore) {
    try {
      const before = input.preview.bindings.authoring;
      if (!before) throw new Error("POLICY_READ_EDIT_DECISION_INVALID: reopen the governed review before editing.");
      const decision = { purpose: "edit_read" as const,
        repository_id: policyStore.repository_id, deployment_id: policyStore.deployment_id, project_id: policyStore.project_id,
        before, nonce_digest: canonicalJsonDigest({ nonce }), decision_id: decisionId,
        review_decision_digest: input.preview.decision_digest, candidate_digest: input.preview.candidate_digest,
        generated_contract_digest: input.preview.generated_contract_digest,
        subject: identity.subject, provider: identity.provider, decision_hash: identity.decision_hash, integrity_hash: identity.integrity_hash,
        issued_at: now.toISOString(), expires_at: expiresAt,
        operator_envelope: { ...envelope, schema_version: "synapsor.boundary-review-operator-decision.v1" as const,
          before: { ...envelope.before, authoring: before } },
        operator_proof: JSON.parse(JSON.stringify(identity)) as GovernedReadEditDecision["operator_proof"] };
      const governed = { ...decision, event_id: readEditEventId(decision) };
      assertGovernedReadEditDecision(governed, policyStore, input.expectedActor, { ...decision, before });
      if (await policyStore.repository.event(policyStore.deployment_id, governed.event_id)) throw readEditAlreadyConsumed();
      return { governed, decisionId, subject: identity.subject, provider: identity.provider };
    } finally { await policyStore.close(); }
  }
  if (input.preview.bindings.authoring) throw new Error("POLICY_AUTHORING_STORE_CHANGED: restore the governed review repository before editing.");
  await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const store = new ProposalStore(storePath);
  const key = `boundary_review_decision:${decisionId}`;
  if (store.getRunnerState(key)) {
    store.close();
    throw new Error("Boundary-review decision was already consumed; create a fresh short-lived decision with a new nonce.");
  }
  store.setRunnerState(key, {
    status: "consumed_before_review_mutation",
    decision_id: decisionId,
    review_decision_digest: input.preview.decision_digest,
    candidate_digest: input.preview.candidate_digest,
    subject: identity.subject,
    provider: identity.provider,
    decision_hash: identity.decision_hash,
    integrity_hash: identity.integrity_hash,
    issued_at: now.toISOString(),
    expires_at: expiresAt,
    nonce_digest: canonicalJsonDigest({ nonce }),
    source_database_changed: false,
  });
  return {
    store,
    key,
    decisionId,
    subject: identity.subject,
    provider: identity.provider,
  };
}


function boundaryMutationPublicPreview(preview: BoundaryReviewMutationPreview): Record<string, unknown> {
  return {
    ok: true,
    schema_version: preview.schema_version,
    bindings: preview.bindings,
    request: preview.request,
    decision_digest: preview.decision_digest,
    candidate_digest: preview.candidate_digest,
    generated_contract_digest: preview.generated_contract_digest,
    semantic_diff: preview.semantic_diff,
    ...(preview.resource_removal_impact
      ? { resource_removal_impact: preview.resource_removal_impact }
      : {}),
    source_database_changed: false,
    authority_activated: false,
  };
}

function boundaryBatchMutationPublicPreview(
  preview: BoundaryReviewMutationBatchPreview,
): Record<string, unknown> {
  return {
    ok: true,
    schema_version: preview.schema_version,
    bindings: preview.bindings,
    requests: preview.requests,
    decision_digest: preview.decision_digest,
    candidate_digest: preview.candidate_digest,
    generated_contract_digest: preview.generated_contract_digest,
    semantic_diff: preview.semantic_diff,
    source_database_changed: false,
    authority_activated: false,
  };
}


function formatBoundaryMutationPreview(
  preview: BoundaryReviewMutationPreview,
  view: BoundaryResourceReviewView,
  applyCommand?: string,
): string {
  const diff = preview.semantic_diff;
  const requested = formatRequestedBoundaryChanges(preview.request, view);
  const effective = [
    ...(diff.before_included !== diff.after_included
      ? [`  Table access: ${diff.before_included ? "included" : "not included"} -> ${diff.after_included ? "included" : "excluded"}`]
      : []),
    ...(diff.added_model_withheld_fields.length
      ? [`  Model-withheld fields added: ${diff.added_model_withheld_fields.join(", ")}`]
      : []),
    ...(diff.removed_model_withheld_fields.length
      ? [`  Model-withheld fields removed: ${diff.removed_model_withheld_fields.join(", ")}`]
      : []),
    ...(diff.added_kept_out_fields.length
      ? [`  Kept-out fields added: ${diff.added_kept_out_fields.join(", ")}`]
      : []),
    ...(diff.removed_kept_out_fields.length
      ? [`  Kept-out fields removed: ${diff.removed_kept_out_fields.join(", ")}`]
      : []),
    ...(diff.added_visible_fields.length
      ? [`  Visible fields added: ${diff.added_visible_fields.join(", ")}`]
      : []),
    ...(diff.removed_visible_fields.length
      ? [`  Visible fields removed: ${diff.removed_visible_fields.join(", ")}`]
      : []),
    ...diff.analytical_operation_changes.map((change) =>
      `  ${change.field} analytical operations: ${change.before.join(", ") || "none"} -> ` +
      `${change.after.join(", ") || "none"}`),
    ...(diff.added_relationships.length
      ? [`  Relationships added: ${diff.added_relationships.join(", ")}`]
      : []),
    ...(diff.removed_relationships.length
      ? [`  Relationships removed: ${diff.removed_relationships.join(", ")}`]
      : []),
    ...(diff.independent_access_change ? [`  Access: ${diff.independent_access_change.after ? "independent queries" : "only through permitted related records; independent queries removed"}.`] : []),
    ...(preview.request.principal_scope_path !== undefined && diff.selected_principal_scope_path
      ? [`  Trusted user/owner scope: mandatory reviewed path ${diff.selected_principal_scope_path}`]
      : []),
    ...(preview.request.principal_rls_setting !== undefined
      ? [`  Trusted user/owner scope: ${diff.selected_principal_rls_setting
        ? `reviewed PostgreSQL RLS setting ${diff.selected_principal_rls_setting}`
        : "not configured"}`]
      : []),
    ...(diff.minimum_cohort_before !== diff.minimum_cohort_after
      ? [
        `  Minimum group size: ${diff.minimum_cohort_before ?? "not included"} -> ` +
        `${diff.minimum_cohort_after ?? "not included"}` +
        `${diff.minimum_cohort_overridden ? " (explicit owner override)" : ""}`,
      ]
      : []),
    ...(diff.max_ranked_groups_before !== diff.max_ranked_groups_after
      ? [
        `  Ranked underlying groups: ${diff.max_ranked_groups_before ?? "not included"} -> ` +
        `${diff.max_ranked_groups_after ?? "not included"}`,
      ]
      : []),
    ...(diff.max_queries_per_session_before !== diff.max_queries_per_session_after
      ? [
        `  Rolling 24-hour query allowance: ${diff.max_queries_per_session_before} -> ` +
        `${diff.max_queries_per_session_after}`,
      ]
      : []),
    ...(diff.rate_limit_per_minute_before !== diff.rate_limit_per_minute_after
      ? [
        `  Requests per minute: ${diff.rate_limit_per_minute_before} -> ` +
        `${diff.rate_limit_per_minute_after}`,
      ]
      : []),
    ...diff.reviewed_budget_changes
      .filter((change) => ![
        "max_ranked_groups",
        "max_queries_per_session",
        "rate_limit_per_minute",
      ].includes(change.name))
      .map((change) =>
        `  ${change.name}: ${change.before} -> ${change.after}`),
  ];
  return [
    "Preview of one pending review decision. Nothing is saved or active yet.",
    "",
    `Table: ${diff.resource_id}`,
    requested.length === 1 ? "Requested change:" : "Requested changes:",
    ...requested.map((line) => `  ${line}`),
    "",
    "Validated effect:",
    ...(effective.length ? effective : ["  Reviewed metadata changes only; runtime authority is unchanged."]),
    "  Everything else: unchanged.",
    ...(diff.minimum_cohort_after === 1
      ? ["  Warning: 1 disables small-group suppression; groups of one identify individuals."]
      : []),
    "",
    "The saved decision will be digest-bound; use --json to inspect the exact digests.",
    "Authority activated: no. Source database changed: no.",
    "",
    ...(applyCommand
      ? [`Next: ${applyCommand}`]
      : ["Press Enter at the next prompt to save this disabled decision; type n to discard it."]),
    "",
  ].join("\n");
}

function formatRequestedBoundaryChanges(
  request: BoundaryResourceReviewRequest,
  view: BoundaryResourceReviewView,
): string[] {
  const lines: string[] = [];
  if (request.metadata) {
    if (request.metadata.label !== undefined) {
      lines.push(`Reviewed table label: ${request.metadata.label === null ? "clear" : JSON.stringify(request.metadata.label)}`);
    }
    if (request.metadata.description !== undefined) {
      lines.push(`Reviewed table description: ${request.metadata.description === null ? "clear" : JSON.stringify(request.metadata.description)}`);
    }
  }
  for (const metadata of request.field_metadata ?? []) {
    if (metadata.label !== undefined) {
      lines.push(`Reviewed label for ${metadata.field}: ${metadata.label === null ? "clear" : JSON.stringify(metadata.label)}`);
    }
    if (metadata.description !== undefined) {
      lines.push(`Reviewed description for ${metadata.field}: ${metadata.description === null ? "clear" : JSON.stringify(metadata.description)}`);
    }
  }
  for (const field of request.withhold_from_model_fields ?? []) {
    lines.push(`Withhold from model: ${describeReviewedField(view, field)}`);
  }
  for (const field of request.keep_out_fields ?? []) {
    lines.push(`Keep out: ${describeReviewedField(view, field)}`);
  }
  for (const field of request.allow_reviewed_fields ?? []) {
    lines.push(`Allow reviewed model-visible use: ${describeReviewedField(view, field)}`);
  }
  for (const field of request.allow_exact_numeric_grouping_fields ?? []) {
    lines.push(`Enable exact grouping: ${describeReviewedField(view, field)}`);
  }
  for (const field of request.remove_exact_numeric_grouping_fields ?? []) {
    lines.push(`Remove exact grouping: ${describeReviewedField(view, field)}`);
  }
  if (request.include) lines.push(`Include ${request.resource_id} in the disabled candidate.`);
  if (request.exclude) lines.push(`Exclude ${request.resource_id} from the disabled candidate.`);
  if (request.row_identity) lines.push(`Record ID: ${describeReviewedField(view, request.row_identity)}`);
  if (request.tenant_key) lines.push(`Trusted customer scope: ${describeReviewedField(view, request.tenant_key)}`);
  if (request.tenant_scope_path) {
    const scope = view.derived_tenant_scope?.candidates.find((candidate) =>
      candidate.path_id === request.tenant_scope_path);
    lines.push(`Trusted customer scope: mandatory reviewed path ${scope
      ? formatDerivedScopePath(scope)
      : request.tenant_scope_path}`);
  }
  if (request.shared_reference_scope) {
    lines.push(
      "Row scope: Shared reference; no tenant predicate will be applied to this table, while field, cohort, and budget controls remain enforced.",
    );
  }
  if (request.principal_key !== undefined) {
    lines.push(request.principal_key === null
      ? "Trusted user/owner scope: not configured."
      : `Trusted user/owner scope: ${describeReviewedField(view, request.principal_key)}`);
  }
  if (request.principal_scope_path !== undefined && request.principal_key === undefined) {
    const scope = view.derived_principal_scope?.candidates.find((candidate) =>
      candidate.path_id === request.principal_scope_path);
    lines.push(request.principal_scope_path === null
      ? "Trusted user/owner scope: not configured."
      : `Trusted user/owner scope: mandatory reviewed path ${scope
        ? formatDerivedScopePath(scope)
        : request.principal_scope_path}`);
  }
  if (request.principal_rls_setting !== undefined
    && request.principal_key === undefined
    && request.principal_scope_path === undefined) {
    lines.push(request.principal_rls_setting === null
      ? "Trusted user/owner scope: not configured."
      : `Trusted user/owner scope: reviewed PostgreSQL RLS setting ${request.principal_rls_setting}.`);
  }
  for (const [label, fields] of [
    ["Visible fields", request.selectable_fields],
    ["Filterable fields", request.filterable_fields],
    ["Sortable fields", request.sortable_fields],
    ["Groupable fields", request.groupable_fields],
    ["Aggregate measures", request.aggregate_measures],
    ["Count-distinct fields", request.count_distinct_fields],
    ["Time-bucket fields", request.time_bucket_fields],
  ] as const) {
    if (fields) lines.push(`${label}: ${fields.join(", ") || "none"}.`);
  }
  if (request.minimum_cohort_size !== undefined) {
    lines.push(`Minimum returned cohort: ${request.minimum_cohort_size}.`);
  }
  if (request.max_ranked_groups !== undefined) {
    lines.push(
      `Maximum underlying groups for bounded top/bottom and period-mover queries: ` +
      `${request.max_ranked_groups}.`,
    );
  }
  if (request.max_queries_per_session !== undefined) {
    lines.push(`Rolling 24-hour query allowance: ${request.max_queries_per_session}.`);
  }
  if (request.rate_limit_per_minute !== undefined) {
    lines.push(`Requests per minute: ${request.rate_limit_per_minute}.`);
  }
  for (const [, key] of REVIEWED_SHAPE_LIMIT_FLAGS) {
    const value = request[key];
    if (value !== undefined) lines.push(`${key}: ${value}.`);
  }
  if (request.relationship_ids) {
    lines.push(`Reviewed relationships: ${request.relationship_ids.join(", ") || "none"}.`);
  }
  if (request.nullable_relationship) {
    lines.push(
      `Nullable relationship ${request.nullable_relationship.relationship_id}: ` +
      `${request.nullable_relationship.unmatched_rows === "keep_null" ? "retain unmatched rows" : "exclude unmatched rows"}.`,
    );
  }
  return lines.length ? lines : ["No effective review change was requested."];
}

function describeReviewedField(view: BoundaryResourceReviewView, fieldName: string): string {
  const field = view.fields.find((candidate) => candidate.name === fieldName);
  if (!field) return `${fieldName} column of ${view.resource_id}`;
  const enumEvidence = field.evidence.find((item) => item.startsWith("database enum values:"));
  const knownValues = enumEvidence?.slice("database enum values:".length).trim();
  return `${field.name} - ${field.data_type} column of ${view.resource_id}` +
    `${knownValues ? ` (database-declared values: ${knownValues})` : ""}`;
}

function formatBoundaryBatchMutationPreview(
  preview: BoundaryReviewMutationBatchPreview,
  expectedConfirmation: string,
): string {
  return [
    "Disabled boundary-review batch preview",
    `  resource decisions: ${preview.requests.length}`,
    `  changed authority: ${preview.semantic_diff.filter((item) => item.authority_changed).length}`,
    ...preview.semantic_diff.map((item) =>
      `  - ${item.resource_id}: ${item.before_included ? "included" : "blocked"} -> ${item.after_included ? "included" : "excluded"}`),
    `  candidate digest: ${preview.candidate_digest}`,
    `  decision digest: ${preview.decision_digest}`,
    "  authority activated: no",
    "  source database changed: no",
    `Next: rerun with --apply and confirm ${shellQuote(expectedConfirmation)} in a real operator terminal.`,
    "",
  ].join("\n");
}


export async function boundaryActivateCommand(
  args: string[],
  schemaInspector: typeof inspectDatabase = inspectDatabase,
  interactiveSession?: BoundaryReviewInteractiveSession,
  activationHandoff?: BoundaryActivationHandoff,
  options: BoundaryActivateCommandOptions = {},
): Promise<number> {
  if (args.includes("--yes")) {
    throw new Error("boundary activate does not accept --yes; activation requires exact digest confirmation and a human or cryptographically verified operator decision.");
  }
  assertKnownOptions(
    args,
    new Set([
      "--project-root",
      "--config",
      "--review-bundle",
      "--headless",
      "--confirm",
      "--actor",
      "--identity",
      "--identity-key",
      "--required-role",
      "--reason",
      "--environment",
      "--expires-at",
      "--nonce",
      "--json",
    ]),
    "boundary activate",
  );
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const context = await loadBoundaryReviewContext(projectRoot);
  const activeBeforeActivation = await loadActivatedExplorationBoundaries(projectRoot).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
  let expectedAuthoring = context.bundle.mutation_bindings.authoring;
  if (context.progress?.policy_migration.status === "review_required") {
    throw new Error([
      `Boundary ${context.candidate.pack.name} has legacy project-wide review settings that are not yet isolated to its immutable boundary identity.`,
      "Runner preserved the exact saved boundary revision but will not activate it as newly reviewed policy.",
      "Open /access and save a reviewed setting for this boundary, or Rescan, then review and activate the resulting disabled revision.",
    ].join("\n"));
  }
  const reviewAuthority = await resolveSavedBoundaryReviewAuthority({
    projectRoot,
    draft: context.draft,
    candidate: context.candidate,
    ...(context.progress ? { progress: context.progress } : {}),
  });
  const activationInspection = await schemaInspector({
    engine: reviewAuthority.generationLock.engine,
    databaseUrlEnv: reviewAuthority.generationLock.source_env,
    schema: reviewAuthority.generationLock.inspected_schema,
    env: process.env,
  });
  assertDatabaseRoleSafeForModelReads({
    inspection: activationInspection,
    sourceEnv: reviewAuthority.generationLock.source_env,
    nextAction: `Rerun ${cliCommandName()} boundary activate after updating the credential.`,
    statePreserved: "The reviewed boundary was not activated, existing active boundaries remain unchanged, and the source database was not changed.",
  });
  const headless = args.includes("--headless");
  const expectedConfirmation = `ACTIVATE ${context.bundle.candidate_digest}`;
  let confirmation = optionalArg(args, "--confirm")?.trim();
  let actor = optionalArg(args, "--actor")?.trim();
  let operator: {
    subject: string;
    provider: "interactive_terminal" | "signed_key" | "jwt_oidc";
    verified: boolean;
    decision_hash?: string;
    integrity_hash?: string;
    key_id?: string;
    roles?: string[];
    decision_id?: `sha256:${string}`;
  };
  let consumedDecision: {
    store: ProposalStore;
    key: string;
    decisionId: `sha256:${string}`;
    expiresAt: string;
  } | undefined;
  let governedDecision: GovernedReadActivationDecision | undefined;

  if (headless) {
    if (process.stdin.isTTY && !confirmation) {
      throw new Error(`Headless activation still requires --confirm ${shellQuote(expectedConfirmation)}.`);
    }
    if (confirmation !== expectedConfirmation) {
      throw new Error(`Headless activation requires the exact confirmation ${expectedConfirmation}.`);
    }
    const bundlePath = optionalArg(args, "--review-bundle");
    if (!bundlePath) throw new Error("Headless activation requires --review-bundle <exported-review.json>.");
    const suppliedBundle = await readJsonFileWithLocation<BoundaryReviewBundle>(bundlePath, "boundary review bundle");
    assertCurrentBoundaryReviewBundle(suppliedBundle, context.bundle);

    const resolvedProject = await resolveSynapsorProject(projectRoot, process.env);
    const configPath = optionalArg(args, "--config") ?? resolvedProject?.config_path;
    if (!configPath) {
      throw new Error("Headless activation requires a discoverable Runner config or --config <path> with signed_key or jwt_oidc operator identity.");
    }
    const config = await readRuntimeConfig(configPath);
    if (config.operator_identity?.provider !== "signed_key" && config.operator_identity?.provider !== "jwt_oidc") {
      throw new Error("Headless activation requires a configured signed_key or jwt_oidc operator identity.");
    }
    const requiredRole = optionalArg(args, "--required-role")?.trim();
    if (!requiredRole) throw new Error("Headless activation requires --required-role <reviewed-operator-role>.");
    const reason = optionalArg(args, "--reason")?.trim();
    if (!reason) throw new Error("Headless activation requires --reason <human review reason>.");
    const environment = optionalArg(args, "--environment")?.trim() ?? context.candidate.deployment_profile;
    if (environment !== context.candidate.deployment_profile) {
      throw new Error(`Activation environment ${environment} does not match reviewed deployment profile ${context.candidate.deployment_profile}.`);
    }
    const now = new Date();
    const expiresAt = boundaryDecisionExpiry(optionalArg(args, "--expires-at"), now);
    const nonce = optionalArg(args, "--nonce")?.trim() || crypto.randomBytes(24).toString("base64url");
    if (!/^[A-Za-z0-9._~-]{16,200}$/.test(nonce)) {
      throw new Error("Boundary activation nonce must contain 16-200 URL-safe non-secret characters.");
    }
    const decisionEnvelope = {
      schema_version: "synapsor.boundary-activation-decision.v1",
      review_bundle_digest: context.bundle.bundle_digest,
      ...(expectedAuthoring ? { authoring_binding: expectedAuthoring } : {}),
      boundary_digest: context.bundle.candidate_digest,
      confirmed_decision_ids: context.bundle.decisions.map((decision) => decision.id).sort(),
      schema_fingerprint: context.bundle.authority.schema_fingerprint,
      generation_lock_fingerprint: context.bundle.authority.generation_lock_fingerprint,
      role_posture_fingerprint: context.bundle.authority.role_posture_fingerprint,
      compiler_version: context.bundle.authority.compiler_version,
      spec_version: context.bundle.authority.spec_version,
      deployment_profile: context.bundle.authority.deployment_profile,
      environment,
      budgets: context.bundle.authority.budgets,
      required_role: requiredRole,
      issued_at: now.toISOString(),
      expires_at: expiresAt,
      nonce,
    };
    const decisionId = canonicalJsonDigest(decisionEnvelope);
    const identity = await resolveOperatorIdentity({
      config: config.operator_identity as OperatorIdentityConfig,
      configPath,
      proposal: {
        proposal_id: `boundary_${context.bundle.candidate_digest.slice("sha256:".length, "sha256:".length + 24)}`,
        proposal_version: 1,
        proposal_hash: decisionId,
      },
      action: "boundary_activate",
      reason,
      actor,
      identity: optionalArg(args, "--identity"),
      privateKeyPath: optionalArg(args, "--identity-key"),
      requiredRole,
      now: now.toISOString(),
    });
    if (!identity.verified || identity.provider === "dev_env") {
      throw new Error("Headless boundary activation identity was not cryptographically verified.");
    }
    await assertFreshOperatorProof(identity, config.operator_identity as OperatorIdentityConfig, configPath);
    actor = identity.subject;
    operator = {
      subject: identity.subject,
      provider: identity.provider,
      verified: true,
      decision_hash: identity.decision_hash,
      integrity_hash: identity.integrity_hash,
      key_id: identity.key_id,
      roles: identity.roles,
      decision_id: decisionId,
    };

    const configuredStorePath = path.resolve(path.dirname(path.resolve(configPath)), config.storage?.sqlite_path ?? ".synapsor/local.db");
    const storePath = optionalArg(args, "--config") ? configuredStorePath : resolvedProject?.store_path ?? configuredStorePath;
    const policyStore = await openProjectControlPolicies({ projectRoot, config, storePath });
    if (policyStore) {
      try {
        const decision = { purpose: "activate_read" as const,
          repository_id: policyStore.repository_id, deployment_id: policyStore.deployment_id, project_id: policyStore.project_id,
          nonce_digest: canonicalJsonDigest({ nonce }), decision_id: decisionId,
          boundary_digest: context.bundle.candidate_digest, review_bundle_digest: context.bundle.bundle_digest,
          subject: identity.subject, provider: identity.provider,
          decision_hash: identity.decision_hash, integrity_hash: identity.integrity_hash,
          issued_at: now.toISOString(), expires_at: expiresAt };
        governedDecision = { ...decision, event_id: readActivationEventId(decision) };
        assertGovernedReadActivationDecision(governedDecision, policyStore, actor, context.bundle.candidate_digest);
        if (await policyStore.repository.event(policyStore.deployment_id, governedDecision.event_id)) throw readActivationAlreadyConsumed();
      } finally { await policyStore.close(); }
    } else {
      if (expectedAuthoring) throw new Error("POLICY_REPOSITORY_MISSING: restore the reviewed repository before activation.");
      await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
      const store = new ProposalStore(storePath);
      const key = `boundary_activation_decision:${decisionId}`;
      if (store.getRunnerState(key)) {
        store.close();
        throw readActivationAlreadyConsumed();
      }
      store.setRunnerState(key, {
        status: "consumed_before_activation", decision_id: decisionId,
        boundary_digest: context.bundle.candidate_digest, subject: identity.subject,
        provider: identity.provider, decision_hash: identity.decision_hash, integrity_hash: identity.integrity_hash,
        issued_at: now.toISOString(), expires_at: expiresAt, nonce_digest: canonicalJsonDigest({ nonce }), source_database_changed: false,
      });
      consumedDecision = { store, key, decisionId, expiresAt };
    }

    const progress = createBoundaryReviewProgress({
      draft: context.draft,
      candidate: context.candidate,
      confirmedDecisions: context.candidate.unresolved_decisions,
      previous: context.progress,
      actor: identity.subject,
      revision: (context.progress?.revision ?? 0) + 1,
      now: now.toISOString(),
    });
    try {
      expectedAuthoring = await saveBoundaryReviewSignoff(projectRoot, context, progress);
    } catch (error) {
      consumedDecision?.store.setRunnerState(consumedDecision.key, {
        status: "consumed_review_persistence_failed",
        decision_id: decisionId,
        boundary_digest: context.bundle.candidate_digest,
        subject: identity.subject,
        provider: identity.provider,
        failed_at: new Date().toISOString(),
        source_database_changed: false,
      });
      consumedDecision?.store.close();
      consumedDecision = undefined;
      throw error;
    }
  } else {
    if (!interactiveSession && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      throw new Error("Noninteractive boundary activation requires --headless and a verified signed_key or jwt_oidc operator identity.");
    }
    if (context.bundle.outstanding_decision_ids.length > 0) {
      throw new Error(
        `Boundary activation is blocked by ${context.bundle.outstanding_decision_ids.length} unresolved decision(s). Run boundary review --confirm first.`,
      );
    }
    const session = interactiveSession ?? createBoundaryReviewInteractiveSession();
    const activationContext = [
      (await formatBoundaryReviewSummary(context.bundle, projectRoot, { nextAction: false, active: activeBeforeActivation })).trimEnd(),
      `Exact reviewed fingerprint: ${context.bundle.candidate_digest}`,
      context.candidate.deployment_profile === "production"
        ? "Activation makes this boundary eligible only for an explicitly configured secured production HTTP Explore runtime."
        : "Activation adds this reviewed boundary to local read-only Explore. Each query remains inside exactly one active boundary.",
    ];
    if (session.presentationMode !== "conversation") {
      process.stdout.write([...activationContext, ""].join("\n"));
    }
    if (!confirmation) {
      const approved = await session.confirm(
        `Activate "${context.candidate.pack.name}" now?`,
        { defaultValue: true, context: activationContext },
      );
      if (!approved) {
        const prior = activeBeforeActivation.some(boundary => boundary.pack.name === context.candidate.pack.name);
        const lines = [
          "No agent authority or source data changed.",
          ...(prior ? ["Existing active Read authority is unchanged; the proposed activation was not applied."]
            : [`Resume: ${cliCommandName()} boundary activate`]),
        ];
        const title = prior ? "READ AUTHORITY UNCHANGED" : "BOUNDARY REMAINS REVIEWED AND INACTIVE";
        if (session.present) session.present(title, lines, "warning");
        else process.stdout.write([prior ? "Read authority unchanged." : "Boundary remains reviewed and inactive.", ...lines, ""].join("\n"));
        return 0;
      }
      confirmation = expectedConfirmation;
    }
    if (!actor) {
      actor = await session.promptText("Human operator identity (audit label, not a password): ");
    }
    if (confirmation !== expectedConfirmation) throw new Error(`Activation requires the exact confirmation ${expectedConfirmation}.`);
    if (!actor) {
      const lines = [
        "The reviewed boundary remains inactive.",
        "No agent authority or source data changed.",
      ];
      if (session.present) session.present("RETURNED TO BOUNDARY REVIEW", lines, "warning");
      else process.stdout.write(["Returned to boundary review. The reviewed boundary remains inactive.", ...lines.slice(1), ""].join("\n"));
      return 0;
    }
    operator = { subject: actor, provider: "interactive_terminal", verified: false };
  }

  let activatedBoundary: Awaited<ReturnType<typeof activateExplorationBoundary>> | undefined;
  let productionReadiness: ProductionActivationReadiness | undefined;
  try {
    const active = await activateExplorationBoundary({
      projectRoot,
      candidate: context.candidate,
      reviewDraft: reviewAuthority.reviewDraft,
      generationLock: reviewAuthority.generationLock,
      expectedDigest: context.bundle.candidate_digest,
      expectedAuthoring,
      actor: actor!,
      confirmation: expectedConfirmation,
      verifiedDecision: governedDecision,
      confirmedDecisions: context.candidate.unresolved_decisions,
      currentInspection: activationInspection,
      activeSetMode: "add",
    });
    await reconcileGuidedProjectTrustedContext({ projectRoot });
    if (active.deployment_profile === "production") {
      productionReadiness = await (
        options.inspectProductionReadiness ?? inspectProductionActivationReadiness
      )({ args, projectRoot }).catch(() => ({
        ready: false,
        config_valid: false,
        shared_ledger_initialized: false,
      }));
    }
    await updateGuidedOnboardingState({
      projectRoot,
      status: "boundary_active",
      completedStep: "boundary_active",
      authorityActive: true,
      recommendedNextAction: active.deployment_profile === "production"
        ? productionReadiness?.ready
          ? activeBeforeActivation.length > 0
            ? "A running production HTTP server will load the updated active boundary set on its next tool call; no restart or setup rerun is required."
            : "Production HTTP configuration and shared accounting are ready; run doctor --preflight before starting the server if it is not already running."
          : "Configure the secured production HTTP runtime, initialize shared accounting, and run doctor before serving."
        : "Choose a model or MCP client and ask your first reviewed question.",
      now: active.activation.activated_at,
    }).catch(() => undefined);
    if (consumedDecision) {
      consumedDecision.store.setRunnerState(consumedDecision.key, {
        status: "activated",
        decision_id: consumedDecision.decisionId,
        boundary_digest: active.activation.digest,
        subject: operator.subject,
        provider: operator.provider,
        decision_hash: operator.decision_hash ?? "interactive",
        integrity_hash: operator.integrity_hash ?? "interactive",
        activated_at: active.activation.activated_at,
        expires_at: consumedDecision.expiresAt,
        source_database_changed: false,
      });
      consumedDecision.store.recordAttentionEvent({
        event_type: "capability.activated",
        severity: "informational",
        environment: active.deployment_profile,
        capability: "app.explore_data",
        contract_digest: active.activation.digest,
        attention_required: false,
        immediate_default: false,
        summary: active.deployment_profile === "production"
          ? "Verified operator activated reviewed production HTTP Explore authority"
          : "Verified operator activated reviewed local authoring authority",
        workbench_path: "/",
        details: {
          authority_type: "scoped_explore",
          operator_provider: operator.provider,
          operator_subject_digest: canonicalJsonDigest({ subject: operator.subject }),
          decision_id: consumedDecision.decisionId,
          source_database_changed: false,
        },
        source_event_key: `boundary-cli-activated:${consumedDecision.decisionId}`,
        now: active.activation.activated_at,
      });
    }
    const payload = {
      ok: true,
      active,
      operator,
      source_database_changed: false,
      model_facing_activation_tool: false,
    };
    const theme = terminalTheme(
      process.stdout.isTTY === true && !("NO_COLOR" in process.env),
    );
    const activationMessage = active.deployment_profile === "production"
      ? `Reviewed boundary "${active.pack.name}" is active for secured production HTTP Explore.`
      : `Reviewed boundary "${active.pack.name}" is active for local read-only Explore.`;
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else if (interactiveSession?.present) {
      interactiveSession.present("READ BOUNDARY ACTIVATED", [
        activationMessage,
        `Exact fingerprint: ${active.activation.digest}`,
        "Source database changed: no",
      ], "success");
    } else {
      process.stdout.write([
        theme.success("\uD83D\uDC90 ACTIVATION SUCCEEDED"),
        theme.success(activationMessage),
        `Exact fingerprint: ${active.activation.digest}`,
        "Source database changed: no",
        "",
      ].join("\n"));
    }
    activatedBoundary = active;
  } catch (error) {
    if (consumedDecision) {
      consumedDecision.store.setRunnerState(consumedDecision.key, {
        status: "consumed_activation_failed",
        decision_id: consumedDecision.decisionId,
        boundary_digest: context.bundle.candidate_digest,
        subject: operator.subject,
        provider: operator.provider,
        failed_at: new Date().toISOString(),
        safe_error: redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
        source_database_changed: false,
      });
    }
    throw error;
  } finally {
    consumedDecision?.store.close();
  }
  if (!headless
    && !args.includes("--json")
    && activationHandoff
    && activatedBoundary
    && activatedBoundary.deployment_profile !== "production") {
    return activationHandoff({
      projectRoot,
      boundaryName: activatedBoundary.pack.name,
      boundaryDigest: activatedBoundary.activation.digest,
    });
  }
  if (!headless && !args.includes("--json") && activatedBoundary) {
    const displayedProjectRoot = displayPath(projectRoot);
    const guidedStart = `${cliCommandName()} start --from-env ${context.lock.source_env} --cli`;
    const guidedStartFromProject = displayedProjectRoot === "."
      ? guidedStart
      : `cd ${shellQuote(displayedProjectRoot)} && ${guidedStart}`;
    process.stdout.write(activatedBoundary.deployment_profile === "production"
      ? formatProductionActivationNextSteps({
        boundaryName: activatedBoundary.pack.name,
        activeBeforeActivation: activeBeforeActivation.map((boundary) => boundary.pack.name),
        readiness: productionReadiness,
        color: process.stdout.isTTY === true && !("NO_COLOR" in process.env),
      })
      : [
        "NEXT",
        "Resume the guided CLI and choose a model or MCP client:",
        `  ${guidedStartFromProject}`,
        "Or open Ask directly with an explicit provider:",
        `  ${cliCommandName()} try ask --project-root ${shellQuote(displayPath(projectRoot))} --provider openai --model ${DEFAULT_TERMINAL_OPENAI_ASK_MODEL}`,
        "",
      ].join("\n"));
  }
  return 0;
}

async function inspectProductionActivationReadiness(input: {
  args: string[];
  projectRoot: string;
}): Promise<ProductionActivationReadiness> {
  const explicitConfigPath = optionalArg(input.args, "--config");
  const resolvedProject = explicitConfigPath
    ? undefined
    : await resolveSynapsorProject(input.projectRoot, process.env);
  const configPath = explicitConfigPath
    ?? resolvedProject?.config_path
    ?? path.join(input.projectRoot, "synapsor.runner.json");
  if (!await fileExists(configPath)) {
    return {
      ready: false,
      config_valid: false,
      shared_ledger_initialized: false,
    };
  }
  const config = await readRuntimeConfig(configPath);
  const configValid = config.production_explore?.enabled === true
    && config.storage?.shared_postgres?.mode === "runtime_store";
  if (!configValid) {
    return {
      ready: false,
      config_valid: false,
      shared_ledger_initialized: false,
      config_path: configPath,
    };
  }
  const ledgerChecks = await sharedPostgresLedgerDoctorChecks(config);
  const ledgerInitialized = ledgerChecks.some((check) =>
    check.name === "shared-postgres-ledger:migration" && check.ok);
  return {
    ready: ledgerInitialized,
    config_valid: true,
    shared_ledger_initialized: ledgerInitialized,
    config_path: configPath,
  };
}

function formatProductionActivationNextSteps(input: {
  boundaryName: string;
  activeBeforeActivation: string[];
  readiness: ProductionActivationReadiness | undefined;
  color: boolean;
}): string {
  const theme = terminalTheme(input.color);
  if (input.readiness?.ready) {
    const priorAuthority = input.activeBeforeActivation.length > 0;
    return [
      theme.success("NEXT - PRODUCTION ACCESS UPDATED"),
      theme.success(`Boundary "${input.boundaryName}" is in the active production Explore set.`),
      "A running production HTTP server reloads the active set on its next tool call; no restart is required.",
      priorAuthority
        ? "Production configuration and shared accounting are already ready; do not rerun config initialization or the ledger migration for this activation."
        : "Production HTTP configuration and the shared accounting ledger are ready. If the server is not running, run doctor --preflight before starting it.",
      "Guide: docs/production-scoped-explore-http.md",
      "",
    ].join("\n");
  }
  return [
    theme.warning("NEXT - PRODUCTION RUNTIME SETUP"),
    "Activation succeeded, but production runtime readiness was not fully verified.",
    "Next: configure the secured production HTTP runtime, initialize its shared accounting ledger, and run doctor.",
    "Guide: docs/production-scoped-explore-http.md",
    "",
  ].join("\n");
}


async function saveBoundaryReviewSignoff(projectRoot: string,
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>, progress: BoundaryReviewProgress,
): Promise<ReadAuthoringBindings | undefined> {
  const shown = structuredClone({ bindings: context.bundle.mutation_bindings, previous: context.progress ?? null, progress });
  return withProjectAuthorityMutation(projectRoot, async (held) => {
    const current = await loadBoundaryReviewContext(held.projectRoot);
    if (canonicalJsonDigest(shown.bindings) !== canonicalJsonDigest(current.bundle.mutation_bindings)
      || canonicalJsonDigest(shown.previous) !== canonicalJsonDigest(current.progress ?? null)) {
      throw Object.assign(new Error("This Boundary changed while you were reviewing it. Reopen the current revision before signing off; your earlier review was not saved."),
        { code: "POLICY_AUTHORING_REVIEW_CHANGED" });
    }
    return saveBoundaryReviewProgress(held.projectRoot, shown.progress, shown.bindings.authoring, held);
  });
}

export async function loadBoundaryReviewContext(projectRoot: string): Promise<{
  boundaryRoot: string;
  draft: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  lock: GenerationLock;
  progress: Awaited<ReturnType<typeof readBoundaryReviewProgress>>;
  bundle: BoundaryReviewBundle;
}> {
  const journey = await readGuidedOnboardingState(projectRoot);
  const boundaryRoot = path.resolve(projectRoot, journey?.artifacts.boundary_root ?? "synapsor/generated");
  const relative = path.relative(projectRoot, boundaryRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Managed boundary root escapes the selected project.");
  }
  const stored = await readProjectReadAuthoring(projectRoot);
  if (stored && !stored.selected) {
    throw new Error("No saved Read boundary is selected. Create a disabled boundary before opening its review.");
  }
  const draft = stored?.selected?.draft ?? await readJsonFileWithLocation<ExplorationBoundaryDraft>(
    path.join(boundaryRoot, "exploration-boundary.draft.json"),
    "exploration boundary draft",
  );
  const lock = stored?.selected?.draft_lock ?? await readJsonFileWithLocation<GenerationLock>(
    path.join(projectRoot, ".synapsor/generation-lock.json"),
    "generation lock",
  );
  const progress = stored?.selected?.progress ?? await readBoundaryReviewProgress(projectRoot, draft);
  const candidate = progress?.candidate ?? recommendedBoundaryReviewCandidate(draft);
  const decisions = boundaryReviewDecisions(candidate).map((decision) => ({
    ...decision,
    confirmed: progress?.confirmed_decisions.includes(decision.decision) ?? false,
  }));
  const candidateDigest = explorationBoundaryCandidateDigest(candidate);
  const core = {
    schema_version: "synapsor.boundary-review-bundle.v1" as const,
    candidate_digest: candidateDigest,
    activation: "disabled_unreviewed" as const,
    authority: {
      source: candidate.source,
      deployment_profile: candidate.deployment_profile,
      compiler_version: candidate.compiler_version,
      spec_version: candidate.spec_version,
      generation_lock_fingerprint: candidate.generation_lock_fingerprint,
      schema_fingerprint: lock.schema_fingerprint,
      role_posture_fingerprint: candidate.role_posture_fingerprint,
      environment: candidate.deployment_profile,
      budgets: candidate.budgets,
    },
    decisions,
    outstanding_decision_ids: decisions.filter((decision) => !decision.confirmed).map((decision) => decision.id),
    candidate,
  };
  const bundle: BoundaryReviewBundle = {
    ...core,
    mutation_bindings: {
      draft_digest: explorationBoundaryCandidateDigest(draft),
      candidate_digest: candidateDigest,
      generation_lock_fingerprint: draft.generation_lock_fingerprint,
      schema_fingerprint: lock.schema_fingerprint,
      role_posture_fingerprint: lock.role_posture_fingerprint,
      review_revision: progress?.revision ?? 0,
      ...(stored ? { authoring: stored.bindings } : {}),
    },
    bundle_digest: canonicalJsonDigest(core),
  };
  return { boundaryRoot, draft, candidate, lock, progress, bundle };
}


async function formatBoundaryReviewSummary(
  bundle: BoundaryReviewBundle,
  projectRoot: string,
  options: { nextAction?: boolean; active?: ActivatedExplorationBoundary[] } = {},
): Promise<string> {
  const overview = boundaryReviewOverview(bundle);
  const complete = overview.outstanding_decisions === 0;
  const includeNextAction = options.nextAction !== false;
  const active = (options.active ?? await loadActivatedExplorationBoundaries(projectRoot).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  })).find(boundary => boundary.pack.name === bundle.candidate.pack.name);
  const exactActive = active?.activation.digest === bundle.candidate_digest;
  return [
    "BOUNDARY REVIEW",
    "",
    ...formatTextTable(
      ["NAME", "STATUS", "TABLES", "REVIEW"],
      [[
        bundle.candidate.pack.name,
        exactActive ? "ACTIVE" : active ? "REPLACEMENT DRAFT" : complete ? "REVIEWED - NOT ACTIVE" : "DRAFT - NO ACCESS",
        String(bundle.candidate.pack.resources.length),
        complete ? "Complete" : formatReviewLeft(overview),
      ]],
      [20, 21, 6, 28],
    ),
    "",
    `${overview.confirmed_decisions}/${bundle.decisions.length} exact digest-bound decisions are recorded.`,
    exactActive ? "Authority active: yes, this exact revision"
      : active ? "Authority active: yes, earlier revision; this replacement is disabled" : "Authority active: no",
    "Source database changed: no",
    ...(exactActive ? ["This exact revision is already active. Opening this review does not require another activation."] : []),
    ...(includeNextAction && complete && !exactActive
      ? [
        `Next: ${cliCommandName()} boundary activate`,
        `Advanced fingerprint and decision IDs: ${cliCommandName()} boundary review --json`,
      ]
      : includeNextAction && !exactActive
        ? [
          `Next: ${cliCommandName()} boundary review`,
          "Open a table and sign it off, or choose Review all for the guided remaining review.",
        ]
        : []),
    "",
  ].join("\n");
}

function boundaryReviewOverview(bundle: BoundaryReviewBundle): BoundaryReviewOverview {
  const outstanding = bundle.decisions.filter((decision) => !decision.confirmed);
  const resourceDecisions = outstanding.filter((decision) => Boolean(decision.resource_id));
  return {
    confirmed_decisions: bundle.decisions.length - outstanding.length,
    outstanding_decisions: outstanding.length,
    outstanding_resource_decisions: resourceDecisions.length,
    outstanding_boundary_decisions: outstanding.length - resourceDecisions.length,
    resources_requiring_signoff: new Set(
      resourceDecisions.map((decision) => decision.resource_id),
    ).size,
  };
}

function formatReviewLeft(overview: BoundaryReviewOverview): string {
  const parts: string[] = [];
  if (overview.resources_requiring_signoff) {
    parts.push(
      `${overview.resources_requiring_signoff} ` +
      `${overview.resources_requiring_signoff === 1 ? "table" : "tables"}`,
    );
  }
  if (overview.outstanding_boundary_decisions) parts.push("boundary settings");
  return parts.length ? parts.join(" + ") : "Complete";
}

function formatBoundaryFinalReview(bundle: BoundaryReviewBundle): string {
  const outstanding = bundle.decisions.filter((decision) => !decision.confirmed);
  const rows: string[][] = [];
  if (outstanding.some((decision) => !decision.resource_id)) {
    rows.push([
      "Boundary settings",
      "-",
      bundle.authority.deployment_profile === "production"
        ? "production HTTP + JWT scope"
        : `${bundle.authority.deployment_profile} local authoring`,
      "-",
      "Sign-off needed",
    ]);
  }
  for (const resource of bundle.candidate.pack.resources) {
    if (!outstanding.some((decision) => decision.resource_id === resource.id)) continue;
    const principalScope = reviewedPrincipalScopeLabel(resource);
    rows.push([
      resource.id,
      [
        resource.selectable_fields.filter(
          (field) => !(resource.model_withheld_fields ?? []).includes(field),
        ).length,
        resource.model_withheld_fields?.length ?? 0,
        resource.kept_out_fields.length,
      ].join("/"),
      principalScope
        ? `${reviewedTenantScopeLabel(resource)} + ${principalScope}`
        : reviewedTenantScopeLabel(resource),
      `${resource.minimum_cohort_size}/${resource.relationships.length}`,
      "Sign-off needed",
    ]);
  }
  return [
    "FINAL REVIEW",
    "",
    "This records human review of the disabled draft. It does not activate agent access.",
    "Each row below is one plain-language sign-off; exact individual decisions remain digest-bound.",
    "",
    ...formatTextTable(
      ["REVIEW UNIT", "FIELDS M/R/OUT", "ROW SCOPE", "MIN GROUP / LINKS", "STATUS"],
      rows,
      [20, 14, 22, 17, 15],
    ),
    "",
    "M/R/OUT = model-visible / Runner-output-only / kept-out fields.",
    "MIN GROUP / LINKS = minimum returned cohort size / reviewed paths to related tables.",
    "",
  ].join("\n");
}

function reviewedTenantScopeLabel(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): string {
  if (resource.tenant_key) return resource.tenant_key;
  if (resource.tenant_scope) return `through ${formatDerivedScopePath(resource.tenant_scope)}`;
  return "Shared reference (no tenant predicate)";
}

function reviewedPrincipalScopeLabel(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): string | undefined {
  if (resource.principal_key) return resource.principal_key;
  if (resource.principal_scope) return `through ${formatDerivedScopePath(resource.principal_scope)}`;
  if (resource.rls_session?.principal_setting) {
    return `PostgreSQL RLS setting ${resource.rls_session.principal_setting}`;
  }
  return undefined;
}

function formatBoundarySettingsSignoff(bundle: BoundaryReviewBundle): string {
  return [
    "BOUNDARY SETTINGS",
    "",
    ...formatTextTable(
      ["SETTING", "REVIEWED VALUE"],
      [
        [
          "Where this can run",
          bundle.authority.deployment_profile === "production"
            ? "production over secured Streamable HTTP; explicit runtime opt-in and verified JWT scope required"
            : `${bundle.authority.deployment_profile} local authoring; production and remote Explore are refused`,
        ],
        [
          "Customer/user scope",
          "Runner supplies trusted values outside AI requests; the AI cannot choose either",
        ],
        [
          "Agent authority",
          "Still disabled after this sign-off; activation remains a separate exact-fingerprint action",
        ],
        [
          "Ranked queries",
          `Validate at most ${bundle.candidate.budgets.max_ranked_groups
            ?? bundle.candidate.budgets.max_groups} candidate groups, suppress small cohorts, ` +
          `then return at most top ${bundle.candidate.budgets.max_top_n}`,
        ],
      ],
      [20, 56],
    ),
    "",
  ].join("\n");
}

function formatBoundaryResourceSignoff(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
  decisionCount: number,
): string {
  const displayField = (field: string) => resource.field_metadata?.[field]?.label
    ? `${resource.field_metadata[field]!.label} (${field})`
    : field;
  const modelFields = resource.selectable_fields.filter(
    (field) => !(resource.model_withheld_fields ?? []).includes(field),
  ).map(displayField);
  const localFields = (resource.model_withheld_fields ?? []).map(displayField);
  const operationCounts = [
    `return ${resource.selectable_fields.length}`,
    `filter ${Object.keys(resource.filterable_fields).length}`,
    `sort ${resource.sortable_fields.length}`,
    `group ${resource.groupable_fields.length}`,
    `measure ${resource.aggregate_measures.length}`,
    `unique ${resource.count_distinct_fields.length}`,
    `time ${Object.keys(resource.time_bucket_fields).length}`,
  ].join(", ");
  return [
    `TABLE SIGN-OFF - ${resource.label ? `${resource.label} (${resource.id})` : resource.id}`,
    ...(resource.description ? [resource.description] : []),
    "",
    ...formatTextTable(
      ["ACCESS", "FIELDS"],
      [
        ["Model + Runner", fieldList(modelFields)],
        ["Raw values: Runner only", fieldList(localFields)],
        ["Kept out", fieldList(resource.kept_out_fields.map(displayField))],
      ],
      [20, 56],
    ),
    "",
    "Runner only controls raw-value egress, not inference: reviewed filter/group/sort operations may still reveal equality, frequency, or order. Use Kept out for confidentiality.",
    "",
    ...formatTextTable(
      ["SETTING", "REVIEWED VALUE"],
      [
        ["Record identity", resource.primary_key],
        ["Customer scope", `${reviewedTenantScopeLabel(resource)} - supplied outside AI requests`],
        [
          "User/owner scope",
          reviewedPrincipalScopeLabel(resource)
            ? `${reviewedPrincipalScopeLabel(resource)} - supplied outside AI requests`
            : "No separate per-user row limit is configured",
        ],
        ["Allowed operations", operationCounts],
        ["Model vocabulary", formatExploreVocabularyCoverage(resource)],
        [
          "Privacy",
          `minimum returned group ${resource.minimum_cohort_size}; suppression-aware totals stay on`,
        ],
        [
          "Related tables",
          resource.relationships.length
            ? resource.relationships.map((relationship) =>
              `${relationship.target_resource} ` +
              `(${relationship.cardinality.replaceAll("_", "-")}, max fan-out ${relationship.max_fan_out})`)
              .join(", ")
            : "None",
        ],
      ],
      [20, 56],
    ),
    "",
    `One confirmation records ${decisionCount} exact digest-bound ` +
      `${decisionCount === 1 ? "decision" : "decisions"} covering this table.`,
    "",
  ].join("\n");
}

function fieldList(fields: string[]): string {
  return fields.length ? fields.join(", ") : "None";
}

function formatTextTable(
  headers: string[],
  rows: string[][],
  maximumWidths: number[],
): string[] {
  const widths = headers.map((header, index) => Math.min(
    maximumWidths[index] ?? 40,
    Math.max(
      header.length,
      ...rows.map((row) => safeCliCell(row[index] ?? "").length),
    ),
  ));
  const formatLine = (row: string[]) => row.map((value, index) => {
    const fitted = safeCliCell(value);
    return index === row.length - 1 ? fitted : fitted.padEnd(widths[index]!);
  }).join("  ");
  const formatRow = (row: string[]): string[] => {
    const cells = row.map((value, index) => wrapCliCell(value, widths[index]!));
    const lines = Math.max(...cells.map((cell) => cell.length));
    return Array.from({ length: lines }, (_, line) =>
      formatLine(cells.map((cell) => cell[line] ?? "")));
  };
  return [
    formatLine(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.flatMap(formatRow),
  ];
}

function wrapCliCell(value: string, width: number): string[] {
  let remaining = safeCliCell(value).trim();
  if (!remaining) return [""];
  const lines: string[] = [];
  while (remaining.length > width) {
    const space = remaining.lastIndexOf(" ", width);
    const comma = remaining.lastIndexOf(", ", width);
    const breakAt = Math.max(space, comma >= 0 ? comma + 1 : -1);
    const length = breakAt > 0 ? breakAt : width;
    lines.push(remaining.slice(0, length).trim());
    remaining = remaining.slice(length).trim();
  }
  lines.push(remaining);
  return lines;
}

function safeCliCell(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}


function assertCurrentBoundaryReviewBundle(
  supplied: BoundaryReviewBundle,
  current: BoundaryReviewBundle,
): void {
  if (supplied.schema_version !== "synapsor.boundary-review-bundle.v1") {
    throw new Error("Unsupported boundary review bundle version.");
  }
  const {
    bundle_digest: suppliedDigest,
    mutation_bindings: _suppliedMutationBindings,
    ...suppliedCore
  } = supplied;
  if (canonicalJsonDigest(suppliedCore) !== suppliedDigest) {
    throw new Error("Boundary review bundle digest does not match its contents.");
  }
  if (suppliedDigest !== current.bundle_digest
    || supplied.candidate_digest !== current.candidate_digest) {
    throw new Error("Boundary review bundle is stale or belongs to a different candidate; export the current review again.");
  }
  if (current.mutation_bindings.authoring) {
    assertReadAuthoringBindings(supplied.mutation_bindings?.authoring, current.mutation_bindings.authoring);
  } else if (supplied.mutation_bindings?.authoring) {
    throw new Error("The review repository changed. Export and review the current bundle before activation.");
  }
}


function boundaryDecisionExpiry(value: string | undefined, now: Date): string {
  const maximumMs = 15 * 60 * 1000;
  const expires = value ? new Date(value) : new Date(now.getTime() + 5 * 60 * 1000);
  if (!Number.isFinite(expires.getTime())
    || expires.getTime() <= now.getTime()
    || expires.getTime() - now.getTime() > maximumMs) {
    throw new Error("Operator activation decision expiry must be in the future and no more than 15 minutes from now.");
  }
  return expires.toISOString();
}


async function assertFreshOperatorProof(
  proof: Awaited<ReturnType<typeof resolveOperatorIdentity>>,
  config: OperatorIdentityConfig,
  configPath: string,
): Promise<void> {
  if (proof.provider === "signed_key") {
    const operator = config.operators?.[proof.subject];
    if (!operator) throw new Error("Verified operator is no longer configured.");
    const publicKey = await fs.readFile(
      path.resolve(path.dirname(path.resolve(configPath)), operator.public_key_path),
      "utf8",
    );
    if (!verifySignedOperatorProof(proof, publicKey)) {
      throw new Error("Signed operator proof failed independent verification.");
    }
    return;
  }
  if (proof.provider === "jwt_oidc") {
    const secretEnv = config.attestation_secret_env ?? "SYNAPSOR_OPERATOR_ATTESTATION_SECRET";
    const secret = process.env[secretEnv]?.trim();
    if (!secret || !verifyJwtOperatorProof(proof, secret)) {
      throw new Error("OIDC operator proof failed independent attestation verification.");
    }
    return;
  }
  throw new Error("Operator proof must use signed_key or jwt_oidc.");
}


export async function startSafeAction(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--action", "--description", "--based-on", "--config", "--project-root", "--force", "--json"]), "start --action");
  const actionName = optionalArg(args, "--action");
  const description = optionalArg(args, "--description");
  if (!actionName) throw new Error("start --action requires a business action name, for example --action refund_order");
  if (!description) throw new Error("start --action requires --description so the intended business effect is reviewable");
  const projectRoot = optionalArg(args, "--project-root") ?? process.cwd();
  const result = await scaffoldSafeAction({
    projectRoot,
    configPath: optionalArg(args, "--config"),
    actionName,
    description,
    basedOnCapability: optionalArg(args, "--based-on"),
    force: args.includes("--force"),
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: true, state: "disabled_scaffold", ...result }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write([
    "Synapsor Safe Action Composer",
    "",
    `Action: ${result.action_name}`,
    `Draft source: ${result.source_path}`,
    `Inherited read boundary: ${result.based_on_capability}`,
    `Base contract: ${result.base_contract_path}`,
    `Agent instructions: ${result.instructions.canonical}`,
    `Detected project evidence: ${result.project_context.schema_inputs.map((item) => `${item.kind}:${item.path}`).join(", ") || "none"}`,
    `Detected database environment names: ${result.project_context.database_env_names.join(", ") || "none"} (values were not read)`,
    "State: disabled scaffold (active Runner tools are unchanged)",
    "",
    "Authority questions the coding agent must leave for explicit review:",
    ...result.authority_questions.map((item) => `  - ${item.field}: ${item.question}\n    Source: ${item.source}`),
    "",
    "Give your coding agent this task:",
    `  Complete ${result.source_path} using the existing application and schema. Keep trusted tenant/principal values out of model arguments. Resolve every __REVIEW_*__ placeholder, add deterministic allow/deny/effect coverage, and run:`,
    `  ${cliCommandName()} action validate ${result.source_path}`,
    "  Leave the result disabled. Do not edit active contract artifacts or claim activation.",
    "",
    "After validation, open the secured local Workbench for human effect review and activation.",
    "",
  ].join("\n"));
  return 0;
}


type ActionProjectInspector = typeof inspectActionProject;

export async function actionCommand(
  args: string[],
  actionProjectInspector: ActionProjectInspector = inspectActionProject,
  clientSetup?: (projectRoot: string) => Promise<number>,
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "review" || subcommand === "tui") return reviewActionsCommand(rest, actionProjectInspector, undefined, undefined, true, false, clientSetup);
  if (subcommand === "suggest") return importActionSuggestionCommand(rest, actionProjectInspector);
  if (subcommand === "suggestions") return listActionSuggestionsCommand(rest, actionProjectInspector);
  if (subcommand === "draft") return draftGuidedActionCommand(rest, actionProjectInspector);
  if (subcommand === "revise") return reviseGuidedActionCommand(rest, actionProjectInspector);
  if (subcommand === "preview") return previewGuidedActionCommand(rest);
  if (subcommand === "activate") return activateGuidedActionCommand(rest, actionProjectInspector);
  if (subcommand === "validate" || subcommand === "compile") return validateSafeActionCommand(rest);
  if (subcommand === "watch") return watchSafeActionCommand(rest);
  if (subcommand === "status") return safeActionStatusCommand(rest);
  usage(["action"]);
  return 2;
}


async function reviewReadFromSavedActions(input: { projectRoot: string; boundaryName: string;
  session: BoundaryReviewInteractiveSession; schemaInspector: typeof inspectDatabase;
  authoringOptions?: BoundaryReviewCommandOptions }): Promise<void> {
  const context = await loadBoundaryReviewContext(input.projectRoot);
  if (context.candidate.pack.name !== input.boundaryName) {
    await showManualReadActivationBlocker(input.session, "Select the linked read access", [
      `The selected review changed. Open the saved ${input.boundaryName} review before continuing.`,
      "No permissions or saved business rules changed.",
    ]);
    return;
  }
  try {
    await confirmAndActivateFocusedBoundary({ projectRoot: input.projectRoot,
      schemaInspector: input.schemaInspector, session: input.session, keepAccessOpen: true,
      reviewOptions: { openModelRevision: async () => {
        await reloadReadReviewForModelRevision(input.projectRoot, context);
        const result = await boundaryReviewCommand(["--project-root", input.projectRoot, "--access", "--job-first"],
          input.schemaInspector, input.session, undefined, { ...input.authoringOptions,
            startWithAgentJob: true, initialSavedReadRevision: true, exitAfterAgentJob: true });
        if (result !== 0) throw new Error("The saved access revision did not finish. Return to this review to inspect the retained draft or retry.");
      } } });
  } catch (error) {
    await showManualReadActivationBlocker(input.session, "Read access needs attention", [
      redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
      "Your saved actions remain available. Check the current permissions before retrying an interrupted approval.",
    ]);
  }
}

async function reviewActionsCommand(
  args: string[],
  actionProjectInspector: ActionProjectInspector,
  modelSuggestionSession?: ActionModelSuggestionSession,
  actionControlPlane: typeof runActionControlPlane = runActionControlPlane,
  includeModelGuidedVerifiedActionRevision = true,
  initialManualSemantic = false,
  clientSetup?: (projectRoot: string) => Promise<number>,
): Promise<number> {
  assertKnownOptions(args, new Set(["--config", "--project-root", "--store", "--suggestion", "--boundary"]), "action review");
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  await actionControlPlane({
    projectRoot,
    ...(clientSetup ? { clientSetup: () => clientSetup(projectRoot) } : {}),
    reviewLinkedRead: ({ boundaryName, session }) => reviewReadFromSavedActions({ projectRoot, boundaryName,
      session, schemaInspector: inspectDatabase }),
    ...(optionalArg(args, "--boundary") ? { boundaryName: optionalArg(args, "--boundary") } : {}),
    inspection: await actionProjectInspector(projectRoot, process.env),
    ...(initialManualSemantic ? { initialManualSemantic: true } : {}),
    ...(optionalArg(args, "--config") ? { configPath: optionalArg(args, "--config") } : {}),
    ...(optionalArg(args, "--store") ? { storePath: optionalArg(args, "--store") } : {}),
    ...(optionalArg(args, "--suggestion") ? { initialSuggestionId: optionalArg(args, "--suggestion") } : {}),
    ...(modelSuggestionSession ? { modelSuggestionSession } : {}),
    ...(includeModelGuidedVerifiedActionRevision ? { modelGuidedVerifiedActionRevision: async ({ modelSuggestionSession: currentModel }) => {
      const result = await boundaryReviewCommand(
        ["--project-root", projectRoot, "--access", "--job-first"],
        inspectDatabase,
        undefined,
        undefined,
        {
          startWithAgentJob: true,
          exitAfterAgentJob: true,
          clientSetup,
          ...(currentModel ?? modelSuggestionSession
            ? { modelAuthoringSession: currentModel ?? modelSuggestionSession }
            : {}),
        },
      );
      return result === 0
        ? {
            tone: "success",
            title: "Returned from model-guided Boundary drafting.",
            lines: [
              "The verified Action view will reload the active authority and any disabled replacement.",
              "No authority changed except through an exact confirmation shown during that conversation.",
            ],
          }
        : {
            tone: "warning",
            title: "Model-guided Boundary drafting did not complete.",
            lines: ["The existing active authority and source data remain unchanged."],
          };
    } } : {}),
  });
  return 0;
}


async function importActionSuggestionCommand(
  args: string[],
  actionProjectInspector: ActionProjectInspector,
): Promise<number> {
  assertKnownOptions(args, new Set([
    "--input",
    "--intent",
    "--provider",
    "--model",
    "--api-key-env",
    "--base-url",
    "--acknowledge-egress",
    "--project-root",
    "--json",
  ]), "action suggest");
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const inspection = await actionProjectInspector(projectRoot, process.env);
  const options = await guidedActionOptions({ projectRoot, inspection });
  const inputPath = optionalArg(args, "--input");
  const intent = optionalArg(args, "--intent");
  if (Boolean(inputPath) === Boolean(intent)) {
    throw new Error("action suggest requires exactly one of --input <json> or --intent <business intent>.");
  }
  let value: Record<string, unknown>;
  let generatedBy: { provider: string; model: string } | undefined;
  if (inputPath) {
    value = await readContainedActionJson(projectRoot, inputPath);
  } else {
    const rawProvider = requiredActionArg(args, "--provider", "action suggest");
    const provider = rawProvider === "openai-compatible" ? "openai_compatible" : rawProvider;
    if (provider !== "openai" && provider !== "anthropic" && provider !== "openrouter" && provider !== "openai_compatible") {
      throw new Error("action suggest --provider must be openai, anthropic, openrouter, or openai-compatible.");
    }
    const model = optionalArg(args, "--model")
      ?? (provider === "openai_compatible" ? undefined : defaultHostedModel(provider));
    if (!model) throw new Error("action suggest with an OpenAI-compatible provider requires --model <name>.");
    const generated = await generateModelActionSuggestion({
      intent: intent!,
      provider,
      model,
      options,
      env: process.env,
      ...(optionalArg(args, "--api-key-env") ? { apiKeyEnv: optionalArg(args, "--api-key-env") } : {}),
      ...(optionalArg(args, "--base-url") ? { baseUrl: optionalArg(args, "--base-url") } : {}),
      egressAcknowledged: args.includes("--acknowledge-egress"),
    });
    value = generated.assessment.suggestion as unknown as Record<string, unknown>;
    generatedBy = { provider, model };
  }
  const suggestion = await importActionSuggestion({ projectRoot, value, options });
  const payload = {
    ok: suggestion.state === "suggested",
    suggestion,
    authority_granted: false,
    active_tools_changed: false,
    source_database_changed: false,
    ...(generatedBy ? { generated_by: generatedBy } : {}),
  };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write([
    `Safe Action suggestion ${suggestion.suggestion_id} imported as ${suggestion.state.toUpperCase()}.`,
    `Intent: ${suggestion.assessment.suggestion.intent}`,
    ...suggestion.current_assessment.structural_evidence.map((item) =>
      `${item.state.toUpperCase()} ${item.decision} ${item.value}: ${item.reason}`),
    ...suggestion.current_assessment.blockers.map((blocker) => `BLOCKED: ${blocker}`),
    "Authority granted: no",
    "Active tools changed: no",
    "Source database changed: no",
    suggestion.state === "suggested"
      ? `Next: ${cliCommandName()} action review --suggestion ${suggestion.suggestion_id} --project-root ${shellQuote(projectRoot)}`
      : "Next: correct the suggestion against the current reviewed candidates, then import a new immutable suggestion.",
    "",
  ].join("\n"));
  return suggestion.state === "suggested" ? 0 : 1;
}


async function listActionSuggestionsCommand(
  args: string[],
  actionProjectInspector: ActionProjectInspector,
): Promise<number> {
  assertKnownOptions(args, new Set(["--project-root", "--json"]), "action suggestions");
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const inspection = await actionProjectInspector(projectRoot, process.env);
  const options = await guidedActionOptions({ projectRoot, inspection });
  const suggestions = await listActionSuggestions({ projectRoot, options });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: true, suggestions, source_database_changed: false }, null, 2)}\n`);
  } else {
    process.stdout.write([
      "Imported Safe Action suggestions",
      "",
      ...(suggestions.length
        ? suggestions.flatMap((suggestion) => [
            `${suggestion.suggestion_id}  ${suggestion.state.toUpperCase()}  ${suggestion.assessment.suggestion.intent}`,
            `  ${suggestion.assessment.suggestion.operation?.toUpperCase() ?? "OPERATION NEEDED"} ${suggestion.assessment.suggestion.resource ?? "RESOURCE NEEDED"}`,
          ])
        : ["No bounded suggestions are imported."]),
      "",
      "Suggestions are untrusted convenience metadata. They never grant authority or alter active tools.",
      "",
    ].join("\n"));
  }
  return 0;
}


async function draftGuidedActionCommand(
  args: string[],
  actionProjectInspector: ActionProjectInspector,
): Promise<number> {
  assertKnownOptions(args, new Set(["--answers", "--project-root", "--json"]), "action draft");
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const answersPath = requiredActionArg(args, "--answers", "action draft");
  const answers = await readContainedActionJson(projectRoot, answersPath);
  const action = (isCliRecord(answers.action) ? answers.action : answers) as GuidedActionInput;
  const inspection = await actionProjectInspector(projectRoot, process.env);
  const created = await createGuidedActionDraft({ projectRoot, action, inspection });
  const payload = {
    ok: true,
    state: created.draft.state,
    draft: created.draft,
    preview_args: created.preview_args,
    source_database_changed: false,
    active_tools_changed: false,
  };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write([
    "Disabled Safe Action revision created",
    `Capability: ${created.draft.capability}`,
    `Authority: ${created.draft.authority_posture}`,
    `Writeback: ${created.draft.writeback_mode}`,
    `Exact digest: ${created.draft.contract_digest}`,
    "Source database changed: no",
    `Next: ${cliCommandName()} action preview --capability ${created.draft.capability} --project-root ${shellQuote(projectRoot)}`,
    "",
  ].join("\n"));
  return 0;
}


async function reviseGuidedActionCommand(
  args: string[],
  actionProjectInspector: ActionProjectInspector,
): Promise<number> {
  assertKnownOptions(args, new Set(["--capability", "--expected-digest", "--answers", "--project-root", "--json"]), "action revise");
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const capabilityName = requiredActionArg(args, "--capability", "action revise");
  const expectedCurrentDigest = requiredActionArg(args, "--expected-digest", "action revise");
  const answers = await readContainedActionJson(projectRoot, requiredActionArg(args, "--answers", "action revise"));
  const authority = (isCliRecord(answers.authority) ? answers.authority : answers) as GuidedActionAuthorityRevisionInput;
  const inspection = await actionProjectInspector(projectRoot, process.env);
  const revised = await reviseGuidedActionAuthority({
    projectRoot,
    capabilityName,
    expectedCurrentDigest,
    authority,
    inspection,
  });
  const payload = {
    ok: true,
    transition: revised.transition,
    previous_digest: revised.previous.contract_digest,
    draft: revised.draft,
    source_database_changed: false,
    active_tools_changed: false,
  };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write([
    `Disabled ${revised.transition.kind} revision created for ${revised.draft.capability}.`,
    `Active digest remains: ${revised.previous.contract_digest}`,
    `New disabled digest: ${revised.draft.contract_digest}`,
    "Old proposals gain execution authority: no",
    "",
  ].join("\n"));
  return 0;
}


async function previewGuidedActionCommand(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--capability", "--args", "--config", "--project-root", "--token-env", "--json"]), "action preview");
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const capabilityName = requiredActionArg(args, "--capability", "action preview");
  const argsPath = optionalArg(args, "--args");
  if (!argsPath) {
    const draft = await recordGuidedActionStructuralPreview({
      projectRoot,
      capabilityName,
      ...(optionalArg(args, "--config") ? { configPath: optionalArg(args, "--config") } : {}),
    });
    const payload = {
      ok: true,
      preview: draft.effect_preview,
      activation_review: { expected_digest: draft.action_boundary_digest, confirmation: `ACTIVATE ${draft.action_boundary_digest}`,
        digest_purpose: "Action Boundary authority, not the compiled contract digest", authority_posture: draft.authority_posture,
        writeback_mode: draft.writeback_mode, trusted_operator_confirmation_required: true },
      rehearsal_mode: "structural",
      runtime_identity_resolved: false,
      source_rows_read: false,
      source_database_changed: false,
    };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write([
      `Exact structural rehearsal verified for ${capabilityName}.`,
      `Reviewed posture: ${draft.authority_posture}; writeback: ${draft.writeback_mode}. Nothing is activated by this rehearsal.`,
      `Action Boundary digest for --expected-digest: ${draft.action_boundary_digest}`,
      `Exact confirmation: ACTIVATE ${draft.action_boundary_digest}`,
      "Runtime tenant/principal values used: no",
      "Source rows read: no",
      "Source database changed: no",
      "Use --args <json-file> only when you deliberately want an optional live scoped proposal rehearsal.",
      "",
    ].join("\n"));
    return 0;
  }
  const previewArgs = await readContainedActionJson(projectRoot, argsPath);
  const preview = await executeGuidedActionPreview({
    projectRoot,
    capabilityName,
    args: previewArgs,
    ...(optionalArg(args, "--config") ? { baseConfigPath: optionalArg(args, "--config") } : {}),
    ...(optionalArg(args, "--token-env") ? { accessTokenEnv: optionalArg(args, "--token-env") } : {}),
  });
  const draft = await recordGuidedActionPreview({
    projectRoot,
    capabilityName,
    contractDigest: preview.draft_digest,
    actionBoundaryDigest: preview.action_boundary_digest,
    proposalId: preview.proposal_id,
    proposalHash: preview.proposal_hash,
    sourceDatabaseChanged: preview.source_database_changed,
  });
  const payload = { ok: true, preview: draft.effect_preview,
    activation_review: { expected_digest: draft.action_boundary_digest, confirmation: `ACTIVATE ${draft.action_boundary_digest}`,
      digest_purpose: "Action Boundary authority, not the compiled contract digest", authority_posture: draft.authority_posture,
      writeback_mode: draft.writeback_mode, trusted_operator_confirmation_required: true },
    source_database_changed: false, rehearsal_ledger_persisted: false };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write([
    `Exact proposal rehearsal verified for ${capabilityName}.`,
    `Reviewed posture: ${draft.authority_posture}; writeback: ${draft.writeback_mode}. Nothing is activated by this rehearsal.`,
    `Action Boundary digest for --expected-digest: ${draft.action_boundary_digest}`,
    `Exact confirmation: ACTIVATE ${draft.action_boundary_digest}`,
    `Proposal: ${preview.proposal_id}`,
    `Hash: ${preview.proposal_hash}`,
    "Source database changed: no",
    "Disposable rehearsal ledger persisted: no",
    "",
  ].join("\n"));
  return 0;
}


async function activateGuidedActionCommand(
  args: string[],
  actionProjectInspector: ActionProjectInspector,
): Promise<number> {
  assertKnownOptions(args, new Set([
    "--capability",
    "--expected-digest",
    "--confirmation",
    "--actor",
    "--config",
    "--project-root",
    "--headless",
    "--identity",
    "--identity-key",
    "--required-role",
    "--reason",
    "--expires-at",
    "--nonce",
    "--json",
  ]), "action activate");
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const capabilityName = requiredActionArg(args, "--capability", "action activate");
  const expectedDigest = requiredActionArg(args, "--expected-digest", "action activate");
  const confirmation = requiredActionArg(args, "--confirmation", "action activate");
  const headless = args.includes("--headless");
  if (!headless && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(
      "Noninteractive Safe Action activation requires --headless and a verified signed_key or jwt_oidc operator identity.",
    );
  }
  let actor = optionalArg(args, "--actor")?.trim();
  let consumedDecision: { store: ProposalStore; key: string; decisionId: `sha256:${string}` } | undefined;
  if (headless) {
    const draft = await readGuidedActionDraft(projectRoot, capabilityName);
    if (draft.action_boundary_digest !== expectedDigest || confirmation !== `ACTIVATE ${draft.action_boundary_digest}`) {
      throw new Error(`Headless Safe Action activation requires the Action Boundary digest (not contract_digest): --expected-digest ${draft.action_boundary_digest} and --confirmation 'ACTIVATE ${draft.action_boundary_digest}'. No authority changed.`);
    }
    if (!draft.effect_preview
      || draft.effect_preview.contract_digest !== draft.contract_digest
      || draft.effect_preview.action_boundary_digest !== draft.action_boundary_digest) {
      throw new Error("Headless Safe Action activation requires an exact successful rehearsal of the complete capability and Action Boundary authority.");
    }
    const resolvedProject = await resolveSynapsorProject(projectRoot, process.env);
    const configPath = optionalArg(args, "--config") ?? resolvedProject?.config_path;
    if (!configPath) {
      throw new Error("Headless Safe Action activation requires a discoverable Runner config or --config <path>.");
    }
    const config = await readRuntimeConfig(configPath);
    if (config.operator_identity?.provider !== "signed_key"
      && config.operator_identity?.provider !== "jwt_oidc") {
      throw new Error("Headless Safe Action activation requires configured signed_key or jwt_oidc operator identity.");
    }
    const requiredRole = optionalArg(args, "--required-role")?.trim();
    if (!requiredRole) throw new Error("Headless Safe Action activation requires --required-role <reviewed-operator-role>.");
    const reason = optionalArg(args, "--reason")?.trim();
    if (!reason) throw new Error("Headless Safe Action activation requires --reason <human review reason>.");
    const now = new Date();
    const expiresAt = boundaryDecisionExpiry(optionalArg(args, "--expires-at"), now);
    const nonce = optionalArg(args, "--nonce")?.trim() || crypto.randomBytes(24).toString("base64url");
    if (!/^[A-Za-z0-9._~-]{16,200}$/.test(nonce)) {
      throw new Error("Safe Action activation nonce must contain 16-200 URL-safe non-secret characters.");
    }
    const envelope = {
      schema_version: "synapsor.action-activation-decision.v1",
      capability: draft.capability,
      contract_digest: draft.contract_digest,
      action_boundary_digest: draft.action_boundary_digest,
      boundary_digest: draft.boundary_digest,
      generation_lock_fingerprint: draft.generation_lock_fingerprint,
      authority_posture: draft.authority_posture,
      writeback_mode: draft.writeback_mode,
      rehearsal_proposal_hash: draft.effect_preview.proposal_hash,
      required_role: requiredRole,
      issued_at: now.toISOString(),
      expires_at: expiresAt,
      nonce,
    };
    const decisionId = canonicalJsonDigest(envelope);
    const identity = await resolveOperatorIdentity({
      config: config.operator_identity as OperatorIdentityConfig,
      configPath,
      proposal: {
        proposal_id: `action_${draft.contract_digest.slice("sha256:".length, "sha256:".length + 24)}`,
        proposal_version: 1,
        proposal_hash: decisionId,
      },
      action: "action_activate",
      reason,
      actor,
      identity: optionalArg(args, "--identity"),
      privateKeyPath: optionalArg(args, "--identity-key"),
      requiredRole,
      now: now.toISOString(),
    });
    if (!identity.verified || identity.provider === "dev_env") {
      throw new Error("Headless Safe Action activation identity was not cryptographically verified.");
    }
    if (actor && actor !== identity.subject) {
      throw new Error("The verified operator subject does not match --actor.");
    }
    await assertFreshOperatorProof(
      identity,
      config.operator_identity as OperatorIdentityConfig,
      configPath,
    );
    actor = identity.subject;
    const storePath = resolvedProject?.store_path
      ?? (config.storage?.sqlite_path
        ? path.resolve(path.dirname(path.resolve(configPath)), config.storage.sqlite_path)
        : path.join(projectRoot, ".synapsor/local.db"));
    await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const store = new ProposalStore(storePath);
    // The signed decision includes issued_at, so its digest changes between
    // attempts. Replay protection must instead key the caller-supplied nonce to
    // the exact immutable action revision.
    const nonceDigest = canonicalJsonDigest({
      schema_version: "synapsor.action-activation-nonce.v1",
      capability: draft.capability,
      contract_digest: draft.contract_digest,
      action_boundary_digest: draft.action_boundary_digest,
      nonce,
    });
    const key = `action_activation_nonce:${nonceDigest}`;
    if (store.getRunnerState(key)) {
      store.close();
      throw new Error("Safe Action activation decision was already consumed; create a fresh short-lived decision with a new nonce.");
    }
    store.setRunnerState(key, {
      status: "consumed_before_activation",
      decision_id: decisionId,
      capability: draft.capability,
      contract_digest: draft.contract_digest,
      subject: identity.subject,
      provider: identity.provider,
      decision_hash: identity.decision_hash,
      integrity_hash: identity.integrity_hash,
      issued_at: now.toISOString(),
      expires_at: expiresAt,
      nonce_digest: nonceDigest,
      source_database_changed: false,
    });
    consumedDecision = { store, key, decisionId };
  }
  if (!actor) throw new Error("Interactive Safe Action activation requires --actor <operator-audit-label>.");
  const inspection = await actionProjectInspector(projectRoot, process.env);
  let active;
  try {
    active = await activateGuidedAction({
      projectRoot,
      capabilityName,
      expectedDigest,
      confirmation,
      actor,
      inspection,
      ...(optionalArg(args, "--config") ? { configPath: optionalArg(args, "--config") } : {}),
    });
    consumedDecision?.store.setRunnerState(consumedDecision.key, {
      status: "activated",
      decision_id: consumedDecision.decisionId,
      capability: active.capability,
      contract_digest: active.contract_digest,
      activated_at: active.activated_at,
      source_database_changed: false,
    });
  } catch (error) {
    consumedDecision?.store.setRunnerState(consumedDecision.key, {
      status: "consumed_activation_failed",
      decision_id: consumedDecision.decisionId,
      capability: capabilityName,
      contract_digest: expectedDigest,
      failed_at: new Date().toISOString(),
      source_database_changed: false,
    });
    throw error;
  } finally {
    consumedDecision?.store.close();
  }
  const payload = { ok: true, active, source_database_changed: false };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write([
    `Safe Action ${active.capability} activated.`,
    `Authority: ${active.authority_posture}`,
    `Writeback: ${active.writeback_mode}`,
    `Exact digest: ${active.contract_digest}`,
    `Action runtime: ${active.config_path}`,
    active.writeback_mode === "none"
      ? "Source mutation remains impossible; calls create proposals only."
      : "Approval and execution remain separate trusted operator steps.",
    "",
  ].join("\n"));
  return 0;
}


async function validateSafeActionCommand(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--config", "--project-root", "--json"]), "action validate");
  const sourcePath = positional(args, 0);
  if (!sourcePath) throw new Error("action validate requires a TypeScript Safe Action source path");
  try {
    const result = await compileSafeActionDraft({
      projectRoot: optionalArg(args, "--project-root"),
      configPath: optionalArg(args, "--config"),
      sourcePath,
    });
    const payload = {
      ok: result.manifest.validation.ok,
      state: result.manifest.state,
      action_name: result.manifest.action_name,
      draft_digest: result.manifest.draft_contract_digest,
      draft_contract: result.manifest.draft_contract_path,
      generated_tests: result.manifest.generated_tests_path,
      lint_report: result.manifest.validation.lint_report_path,
      explanation: result.manifest.validation.explanation_path,
      static_test_report: result.manifest.validation.static_test_report_path,
      lint_summary: result.manifest.validation.lint_summary,
      blocking_lint_issues: result.manifest.validation.blocking_lint_issues,
      static_test_summary: result.manifest.validation.static_test_summary,
      live_tests_pending: result.manifest.validation.live_tests_pending,
      unresolved_authority: result.manifest.unresolved_authority,
      diagnostics: result.manifest.diagnostics,
      active_tools_changed: false,
      source_database_changed: false,
    };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(formatSafeActionValidation(payload));
    return payload.ok ? 0 : 1;
  } catch (error) {
    if (!(error instanceof SafeActionValidationError) || !args.includes("--json")) throw error;
    process.stdout.write(`${JSON.stringify({ ok: false, state: "blocked", diagnostics: error.diagnostics, active_tools_changed: false, source_database_changed: false }, null, 2)}\n`);
    return 1;
  }
}


async function watchSafeActionCommand(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--config", "--project-root", "--json", "--once"]), "action watch");
  const sourcePath = positional(args, 0);
  if (!sourcePath) throw new Error("action watch requires a TypeScript Safe Action source path");
  const run = async () => {
    try {
      return await validateSafeActionCommand([sourcePath, ...flagWithValue(args, "--config"), ...flagWithValue(args, "--project-root"), ...(args.includes("--json") ? ["--json"] : [])]);
    } catch (error) {
      if (error instanceof SafeActionValidationError) {
        if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: false, state: "blocked", diagnostics: error.diagnostics }, null, 2)}\n`);
        else process.stderr.write(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
  };
  const initial = await run();
  if (args.includes("--once")) return initial;
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const watchedPath = path.resolve(projectRoot, sourcePath);
  process.stderr.write(`Watching disabled Safe Action draft: ${watchedPath}\nActive tools will not reload or change. Press Ctrl+C to stop.\n`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    for await (const event of fs.watch(watchedPath, { signal: controller.signal })) {
      if (event.eventType === "change" || event.eventType === "rename") await run();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).name !== "AbortError") throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}


async function safeActionStatusCommand(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--project-root", "--json"]), "action status");
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const [status, guided, verifiedDrafts] = await Promise.all([
    safeActionStatus(projectRoot),
    guidedActionStatus(projectRoot),
    listActionRuleAuthorityDrafts(projectRoot),
  ]);
  let verifiedActive: ActionRuleAuthorityActivationV1 | undefined;
  let verifiedError: string | undefined;
  let readiness: import("./authoring-client-readiness.js").PostActivationReadiness | undefined;
  try {
    verifiedActive = await readActionRuleAuthorityActivation(projectRoot);
    const { readPostActivationReadiness } = await import("./authoring-client-readiness.js");
    readiness = await readPostActivationReadiness(projectRoot);
  } catch (error) {
    verifiedError = error instanceof Error ? error.message : String(error);
  }
  const verified = {
    state: verifiedError
      ? "blocked" as const
      : verifiedActive && verifiedDrafts.length
        ? "active_with_disabled_changes" as const
        : verifiedActive
          ? "active" as const
          : verifiedDrafts.length
            ? "disabled" as const
            : "off" as const,
    active: verifiedActive,
    drafts: verifiedDrafts,
    ...(verifiedError ? { error: verifiedError } : {}),
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({
      ok: verifiedError === undefined,
      // Preserve the original automation contract while exposing the new
      // multi-action control-plane views additively.
      ...status,
      code_first: status,
      managed_actions: guided,
      verified_outcomes: verified,
      readiness: readiness ?? { state: "blocked", worker: "not_checked" },
    }, null, 2)}\n`);
  }
  else process.stdout.write([
    "Synapsor Safe Action status",
    "",
    ...(readiness ? [
      `Read: ${readiness.read} | Verified outcomes: ${readiness.semantic_actions} | Legacy actions: ${readiness.legacy_actions}`,
      ...readiness.semantic_outcomes.map((outcome) => `${outcome.outcome}: approval ${outcome.approval_mode}; execution ${outcome.execution_enabled ? "enabled" : "disabled"}`),
      "Worker: not checked. Approval is not completion; completion requires an applied receipt.",
      "",
    ] : []),
    "Verified outcomes (Runner derives the exact effect from current facts)",
    ...renderVerifiedActionStatus(verified),
    "",
    "Caller-supplied proposal values",
    ...renderActionControlPlaneTable(guided, process.stdout.columns ?? 100),
    "",
    "Code-first compatibility path",
    `Draft: ${status.draft ? `${status.draft.action_name} (${status.draft.state}, ${status.draft.draft_contract_digest})` : "none"}`,
    `Active: ${status.active ? `${status.active.action_name} (${status.active.contract_digest})` : "not managed by Safe Action activation"}`,
    `Draft matches active: ${status.draft_matches_active ? "yes" : "no"}`,
    "Open the human control plane with: synapsor-runner action review",
    "No authoring, activation, approval, apply, or policy command is model-facing.",
    "",
  ].join("\n"));
  return verifiedError ? 1 : 0;
}

function renderVerifiedActionStatus(input: {
  state: "off" | "disabled" | "active" | "active_with_disabled_changes" | "blocked";
  active?: ActionRuleAuthorityActivationV1;
  drafts: ActionRuleAuthorityDraftV1[];
  error?: string;
}): string[] {
  if (input.state === "blocked") {
    return [
      "State: BLOCKED",
      `Reason: ${input.error ?? "The active verified Action authority failed integrity validation."}`,
      "Proposal authority for verified outcomes is unavailable. Read authority is unchanged.",
    ];
  }
  const rows: string[][] = [];
  if (input.active) {
    for (const rule of input.active.authority.action_boundary.rules) {
      rows.push([
        rule.outcome,
        "ACTIVE",
        `${rule.operation.toUpperCase()} ${rule.target_resource}`,
        rule.approval_mode === "policy" ? "Policy + fallback" : "Human review",
        rule.writeback.mode === "none" ? "Proposal only" : "Supervised",
      ]);
    }
  }
  for (const draft of input.drafts) {
    for (const rule of draft.authority.action_boundary.rules) {
      rows.push([
        rule.outcome,
        "DISABLED",
        `${rule.operation.toUpperCase()} ${rule.target_resource}`,
        rule.approval_mode === "policy" ? "Policy + fallback" : "Human review",
        rule.writeback.mode === "none" ? "Proposal only" : "Supervised",
      ]);
    }
  }
  if (!rows.length) return ["State: OFF", "No verified outcome is drafted or active."];
  return [
    `State: ${input.state.replace(/_/gu, " ").toUpperCase()}`,
    ...renderBoundaryMapTable(
      ["Outcome", "Authority", "Derived effect", "Approval", "Apply"],
      rows,
      { widths: [27, 10, 31, 19, 14], rowSeparators: false },
    ),
    "Agent input: outcome + opaque subject reference. Patch, trusted scope, approval, and apply are not agent inputs.",
  ];
}


function formatSafeActionValidation(input: {
  ok: boolean;
  action_name: string;
  draft_digest: string;
  draft_contract: string;
  generated_tests: string;
  lint_report: string;
  explanation: string;
  static_test_report: string;
  lint_summary: { errors: number; warnings: number; info: number };
  blocking_lint_issues: number;
  static_test_summary: { passed: number; failed: number; total: number };
  live_tests_pending: string[];
  unresolved_authority: string[];
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}): string {
  return [
    `Synapsor Safe Action draft: ${input.ok ? "valid" : "blocked"}`,
    `Action: ${input.action_name}`,
    `Disabled draft digest: ${input.draft_digest}`,
    `Canonical draft: ${input.draft_contract}`,
    `Generated contract tests: ${input.generated_tests}`,
    `Strict incremental lint: ${input.blocking_lint_issues === 0 ? "PASS" : "BLOCKED"} (${input.lint_summary.errors} error / ${input.lint_summary.warnings} warning / ${input.lint_summary.info} info; inherited warnings remain visible)`,
    `Static generated tests: ${input.static_test_summary.failed === 0 ? "PASS" : "FAIL"} (${input.static_test_summary.passed}/${input.static_test_summary.total})`,
    `Live staging tests pending: ${input.live_tests_pending.length}`,
    `Lint report: ${input.lint_report}`,
    `Reviewer explanation: ${input.explanation}`,
    `Static test report: ${input.static_test_report}`,
    `Warnings: ${input.diagnostics.filter((item) => item.severity === "warning").length}`,
    ...(input.unresolved_authority.length ? ["Unresolved authority:", ...input.unresolved_authority.map((item) => `  - ${item}`)] : []),
    "Active Runner tools changed: no",
    "Source database changed: no",
    input.ok
      ? "Next: open the secured localhost Workbench and review the exact digest/effect before activation."
      : "Next: resolve every blocking lint/test finding, then validate a new disabled draft.",
    "",
  ].join("\n");
}


function flagWithValue(args: string[], flag: string): string[] {
  const value = optionalArg(args, flag);
  return value ? [flag, value] : [];
}


function requiredActionArg(args: string[], flag: string, command: string): string {
  const value = optionalArg(args, flag);
  if (!value) throw new Error(`${command} requires ${flag} <value>.`);
  return value;
}


async function readContainedActionJson(projectRoot: string, inputPath: string): Promise<Record<string, unknown>> {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, inputPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Action input JSON must stay inside the project root.");
  }
  const parsed = JSON.parse(await fs.readFile(resolved, "utf8")) as unknown;
  if (!isCliRecord(parsed)) throw new Error("Action input must be a JSON object.");
  return parsed;
}


function isCliRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


export function preferredDetectedDatabaseEnv(names: string[], env: NodeJS.ProcessEnv): string | undefined {
  const available = names.filter((name) => envValue(env, name));
  const preference = ["DATABASE_URL", "SYNAPSOR_DATABASE_READ_URL", "POSTGRES_URL", "POSTGRESQL_URL", "MYSQL_URL", "DB_URL"];
  return preference.find((name) => available.includes(name)) ?? available.find((name) => !name.includes("WRITE"));
}
import { defaultProviderKeyEnv, defaultHostedModel, OPENROUTER_EGRESS } from "./hosted-provider-settings.js";

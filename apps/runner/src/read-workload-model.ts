import { readScopeReplacementContinuation, type ReadScopeReplacementOwner, currentStructuredReadEvidence, currentReadScopeContextDigest,
  type CurrentReadEvidenceRecords, type CurrentStructuredReadEvidence } from "./read-current-evidence.js";
import { READ_SCOPE_PROTOCOL, READ_SUBJECT_SCOPE_GUIDANCE, readScopeProposalSchema, resolveReadScopeProposal, assessReadScopeDraft, readScopeDelta,
  type ReadScopeBinding, type ReadScopeCatalog, type ReadScopeReference, type ReadScopeRecord } from "./read-structured-scope.js";
import type { ReadMeaningAttempt } from "./read-meaning-evidence.js";
import type { ReadScopeReasonBinding, ModelReadValueRequest, ModelReadClarificationRequest, ModelReadValueContextDecision, ModelReadClarificationDecision } from "./read-authoring-contract-types.js";
export type { ModelReadValueRequest, ModelReadClarificationRequest, ModelReadValueContextDecision, ModelReadClarificationDecision } from "./read-authoring-contract-types.js";
import { isAuthoringGenerationStop, assertAuthoringGenerationAdmission, authoringInterruptedProducerCorrections, reserveAuthoringProducerCorrection,
  withAuthoringProducerCorrection } from "./authoring-generation-recovery.js";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import { readWorkloadAssistanceCheckpoint, parseReadWorkloadAssistanceCheckpoint, ReadWorkloadAssistancePausedError,
  type ReadWorkloadAssistanceCheckpoint, type ReadWorkloadAssistanceQuestion, type ReadReviewedClarificationReplacement,
  type ReadScopeAssistanceRequest, type ReadScopeAnswerReference } from "./read-workload-assistance-checkpoint.js";
import { authoringRequestTimeoutSeconds } from "./authoring-request-timeout.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { operatorBusinessContext, operatorClarificationGate, presentOperatorClarification } from "./authoring-operator-presentation.js";
import {
  AskError,
  askToolSurfaceDigest,
  resolveAskProviderConfiguration,
  runAskProviderTurn,
  completedAuthoringQuestionSequence,
  type AskTurnResult,
  type AskProvider,
  type AskProviderDependencies,
  type AskToolDefinition,
  type AskToolGateway,
} from "./model-ask.js";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { validateReadWorkloadRelationshipPreparation, type PreparedReadWorkloadRelationship } from "./read-relationship-preparation.js";
import {
  READ_WORKLOAD_SET_VERSION,
  analyzeReadWorkloadSet,
  type ReadWorkloadAnalysis,
  type ReadWorkloadSet,
} from "./read-workload-assist.js";
import { RELATIVE_TIME_COMPARISONS, RELATIVE_TIME_WINDOWS } from "./relative-time-window.js";
import { runRequiredAuthoringToolCall } from "./authoring-tool-call.js";
import {
  modelAuthoringHistory,
  type ModelAuthoringConversation,
} from "./model-authoring-conversation.js";
import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";
import { ReadWorkloadDraftError, safeReadWorkloadDiagnostic, readWorkloadDiagnosticLines, type ReadWorkloadDiagnostic } from "./read-workload-diagnostics.js";
import { activePolicySource, policySourceHistory } from "./authoring-policy-source.js";

const SUBMIT_READ_WORKLOAD_TOOL = "runner.submit_read_workloads";
const MAX_READ_CLARIFICATIONS = 4;
const MAX_READ_RELATIONSHIP_REVIEWS = 3;
const OPAQUE_SELECTION_GUIDANCE = "An opaque selection reference (obj_...) is not a database field. For an activated Action subject, Runner issues it from a scoped rows result, using privately reviewed identity and version fields. Do not add obj_ or a raw primary key to select, manufacture references, or ask the operator which column supplies them. Map the requested business fields; Action verification and reference readiness are checked separately. This does not make a read-only resource actionable or grant any authority.";

function isReadProviderFailure(error: unknown): error is AskError {
  return error instanceof AskError && (error.code.startsWith("ASK_PROVIDER_")
    || error.code === "ASK_REQUIRED_TOOL_NOT_CALLED" || error.code === "ASK_TOOL_ARGUMENTS_INVALID");
}

/** Fresh protected host projection; may re-read native structural review. */
export type ModelReadScopeContext = { binding: ReadScopeBinding; references: readonly ReadScopeReference[]; catalog: ReadScopeCatalog;
  native?: Pick<CurrentStructuredReadEvidence, "questions" | "handoffs" | "generation" | "question_id" | "analysis"> };

export type ModelReadWorkloadResult = {
  workload: ReadWorkloadSet;
  analysis: ReadWorkloadAnalysis;
  /** Typed interpretation proposal only; native operator confirmation is separate. */
  read_scope?: ReadScopeRecord;
  read_scope_predecessor_id?: string;
  /** Transient host clock for exact acceptance revalidation; never model or saved authority. */
  analysis_clock?: number;
  provider: AskProvider;
  model: string;
  authority_granted: false;
  source_query_executed: false;
  explore_budget_consumed: false;
  source_database_changed: false;
  model_message?: string;
  diagnostics?: ReadWorkloadDiagnostic[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
};





/**
 * Optional semantic frontend: a provider maps operator-authored questions to
 * exact candidate plans. The returned plans still pass the deterministic
 * workload compiler and never activate authority.
 */
export type ModelReadWorkloadInput = {
  name: string;
  allowedQuestions: string[];
  /** Original operator wording, not a model-generated summary or answer. */
  operatorNamingContext?: string;
  forbiddenQuestions?: string[];
  provider: AskProvider;
  model: string;
  generatedBoundary: ExplorationBoundaryDraft;
  /** Own-record jobs: roots with reviewed or reviewable person scope. Not an authorization grant. */
  principalScopedRootResources?: readonly string[];
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  egressAcknowledged: boolean;
  valueRequestHandler?: (
    request: ModelReadValueRequest,
  ) => Promise<ModelReadValueContextDecision | undefined>;
  clarificationHandler?: (
    request: ModelReadClarificationRequest,
    context?: { previous: ModelReadClarificationRequest & { answer: string } },
  ) => Promise<ModelReadClarificationDecision | undefined>;
  /** Trusted host records only. The model receives current reference metadata,
   * never authority to create or confirm the operator's actual answer. */
  operatorQuestions?: () => readonly OperatorQuestion[];
  /** Existing native records only; the shared resolver derives current applicability. */
  currentEvidenceRecords?: () => CurrentReadEvidenceRecords;
  /** Main pins this from the native job version. Absence is accepted by the
   * TypeScript ingress only so old callers fail closed before provider access. */
  structuredScope?: {
    protocol: typeof READ_SCOPE_PROTOCOL;
    current: () => ModelReadScopeContext | Promise<ModelReadScopeContext>;
    answer?: (request: ReadScopeAssistanceRequest, completion: AuthoringQuestionCompletion | undefined) => Promise<ReadScopeAnswerReference | undefined>;
    resolveAnswer?: (reference: ReadScopeAnswerReference, request: ReadScopeAssistanceRequest) => ReadScopeReference | undefined;
    replacementAnswer?: (reviewQuestionId: string) => Promise<ReadScopeAnswerReference | undefined>;
    resolveReplacementAnswer?: (reference: ReadScopeAnswerReference, reviewQuestionId: string) => ReadScopeReference | undefined;
  };
  /** Local operator review, never a model decision. The proposed response is
   * checkpointed before this default-No review and is not yet current meaning. */
  clarificationReplacementHandler?: (input: {
    previous: ModelReadClarificationRequest & { answer: string };
    request: ModelReadClarificationRequest; answer: string;
  }) => Promise<boolean | undefined>;
  /** Host exact-path review and disabled save; never a model-supplied candidate. */
  relationshipReviewHandler?: (
    request: ModelReadClarificationRequest,
    currentBoundary: ExplorationBoundaryDraft,
  ) => Promise<PreparedReadWorkloadRelationship | undefined>;
  dependencies?: AskProviderDependencies;
  conversation?: ModelAuthoringConversation;
  /** The outer authoring session will narrate the combined validated draft. */
  deferNarration?: boolean;
  resumeCheckpoint?: ReadWorkloadAssistanceCheckpoint;
  /** Exact parsed native projection. Completed history is never an active dispatch. */
  postReviewReplacement?: ReadScopeReplacementOwner;
  /** Main commits this and the real completion sidecar with existing Source/
   * generation/resume CAS. The current boundary is needed after an exact link review. */
  onCheckpoint?: (checkpoint: ReadWorkloadAssistanceCheckpoint | undefined, currentBoundary: ExplorationBoundaryDraft,
    acceptedResult?: ModelReadWorkloadResult, completion?: AuthoringQuestionCompletion) => Promise<void>;
  signal?: AbortSignal;
};

export async function generateModelReadWorkload(input: ModelReadWorkloadInput): Promise<ModelReadWorkloadResult> {
  if (!input.structuredScope) throw new Error("READ_SCOPE_PROTOCOL_REQUIRED: This Read entry requires the pinned structured scope protocol; preserve the saved job without replay.");
  if (input.structuredScope.protocol !== READ_SCOPE_PROTOCOL) throw new Error("READ_SCOPE_PROTOCOL_UNSUPPORTED: No legacy scope fallback is available.");
  const name = boundedText(input.name, "workload name", 80);
  const allowedQuestions = boundedQuestions(input.allowedQuestions, "allowed questions", true);
  const forbiddenQuestions = boundedQuestions(input.forbiddenQuestions ?? [], "forbidden questions", false);
  const originalNamingSources = input.operatorNamingContext
    ? [boundedText(input.operatorNamingContext, "operator naming context", 4_000)] : allowedQuestions;
  const policySource = activePolicySource(input.conversation?.policySources);
  if (policySource) policySourceHistory(input.conversation?.policySources, input);
  // Preserve the producer's ordinary immutable input episode; new answers use
  // exact native clarified-target records until the accepted save.
  const meaningConversation = input.conversation ? structuredClone(input.conversation) : undefined;
  const namingSources = [...originalNamingSources,
    ...(input.conversation?.turns.filter(turn => turn.kind === "clarification").map(turn => turn.answer) ?? []), ...(policySource
    ? [policySource.text, ...(input.conversation?.policySources?.operator_messages ?? [])] : [])];
  const meaningContext = () => canonicalJsonDigest({ source: activePolicySource(input.conversation?.policySources) ?? null,
    messages: input.conversation?.policySources?.operator_messages ?? [],
    answers: input.conversation?.turns.filter(turn => turn.kind === "clarification") ?? [],
    original: input.operatorNamingContext ?? null, allowed: input.allowedQuestions, forbidden: input.forbiddenQuestions ?? [] });
  const expectedMeaningContext = meaningContext();
  const requestedUseDigest = canonicalJsonDigest({ allowedQuestions, forbiddenQuestions, originalNamingSources });
  let mappingBoundary = input.generatedBoundary;
  let expectedBoundaryDigest = explorationBoundaryCandidateDigest(mappingBoundary);
  let catalog = readWorkloadCatalog(mappingBoundary, input.principalScopedRootResources);
  const serializeCatalog = () => {
    const serialized = JSON.stringify(catalog);
    if (Buffer.byteLength(serialized) > 64 * 1024) {
      throw new Error("READ_WORKLOAD_CATALOG_TOO_LARGE: narrow the generated boundary or use exact-plan workload import instead.");
    }
    return serialized;
  };
  serializeCatalog();
  const inheritedHistory = input.resumeCheckpoint ?? input.postReviewReplacement?.read.assistance_history;
  const inheritedCheckpoint = inheritedHistory ? parseReadWorkloadAssistanceCheckpoint(inheritedHistory) : undefined;
  const inheritedScopeAnswers = inheritedCheckpoint?.state;
  const ownedAnswerIds = new Set([...(inheritedScopeAnswers?.scope_answers ?? []), ...(inheritedScopeAnswers?.scope_replacements ?? [])]
    .map(answer => answer.answer_reference.question_id));
  // A crash after the decided save precedes appending this answer to history.
  // Re-resolve its exact native owner before excluding that acknowledged delta.
  const decidedScope = inheritedCheckpoint?.stage === "decided" && inheritedCheckpoint.pending_question.kind === "scope"
    ? inheritedCheckpoint.pending_question : undefined;
  if (decidedScope?.decision) {
    const reference = decidedScope.decision.answer_reference;
    const actual = input.structuredScope.resolveAnswer?.(reference, decidedScope.request);
    if (!actual || actual.kind !== "answer" || actual.question_id !== reference.question_id
      || actual.question_revision !== reference.revision || actual.answer_id !== reference.answer_id)
      throw new Error("READ_SCOPE_ANSWER_STALE: The saved decision does not match the current native question.");
    ownedAnswerIds.add(reference.question_id);
  }
  let structuredScopeInput = input.structuredScope ? structuredClone(await input.structuredScope.current()) : undefined;
  if (input.structuredScope && input.structuredScope.protocol !== READ_SCOPE_PROTOCOL)
    throw new Error("READ_SCOPE_PROTOCOL_UNSUPPORTED: Preserve the native job; no legacy protocol fallback is available.");
  const nativeScope = structuredScopeInput?.native ? currentStructuredReadEvidence({ ...structuredScopeInput.native,
    expectedBinding: structuredScopeInput.binding, references: structuredScopeInput.references, catalog: structuredScopeInput.catalog }) : undefined;
  const replacementOwner = input.postReviewReplacement ? readScopeReplacementContinuation(input.postReviewReplacement,
    { expectedBinding: structuredScopeInput!.binding, references: structuredScopeInput!.references, catalog: structuredScopeInput!.catalog }) : undefined;
  if (replacementOwner && (structuredScopeInput?.native?.question_id !== replacementOwner.question.id
    || nativeScope?.question.digest !== replacementOwner.question.digest))
    throw new Error("READ_SCOPE_REPLACEMENT_STALE: The current host projection must include its exact owning declined review.");
  if (replacementOwner) for (const question of structuredScopeInput!.native!.questions) {
    if (question.read_scope?.mode === "replacement_answer" && question.read_scope.review_question_id === replacementOwner.question.id)
      ownedAnswerIds.add(question.id);
  }
  let structuredScopeDigest = currentReadScopeContextDigest(structuredScopeInput, ownedAnswerIds);
  const confirmedScope = nativeScope?.status === "confirmed" ? nativeScope.record : undefined;
  if (nativeScope && nativeScope.status !== "confirmed" && !replacementOwner)
    throw new Error("READ_SCOPE_NATIVE_PENDING: The exact native scope is stale, replaced or not confirmed. Review its current question before remapping.");
  const tools: AskToolDefinition[] = [readWorkloadToolDefinition(
    catalog.resources.map((resource) => resource.id),
    !!input.structuredScope,
    !!confirmedScope,
  )];
  const authorityDigest = askToolSurfaceDigest(tools);
  const defaultKeyEnv = input.provider === "openai_compatible" ? undefined : defaultProviderKeyEnv(input.provider);
  const configuration = resolveAskProviderConfiguration({
    provider: input.provider,
    model: input.model,
    ...(input.baseUrl ? { base_url: input.baseUrl } : {}),
    ...(input.apiKey
      ? { api_key: input.apiKey }
      : input.apiKeyEnv ?? defaultKeyEnv
        ? { api_key_env: input.apiKeyEnv ?? defaultKeyEnv }
        : {}),
    authority_digest: authorityDigest,
    egress_acknowledged: input.egressAcknowledged,
    request_timeout_seconds: authoringRequestTimeoutSeconds(),
    max_output_tokens: 4_000,
  }, input.env ?? process.env, new Date());

  let workload: ReadWorkloadSet | undefined;
  let analysis: ReadWorkloadAnalysis | undefined;
  let structuredReadScope: ReadScopeRecord | undefined;
  let structuredScopeRequest: ReadScopeAssistanceRequest | undefined;
  const scopeAnswers: NonNullable<ReadWorkloadAssistanceCheckpoint["state"]["scope_answers"]> = [];
  const scopeAnswerInventory = (): ReadScopeReference[] => scopeAnswers.map(answer => {
    const found = input.structuredScope?.resolveAnswer?.(answer.answer_reference, answer.request);
    if (!found || found.kind !== "answer" || found.question_id !== answer.answer_reference.question_id
      || found.question_revision !== answer.answer_reference.revision || found.answer_id !== answer.answer_reference.answer_id)
      throw new Error("READ_SCOPE_ANSWER_STALE: The exact native captured answer is unavailable or no longer current.");
    return found;
  });
  const scopeReplacements: NonNullable<ReadWorkloadAssistanceCheckpoint["state"]["scope_replacements"]> = [];
  const replacementInventory = (): ReadScopeReference[] => scopeReplacements.map(answer => {
    const actual = input.structuredScope?.resolveReplacementAnswer?.(answer.answer_reference, answer.review_question_id);
    if (!actual || actual.kind !== "answer" || actual.question_id !== answer.answer_reference.question_id
      || actual.question_revision !== answer.answer_reference.revision || actual.answer_id !== answer.answer_reference.answer_id)
      throw new Error("READ_SCOPE_ANSWER_STALE: The replacement testimony is not current native evidence.");
    return actual;
  });
  const scopeReferences = () => {
    const references = new Map<string, ReadScopeReference>();
    for (const ref of [...(structuredScopeInput?.references ?? []), ...scopeAnswerInventory(), ...replacementInventory()]) {
      const prior = references.get(ref.id);
      if (prior && canonicalJsonDigest(prior) !== canonicalJsonDigest(ref)) throw new Error("READ_SCOPE_ANSWER_STALE: Conflicting native testimony identity.");
      references.set(ref.id, ref);
    }
    return [...references.values()];
  };
  let analysisClock: number | undefined;
  let valueRequest: ModelReadValueRequest | undefined;
  let clarificationRequest: ModelReadClarificationRequest | undefined;
  let clarificationFromInvalidNaming = false;
  let mechanicalClarificationRequest: ModelReadClarificationRequest | undefined;
  let resolvedMechanicalRequest: ModelReadClarificationRequest | undefined;
  const clarifiedTargets: (ModelReadClarificationRequest & { answer: string })[] = [];
  const unresolvedAnswers: ReadMeaningAttempt[] = [];
  const reviewedReplacements: ReadReviewedClarificationReplacement[] = [];
  const retiredIndices = () => new Set(reviewedReplacements.map(review => review.previous_index));
  const activeClarifiedTargets = () => clarifiedTargets.filter((_answer, index) => !retiredIndices().has(index));
  const meaningBinding = () => canonicalJsonDigest({ meaning: expectedMeaningContext, boundary: expectedBoundaryDigest, catalog: catalog.digest });
  const readAnswerCount = () => clarifiedTargets.length + unresolvedAnswers.length + scopeAnswers.length + scopeReplacements.length;
  const clarificationAnswers: string[] = [];
  const clarificationKey = (request: ModelReadClarificationRequest) =>
    JSON.stringify([request.resource, request.field ?? "", request.category ?? "business_meaning"]);
  let approvedValueContext: Extract<ModelReadValueContextDecision, { state: "provided" }> | undefined;
  let opaqueGuessBlockers: string[] = [];
  let workloadValidationBlockers: string[] = [];
  const businessContext = () => operatorBusinessContext(catalog.resources);
  let wording = operatorClarificationGate({ stage: "read", context: businessContext() });
  const businessRequest = (request: ModelReadClarificationRequest): ModelReadClarificationRequest => ({ ...request,
    question: presentOperatorClarification(request.question, { stage: "read", context: businessContext(), target: request }) });
  let clarificationResolved = false;
  let mechanicalClarificationResolved = false;
  let relationshipReviews = 0;
  let valueRequestResolved = false;
  const valueContextContinuation = () => approvedValueContext ? [
    `The separately reviewed value-context step is already complete. The operator approved these exact values for ${approvedValueContext.resource}.${approvedValueContext.field}: ${JSON.stringify(approvedValueContext.values)}. Do not request values again.`,
    `Use plan.where on that exact field with only those values: ${JSON.stringify({ where: [{ field: approvedValueContext.field, op: approvedValueContext.values.length === 1 ? "eq" : "in", value: approvedValueContext.values.length === 1 ? approvedValueContext.values[0] : approvedValueContext.values }] })}. Never use a filters key.`,
  ] : valueRequestResolved ? ["The separately reviewed value-context step is already complete. Do not request values again."]
    : ["If exact observed values are still indispensable, use one value_request now; do not guess them."];
  let repeatedAssistanceRequest = false;
  let namingEvidenceCorrectionUsed = authoringInterruptedProducerCorrections().naming_evidence_correction_used;
  let lastSubmission: Record<string, unknown> | undefined;
  let namingCorrectionWorkload: ReturnType<typeof canonicalJsonDigest> | undefined;
  let callCount = 0;
  let lastDispatchQuestion: string | undefined;
  const relationshipReviewLimit = input.relationshipReviewHandler ? MAX_READ_RELATIONSHIP_REVIEWS : 0;
  const gateway: AskToolGateway = {
    mode: "authoring",
    listTools: () => tools,
    async callTool(nameCalled, args) {
      if (nameCalled !== SUBMIT_READ_WORKLOAD_TOOL || callCount >= MAX_READ_CLARIFICATIONS + relationshipReviewLimit + 4) {
        return {
          ok: false,
          value: {
            error_code: "READ_WORKLOAD_SUBMISSION_REFUSED",
            message: "Runner accepts one initial mapping, up to four business clarification answers, three exact host relationship reviews, one Runner-resolved scope redirect, one separately approved value-context request, and one corrected workload.",
            authority_granted: false,
            source_database_changed: false,
          },
          error_code: "READ_WORKLOAD_SUBMISSION_REFUSED",
        };
      }
      callCount += 1;
      if (lastDispatchQuestion) await saveDispatch(lastDispatchQuestion);
      // A new submission must never reuse a rejected earlier candidate.
      workload = undefined;
      analysis = undefined;
      structuredReadScope = undefined;
      structuredScopeRequest = undefined;
      lastSubmission = structuredClone(args);
      const assistanceBranch = Object.keys(args).length === 1
        && (Object.hasOwn(args, "value_request") || Object.hasOwn(args, "relationship_review_request"));
      if (input.structuredScope && !assistanceBranch && Object.keys(args).some(key => !["allowed", "forbidden", "read_scope"].includes(key))) {
        workloadValidationBlockers = ["READ_SCOPE_PROTOCOL_INVALID: This job requires the structured scope tool. Legacy meaning or clarification fields cannot select a fallback protocol."];
        return { ok: false, error_code: "READ_SCOPE_PROTOCOL_INVALID", value: { blockers: workloadValidationBlockers,
          authority_granted: false, source_query_executed: false, source_database_changed: false } };
      }
      if (structuredScopeInput && args.read_scope !== undefined) {
        try {
          const scope = resolveReadScopeProposal(args.read_scope, { expectedBinding: structuredScopeInput.binding,
            references: scopeReferences(), catalog: structuredScopeInput.catalog });
          const missing = scope.proposal.requirements.find(requirement => requirement.disposition === "unresolved");
          if (missing) {
            if (readAnswerCount() >= MAX_READ_CLARIFICATIONS) {
              repeatedAssistanceRequest = true;
              throw new Error("READ_SCOPE_ASSISTANCE_LIMIT: The existing four-question allowance is exhausted; preserve the unresolved scope.");
            }
            structuredScopeRequest = { scope, requirement_digest: scope.requirement_bindings.find(item => item.id === missing.id)!.digest,
              question: "Please clarify the missing detail for this Read requirement." };
            return { ok: true, value: { status: "scope_clarification_required", unresolved: missing.unresolved,
              authority_granted: false, source_query_executed: false, source_database_changed: false } };
          }
        } catch (error) {
          workloadValidationBlockers = [error instanceof Error ? error.message : String(error)];
          return { ok: false, error_code: "READ_SCOPE_INVALID", value: { blockers: workloadValidationBlockers,
            authority_granted: false, source_query_executed: false, source_database_changed: false } };
        }
      }
      if (Object.hasOwn(args, "relationship_review_request")) {
        if (!input.relationshipReviewHandler || relationshipReviews >= MAX_READ_RELATIONSHIP_REVIEWS
          || mechanicalClarificationRequest || valueRequest || clarificationRequest)
          return { ok: false, error_code: "READ_RELATIONSHIP_REVIEW_LIMIT", value: { authority_granted: false,
            source_query_executed: false, source_database_changed: false } };
        try {
          const request = args.relationship_review_request;
          if (!isRecord(request) || Object.keys(request).some(key => !["resource", "reason", "question"].includes(key)))
            throw new Error("The relationship review needs one exact root, reason and question.");
          mechanicalClarificationRequest = parseReadClarificationRequest({ ...request, category: "relationship_support" }, catalog);
          return { ok: true, value: { status: "relationship_review_requested", resource: mechanicalClarificationRequest.resource,
            authority_granted: false, source_query_executed: false, source_database_changed: false } };
        } catch (error) {
          return { ok: false, error_code: "READ_RELATIONSHIP_REVIEW_INVALID", value: { message: error instanceof Error ? error.message : String(error),
            authority_granted: false, source_query_executed: false, source_database_changed: false } };
        }
      }
      if (isRecord(args.value_request)) {
        if (valueRequestResolved || valueRequest || clarificationRequest) {
          repeatedAssistanceRequest = true;
          return {
            ok: false,
            value: {
              error_code: "READ_WORKLOAD_VALUE_REQUEST_REFUSED",
              message: "Runner permits one exact value-context request per bounded Read Boundary mapping.",
              authority_granted: false,
              source_query_executed: false,
              source_database_changed: false,
            },
            error_code: "READ_WORKLOAD_VALUE_REQUEST_REFUSED",
          };
        }
        try {
          valueRequest = parseReadValueRequest(args.value_request, catalog);
          return {
            ok: true,
            value: {
              status: "value_context_requested",
              resource: valueRequest.resource,
              field: valueRequest.field,
              source_query_executed: false,
              authority_granted: false,
              source_database_changed: false,
            },
          };
        } catch (error) {
          return {
            ok: false,
            value: {
              error_code: "READ_WORKLOAD_VALUE_REQUEST_REFUSED",
              message: error instanceof Error ? error.message : String(error),
              authority_granted: false,
              source_query_executed: false,
              source_database_changed: false,
            },
            error_code: "READ_WORKLOAD_VALUE_REQUEST_REFUSED",
          };
        }
      }
      const misplacedRootFields = misplacedReadRootFieldIssues(args);
      const candidateWorkload: ReadWorkloadSet = {
        schema_version: READ_WORKLOAD_SET_VERSION,
        name,
        allowed: Array.isArray(args.allowed) ? args.allowed as ReadWorkloadSet["allowed"] : [],
        forbidden: Array.isArray(args.forbidden) ? args.forbidden as ReadWorkloadSet["forbidden"] : [],
        source: {
          kind: "model",
          provider: input.provider,
          model: input.model,
        },
      };
      const candidateAnalysisClock = Date.now();
      let candidateAnalysis: ReadWorkloadAnalysis;
      try {
        candidateAnalysis = analyzeReadWorkloadSet({
          workload: candidateWorkload,
          generatedBoundary: mappingBoundary,
          now: candidateAnalysisClock,
        });
        if (misplacedRootFields.length) {
          candidateAnalysis.status = "blocked";
          candidateAnalysis.blockers = [...misplacedRootFields, ...candidateAnalysis.blockers];
        }
        const relatedOnlyRoots = candidateWorkload.allowed.flatMap(entry =>
          catalog.resources.some(resource => resource.id === entry.plan.resource && resource.relationship_only)
            ? [entry.plan.resource] : []);
        if (relatedOnlyRoots.length) {
          throw new Error(`READ_WORKLOAD_OWN_RECORD_ROOT_REQUIRED: ${[...new Set(relatedOnlyRoots)].join(", ")} cannot be independent reads for this job. Include requested related information through listed rows.related paths from an owned-record root. Keep private Action verification separate. Preserve every requested business read; if no listed path covers it, ask about the missing business access instead of inventing ownership or dropping it.`);
        }
      } catch (error) {
        workload = undefined;
        analysis = undefined;
        workloadValidationBlockers = [error instanceof Error ? error.message : String(error)];
        return {
          ok: false,
          value: {
            error_code: "READ_WORKLOAD_BLOCKED",
            blockers: workloadValidationBlockers,
            authority_granted: false,
            source_query_executed: false,
            source_database_changed: false,
          },
          error_code: "READ_WORKLOAD_BLOCKED",
        };
      }
      const recordCandidateAnalysis = () => {
        workload = candidateWorkload;
        analysis = candidateAnalysis;
        analysisClock = candidateAnalysisClock;
        workloadValidationBlockers = [];
      return {
        ok: candidateAnalysis.status === "ready",
        value: {
          status: candidateAnalysis.status,
          coverage: candidateAnalysis.coverage,
          blockers: candidateAnalysis.blockers,
          authority_granted: false,
          source_query_executed: false,
          explore_budget_consumed: false,
          source_database_changed: false,
        },
        ...(candidateAnalysis.status === "blocked" ? { error_code: "READ_WORKLOAD_BLOCKED" } : {}),
      };
      };
      // Structural blockers and invalid independent roots cannot be repaired by
      // a business answer. Keep native diagnostics/correction; a ready analysis
      // still passes every scope, meaning and approved-value check below.
      if (candidateAnalysis.status === "blocked") return recordCandidateAnalysis();
      // Approved literal context is a finite constraint on every admitted
      // mapping, including typed correction and cold continuation.
      const approvedValueIssue = approvedValueContext
        ? approvedValueContextIssue(args, approvedValueContext)
        : undefined;
      if (approvedValueIssue) {
        workloadValidationBlockers = [approvedValueIssue];
        return {
          ok: false,
          value: {
            error_code: "READ_WORKLOAD_APPROVED_VALUE_UNUSED",
            message: approvedValueIssue,
            authority_granted: false,
            source_query_executed: false,
            source_database_changed: false,
          },
          error_code: "READ_WORKLOAD_APPROVED_VALUE_UNUSED",
        };
      }
      if (structuredScopeInput) {
        // All structured submissions, including bounded corrections, pass the
        // same finite checker. Neither labels nor English clauses select scope.
        try {
          const record = resolveReadScopeProposal(args.read_scope ?? confirmedScope?.proposal, { expectedBinding: structuredScopeInput.binding,
            references: scopeReferences(), catalog: structuredScopeInput.catalog, analysis: candidateAnalysis });
          if (confirmedScope) {
            const delta = readScopeDelta(confirmedScope, record);
            if (delta.removed.length || delta.added.length) {
              workloadValidationBlockers = [`READ_SCOPE_REVIEWED_DELTA_REQUIRED: ${JSON.stringify(delta)}`];
              return { ok: false, error_code: "READ_SCOPE_REVIEWED_DELTA_REQUIRED", value: { delta,
                authority_granted: false, source_query_executed: false, source_database_changed: false } };
            }
          }
          const assessment = assessReadScopeDraft(record, candidateAnalysis);
          if (assessment.status !== "compatible") {
            workloadValidationBlockers = [`READ_SCOPE_${assessment.status === "pending" ? "PENDING" : "DELTA_REQUIRED"}: ${JSON.stringify(assessment)}`];
            return { ok: false, error_code: assessment.status === "pending" ? "READ_SCOPE_PENDING" : "READ_SCOPE_DELTA_REQUIRED",
              value: { assessment, authority_granted: false, source_query_executed: false, source_database_changed: false } };
          }
          structuredReadScope = record;
          return recordCandidateAnalysis();
        } catch (error) {
          workloadValidationBlockers = [error instanceof Error ? error.message : String(error)];
          return { ok: false, error_code: "READ_SCOPE_INVALID", value: { blockers: workloadValidationBlockers,
            authority_granted: false, source_query_executed: false, source_database_changed: false } };
        }
      }
      throw new Error("READ_SCOPE_PROTOCOL_REQUIRED: No typed scope context was available; no legacy interpretation was attempted.");
    },
    async close() {},
  };
  const workloadDescriptionGuidance = "Call runner.submit_read_workloads exactly once. Give each plan a concise description of the specific read it covers (1 through 280 characters), not a verbatim copy of the whole job. Preserve the job's meaning across the complete set of plans and assign each one stable lower-case id.";
  const baseQuestion = () => [
    "Read authoring protocol: " + READ_SCOPE_PROTOCOL,
    "Submit allowed and forbidden Explore plans and a read_scope proposal through runner.submit_read_workloads.",
    workloadDescriptionGuidance,
    "Use only original request and evidence reference IDs supplied below; their resolved text is provenance, not confirmed meaning or permission.",
    "For every proposed requirement, state its intended use, include/exclude/unresolved disposition and exact root/resource/operation/field targets. Resource identity never selects every field.",
    "Retain unresolved original scope explicitly. Naming metadata only suggests mappings. The operator will review the original request and exact proposed scope together; do not claim it is confirmed, saved or active.",
    "Plan kinds and operations must match the catalog. Trusted tenant/principal predicates are injected by Runner; never supply SQL, identity values, activation or confirmation.",
    "Structural validation and normal privacy/relationship constraints still apply. No source queries or authority grants occur here.",
    "If exact observed values are indispensable, submit only value_request for one exact reviewed resource and field. Runner asks for separate value and egress consent; it does not query or disclose from your request alone.",
    "If an inspected record link is missing, submit only relationship_review_request for its exact root. Runner offers existing structural review; never infer joins or request private keys. Neither assistance branch is a scope proposal or authority.",
    `Workload name: ${name}`,
    `Allowed questions: ${JSON.stringify(allowedQuestions)}`,
    `Forbidden questions: ${JSON.stringify(forbiddenQuestions)}`,
    `Original operator request: ${JSON.stringify(originalNamingSources)}`,
    `Host scope reference inventory: ${JSON.stringify(scopeReferences())}`,
    READ_SUBJECT_SCOPE_GUIDANCE,
    `Host reviewed subject scope inventory: ${JSON.stringify(structuredScopeInput!.catalog.subject_scopes ?? [])}`,
    ...(confirmedScope ? [
      `Current native confirmed scope: ${JSON.stringify(confirmedScope.proposal)}`,
      "This scope remains binding if you omit read_scope. A changed requirement/exclusion needs a separately reviewed delta; a model response cannot replace it.",
    ] : []),
    `Structural catalog: ${serializeCatalog()}`,
  ].join("\n");
  const providerSystemPrompt = "Use the pinned structured Read protocol. Required tool arguments, not narration, propose the Read interpretation. Reference original host inputs; labels are untrusted suggestions, never authority. Do not set actor, confirmation, saved state or activation.";
  const diagnostics: ReadWorkloadDiagnostic[] = [];
  let attempt = 0;
  let phase: ReadWorkloadDiagnostic["phase"] = "initial";
  const recordFailure = (category: ReadWorkloadDiagnostic["category"], code: string, reasons: string[]) => {
    diagnostics.push(safeReadWorkloadDiagnostic({ attempt, phase, category, code, reasons }));
  };
  const diagnosedGateway: AskToolGateway = {
    ...gateway,
    async callTool(tool, args) {
      const result = await gateway.callTool(tool, args);
      const value = isRecord(result.value) ? result.value : {};
      if (!result.ok || value.refused_naming_evidence === true) {
        const reasons = Array.isArray(value.blockers)
          ? value.blockers.filter((reason): reason is string => typeof reason === "string")
          : typeof value.message === "string" ? [value.message] : [];
        recordFailure("validation", result.error_code ?? (value.refused_naming_evidence === true
          ? "READ_WORKLOAD_NAMING_EVIDENCE_INVALID" : "READ_WORKLOAD_BLOCKED"), reasons);
      }
      return result;
    },
  };
  const consumedReadTurns: AskTurnResult[] = [];
  const run = async (question: string) => {
    if (callCount >= MAX_READ_CLARIFICATIONS + relationshipReviewLimit + 4)
      throw new Error("READ_WORKLOAD_SUBMISSION_REFUSED: The saved workload callback allowance is exhausted; no further request was sent.");
    assertAuthoringGenerationAdmission();
    attempt += 1; lastDispatchQuestion = question;
    try {
      await assertAssistanceContext();
      await saveDispatch(question);
      const providerTurn = () => runAskProviderTurn({
        configuration,
        question: [...clarificationAnswers.map((line, index) => retiredIndices().has(index)
          ? `Historical response ${index}, superseded by an explicit operator review; not current meaning: ${line}` : line), question,
].join("\n"),
    history: modelAuthoringHistory(input.conversation, input),
        gateway: diagnosedGateway,
        tools,
        signal: input.signal ?? new AbortController().signal,
        dependencies: input.dependencies,
        authorityDigest,
        providerSystemPrompt,
        skipRunnerQuestionContext: true,
        requiredInitialToolName: SUBMIT_READ_WORKLOAD_TOOL,
        completeAfterRequiredTool: true,
        authorityGuard: async () => {
          scopeAnswerInventory(); replacementInventory();
          const current = explorationBoundaryCandidateDigest(mappingBoundary);
          const currentCatalog = readWorkloadCatalog(mappingBoundary, input.principalScopedRootResources).digest;
          return current === expectedBoundaryDigest && currentCatalog === catalog.digest
            && (!input.structuredScope || currentReadScopeContextDigest(await input.structuredScope.current(), ownedAnswerIds) === structuredScopeDigest)
            ? authorityDigest : canonicalJsonDigest({ stale: current, catalog: currentCatalog });
        },
      });
      const result = namingEvidenceCorrectionUsed ? await withAuthoringProducerCorrection("read_naming",providerTurn)
        : correctionUsed ? await withAuthoringProducerCorrection("semantic",providerTurn) : await providerTurn();
      consumedReadTurns.push(result);
      return result;
    } catch (error) {
      if (isReadProviderFailure(error) || isAuthoringGenerationStop(error)) {
        recordFailure(error.code === "ASK_REQUIRED_TOOL_NOT_CALLED" ? "required_tool"
          : ["ASK_PROVIDER_RESPONSE_INVALID", "ASK_TOOL_ARGUMENTS_INVALID"].includes(error.code)
            ? "provider_response" : "provider_request",
          error.code, [error.message]);
      }
      throw error;
    }
  };
  const rethrowDiagnostic = (error: unknown): never => {
    if (isAuthoringGenerationStop(error)) {
      const safe = diagnostics.slice(0, 6).map(safeReadWorkloadDiagnostic);
      // Keep the original validation history without converting a transport
      // stop into ReadWorkloadDraftError (which offers another model attempt).
      const stopped = new AskError(error.code, [error.message, ...readWorkloadDiagnosticLines(safe)].join("\n"), error.httpStatus);
      Object.defineProperty(stopped, "diagnostics", { value: safe });
      throw stopped;
    }
    if (isReadProviderFailure(error) && diagnostics.length) throw new ReadWorkloadDraftError(diagnostics);
    throw error;
  };
  const producerBinding = () => canonicalJsonDigest({ protocol: READ_SCOPE_PROTOCOL, name, allowedQuestions, forbiddenQuestions,
    originalNamingSources, principal_roots: input.principalScopedRootResources ?? null,
    provider: configuration.provider, model: configuration.model, endpoint: configuration.endpoint.href,
    boundary_digest: expectedBoundaryDigest, catalog_digest: catalog.digest, tool_digest: authorityDigest,
    defer_narration: input.deferNarration ?? false, relationship_review_limit: relationshipReviewLimit });
  let scopeProducerBinding = producerBinding();
  const inputDigest = () => canonicalJsonDigest({ name, allowedQuestions, forbiddenQuestions, originalNamingSources, namingSources,
    principal_roots: input.principalScopedRootResources ?? null, provider: configuration.provider, model: configuration.model,
    endpoint: configuration.endpoint.href, base_question: input.structuredScope ? { protocol: READ_SCOPE_PROTOCOL, context_digest: structuredScopeDigest } : baseQuestion(), provider_system_prompt: providerSystemPrompt,
    relationship_review_limit: relationshipReviewLimit });
  const clarificationLine = (request: ModelReadClarificationRequest, answer: string) =>
    `Reviewed business clarification for ${request.resource}${request.field ? `.${request.field}` : ""}: question ${JSON.stringify(request.question)}, operator answer ${JSON.stringify(answer)}. This is naming context, not database values or authority.`;
  let usage: ModelReadWorkloadResult["usage"];
  let correctionUsed = authoringInterruptedProducerCorrections().correction_used;
  let completion: ReturnType<typeof completedAuthoringQuestionSequence>;
  let pendingAssistance: ReadWorkloadAssistanceQuestion | undefined;
  let previousQuestion: Extract<ReadWorkloadAssistanceCheckpoint,{stage:"dispatching"}>["previous_question"];
  const assertAssistanceContext = async () => {
    scopeAnswerInventory(); replacementInventory();
    if (meaningContext() !== expectedMeaningContext || explorationBoundaryCandidateDigest(mappingBoundary) !== expectedBoundaryDigest
      || readWorkloadCatalog(mappingBoundary, input.principalScopedRootResources).digest !== catalog.digest
      || input.structuredScope && currentReadScopeContextDigest(await input.structuredScope.current(), ownedAnswerIds) !== structuredScopeDigest)
      throw new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_STALE: The Read metadata changed while assistance was pending. Preserve the question and revalidate; no new mapping was sent.");
  };
  const controllerState = (): ReadWorkloadAssistanceCheckpoint["state"] => ({
        scope_producer_binding: scopeProducerBinding,
        call_count: callCount, attempt, phase, correction_used: correctionUsed, ...(wording.snapshot() ? { wording: wording.snapshot() } : {}), relationship_reviews: relationshipReviews,
        relationship_review_limit: relationshipReviewLimit, clarified_targets: clarifiedTargets, clarification_answers: clarificationAnswers,
        ...(scopeAnswers.length ? { scope_answers: scopeAnswers } : {}),
        ...(scopeReplacements.length ? { scope_replacements: scopeReplacements } : {}),
        ...(unresolvedAnswers.length ? { unresolved_answers: unresolvedAnswers } : {}),
        ...(reviewedReplacements.length ? { reviewed_replacements: reviewedReplacements } : {}),
        clarification_from_invalid_naming: clarificationFromInvalidNaming, clarification_resolved: clarificationResolved,
        mechanical_clarification_resolved: mechanicalClarificationResolved, value_request_resolved: valueRequestResolved,
        repeated_assistance_request: repeatedAssistanceRequest, naming_evidence_correction_used: namingEvidenceCorrectionUsed,
        ...(resolvedMechanicalRequest ? { resolved_mechanical_request: resolvedMechanicalRequest } : {}),
        ...(namingCorrectionWorkload ? { naming_correction_workload: namingCorrectionWorkload } : {}),
        ...(approvedValueContext ? { approved_value_context: approvedValueContext } : {}),
        diagnostics: diagnostics.slice(0, 6).map(safeReadWorkloadDiagnostic), ...(usage ? { usage } : {}),
      });
  const saveDispatch = async (question: string) => {
    if (!input.onCheckpoint) return;
    await assertAssistanceContext();
    await input.onCheckpoint(readWorkloadAssistanceCheckpoint({ input_digest: inputDigest(), boundary_digest: expectedBoundaryDigest,
      catalog_digest: catalog.digest, tool_digest: authorityDigest, stage: "dispatching", dispatch_question: question,
      ...(previousQuestion ? { previous_question: structuredClone(previousQuestion) } : {}), state: controllerState() }), structuredClone(mappingBoundary));
  };
  const saveAssistance = async (question: ReadWorkloadAssistanceQuestion, stage: "waiting" | "decided") => {
    pendingAssistance = structuredClone(question); previousQuestion = { stage, pending_question: structuredClone(question) };
    if (!input.onCheckpoint) return;
    await assertAssistanceContext();
    await input.onCheckpoint(readWorkloadAssistanceCheckpoint({ input_digest: inputDigest(), boundary_digest: expectedBoundaryDigest,
      catalog_digest: catalog.digest, tool_digest: authorityDigest, stage, pending_question: question, state: controllerState() }), structuredClone(mappingBoundary));
  };
  if (inheritedHistory) {
    const saved = parseReadWorkloadAssistanceCheckpoint(inheritedHistory);
    if (replacementOwner && saved.state.scope_producer_binding !== scopeProducerBinding)
      throw new Error("READ_SCOPE_REPLACEMENT_PRODUCER_CHANGED: The original task, model, destination or mapping configuration is missing or changed. Preserve the old proposal; no correction was solicited or sent.");
    // The pin is an ingress contract, not permission to reinterpret an older
    // question/history shape under the new tool. Keep that history for inspection.
    const retainedQuestion = saved.stage === "dispatching" ? saved.previous_question?.pending_question : saved.pending_question;
    if (retainedQuestion && !["scope", "value", "relationship"].includes(retainedQuestion.kind)
      || saved.state.clarified_targets.length || saved.state.clarification_answers.length
      || saved.state.unresolved_answers?.length || saved.state.reviewed_replacements?.length
      || saved.state.resolved_mechanical_request && saved.state.resolved_mechanical_request.category !== "relationship_support"
      || saved.state.naming_correction_workload
      || saved.state.clarification_from_invalid_naming || saved.state.clarification_resolved
      || saved.state.mechanical_clarification_resolved && !saved.state.relationship_reviews
      || saved.state.naming_evidence_correction_used)
      throw new Error("READ_SCOPE_CHECKPOINT_UNSUPPORTED: The retained assistance shape belongs to a retired protocol. Preserve its history; no legacy handler or replay was started.");
    if (!saved.state.scope_producer_binding
      || (!replacementOwner || input.resumeCheckpoint) && (saved.input_digest !== inputDigest() || saved.tool_digest !== authorityDigest)
      || saved.boundary_digest !== expectedBoundaryDigest || saved.catalog_digest !== catalog.digest || saved.state.relationship_review_limit !== relationshipReviewLimit)
      throw new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_STALE: The original mapping input, boundary, catalog or provider changed. Preserve the pending question and revalidate; no replacement was sent.");
    const canonicalRequest = (request: ModelReadClarificationRequest) => {
      const parsed = parseReadClarificationRequest(request as unknown as Record<string, unknown>, catalog, true);
      if (canonicalJsonDigest(parsed) !== canonicalJsonDigest(request)) throw new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_INVALID: The retained request is not canonical for this catalog.");
      if (parsed.reason_binding)
        throw new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_STALE: The retired English scope question cannot enter typed mapping. Preserve its history without replay.");
      return parsed;
    };
    const s = saved.state, q = saved.pending_question;
    if (s.scope_answers?.length && !input.structuredScope) throw new Error("READ_SCOPE_PROTOCOL_REQUIRED: A structured checkpoint cannot enter legacy mapping.");
    scopeAnswers.push(...(s.scope_answers ?? []));
    scopeReplacements.push(...(s.scope_replacements ?? []));
    scopeAnswerInventory(); replacementInventory();
    wording = operatorClarificationGate({ stage: "read", context: businessContext(), ...(s.wording ? { resumeState: s.wording } : {}) });
    previousQuestion = saved.stage === "dispatching" ? saved.previous_question : { stage: saved.stage, pending_question: structuredClone(saved.pending_question) };
    if (saved.stage !== "dispatching" && (!s.call_count || !s.attempt) || s.call_count > MAX_READ_CLARIFICATIONS + relationshipReviewLimit + 4
      || q?.kind === "value" && s.value_request_resolved
      || q?.kind === "relationship" && (q.request.category !== "relationship_support" || !s.relationship_reviews
        || !s.mechanical_clarification_resolved || !input.relationshipReviewHandler))
      throw new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_INVALID: The retained request violates the existing assistance limits or flags.");
    if (q) {
    if (q.kind === "scope") {
      if (!input.structuredScope || canonicalJsonDigest(q.request.scope.binding) !== canonicalJsonDigest(structuredScopeInput!.binding))
        throw new Error("READ_SCOPE_QUESTION_STALE: The pending typed scope does not match the pinned job context.");
      structuredScopeRequest = q.request;
    } else if (q.kind === "value") {
      const parsed = parseReadValueRequest(q.request as unknown as Record<string, unknown>, catalog);
      if (canonicalJsonDigest(parsed) !== canonicalJsonDigest(q.request)) throw new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_INVALID: The retained value request is not canonical.");
      if (q.decision && canonicalJsonDigest(validateReadValueContextDecision(q.decision, q.request)) !== canonicalJsonDigest(q.decision))
        throw new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_INVALID: The retained value decision is not canonical.");
      valueRequest = parsed;
    } else {
      canonicalRequest(q.request);
      mechanicalClarificationRequest = q.request;
    }
    }
    if (saved.stage === "dispatching" && saved.previous_question) {
      const previous = saved.previous_question.pending_question;
      if (previous.kind === "scope") {
        if (!input.structuredScope || canonicalJsonDigest(previous.request.scope.binding) !== canonicalJsonDigest(structuredScopeInput!.binding))
          throw new Error("READ_SCOPE_QUESTION_STALE: The retained typed scope no longer matches this job.");
      } else if (previous.kind === "value") {
        const request = parseReadValueRequest(previous.request as unknown as Record<string, unknown>, catalog);
        if (canonicalJsonDigest(request) !== canonicalJsonDigest(previous.request)
          || previous.decision && canonicalJsonDigest(validateReadValueContextDecision(previous.decision, request)) !== canonicalJsonDigest(previous.decision))
          throw new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_INVALID: Retained historical value target or decision changed.");
      } else {
        canonicalRequest(previous.request);
        if (previous.kind === "clarification" && previous.decision
          && canonicalJsonDigest(validateReadClarificationDecision(previous.decision)) !== canonicalJsonDigest(previous.decision))
          throw new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_INVALID: Retained historical clarification decision changed.");
      }
    }
    if (s.resolved_mechanical_request) canonicalRequest(s.resolved_mechanical_request);
    if (s.approved_value_context) {
      const c = s.approved_value_context;
      const request = parseReadValueRequest({ resource: c.resource, field: c.field, reason: "Retained separately approved context", question: "Retained separately approved context" }, catalog);
      if (canonicalJsonDigest(validateReadValueContextDecision(c, request)) !== canonicalJsonDigest(c)) throw new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_INVALID: Retained approved values changed.");
    }
    callCount = s.call_count; attempt = s.attempt; phase = s.phase; correctionUsed ||= s.correction_used; relationshipReviews = s.relationship_reviews;
    clarifiedTargets.push(...s.clarified_targets); clarificationAnswers.push(...s.clarification_answers);
    unresolvedAnswers.push(...(s.unresolved_answers ?? []));
    reviewedReplacements.push(...(s.reviewed_replacements ?? []));
    clarificationFromInvalidNaming = s.clarification_from_invalid_naming; clarificationResolved = s.clarification_resolved;
    mechanicalClarificationResolved = s.mechanical_clarification_resolved; valueRequestResolved = s.value_request_resolved;
    repeatedAssistanceRequest = s.repeated_assistance_request; namingEvidenceCorrectionUsed ||= s.naming_evidence_correction_used;
    resolvedMechanicalRequest = s.resolved_mechanical_request; namingCorrectionWorkload = s.naming_correction_workload;
    approvedValueContext = s.approved_value_context; diagnostics.push(...s.diagnostics); usage = s.usage;
    pendingAssistance = q; completion = q?.completion;
    if (saved.stage === "dispatching" && (!replacementOwner || input.resumeCheckpoint)) {
      const continued = await (correctionUsed ? run(saved.dispatch_question).then(result => ({ result, correction_used: false }))
        : runRequiredAuthoringToolCall({ run, question: saved.dispatch_question, toolName: SUBMIT_READ_WORKLOAD_TOOL,
          onCorrection: () => { phase = "correction"; correctionUsed = true; } })).catch(rethrowDiagnostic);
      correctionUsed ||= continued.correction_used;
      usage = mergeUsage(usage, continued.result.usage); completion = completedAuthoringQuestionSequence(consumedReadTurns);
      namingCorrectionWorkload = undefined;
    }
  } else {
    const initial = await runRequiredAuthoringToolCall({ run, question: baseQuestion(), toolName: SUBMIT_READ_WORKLOAD_TOOL,
      onCorrection: () => { phase = "correction"; correctionUsed = true; } }).catch(rethrowDiagnostic);
    usage = initial.result.usage; correctionUsed ||= initial.correction_used; completion = completedAuthoringQuestionSequence(consumedReadTurns);
  }
  const remap = async (question: string, nextPhase: ReadWorkloadDiagnostic["phase"] = "follow-up"): Promise<void> => {
    phase = nextPhase;
    if (nextPhase !== "correction") wording = operatorClarificationGate({ stage: "read", context: businessContext() });
    const result = await (correctionUsed
      ? run(question).then((result) => ({ result, correction_used: false }))
      : runRequiredAuthoringToolCall({
          run,
          question,
          toolName: SUBMIT_READ_WORKLOAD_TOOL,
          onCorrection: () => { phase = "correction"; correctionUsed = true; },
        })).catch(rethrowDiagnostic);
    usage = mergeUsage(usage, result.result.usage);
    correctionUsed = correctionUsed || result.correction_used;
    completion = completedAuthoringQuestionSequence(consumedReadTurns);
    pendingAssistance = undefined;
  };
  if (replacementOwner && !input.resumeCheckpoint) {
    if (readAnswerCount() >= MAX_READ_CLARIFICATIONS || callCount >= MAX_READ_CLARIFICATIONS + relationshipReviewLimit + 4)
      throw new Error("READ_SCOPE_ASSISTANCE_LIMIT: The existing Read allowance is exhausted; no replacement answer or request was solicited.");
    const reference = await input.structuredScope?.replacementAnswer?.(replacementOwner.question.id);
    if (!reference) throw new ReadWorkloadAssistancePausedError("The operator correction is still pending. No mapping or permission was inferred.");
    if (scopeReplacements.some(answer => canonicalJsonDigest(answer.answer_reference) === canonicalJsonDigest(reference)))
      throw new Error("READ_SCOPE_ASSISTANCE_LIMIT: This correction was already dispatched; use the saved continuation.");
    scopeReplacements.push({ review_question_id: replacementOwner.question.id, answer_reference: reference });
    ownedAnswerIds.add(reference.question_id); replacementInventory();
    await remap(["The operator declined the prior grouped Read proposal and supplied an exact raw correction.",
      `Prior declined proposal (not authority): ${JSON.stringify(replacementOwner.question.read_scope!.record.proposal)}`,
      "Interpret the correction only from its current native answer reference. Preserve unchanged requirements and exclusions; show any changed scope explicitly. The next proposal needs separate operator confirmation.", baseQuestion()].join("\n"));
  }
  const resolveRequestedAssistance = async () => {
    while (!workload && (structuredScopeRequest || mechanicalClarificationRequest || clarificationRequest || valueRequest)) {
      if (structuredScopeRequest) {
        const request = structuredScopeRequest;
        const retained = pendingAssistance?.kind === "scope" && pendingAssistance.request.scope.digest === request.scope.digest
          && pendingAssistance.request.requirement_digest === request.requirement_digest ? pendingAssistance : undefined;
        if (!retained) await saveAssistance({ kind: "scope", request, question: request.question, ...(completion ? { completion } : {}) }, "waiting");
        if (input.signal?.aborted) throw new ReadWorkloadAssistancePausedError();
        const reference = retained?.decision?.answer_reference ?? await input.structuredScope?.answer?.(request, completion);
        if (!reference) throw new ReadWorkloadAssistancePausedError("The typed scope requirement is still pending; no answer, mapping or confirmation was inferred.");
        const actual = input.structuredScope?.resolveAnswer?.(reference, request);
        if (!actual || actual.kind !== "answer" || actual.question_id !== reference.question_id
          || actual.question_revision !== reference.revision || actual.answer_id !== reference.answer_id)
          throw new Error("READ_SCOPE_ANSWER_STALE: The captured answer does not match the current native question.");
        // Only this exact native answer was just acknowledged by the owner.
        // Exclude its bookkeeping delta, not other questions or Source changes.
        ownedAnswerIds.add(reference.question_id);
        if (!retained?.decision) await saveAssistance({ kind: "scope", request, question: request.question,
          ...(completion ? { completion } : {}), decision: { state: "answered", answer_reference: reference } }, "decided");
        if (readAnswerCount() >= MAX_READ_CLARIFICATIONS || scopeAnswers.some(answer => canonicalJsonDigest(answer.answer_reference) === canonicalJsonDigest(reference)))
          throw new Error("READ_SCOPE_ASSISTANCE_LIMIT: The captured answer is repeated or the existing assistance allowance is exhausted.");
        scopeAnswers.push({ request, answer_reference: reference });
        structuredScopeRequest = undefined;
        await remap(["Interpret the captured answer reference in the host inventory. It is raw operator testimony, not confirmed scope.",
          "Retain earlier requirements and exclusions. If the answer leaves missing detail, return that requirement unresolved; do not guess.",
          ...valueContextContinuation(), baseQuestion()].join("\n"));
        continue;
      }
      if (mechanicalClarificationRequest) {
        const request = mechanicalClarificationRequest;
        mechanicalClarificationRequest = undefined;
        mechanicalClarificationResolved = true;
        resolvedMechanicalRequest = request;
        correctionUsed = true;
        if (request.category === "relationship_support" && input.relationshipReviewHandler) {
          const retained = pendingAssistance?.kind === "relationship" && canonicalJsonDigest(pendingAssistance.request) === canonicalJsonDigest(request)
            ? pendingAssistance : undefined;
          if (!retained && ++relationshipReviews > MAX_READ_RELATIONSHIP_REVIEWS) {
            throw new Error("READ_RELATIONSHIP_REVIEW_LIMIT: Resume the saved job after reviewing the remaining relationship requirement.");
          }
          if (!retained?.decision) await saveAssistance({ kind: "relationship", request, question: request.question, ...(completion ? { completion } : {}) }, "waiting");
          if (input.signal?.aborted) throw new ReadWorkloadAssistancePausedError();
          const requestedResource = request.resource;
          if (!retained?.decision) {
            const prepared = await input.relationshipReviewHandler(request, mappingBoundary);
            if (!prepared) throw new Error("READ_RELATIONSHIP_REVIEW_PENDING: No exact path was saved. Keep the Read mapping pending without omitting the requested information.");
            if (prepared.reviewed_relationship.resource !== requestedResource) throw new Error("READ_RELATIONSHIP_REVIEW_MISMATCH: The exact reviewed path belongs to another requested root.");
            if (explorationBoundaryCandidateDigest(mappingBoundary) !== expectedBoundaryDigest) throw new Error("READ_RELATIONSHIP_CANDIDATE_STALE: The Read mapping changed during relationship review.");
            const nextBoundary = validateReadWorkloadRelationshipPreparation(prepared, mappingBoundary);
            const nextCatalog = readWorkloadCatalog(nextBoundary, input.principalScopedRootResources);
            const nextScope = structuredClone(await input.structuredScope!.current());
            const fields = (resources: ModelReadScopeContext["catalog"]["resources"]) => resources.map(resource => ({
              id: resource.id, fields: resource.fields.map(field => ({ id: field.id })),
            }));
            const relationships = nextCatalog.resources.flatMap(resource => resource.relationships.map(relationship => ({
              id: relationship.id, from: resource.id, to: relationship.target_resource,
            })));
            // Only the exact host-acknowledged path changes this invocation.
            // Source, question/answer lineage and subject acknowledgements do not
            // become current merely because a newer catalog is available.
            const withoutCatalogTransition = { ...nextScope, binding: { ...nextScope.binding,
              catalog_digest: structuredScopeInput!.binding.catalog_digest,
              operation_digest: structuredScopeInput!.binding.operation_digest }, catalog: structuredScopeInput!.catalog };
            if (nextScope.binding.catalog_digest !== nextCatalog.digest
              || canonicalJsonDigest(fields(nextScope.catalog.resources)) !== canonicalJsonDigest(fields(nextCatalog.resources))
              || canonicalJsonDigest(nextScope.catalog.relationships) !== canonicalJsonDigest(relationships)
              || canonicalJsonDigest(nextScope.catalog.subject_scopes ?? []) !== canonicalJsonDigest(structuredScopeInput!.catalog.subject_scopes ?? [])
              || currentReadScopeContextDigest(withoutCatalogTransition, ownedAnswerIds) !== structuredScopeDigest)
              throw new Error("READ_RELATIONSHIP_SCOPE_CHANGED: The current inventory is not the exact acknowledged path transition; preserve the pending review.");
            mappingBoundary = nextBoundary;
            expectedBoundaryDigest = explorationBoundaryCandidateDigest(mappingBoundary);
            catalog = nextCatalog;
            structuredScopeInput = nextScope;
            structuredScopeDigest = currentReadScopeContextDigest(nextScope, ownedAnswerIds);
            scopeProducerBinding = producerBinding();
            serializeCatalog();
            await saveAssistance({ kind: "relationship", request, question: request.question, ...(completion ? { completion } : {}), decision: { state: "relationship_reviewed" } }, "decided");
          }
        }
        await remap([
          runnerResolvedReadMechanicalGuidance(request),
          `Available record links for this view: ${JSON.stringify(catalog.resources.find(resource => resource.id === request.resource)?.relationships ?? [])}. Use their exact IDs; composite key details and private keys are already checked by Runner. rows.related selects target fields without granting independent target reads.`,
          "Do not ask the operator about trusted ownership or scope mechanics again. Submit the complete workload using only model-visible business fields and relationships from the catalog.",
          baseQuestion(),
        ].join("\n"));
        continue;
      }
      if (!valueRequest) break;
      const request = valueRequest;
      const retained = pendingAssistance?.kind === "value" && canonicalJsonDigest(pendingAssistance.request) === canonicalJsonDigest(request)
        ? pendingAssistance : undefined;
      if (!retained?.decision) await saveAssistance({ kind: "value", request, question: request.question, ...(completion ? { completion } : {}) }, "waiting");
      if (input.signal?.aborted) throw new ReadWorkloadAssistancePausedError();
      if (!input.valueRequestHandler && !retained?.decision) {
        throw new Error(
          `READ_WORKLOAD_VALUE_CONTEXT_REQUIRED: the model requested ${valueRequest.resource}.${valueRequest.field}. Use interactive Boundary review to approve or decline exact value context. No source query ran.`,
        );
      }
      const decision = retained?.decision ?? validateReadValueContextDecision(await input.valueRequestHandler!(request), request);
      if (!retained?.decision) await saveAssistance({ kind: "value", request, question: request.question, ...(completion ? { completion } : {}), decision }, "decided");
      valueRequest = undefined;
      valueRequestResolved = true;
      approvedValueContext = decision.state === "provided" ? decision : undefined;
      const valueContext = decision.state === "provided"
        ? [
            `The operator separately approved these exact values for ${decision.resource}.${decision.field}: ${JSON.stringify(decision.values)}.`,
            "Use only those values for this mapping. They are context for this bounded request, not authority and not a permission to expose rows.",
            `Express the approved value constraint with plan.where, for example ${JSON.stringify({ where: [{ field: decision.field, op: decision.values.length === 1 ? "eq" : "in", value: decision.values.length === 1 ? decision.values[0] : decision.values }] })}. Never use a filters key.`,
          ]
        : [
            "The operator declined observed-value context. Complete the mapping from reviewed structural metadata only.",
            "Do not request values again. If the job cannot be mapped safely, submit a structurally valid conservative workload or allow Runner validation to refuse it.",
          ];
      await remap([
        ...valueContext,
        "Retain the completed business clarifications. If a different reviewed name remains genuinely ambiguous, request that missing meaning; do not repeat an answered question or guess it.",
        baseQuestion(),
      ].join("\n"));
    }
  };
  await resolveRequestedAssistance();
  const correctionBlockers = analysis?.status === "blocked"
    ? analysis.blockers
    : workloadValidationBlockers;
  if ((!workload || !analysis || analysis.status === "blocked")
    && correctionBlockers.length
    && !repeatedAssistanceRequest
    && !correctionUsed) {
    if (!await reserveAuthoringProducerCorrection("semantic")) throw new Error("READ_WORKLOAD_CORRECTION_EXHAUSTED: The saved workload correction was already used; preserve the unresolved mapping and answers.");
    correctionUsed = true;
    const approvedValueReminder = approvedValueContext
      ? [
          `The operator already approved these exact values for ${approvedValueContext.resource}.${approvedValueContext.field}: ${JSON.stringify(approvedValueContext.values)}. Do not request them again.`,
          `The corrected plan must use plan.where on that exact field with only those values. Use ${JSON.stringify({ where: [{ field: approvedValueContext.field, op: approvedValueContext.values.length === 1 ? "eq" : "in", value: approvedValueContext.values.length === 1 ? approvedValueContext.values[0] : approvedValueContext.values }] })}; never use a filters key.`,
        ]
      : [];
    await remap([
      "Your first non-authoritative workload was refused by Runner validation. Do not repeat it.",
      "Submit one complete corrected workload using the required tool exactly once.",
      "Use only exact catalog ids and operations. Do not remove an allowed question merely to avoid a validation error.",
      'Remember: each id is at most 64 characters and each description is a concise 1 through 280 character summary; plan.kind is exactly "rows" or "aggregate"; rows requires select and aggregate requires measures. Every measure except count requires an exact field.',
      ...approvedValueReminder,
      `Validation issues: ${JSON.stringify(correctionBlockers.slice(0, 12).map((blocker) => blocker.slice(0, 700)))}`,
      baseQuestion(),
    ].join("\n"), "correction");
    await resolveRequestedAssistance();
  }
  if (!workload || !analysis) {
    if (diagnostics.length) throw new ReadWorkloadDraftError(diagnostics);
    throw new Error(repeatedAssistanceRequest
      ? "READ_WORKLOAD_ASSISTANCE_REQUEST_REPEATED: the model exceeded the bounded clarification or value-context review. Runner sent nothing else and accepted no draft."
      : "READ_WORKLOAD_NOT_SUBMITTED: the model did not submit one bounded structured workload.");
  }
  const modelMessage = input.deferNarration
    ? undefined
    : await narrateValidatedAuthoringStep({
        session: {
          provider: input.provider,
          model: input.model,
          ...(input.apiKey ? { apiKey: input.apiKey } : {}),
          ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
          ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
          ...(input.dependencies ? { dependencies: input.dependencies } : {}),
          ...(input.conversation ? { conversation: input.conversation } : {}),
        },
        operatorMessage: allowedQuestions.join("\n"),
        validatedFacts: [
          `${workload.allowed.length} representative Read plan${workload.allowed.length === 1 ? "" : "s"} passed Runner grammar validation.`,
          ...workload.allowed.slice(0, 8).map((entry) =>
            `${entry.plan.resource}: ${entry.description}`),
          ...(workload.allowed.length > 8
            ? [`${workload.allowed.length - 8} additional validated Read plans are in Runner details.`]
            : []),
          "Read authority remains disabled and the source database was not changed.",
        ],
        env: input.env,
        egressAcknowledged: input.egressAcknowledged,
        signal: input.signal,
      });
  const result: ModelReadWorkloadResult = {
    workload,
    ...(diagnostics.length ? { diagnostics } : {}),
    analysis,
    ...(structuredReadScope ? { read_scope: structuredReadScope } : {}),
    ...(replacementOwner ? { read_scope_predecessor_id: replacementOwner.question.id } : {}),
    analysis_clock: analysisClock,
    provider: input.provider,
    model: input.model,
    authority_granted: false,
    source_query_executed: false,
    explore_budget_consumed: false,
    source_database_changed: false,
    ...(modelMessage ? { model_message: modelMessage } : {}),
    ...(usage ? { usage } : {}),
  };
  // Main can commit the actual accepted disabled artifact and clear its wait in
  // the same CAS. A blocked mapping or narration failure never clears it.
  if (analysis.status === "ready" && input.onCheckpoint) {
    await assertAssistanceContext();
    await input.onCheckpoint(undefined, structuredClone(mappingBoundary), result, completion);
  }
  return result;
}

export function readWorkloadCatalog(boundary: ExplorationBoundaryDraft, principalScopedRootResources?: readonly string[]) {
  const principalRoots = principalScopedRootResources === undefined ? undefined : new Set(principalScopedRootResources);
  const resources = boundary.pack.resources.map((resource) => {
    const availableFields = new Set([
      ...resource.selectable_fields,
      ...Object.keys(resource.filterable_fields),
      ...resource.sortable_fields,
      ...resource.groupable_fields,
      ...resource.aggregate_measures,
      ...(resource.presence_measure_fields ?? []),
      ...resource.count_distinct_fields,
      ...Object.keys(resource.time_bucket_fields),
    ]);
    const modelUnavailable = new Set([
      ...resource.kept_out_fields,
      ...(resource.model_withheld_fields ?? []),
      ...(resource.tenant_key ? [resource.tenant_key] : []),
      ...(resource.principal_key ? [resource.principal_key] : []),
    ]);
    return {
      id: resource.id,
      ...(resource.label ? { label: resource.label } : {}),
      ...(resource.description ? { description: resource.description } : {}),
      fields: [...availableFields]
        .filter((field) => !modelUnavailable.has(field))
        .sort()
        .map((field) => ({
          id: field,
          type: resource.field_types[field],
          ...(field === resource.primary_key ? { record_identity: true } : {}),
          ...(resource.field_metadata?.[field]?.label ? { label: resource.field_metadata[field]!.label } : {}),
          ...(resource.field_metadata?.[field]?.description ? { description: resource.field_metadata[field]!.description } : {}),
          ...(resource.field_enums[field]?.length
            ? {
                schema_declared_values: [...resource.field_enums[field]!],
                value_source: "schema_declared_enum_or_check",
              }
            : {}),
          operations: {
            return: resource.selectable_fields.includes(field),
            ...(resource.filterable_fields[field]?.length
              ? { filter: [...resource.filterable_fields[field]!] }
              : {}),
            sort: resource.sortable_fields.includes(field),
            group: resource.groupable_fields.includes(field),
            ...(resource.aggregate_measures.includes(field)
              ? { aggregate: [...(resource.aggregate_measure_functions?.[field] ?? ["sum", "avg"])] }
              : {}),
            presence: resource.presence_measure_fields?.includes(field) ?? false,
            count_distinct: resource.count_distinct_fields.includes(field),
            ...(resource.time_bucket_fields[field]
              ? { time_bucket: [...resource.time_bucket_fields[field]!] }
              : {}),
          },
        })),
      relationships: resource.relationships.map((relationship) => ({
        id: relationship.id,
        target_resource: relationship.target_resource,
        path_depth: relationship.path_depth ?? 1,
        cardinality: "many_to_one",
        scope: "independently_enforced_on_every_resource",
      })),
      ...(resource.relationship_only || (principalRoots && !principalRoots.has(resource.id))
        ? { relationship_only: true } : {}),
      derived_measures: (resource.derived_measures ?? []).map((measure) => ({ id: measure.name, label: measure.label })),
      numeric_bands: (resource.numeric_bands ?? []).map((band) => ({ id: band.name, label: band.label })),
      auto_bands: (resource.auto_bands ?? []).map((policy) => ({
        field: policy.field,
        methods: [...policy.methods],
        min_buckets: policy.min_buckets,
        max_buckets: policy.max_buckets,
      })),
    };
  });
  const core = {
    schema_version: "synapsor.read-workload-catalog.v1",
    boundary_name: boundary.pack.name,
    resources,
    relative_time_windows: boundary.reporting_timezone === "UTC" ? [...RELATIVE_TIME_WINDOWS] : [],
    comparison_partners: boundary.reporting_timezone === "UTC" ? [...RELATIVE_TIME_COMPARISONS] : [],
    trust: {
      model_supplies_tenant: false,
      model_supplies_principal: false,
      model_supplies_object_scope: false,
      raw_rows_included: false,
      database_values_included: false,
    },
  };
  return { ...core, digest: canonicalJsonDigest(core) };
}

function readWorkloadToolDefinition(resourceIds: string[], structuredScope = false, retainedScope = false): AskToolDefinition {
  const whereSchema = {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      additionalProperties: true,
      required: ["field", "op", "value"],
      properties: {
        field: { type: "string", minLength: 1 },
        op: { type: "string", enum: ["eq", "neq", "lt", "lte", "gt", "gte", "in"] },
      },
    },
  };
  const planSchema = {
    oneOf: [
      {
        type: "object",
        additionalProperties: true,
        required: ["kind", "resource", "select"],
        properties: {
          kind: { type: "string", enum: ["rows"] },
          resource: { type: "string", enum: resourceIds },
          select: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          related: { type: "array", minItems: 1, maxItems: 3, items: {
            type: "object", additionalProperties: false, required: ["relationship", "select"],
            properties: { relationship: { type: "string", minLength: 1 },
              select: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1 } } },
          } },
          where: whereSchema,
        },
      },
      {
        type: "object",
        additionalProperties: true,
        required: ["kind", "resource", "measures"],
        properties: {
          kind: { type: "string", enum: ["aggregate"] },
          resource: { type: "string", enum: resourceIds },
          measures: {
            type: "array",
            minItems: 1,
            items: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["function"],
                  properties: { function: { type: "string", enum: ["count"] } },
                },
                {
                  type: "object",
                  additionalProperties: true,
                  required: ["function", "field"],
                  properties: {
                    function: {
                      type: "string",
                      enum: [
                        "count_distinct",
                        "sum",
                        "avg",
                        "stddev_samp",
                        "stddev_pop",
                        "var_samp",
                        "var_pop",
                        "null_count",
                        "non_null_count",
                        "completion_rate",
                      ],
                    },
                    field: { type: "string", minLength: 1 },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["derived_measure"],
                  properties: { derived_measure: { type: "string", minLength: 1 } },
                },
              ],
            },
          },
          where: whereSchema,
        },
      },
    ],
  };
  const entrySchema = {
    type: "object",
    additionalProperties: false,
    required: ["id", "description", "plan"],
    properties: {
      id: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,63}$" },
      description: { type: "string", minLength: 1, maxLength: 280 },
      plan: {
        ...planSchema,
        description: 'One exact Explore plan. kind is the literal "rows" or "aggregate"; synonyms are invalid.',
      },
    },
  };
  return {
    name: SUBMIT_READ_WORKLOAD_TOOL,
    title: "Submit one non-authoritative read workload",
    description: "Submit exact candidate Explore plans for allowed and forbidden questions. Runner validates and minimizes them; this tool never grants or activates authority.",
    input_schema: { oneOf: [{
      type: "object", additionalProperties: false, required: ["allowed", "forbidden", ...(retainedScope ? [] : ["read_scope"])],
      properties: {
        allowed: { type: "array", minItems: 0, maxItems: 40, items: entrySchema },
        forbidden: { type: "array", minItems: 0, maxItems: 40, items: entrySchema },
        read_scope: readScopeProposalSchema,
      },
    }, {
      type: "object", additionalProperties: false, required: ["value_request"], properties: {
        value_request: { type: "object", additionalProperties: false, required: ["resource", "field", "reason", "question"], properties: {
          resource: { type: "string", enum: resourceIds }, field: { type: "string", minLength: 1, maxLength: 256 },
          reason: { type: "string", minLength: 1, maxLength: 500 }, question: { type: "string", minLength: 1, maxLength: 500 },
        } },
      },
    }, {
      type: "object", additionalProperties: false, required: ["relationship_review_request"], properties: {
        relationship_review_request: { type: "object", additionalProperties: false, required: ["resource", "reason", "question"], properties: {
          resource: { type: "string", enum: resourceIds }, reason: { type: "string", minLength: 1, maxLength: 500 },
          question: { type: "string", minLength: 1, maxLength: 500 },
        } },
      },
    }] },
    metadata: {
      "synapsor.authority_granted": false,
      "synapsor.source_query_executed": false,
      "synapsor.explore_budget_consumed": false,
      "synapsor.source_database_changed": false,
    },
  };
}

function parseReadClarificationRequest(
  value: Record<string, unknown>,
  catalog: ReturnType<typeof readWorkloadCatalog>,
  retainedHostRequest = false,
): ModelReadClarificationRequest {
  let reasonBinding: ReadScopeReasonBinding | undefined;
  if (value.reason_binding !== undefined) {
    const binding = value.reason_binding;
    if (!retainedHostRequest || !isRecord(binding) || binding.kind !== "requested_read_scope"
      || Object.keys(binding).some(key => !["kind", "alternatives", "digest"].includes(key))
      || value.field !== undefined || value.category === "relationship_support"
      || typeof binding.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(binding.digest)
      || !Array.isArray(binding.alternatives) || !binding.alternatives.length
      || binding.alternatives.some(id => typeof id !== "string" || !catalog.resources.some(resource => resource.id === id))
      || new Set(binding.alternatives).size !== binding.alternatives.length || !binding.alternatives.includes(value.resource))
      throw new Error("clarification_request.reason_binding is reserved for an exact retained Runner scope question.");
    reasonBinding = structuredClone(binding) as ReadScopeReasonBinding;
  }
  const resource = boundedText(value.resource, "clarification_request.resource", 256);
  if (value.category !== undefined && value.category !== "business_meaning" && value.category !== "relationship_support") {
    throw new Error("clarification_request.category must be business_meaning or relationship_support.");
  }
  const catalogResource = catalog.resources.find((candidate) => candidate.id === resource);
  if (!catalogResource) {
    throw new Error("clarification_request.resource must be one exact reviewed catalog resource.");
  }
  const field = value.field === undefined
    ? undefined
    : boundedText(value.field, "clarification_request.field", 256);
  if (field && !catalogResource.fields.some((candidate) => candidate.id === field)) {
    throw new Error("clarification_request.field must be one exact model-visible field on the requested resource.");
  }
  return {
    resource,
    ...(value.category ? { category: value.category } : {}),
    ...(field ? { field } : {}),
    ...(reasonBinding ? { reason_binding: reasonBinding } : {}),
    reason: boundedText(value.reason, "clarification_request.reason", 500),
    question: boundedText(value.question, "clarification_request.question", 500),
  };
}

function runnerResolvedReadMechanicalGuidance(request: ModelReadClarificationRequest): string {
  return [
    `Runner rejected this mechanical clarification for ${request.resource}: ${JSON.stringify(request.question)}.`,
    "Scope keys are deliberately absent from the model catalog. Runner validates and injects reviewed predicates outside Explore plans. The catalog's relationship_only flag forbids independent reads of that resource for this job; use a listed related path from an allowed root instead. A catalog entry alone does not prove person-level ownership.",
    "Use only the model-visible business fields and reviewed analytical relationships in the catalog. Do not identify, return, filter, group, or ask about an ownership key or scope relationship.",
    OPAQUE_SELECTION_GUIDANCE,
  ].join(" ");
}


function approvedValueContextIssue(
  args: Record<string, unknown>,
  context: Extract<ModelReadValueContextDecision, { state: "provided" }>,
): string | undefined {
  const entries = [
    ...(Array.isArray(args.allowed) ? args.allowed : []),
    ...(Array.isArray(args.forbidden) ? args.forbidden : []),
  ];
  const approved = new Set(context.values);
  let matchingFieldFound = false;
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.plan) || entry.plan.resource !== context.resource) continue;
    if (!Array.isArray(entry.plan.where)) continue;
    for (const filter of entry.plan.where) {
      if (!isRecord(filter) || filter.field !== context.field || filter.relationship !== undefined) continue;
      matchingFieldFound = true;
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      // One permitted comparison cannot launder a later unapproved one.
      // Literal consent does not grant comparison semantics or result scope;
      // those remain subject to the compiler and explicit typed scope review.
      if (!values.length
        || !values.every((value) => value !== undefined && value !== null && approved.has(String(value)))) {
        return `The corrected workload used an unapproved value for ${context.resource}.${context.field}. Use only the separately approved value context.`;
      }
    }
  }
  return matchingFieldFound ? undefined
    : `The corrected workload omitted the required filter on ${context.resource}.${context.field} after requesting its separately approved value context.`;
}

function validateReadClarificationDecision(
  decision: ModelReadClarificationDecision | undefined,
): ModelReadClarificationDecision {
  if (decision === undefined) throw new ReadWorkloadAssistancePausedError();
  if (!isRecord(decision) || !["answered", "declined"].includes(decision.state as string)) throw new Error("READ_WORKLOAD_CLARIFICATION_DECISION_INVALID: Use a canonical answer or deliberate decline; keep cancellation pending.");
  if (decision.state === "declined") return { state: "declined" };
  boundedText(decision.answer, "clarification answer", 1_000);
  if (typeof decision.answer !== "string" || decision.answer.length > 1_000) throw new Error("READ_WORKLOAD_TEXT_INVALID: The complete clarification answer exceeds 1,000 text units. No answer was shortened.");
  return {
    state: "answered",
    answer: decision.answer,
  };
}

function parseReadValueRequest(
  value: Record<string, unknown>,
  catalog: ReturnType<typeof readWorkloadCatalog>,
): ModelReadValueRequest {
  if (Object.keys(value).some(key => !["resource", "field", "reason", "question"].includes(key)))
    throw new Error("value_request accepts only one exact resource, field, reason and question; model-supplied consent is invalid.");
  const resource = boundedText(value.resource, "value_request.resource", 256);
  const field = boundedText(value.field, "value_request.field", 256);
  const catalogResource = catalog.resources.find((candidate) => candidate.id === resource);
  if (!catalogResource || !catalogResource.fields.some((candidate) => candidate.id === field)) {
    throw new Error("value_request must name one exact model-visible resource and field from the reviewed catalog.");
  }
  return {
    resource,
    field,
    reason: boundedText(value.reason, "value_request.reason", 500),
    question: boundedText(value.question, "value_request.question", 500),
  };
}

function validateReadValueContextDecision(
  decision: ModelReadValueContextDecision | undefined,
  request: ModelReadValueRequest,
): ModelReadValueContextDecision {
  if (decision === undefined) throw new ReadWorkloadAssistancePausedError();
  if (!isRecord(decision) || !["provided", "without_values"].includes(decision.state as string)) throw new Error("READ_WORKLOAD_VALUE_CONTEXT_INVALID: Use separately approved values or a deliberate without_values decision; keep cancellation pending.");
  if (decision.state === "without_values") return { state: "without_values" };
  if (decision.egressAcknowledged !== true
    || decision.resource !== request.resource
    || decision.field !== request.field) {
    throw new Error("READ_WORKLOAD_VALUE_CONTEXT_INVALID: approved values must match the exact requested resource and field.");
  }
  const values = [...new Set(decision.values.map((value) => value.trim()).filter(Boolean))];
  if (!values.length || values.length > 32 || values.some((value) => value.length > 200)) {
    throw new Error("READ_WORKLOAD_VALUE_CONTEXT_INVALID: provide 1 through 32 values of at most 200 characters each.");
  }
  if (JSON.stringify(values).length > 4_000) {
    throw new Error("READ_WORKLOAD_VALUE_CONTEXT_INVALID: approved value context exceeds the 4,000-character bound.");
  }
  if (values.some((value) => /(?:postgres(?:ql)?|mysql):\/\/|BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]+/i.test(value))) {
    throw new Error("READ_WORKLOAD_VALUE_CONTEXT_INVALID: approved value context appears to contain secret material.");
  }
  return { state: "provided", resource: decision.resource, field: decision.field, values, egressAcknowledged: true };
}

function mergeUsage(
  left: ModelReadWorkloadResult["usage"],
  right: ModelReadWorkloadResult["usage"],
): ModelReadWorkloadResult["usage"] {
  if (!left && !right) return undefined;
  const merged: NonNullable<ModelReadWorkloadResult["usage"]> = {};
  const add = (key: keyof NonNullable<ModelReadWorkloadResult["usage"]>) => {
    const values = [left?.[key], right?.[key]].filter((value): value is number => typeof value === "number");
    if (values.length) merged[key] = values.reduce((sum, value) => sum + value, 0);
  };
  add("input_tokens");
  add("output_tokens");
  add("total_tokens");
  return merged;
}

function boundedQuestions(values: string[], label: string, required: boolean): string[] {
  if (!Array.isArray(values) || values.length > 40 || (required && values.length < 1)) {
    throw new Error(`READ_WORKLOAD_QUESTIONS_INVALID: ${label} must contain ${required ? "1 through" : "0 through"} 40 entries.`);
  }
  return values.map((value, index) => boundedText(value, `${label}[${index}]`, 500));
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`READ_WORKLOAD_TEXT_INVALID: ${label} must be text.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`READ_WORKLOAD_TEXT_INVALID: ${label} must be 1 through ${maximum} safe characters.`);
  }
  if (/(?:postgres(?:ql)?|mysql):\/\/|BEGIN [A-Z ]*PRIVATE KEY|api[_ -]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]+/i.test(normalized)) {
    throw new Error(`READ_WORKLOAD_SECRET_BLOCKED: ${label} appears to contain secret material.`);
  }
  return normalized;
}

/** Diagnose misplaced control fields without interpreting or relocating their values. */
function misplacedReadRootFieldIssues(args: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const branch of ["allowed", "forbidden"] as const) {
    const entries = args[branch];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      const locations = [{ value: entry, path: `/${branch}/${index}` },
        ...(isRecord(entry.plan) ? [{ value: entry.plan, path: `/${branch}/${index}/plan` }] : [])];
      for (const { value, path } of locations) {
        if (Object.hasOwn(value, "clarification_request")) issues.push(
          `${path}/clarification_request is misplaced. Submit clarification_request in the standalone root clarification branch, without allowed or forbidden. Runner has not accepted or moved this value.`);
        if (Object.hasOwn(value, "operator_meanings")) issues.push(
          `${path}/operator_meanings is misplaced. Submit operator_meanings as the root list alongside allowed and forbidden in the workload branch. Exact target and operator-evidence validation still apply; Runner has not accepted or moved this value.`);
      }
    });
  }
  return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
import { defaultProviderKeyEnv } from "./hosted-provider-settings.js";

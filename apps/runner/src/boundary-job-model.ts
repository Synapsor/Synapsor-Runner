import { authoringRequestTimeoutSeconds } from "./authoring-request-timeout.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { assertReviewOperationShape, planningFieldShape, REVIEW_OPERATION_GUIDANCE, REVIEW_PLAN_FIELDS } from "./boundary-job-operation-contract.js";
import { BoundaryJobPlanningError, planningErrorDiagnostic, planningResponseDiagnostic,
  type BoundaryJobPlanningDiagnostic, type PlanningAttemptDiagnostic } from "./boundary-job-diagnostics.js";
import { activePolicySource } from "./authoring-policy-source.js";
import { authoringClientChoices, isAuthoringClientPlan, type AuthoringClientPlan } from "./authoring-client-plan.js";
import {
  askToolSurfaceDigest,
  resolveAskProviderConfiguration,
  runAskProviderTurn,
  secureAskJsonRequest,
  AskError,
  type AskProviderDependencies,
  type AskToolDefinition,
  type AskToolGateway,
} from "./model-ask.js";
import {
  modelAuthoringHistory,
  rememberModelAuthoringTurn,
  type ModelAuthoringConversation,
} from "./model-authoring-conversation.js";
import {
  MAX_BOUNDARY_ACTION_INTENT_CHARACTERS,
  MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS,
  MAX_BOUNDARY_READ_QUESTION_CHARACTERS,
} from "./boundary-authoring-limits.js";

const PLAN_BOUNDARY_JOB_TOOL = "runner.plan_boundary_job";

export type BoundaryJobReadState = {
  boundary_name: string;
  authority: "active" | "disabled" | "active_with_disabled_changes";
  fully_reviewed: boolean;
  /** An exact current candidate can be edited without claiming activation readiness. */
  revision_eligible?: boolean;
  /** Resources in any exact Read revision that Runner can preserve locally. */
  resource_ids: string[];
  /** Current serving authority, kept separate from a newer disabled candidate. */
  active_resource_ids?: string[];
  /** Current editor candidate, which may differ from serving authority. */
  candidate_resource_ids?: string[];
  exact_reusable_revision_count: number;
  /** Exact model-mapped drafts saved before their final Read review. */
  resumable_draft_count?: number;
  resumable_resource_ids?: string[];
};

export type BoundaryJobActionState = {
  capability: string;
  kind?: "discretionary" | "rule_derived";
  action_boundary_name?: string;
  outcome?: string;
  operation?: "insert" | "update" | "delete";
  resource?: string;
  authority: "active" | "disabled";
  /** Saved identity only; a stale dependency is not current execution permission. */
  read_dependency?: "current" | "requires_revalidation";
};

export type BoundaryJobCurrentState = {
  read: BoundaryJobReadState;
  actions: BoundaryJobActionState[];
  control_plane: {
    trusted_scope: "runner_injected";
    approval_history: "runner_proposal_ledger";
    model_may_supply_scope_values: false;
    model_may_supply_approval_history: false;
  };
};

export type BoundaryJobPlan = {
  state: "planned";
  operation?: "review_rules";
  intended_client?: AuthoringClientPlan;
  read_mode: "create" | "resume" | "reuse" | "revise" | "none";
  read_intent?: string;
  action_mode: "create" | "reuse" | "revise" | "remove" | "none";
  action_intent?: string;
  action_intents?: string[];
  action_outcome?: string;
  /** Fixed outcomes by default; discretionary only for an existing legacy revision. */
  action_strategy?: "discretionary" | "rule_derived";
  summary: string;
  correction_used: boolean;
  authority_granted: false;
  source_database_changed: false;
} | {
  state: "clarification";
  question: string;
  correction_used: boolean;
  authority_granted: false;
  source_database_changed: false;
};

export type BoundaryJobPlanningSession = {
  provider: "openai" | "anthropic" | "openrouter" | "openai_compatible";
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  dependencies?: AskProviderDependencies;
  conversation?: ModelAuthoringConversation;
};

type BoundaryJobPlanCore = {
  state: "planned";
  operation?: "review_rules";
  intended_client?: AuthoringClientPlan;
  read_mode: "create" | "resume" | "reuse" | "revise" | "none";
  read_intent?: string;
  action_mode: "create" | "reuse" | "revise" | "remove" | "none";
  action_intent?: string;
  action_intents?: string[];
  action_outcome?: string;
  action_strategy?: "discretionary" | "rule_derived";
  summary: string;
  authority_granted: false;
  source_database_changed: false;
} | {
  state: "clarification";
  question: string;
  authority_granted: false;
  source_database_changed: false;
};

/**
 * Splits one operator job into Read and Action work before Runner mutates any
 * disabled candidate. The model chooses only a semantic route from a closed
 * state summary; Runner resolves and validates every durable revision.
 */
export async function planModelBoundaryJob(input: {
  session: BoundaryJobPlanningSession;
  jobIntent: string;
  currentState: BoundaryJobCurrentState;
  availableResourceIds?: string[];
  clarificationAnswer?: string;
  env?: NodeJS.ProcessEnv;
  egressAcknowledged: boolean;
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: BoundaryJobPlanningDiagnostic) => Promise<void> | void;
}): Promise<BoundaryJobPlan> {
  const jobIntent = boundedText(
    input.jobIntent,
    "Boundary job",
    MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS,
  );
  const clarificationAnswer = input.clarificationAnswer === undefined
    ? undefined
    : boundedText(input.clarificationAnswer, "Boundary job clarification", 3_000);
  const state = normalizeCurrentState(input.currentState);
  const availableResourceIds = normalizeAvailableResourceIds(input.availableResourceIds ?? []);
  const explicitlyRequestedReadResources = requestedReadResourceIds(jobIntent, availableResourceIds);
  const exactRevisionRoute = exactSoleSemanticActionRevisionRoute(jobIntent, state);
  if (exactRevisionRoute) {
    rememberModelAuthoringTurn(input.session.conversation, jobIntent, exactRevisionRoute.summary);
    return exactRevisionRoute;
  }
  const tools: AskToolDefinition[] = [jobPlanToolDefinition(state)];
  const authorityDigest = askToolSurfaceDigest(tools);
  const configuration = planningConfiguration(
    input.session,
    authorityDigest,
    input.egressAcknowledged,
    input.env,
  );
  const history = structuredClone(modelAuthoringHistory(input.session.conversation, input.session));
  const diagnostic: BoundaryJobPlanningDiagnostic = { version: 1, expected_tool: PLAN_BOUNDARY_JOB_TOOL,
    context_digest: canonicalJsonDigest({ state, jobIntent, clarificationAnswer: clarificationAnswer ?? null, availableResourceIds, history }),
    ...(activePolicySource(input.session.conversation?.policySources) ? { source_digest: activePolicySource(input.session.conversation?.policySources)!.digest } : {}),
    attempts: [], model_requests: 0, duration_ms: 0, authority_changed: false, source_database_changed: false };
  const started = Date.now();
  let responseDiagnostic: PlanningAttemptDiagnostic["response"];
  const requestJson = input.session.dependencies?.requestJson ?? secureAskJsonRequest;
  let resolution: BoundaryJobPlanCore | undefined;
  let issue = "The model did not submit one bounded Read/Action job plan.";
  let callCount = 0;
  const gateway: AskToolGateway = {
    mode: "authoring",
    listTools: () => tools,
    async callTool(name, args) {
      callCount += 1;
      if (name !== PLAN_BOUNDARY_JOB_TOOL || callCount > 2) {
        return refusal("Runner accepts one job split and one bounded correction only.");
      }
      try {
        resolution = parseJobPlan(args, state, explicitlyRequestedReadResources, jobIntent);
        return {
          ok: true,
          value: {
            status: resolution.state,
            authority_granted: false,
            source_database_changed: false,
          },
        };
      } catch (error) {
        issue = error instanceof Error ? error.message : String(error);
        return refusal(issue);
      }
    },
    async close() {},
  };
  const question = [
    "Split one operator job into Read Boundary work and Action Boundary work before any draft changes.",
    `Operator job: ${JSON.stringify(jobIntent)}`,
    ...(clarificationAnswer
      ? [`Operator clarification: ${JSON.stringify(clarificationAnswer)}`]
      : []),
    `Current reviewed state: ${JSON.stringify(state)}`,
    ...(availableResourceIds.length
      ? [`Available reviewed resource IDs: ${JSON.stringify(availableResourceIds)}`]
      : []),
    `Call ${PLAN_BOUNDARY_JOB_TOOL} exactly once.`,
    REVIEW_OPERATION_GUIDANCE,
    "Review validates the selected current attachment and candidate; it does not draft, activate, or finish an edit. A current attached source is already supplied by the host; do not ask to upload it again. Ask a specific semantic question if its content is ambiguous.",
    "Use read_mode=resume when the current exact disabled Read mapping already covers the requested reads and resumable_draft_count is positive. Resume preserves that draft and continues its pending review; it does not grant authority.",
    "Use read_mode=reuse when the requested reads should stay exactly as reviewed and exact_reusable_revision_count is positive.",
    "Use read_mode=revise when revision_eligible is true (or fully_reviewed for older state) and the operator wants to change existing field visibility, operations, labels, reviewed relationships, privacy or limits. This edits the exact saved candidate, including an incomplete disabled review; it does not remap resources or assert readiness. Keep existing Actions with action_mode=reuse when their business rules should not change; Runner revalidates their Read dependencies. Resource additions or a different workload require create. Do not suggest revise when the tool schema excludes it.",
    "For read_mode=create or revise, put only the requested read behavior in read_intent. Exclude proposal fields, approval rules, and apply/write instructions.",
    "Preserve every reviewed resource concept explicitly named in the operator's read request. Do not summarize a requested read area away.",
    `For read_mode=create, keep read_intent within ${MAX_BOUNDARY_READ_QUESTION_CHARACTERS} characters because it becomes a representative read question. For read_mode=revise, the access-edit instruction may use up to ${MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS} characters; it does not become a read question. Keep action_intent within ${MAX_BOUNDARY_ACTION_INTENT_CHARACTERS} characters. Preserve the full original request and policy; do not copy their complete contents into routing summaries.`,
    "Use action_mode=create or revise only for requested structured changes. Use reuse only when existing Action authority already represents the requested change and should remain unchanged.",
    `For a job with multiple new business actions, put each independent business outcome in action_intents (at most ${AUTHORING_PROGRAM_CAPACITY.totalActions} in the complete selected program), preserving its criteria. Keep one operation whose records must change together (for example switch plan AND consume its offer) in one intent, not separate actions; the checked effect supports up to four exact version-guarded UPDATEs in one transaction. Set action_intent to the first entry. Do not silently drop additional requested actions. A revision edits one named outcome; other outcomes remain unchanged. Runner drafts one Action at a time and saves progress in bounded work units; the inventory is the full requested program, never the first subset.`,
    "Shared automatic-approval limits across the requested actions must remain joint limits in every applicable action_intent. Never rewrite a common allowance into separate per-action allowances. Preserve the overall and trusted-customer maxima, elapsed windows, and human fallback for valid over-limit requests.",
    "Eligibility, refusal of invalid requests, automatic approval, human fallback for other valid requests or limit overruns, and supervised completion are branches of ONE business action, not separate action_intents. For example, switching a subscription from a selected offer is one outcome even when routine offers auto-approve and exceptions need a reviewer. Only separate independently requested database effects; never create a refusal-only or approval-routing-only action.",
    "Preserve automatic-completion/execution intent, and any explicit no-write restriction, in each relevant action_intent. Automatically approve AND complete means separately reviewed supervised execution, not proposal-only. Routing and drafting remain disabled; execution activation is always a later operator decision.",
    "For a rule-derived revision, select the exact existing outcome in action_outcome. If several outcomes are plausible, ask one clarification rather than choosing by similarity.",
    "Use action_mode=remove only when the operator explicitly requests removal of one existing semantic outcome. Select its exact action_outcome from Current reviewed state. Removal accepts only read_mode=reuse or none, has no action intent, action intents, or strategy, prepares only a disabled replacement, retains every other rule unchanged, and requires separate later activation.",
    "For every new Action choose action_strategy=rule_derived. This fixed-tool engine supports both values derived from private facts and caller-selected bounded business inputs. Never create a separate MCP tool for a new business behavior. discretionary is compatibility-only when editing an existing legacy capability.",
    "An Action draft depends on an exact reviewed Read revision. When Action work is requested and an exact reusable Read revision exists, choose read_mode=reuse unless the operator explicitly asked to revise reads.",
    "Trusted tenant/principal/account association is injected by Runner and may be enforced by reviewed SQL scope or PostgreSQL RLS. Never request a source field merely to recreate trusted scope.",
    "Approval counts, rolling windows, and aggregate approval limits are evaluated from Runner's proposal ledger. Never request a source table or source field for approval history.",
    "This step only routes Read versus Action work. Preserve unresolved Action thresholds, bounds, reviewer rules, and rolling limits in action_intent; the focused Action authoring conversation asks those business questions later. Do not ask them here.",
    "If the operator has already selected a supported client in their job or supplied policy, include intended_client. It is a setup preference, not permission to install files, authenticate anyone or activate authority. Do not infer it from the drafting provider or a merely mentioned alternative. Omit when unspecified or ambiguous; Runner will ask once and preserve the choice through resume.",
    "When both modes are reuse or none, summarize the existing Read resources and Action capabilities from Current reviewed state. Do not merely repeat the operator request.",
    "If the job is genuinely ambiguous between Read and Action work, submit one concise clarification question. Do not guess.",
    "Ask about the missing business distinction, explain why it matters, and offer a tentative interpretation or recommended answer when supported by the supplied policy. Do not ask an unexplained table/column naming question or treat your proposed interpretation as accepted scope. Reuse the operator's existing answers.",
    "This plan grants no authority and cannot activate, approve, apply, execute SQL, or write source data.",
  ].join("\n");
  const run = (nextQuestion: string) => runAskProviderTurn({
    configuration,
    question: nextQuestion,
    history,
    gateway,
    tools,
    signal: input.signal ?? new AbortController().signal,
    dependencies: { ...input.session.dependencies, requestJson: async (request) => {
      diagnostic.model_requests += 1;
      const response = await requestJson(request);
      responseDiagnostic = planningResponseDiagnostic(response);
      if (responseDiagnostic.status === "incomplete" || ["length", "max_tokens"].includes(responseDiagnostic.stop_reason)) {
        throw new AskError("ASK_PROVIDER_RESPONSE_INCOMPLETE", "The planning response stopped before completion. No partial tool output was accepted.", 502);
      }
      return response;
    } },
    authorityDigest,
    providerSystemPrompt: [
      "You classify one Boundary-authoring job through the required structured tool.",
      "The current-state object is authoritative and closed. Reuse means preserve the exact local revision; it does not mean recreate it.",
      "For unchanged work, explain the Read resources and Action capabilities being preserved instead of echoing the operator's wording.",
      "Runner-injected trusted scope and Runner proposal-ledger approval history are control-plane capabilities, not missing application columns.",
      "Ask one clarification instead of inventing a Read workload, Action target, source field, identity value, or approval-history table.",
      "Never claim that a Boundary, proposal, approval, apply operation, SQL statement, or source write is active.",
    ].join(" "),
    skipRunnerQuestionContext: true,
    requiredInitialToolName: PLAN_BOUNDARY_JOB_TOOL,
    completeAfterRequiredTool: true,
    authorityGuard: () => canonicalJsonDigest(state) === canonicalJsonDigest(normalizeCurrentState(input.currentState))
      ? authorityDigest
      : canonicalJsonDigest({ stale: true }),
  });
  let correctionUsed = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      responseDiagnostic = undefined;
      resolution = undefined;
      correctionUsed = attempt > 0;
      let failure: ReturnType<typeof planningErrorDiagnostic> | undefined;
      let retryable = true;
      try {
        await run(attempt ? [
          "Runner rejected the first job split. This is the one bounded correction, with the same job and approved policy snapshot.",
          `Validation issue: ${issue.slice(0, 700)}`,
          `Return DATA through ${PLAN_BOUNDARY_JOB_TOOL}, not JSON Schema or prose. Keep routing intents concise.`,
          "Submit one corrected plan using only the Read and Action modes available in the tool schema, or one clarification question. Do not switch to create merely to bypass an unavailable revision when the operator requested preservation of existing access.",
          question,
        ].join("\n") : question);
        if (!resolution) failure = planningErrorDiagnostic(new Error(issue));
      } catch (error) {
        resolution = undefined;
        failure = planningErrorDiagnostic(error);
        retryable = error instanceof AskError && ["ASK_REQUIRED_TOOL_NOT_CALLED", "ASK_PROVIDER_RESPONSE_INVALID", "ASK_TOOL_ARGUMENTS_INVALID", "ASK_PROVIDER_RESPONSE_INCOMPLETE"].includes(error.code);
      }
      diagnostic.attempts.push({ attempt: attempt + 1, phase: attempt ? "correction" : "initial",
        ...(failure ?? { category: "accepted", code: "PLANNING_ACCEPTED", message: "Validated job plan or business clarification; no draft authority changed." }),
        ...(responseDiagnostic ? { response: responseDiagnostic } : {}) });
      if (resolution || !retryable) break;
      issue = `${failure!.code}: ${failure!.message}`;
    }
    diagnostic.duration_ms = Date.now() - started;
    await input.onDiagnostic?.(diagnostic);
  } finally { await gateway.close().catch(() => undefined); }
  if (!resolution) throw new BoundaryJobPlanningError(diagnostic);
  const result = { ...resolution, correction_used: correctionUsed } as BoundaryJobPlan;
  const remembered = result.state === "clarification"
    ? result.question
    : result.summary;
  rememberModelAuthoringTurn(input.session.conversation, jobIntent, remembered);
  return result;
}

/**
 * Do not ask a general routing model to rediscover an already exact route.
 * This grants no authority: the focused Action model still drafts the change,
 * Runner validates it, and the replacement remains disabled until review.
 */
function exactSoleSemanticActionRevisionRoute(
  jobIntent: string,
  state: BoundaryJobCurrentState,
): Extract<BoundaryJobPlan, { state: "planned" }> | undefined {
  // Removal has its own exact tool path. Never turn a mixed "remove and
  // change" request into a sole-outcome revision through this shortcut.
  if (/\bremove\b/iu.test(jobIntent)) return undefined;
  if (state.read.exact_reusable_revision_count !== 1) return undefined;
  const semanticActions = state.actions.filter((action) =>
    action.kind === "rule_derived" && Boolean(action.outcome));
  if (semanticActions.length !== 1) return undefined;
  if (!/\b(?:change|revise|update|modify|set|require|increase|decrease)\b/iu.test(jobIntent)) return undefined;
  if (!/\b(?:action|outcome|rule|policy|approval|reviewer|quorum|fallback|eligibility|effect|limit|threshold)\b/iu.test(jobIntent)) {
    return undefined;
  }
  const preservesRead = /\b(?:keep|preserve|retain|reuse|leave)\b[^.!?]{0,180}\b(?:read|explore)\b[^.!?]{0,120}\b(?:unchanged|same|baseline|intact|as[- ]is)\b/iu.test(jobIntent)
    || /\b(?:read|explore)\b[^.!?]{0,120}\b(?:unchanged|same|baseline|intact|as[- ]is)\b/iu.test(jobIntent);
  if (!preservesRead) return undefined;
  if (/\b(?:add|remove|include|exclude|expand|narrow)\b[^.!?]{0,100}\b(?:read|explore|table|resource|field|column)\b/iu.test(jobIntent)) {
    return undefined;
  }
  const action = semanticActions[0]!;
  return {
    state: "planned",
    read_mode: "reuse",
    action_mode: "revise",
    action_intent: jobIntent,
    action_outcome: action.outcome!,
    action_strategy: "rule_derived",
    summary: `Keep the exact ${state.read.boundary_name} Read revision and prepare one disabled replacement for ${action.outcome}.`,
    correction_used: false,
    authority_granted: false,
    source_database_changed: false,
  };
}

function jobPlanToolDefinition(state: BoundaryJobCurrentState): AskToolDefinition {
  const readModes = [
    "create",
    ...((state.read.resumable_draft_count ?? 0) > 0 ? ["resume"] : []),
    ...(state.read.exact_reusable_revision_count > 0 ? ["reuse"] : []),
    ...((state.read.revision_eligible ?? state.read.fully_reviewed) ? ["revise"] : []),
    "none",
  ];
  const semanticOutcomes = [...new Set(state.actions.flatMap((action) =>
    action.kind === "rule_derived" && action.outcome ? [action.outcome] : []))].sort();
  const actionModes = state.actions.length
    ? ["create", "reuse", "revise", "none"]
    : ["create", "none"];
  return {
    name: PLAN_BOUNDARY_JOB_TOOL,
    title: "Plan one Read and Action Boundary job",
    description: "Classify current Boundary work or ask one clarification. This grants no authority and changes no source data.",
    input_schema: {
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: REVIEW_PLAN_FIELDS.filter(field => field !== "intended_client"),
          properties: {
            status: { type: "string", enum: ["planned"] },
            operation: { type: "string", enum: ["review_rules"] },
            read_mode: { type: "string", enum: ["none", ...(state.read.exact_reusable_revision_count > 0 ? ["reuse"] : [])] },
            action_mode: { type: "string", enum: ["none", ...(state.actions.length ? ["reuse"] : [])] },
            summary: { type: "string", minLength: 1, maxLength: 700 },
            intended_client: { type: "string", enum: authoringClientChoices.map(entry => entry.value) },
          },
          description: REVIEW_OPERATION_GUIDANCE,
        },
        ...readModes.map((readMode) => ({
          type: "object",
          additionalProperties: false,
          required: ["status", "read_mode", "action_mode", "summary", ...(["create", "revise"].includes(readMode) ? ["read_intent"] : [])],
          properties: {
            status: { type: "string", enum: ["planned"] },
            intended_client: { type: "string", enum: authoringClientChoices.map((entry) => entry.value),
              description: "Optional existing operator choice for client setup; omit when not chosen or ambiguous. Does not install, connect or grant authority." },
            read_mode: { type: "string", enum: [readMode] },
            read_intent: {
              type: "string",
              minLength: 1,
              maxLength: readMode === "create" ? MAX_BOUNDARY_READ_QUESTION_CHARACTERS : MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS,
              description: readMode === "create"
                ? `A representative read question of at most ${MAX_BOUNDARY_READ_QUESTION_CHARACTERS} characters. Preserve the full original request and policy outside this routing summary.`
                : readMode === "revise"
                  ? `An access-edit instruction of at most ${MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS} characters, applied to the existing exact revision without remapping.`
                  : `read_mode=${readMode} needs no read_intent. Any redundant instruction remains bounded to ${MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS} characters.`,
            },
            action_mode: { type: "string", enum: actionModes },
            action_intent: {
              type: "string",
              minLength: 1,
              maxLength: MAX_BOUNDARY_ACTION_INTENT_CHARACTERS,
              description: "Concise Action-only routing intent. Runner validates the exact Action separately.",
            },
            action_intents: {
              type: "array", minItems: 1, maxItems: AUTHORING_PROGRAM_CAPACITY.totalActions,
              items: { type: "string", minLength: 1, maxLength: MAX_BOUNDARY_ACTION_INTENT_CHARACTERS },
              description: "Independent business outcomes for a multi-action create job; each keeps its own requested rules.",
            },
            action_outcome: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description: "Exact existing semantic outcome selected from Current reviewed state for reuse or revision.",
            },
            action_strategy: {
              type: "string",
              enum: ["discretionary", "rule_derived"],
              description: "rule_derived is the fixed-tool engine including bounded business inputs; discretionary is legacy revision compatibility only.",
            },
            summary: { type: "string", minLength: 1, maxLength: 700 },
          },
        })),
        ...(semanticOutcomes.length ? [{
          type: "object" as const,
          additionalProperties: false,
          required: ["status", "read_mode", "action_mode", "action_outcome", "summary"],
          properties: {
            status: { type: "string", enum: ["planned"] },
            intended_client: { type: "string", enum: authoringClientChoices.map((entry) => entry.value) },
            read_mode: { type: "string", enum: ["none", ...(state.read.exact_reusable_revision_count > 0 ? ["reuse"] : [])] },
            action_mode: { type: "string", enum: ["remove"] },
            action_outcome: {
              type: "string",
              enum: semanticOutcomes,
              description: "Exact existing semantic outcome to remove from a disabled replacement. Retained outcomes remain unchanged; activation is separate.",
            },
            summary: { type: "string", minLength: 1, maxLength: 700 },
          },
        }] : []),
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "question"],
          properties: {
            status: { type: "string", enum: ["clarification"] },
            question: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
      ],
    },
    metadata: {
      "synapsor.authority_granted": false,
      "synapsor.source_database_changed": false,
    },
  };
}

function parseJobPlan(
  value: Record<string, unknown>,
  state: BoundaryJobCurrentState,
  explicitlyRequestedReadResources: string[],
  jobIntent: string,
): BoundaryJobPlanCore {
  const keys = value.status === "clarification" ? ["status", "question"]
    : ["status", "operation", "read_mode", "read_intent", "action_mode", "action_intent", "action_intents", "action_outcome", "action_strategy", "summary", "intended_client"];
  const extraKeys = Object.keys(value).filter(key => !keys.includes(key));
  if (extraKeys.length) throw new Error(`Planning arguments contain an unexpected property: ${extraKeys.slice(0, 8).map(key => planningFieldShape(key, value[key])).join("; ")}. Return only the fields in the selected tool contract, not schema keywords.`);
  assertReviewOperationShape(value);
  if (value.intended_client !== undefined && !isAuthoringClientPlan(value.intended_client)) {
    throw new Error("intended_client must be a supported client choice or omitted. Custom client configuration remains a later review.");
  }
  if (value.status === "clarification") {
    const question = boundedText(
      value.question,
      "Boundary job clarification question",
      MAX_BOUNDARY_READ_QUESTION_CHARACTERS,
    );
    if (asksForActionPolicyDetail(question)) {
      throw new Error(
        "Boundary job planning must preserve unresolved Action policy details in action_intent; threshold, limit, reviewer, and field decisions belong to focused Action authoring.",
      );
    }
    return {
      state: "clarification",
      question,
      authority_granted: false,
      source_database_changed: false,
    };
  }
  if (value.status !== "planned") {
    throw new Error("status must be planned or clarification.");
  }
  const readMode = boundedMode(value.read_mode, "read_mode", ["create", "resume", "reuse", "revise", "none"]);
  const actionMode = boundedMode(value.action_mode, "action_mode", ["create", "reuse", "revise", "remove", "none"]);
  if (readMode === "reuse" && state.read.exact_reusable_revision_count < 1) {
    throw new Error("read_mode=reuse requires one exact reusable local Read revision.");
  }
  if (readMode === "resume" && (state.read.resumable_draft_count ?? 0) < 1) {
    throw new Error("read_mode=resume requires one exact resumable disabled Read mapping.");
  }
  if (readMode === "revise" && !(state.read.revision_eligible ?? state.read.fully_reviewed)) {
    throw new Error("read_mode=revise requires an exact current Read revision; an unfinished mapping is not an editable reviewed candidate. "
      + `Revise is unavailable in this state. If new mapping is intended, read_mode=create requires read_intent of at most ${MAX_BOUNDARY_READ_QUESTION_CHARACTERS} characters; `
      + "otherwise ask one clarification without inventing review readiness or changing the requested work.");
  }
  if ((actionMode === "reuse" || actionMode === "revise" || actionMode === "remove") && !state.actions.length) {
    throw new Error(`action_mode=${actionMode} requires an existing Action revision.`);
  }
  if ((actionMode === "create" || actionMode === "revise")
    && readMode === "none"
    && state.read.exact_reusable_revision_count > 0) {
    throw new Error("Action work against the current reviewed Read Boundary must use read_mode=reuse or revise.");
  }
  if ((actionMode === "create" || actionMode === "revise")
    && readMode === "none"
    && state.read.exact_reusable_revision_count === 0) {
    throw new Error("Action work requires a reviewed Read dependency; choose read_mode=create or revise.");
  }
  const readIntent = value.read_intent === undefined
    ? undefined
    : boundedText(value.read_intent, `read_mode=${readMode} read_intent`, readMode === "create"
      ? MAX_BOUNDARY_READ_QUESTION_CHARACTERS : MAX_BOUNDARY_JOB_DESCRIPTION_CHARACTERS);
  if (actionMode === "remove") {
    if (readMode !== "reuse" && readMode !== "none") {
      throw new Error("action_mode=remove requires read_mode=reuse or none; it cannot create or revise Read authority.");
    }
    if (readIntent !== undefined) {
      throw new Error("action_mode=remove must not include read_intent; existing Read authority is retained.");
    }
  }
  if ((readMode === "create" || readMode === "revise") && !readIntent) {
    throw new Error(`read_mode=${readMode} requires one bounded read_intent.`);
  }
  // A model may restate the preserved Read intent beside reuse/resume/none.
  // It carries no authority in those modes, so canonicalize it away rather
  // than spending the operator's recovery path on harmless narration.
  const effectiveReadIntent = readMode === "create" || readMode === "revise"
    ? readIntent
    : undefined;
  if (explicitlyRequestedReadResources.length) {
    if (readMode === "none") {
      throw new Error(
        `read_mode=none omitted explicitly requested reviewed reads: ${explicitlyRequestedReadResources.join(", ")}.`,
      );
    }
    if (readMode === "resume" || readMode === "reuse") {
      const existing = new Set(readMode === "resume"
        ? state.read.resumable_resource_ids ?? []
        : state.read.resource_ids);
      const missing = explicitlyRequestedReadResources.filter((resource) => !existing.has(resource));
      if (missing.length) {
        throw new Error(
          `read_mode=${readMode} does not contain explicitly requested reviewed reads: ${missing.join(", ")}. ${(state.read.revision_eligible ?? state.read.fully_reviewed) ? "Choose revise or create." : "Use read_mode=create to prepare the corrected disabled mapping; revise is unavailable until an exact Read revision is reviewed. Preserve the existing policy and active authority."}`,
        );
      }
    }
    if (effectiveReadIntent) {
      // A typed Read routing intent can be a noun phrase. It need not repeat
      // the verb used to distinguish Read from Action in the original job.
      const covered = new Set(requestedReadResourceIds(effectiveReadIntent, explicitlyRequestedReadResources, true));
      const missing = explicitlyRequestedReadResources.filter((resource) => !covered.has(resource));
      if (missing.length) {
        throw new Error(
          `read_intent omitted explicitly requested reviewed reads: ${missing.join(", ")}. Preserve every requested read area or ask one clarification.`,
        );
      }
    }
  }
  const actionIntent = value.action_intent === undefined
    ? undefined
    : boundedText(value.action_intent, "action_intent", MAX_BOUNDARY_ACTION_INTENT_CHARACTERS);
  if (actionMode === "remove" && actionIntent !== undefined) {
    throw new Error("action_mode=remove must not include action_intent; it removes one exact existing outcome.");
  }
  if ((actionMode === "create" || actionMode === "revise") && !actionIntent) {
    throw new Error(`action_mode=${actionMode} requires one bounded action_intent.`);
  }
  // As with Read reuse, a restated Action intent is non-authoritative when the
  // model selected reuse/none. Ignore it; the exact saved revision is used.
  const effectiveActionIntent = actionMode === "create" || actionMode === "revise"
    ? actionIntent
    : undefined;
  let actionIntents: string[] | undefined;
  if (value.action_intents !== undefined) {
    if (actionMode === "remove") {
      throw new Error("action_mode=remove must not include action_intents; it removes one exact existing outcome.");
    }
    if (actionMode !== "create" || !Array.isArray(value.action_intents) || value.action_intents.length < 1 || value.action_intents.length > AUTHORING_PROGRAM_CAPACITY.totalActions) {
      throw new Error(`action_intents must contain 1-${AUTHORING_PROGRAM_CAPACITY.totalActions} separate business outcomes in the complete selected program for action_mode=create.`);
    }
    actionIntents = value.action_intents.map((intent) => boundedText(intent, "Action intent", MAX_BOUNDARY_ACTION_INTENT_CHARACTERS));
    if (new Set(actionIntents).size !== actionIntents.length || actionIntents[0] !== actionIntent) {
      throw new Error("action_intents must be distinct and its first entry must match action_intent.");
    }
  }
  const submittedActionStrategy = value.action_strategy === undefined
    ? effectiveActionIntent === undefined ? undefined : inferActionStrategy(effectiveActionIntent)
    : boundedMode(value.action_strategy, "action_strategy", ["discretionary", "rule_derived"]);
  const existingActionKinds = new Set<"discretionary" | "rule_derived">(
    state.actions.map((action) => action.kind ?? "discretionary"),
  );
  const actionStrategy = actionMode === "create" ? "rule_derived" : actionMode === "revise" && existingActionKinds.size === 1
    ? [...existingActionKinds][0]!
    : submittedActionStrategy;
  if ((actionMode === "create" || actionMode === "revise") && actionStrategy === undefined) {
    throw new Error(`action_mode=${actionMode} requires one action_strategy.`);
  }
  if ((actionMode === "create" || actionMode === "revise")
    && actionStrategy === "discretionary"
    && requiresRuleDerivedAction(jobIntent)) {
    throw new Error(
      "action_strategy must be rule_derived because the operator requires Runner to verify authoritative facts and derive the exact effect. Do not replace that request with a caller-selected value or a different operation.",
    );
  }
  if ((actionMode === "reuse" || actionMode === "remove" || actionMode === "none") && actionStrategy !== undefined) {
    throw new Error(`action_mode=${actionMode} must not include action_strategy.`);
  }
  const requestedOutcome = value.action_outcome === undefined
    ? undefined
    : boundedText(value.action_outcome, "action_outcome", 200);
  const semanticOutcomes = [...new Set(state.actions.flatMap((action) =>
    action.kind === "rule_derived" && action.outcome ? [action.outcome] : []))].sort();
  let actionOutcome = requestedOutcome;
  if (actionMode === "remove") {
    if (actionOutcome === undefined) {
      throw new Error(
        semanticOutcomes.length
          ? `action_mode=remove requires action_outcome to select one exact existing semantic outcome: ${semanticOutcomes.join(", ")}.`
          : "action_mode=remove requires an existing semantic outcome.",
      );
    }
    if (!semanticOutcomes.includes(actionOutcome)) {
      throw new Error(`action_outcome must name one existing semantic outcome: ${semanticOutcomes.join(", ")}.`);
    }
  } else if (actionMode === "revise" && actionStrategy === "rule_derived") {
    if (actionOutcome === undefined && semanticOutcomes.length === 1) {
      actionOutcome = semanticOutcomes[0];
    }
    if (actionOutcome === undefined) {
      throw new Error(
        semanticOutcomes.length
          ? `action_mode=revise requires action_outcome to select one of ${semanticOutcomes.join(", ")}.`
          : "action_mode=revise with action_strategy=rule_derived requires an existing semantic outcome.",
      );
    }
    if (!semanticOutcomes.includes(actionOutcome)) {
      throw new Error(`action_outcome must name one existing semantic outcome: ${semanticOutcomes.join(", ")}.`);
    }
  } else if (actionOutcome !== undefined) {
    if (actionMode !== "reuse") {
      throw new Error(`action_mode=${actionMode} must not include action_outcome.`);
    }
    if (!semanticOutcomes.includes(actionOutcome)) {
      throw new Error(`action_outcome must name one existing semantic outcome: ${semanticOutcomes.join(", ")}.`);
    }
  }
  return {
    state: "planned",
    ...(value.operation === "review_rules" ? { operation: "review_rules" as const } : {}),
    ...(isAuthoringClientPlan(value.intended_client) ? { intended_client: value.intended_client } : {}),
    read_mode: readMode,
    ...(effectiveReadIntent ? { read_intent: effectiveReadIntent } : {}),
    action_mode: actionMode,
    ...(effectiveActionIntent ? { action_intent: effectiveActionIntent } : {}),
    ...(actionIntents ? { action_intents: actionIntents } : {}),
    ...(actionOutcome ? { action_outcome: actionOutcome } : {}),
    ...(actionStrategy ? { action_strategy: actionStrategy } : {}),
    summary: boundedText(value.summary, "Boundary job summary", 700),
    authority_granted: false,
    source_database_changed: false,
  };
}

function inferActionStrategy(intent: string): "discretionary" | "rule_derived" {
  return /\b(?:derive|calculate|compute|cop(?:y|ies|ied|ying)|verify|eligible|eligibility|authoritative|current\s+(?:facts?|state)|exact\s+(?:effect|amount|slot|value)|only\s+when|if\s+and\s+only\s+if)\b/iu.test(intent)
    ? "rule_derived"
    : "discretionary";
}

function requiresRuleDerivedAction(jobIntent: string): boolean {
  const actionText = actionOrientedJobText(jobIntent);
  if (!actionText) return false;
  return /\b(?:derive|calculate|compute)\b[^.!?]{0,180}\b(?:effect|amount|value|refund|change)\b/iu.test(actionText)
    || /\b(?:copy|copies|copied|copying)\b[^.!?]{0,180}\b(?:source|selected|current|row|record|charge|amount|value|field)\b/iu.test(actionText)
    || /\b(?:exact|same)\s+(?:effect|amount|value|refund)\b[^.!?]{0,140}\b(?:from|as|equal(?:s|\s+to)?)\b/iu.test(actionText)
    || /\b(?:refund|amount|value|effect)\b[^.!?]{0,120}\b(?:equal(?:s|\s+to)?|matching)\s+(?:that|the|its|selected|current|source)\b/iu.test(actionText)
    || /\b(?:authoritative(?:ly)?|source[- ]proven|verified\s+(?:source|database))\b[^.!?]{0,180}\b(?:exact|equal|derive|calculate|compute|refund|effect|amount)\b/iu.test(actionText);
}

function actionOrientedJobText(jobIntent: string): string {
  return jobIntent
    .split(/(?<=[.!?;])\s+/u)
    .filter((sentence) =>
      /\b(?:propos(?:e|al|ing)|request\s+(?:a\s+)?(?:change|refund)|update|insert|delete|change|refund|write|apply)\b/iu.test(sentence))
    .join(" ");
}

function asksForActionPolicyDetail(question: string): boolean {
  return /\b(?:what|which)\b[^?]{0,180}\b(?:threshold|minimum|maximum|max(?:imum)?\s+(?:count|amount)|rolling\s+(?:limit|window)|approval\s+(?:count|limit)|reviewer\s+(?:count|role)|source\s+(?:field|column)|exact\s+(?:field|column))\b/iu.test(question);
}

function normalizeAvailableResourceIds(values: string[]): string[] {
  return [...new Set(values.map((value) => boundedText(value, "available resource id", 300)))].sort();
}

function requestedReadResourceIds(jobIntent: string, availableResourceIds: string[], readOnlyText = false): string[] {
  if (!availableResourceIds.length) return [];
  const readText = readOnlyText ? jobIntent : readOrientedJobText(jobIntent);
  if (!readText) return [];
  const words = normalizedSemanticWords(readText);
  const resourceWords = availableResourceIds.map((id) => ({
    id,
    words: normalizedSemanticWords(id.split(".").at(-1) ?? id),
  }));
  return resourceWords.flatMap(({ id, words: candidateWords }) => {
    if (!candidateWords.length) return [];
    const fullNameMatched = containsWordSequence(words, candidateWords);
    // A single coincidentally unique word is not an explicit table request:
    // "services" does not establish service_lines, nor "change" plan offers.
    // Ambiguous business concepts belong to the metadata-aware mapper.
    const meaningfulWords = candidateWords.filter((token) => !RESOURCE_MENTION_STOP_WORDS.has(token));
    return fullNameMatched || meaningfulWords.length > 0 && containsWordSequence(words, meaningfulWords) ? [id] : [];
  });
}

function readOrientedJobText(jobIntent: string): string {
  const fragments = jobIntent
    .split(/(?<=[.!?;])\s+/u)
    .flatMap((sentence) => {
      // "Keep the same Read Boundary" names preserved authority, not a
      // request to expose the private verification facts later in the clause.
      // Continue scanning: a subsequent "and show ..." is still a read request.
      const readMatch = [...sentence.matchAll(/\b(?:read|view|inspect|explore|analy[sz]e|understand|answer|report|show|list|summari[sz]e|explain)\b/giu)]
        .find(match => !isPreservedReadBoundaryMention(sentence, match.index)
          && !/\b(?:do\s+not|don't|never)\s+$/iu.test(sentence.slice(0, match.index)));
      if (!readMatch) return [];
      const afterRead = sentence.slice(readMatch.index);
      const actionConnector = /\b(?:and|then)\s+(?:(?:let|allow)\s+(?:the\s+)?(?:agent|model|user|customer|them|it)\s+)?(?:propos(?:e|ing)|update|insert|delete|write|apply|approve|change)\b/iu.exec(afterRead);
      return [actionConnector ? afterRead.slice(0, actionConnector.index) : afterRead];
    });
  return fragments.join(" ");
}

function isPreservedReadBoundaryMention(sentence: string, index: number): boolean {
  if (!/^read\s+(?:boundary|mapping|revision)\b/iu.test(sentence.slice(index))) return false;
  // An explicit exception/addition contradicts preservation; retain the
  // ordinary missing-resource guard rather than assuming unchanged access.
  if (/\b(?:but|except|and)\s+(?:also\s+)?(?:add|include|expose|extend|expand)\b/iu.test(sentence.slice(index))) return false;
  return /\b(?:keep|reuse|retain|preserve|leave)\s+(?:(?:the|our|this|same|existing|current|unchanged|saved|reviewed)\s+|saved\s+job\s+and\s+)*$/iu
    .test(sentence.slice(0, index));
}

function normalizedSemanticWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map(singularSemanticWord);
}

function singularSemanticWord(value: string): string {
  if (!/^[a-z]+$/u.test(value) || value.length < 4) return value;
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (/(?:ches|shes|sses|xes|zes)$/u.test(value)) return value.slice(0, -2);
  if (value.endsWith("s") && !/(?:ss|us|is)$/u.test(value)) return value.slice(0, -1);
  return value;
}

function containsWordSequence(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((word, offset) => haystack[index + offset] === word)) return true;
  }
  return false;
}

const RESOURCE_MENTION_STOP_WORDS = new Set([
  "application",
  "current",
  "daily",
  "data",
  "detail",
  "entry",
  "event",
  "history",
  "information",
  "item",
  "main",
  "public",
  "recent",
  "record",
  "row",
  "system",
  "table",
]);

function normalizeCurrentState(input: BoundaryJobCurrentState): BoundaryJobCurrentState {
  const resourceIds = [...new Set(input.read.resource_ids.map((resource) =>
    boundedText(resource, "Read resource id", 300)))].sort();
  const activeResourceIds = [...new Set((input.read.active_resource_ids ?? []).map((resource) =>
    boundedText(resource, "active Read resource id", 300)))].sort();
  const candidateResourceIds = [...new Set((input.read.candidate_resource_ids ?? []).map((resource) =>
    boundedText(resource, "candidate Read resource id", 300)))].sort();
  const actions = input.actions.map((action) => ({
    capability: boundedText(action.capability, "Action capability", 200),
    ...(action.kind ? { kind: action.kind } : {}),
    ...(action.action_boundary_name
      ? { action_boundary_name: boundedText(action.action_boundary_name, "Action Boundary name", 200) }
      : {}),
    ...(action.outcome ? { outcome: boundedText(action.outcome, "Action outcome", 200) } : {}),
    ...(action.operation ? { operation: action.operation } : {}),
    ...(action.resource ? { resource: boundedText(action.resource, "Action resource id", 300) } : {}),
    authority: action.authority,
  })).sort((left, right) => left.capability.localeCompare(right.capability));
  if (!Number.isSafeInteger(input.read.exact_reusable_revision_count)
    || input.read.exact_reusable_revision_count < 0) {
    throw new Error("exact_reusable_revision_count must be a non-negative integer.");
  }
  const resumableDraftCount = input.read.resumable_draft_count ?? 0;
  if (!Number.isSafeInteger(resumableDraftCount) || resumableDraftCount < 0) {
    throw new Error("resumable_draft_count must be a non-negative integer.");
  }
  const resumableResourceIds = [...new Set((input.read.resumable_resource_ids ?? []).map((resource) =>
    boundedText(resource, "resumable Read resource id", 300)))].sort();
  return {
    read: {
      boundary_name: boundedText(input.read.boundary_name, "Read Boundary name", 80),
      authority: input.read.authority,
      fully_reviewed: input.read.fully_reviewed === true,
      ...(input.read.revision_eligible !== undefined ? { revision_eligible: input.read.revision_eligible === true } : {}),
      resource_ids: resourceIds,
      ...(activeResourceIds.length ? { active_resource_ids: activeResourceIds } : {}),
      ...(candidateResourceIds.length ? { candidate_resource_ids: candidateResourceIds } : {}),
      exact_reusable_revision_count: input.read.exact_reusable_revision_count,
      resumable_draft_count: resumableDraftCount,
      resumable_resource_ids: resumableResourceIds,
    },
    actions,
    control_plane: {
      trusted_scope: "runner_injected",
      approval_history: "runner_proposal_ledger",
      model_may_supply_scope_values: false,
      model_may_supply_approval_history: false,
    },
  };
}

function planningConfiguration(
  session: BoundaryJobPlanningSession,
  authorityDigest: `sha256:${string}`,
  egressAcknowledged: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  const defaultKeyEnv = session.provider === "openai_compatible" ? undefined : defaultProviderKeyEnv(session.provider);
  return resolveAskProviderConfiguration({
    provider: session.provider,
    model: session.model,
    ...(session.baseUrl ? { base_url: session.baseUrl } : {}),
    ...(session.apiKey
      ? { api_key: session.apiKey }
      : session.apiKeyEnv ?? defaultKeyEnv
        ? { api_key_env: session.apiKeyEnv ?? defaultKeyEnv }
        : {}),
    authority_digest: authorityDigest,
    egress_acknowledged: egressAcknowledged,
    request_timeout_seconds: authoringRequestTimeoutSeconds(),
    max_output_tokens: 4_000,
  }, env, new Date());
}

function boundedMode<T extends string>(value: unknown, label: string, modes: readonly T[]): T {
  if (typeof value !== "string" || !modes.includes(value as T)) {
    throw new Error(`${label} must be one of ${modes.join(", ")}.`);
  }
  return value as T;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be 1-${maximum} characters.`);
  }
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length > maximum) {
    throw new Error(`${label} is ${length} characters; maximum is ${maximum}.`);
  }
  const normalized = trimmed.replace(/\r\n?/gu, "\n");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  return normalized;
}

function refusal(message: string): Awaited<ReturnType<AskToolGateway["callTool"]>> {
  return {
    ok: false,
    value: {
      error_code: "BOUNDARY_JOB_PLAN_REFUSED",
      message,
      authority_granted: false,
      source_database_changed: false,
    },
    error_code: "BOUNDARY_JOB_PLAN_REFUSED",
  };
}
import { defaultProviderKeyEnv } from "./hosted-provider-settings.js";
import { AUTHORING_PROGRAM_CAPACITY } from "./authoring-program-capacity.js";

import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { runRequiredAuthoringToolCall } from "./authoring-tool-call.js";
import {
  askToolSurfaceDigest,
  resolveAskProviderConfiguration,
  runAskProviderTurn,
  type AskProviderDependencies,
  type AskToolDefinition,
  type AskToolGateway,
} from "./model-ask.js";
import {
  modelAuthoringHistory,
  rememberModelAuthoringTurn,
  type ModelAuthoringConversation,
} from "./model-authoring-conversation.js";

const PLAN_BOUNDARY_JOB_TOOL = "runner.plan_boundary_job";
const JOB_INTENT_MAX_CHARS = 500;
const PLANNED_ACTION_INTENT_MAX_CHARS = 1_000;

export type BoundaryJobReadState = {
  boundary_name: string;
  authority: "active" | "disabled" | "active_with_disabled_changes";
  fully_reviewed: boolean;
  resource_ids: string[];
  exact_reusable_revision_count: number;
};

export type BoundaryJobActionState = {
  capability: string;
  operation?: "insert" | "update" | "delete";
  resource?: string;
  authority: "active" | "disabled";
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
  read_mode: "create" | "reuse" | "revise" | "none";
  read_intent?: string;
  action_mode: "create" | "reuse" | "revise" | "none";
  action_intent?: string;
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
  provider: "openai" | "anthropic" | "openai_compatible";
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  dependencies?: AskProviderDependencies;
  conversation?: ModelAuthoringConversation;
};

type BoundaryJobPlanCore = {
  state: "planned";
  read_mode: "create" | "reuse" | "revise" | "none";
  read_intent?: string;
  action_mode: "create" | "reuse" | "revise" | "none";
  action_intent?: string;
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
}): Promise<BoundaryJobPlan> {
  const jobIntent = boundedText(input.jobIntent, "Boundary job", JOB_INTENT_MAX_CHARS);
  const clarificationAnswer = input.clarificationAnswer === undefined
    ? undefined
    : boundedText(input.clarificationAnswer, "Boundary job clarification", 1_000);
  const state = normalizeCurrentState(input.currentState);
  const availableResourceIds = normalizeAvailableResourceIds(input.availableResourceIds ?? []);
  const explicitlyRequestedReadResources = requestedReadResourceIds(jobIntent, availableResourceIds);
  const tools: AskToolDefinition[] = [jobPlanToolDefinition(state)];
  const authorityDigest = askToolSurfaceDigest(tools);
  const configuration = planningConfiguration(
    input.session,
    authorityDigest,
    input.egressAcknowledged,
    input.env,
  );
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
        resolution = parseJobPlan(args, state, explicitlyRequestedReadResources);
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
    "Use read_mode=reuse when the requested reads should stay exactly as reviewed and exact_reusable_revision_count is positive.",
    "Use read_mode=revise only when the operator asks to change the reviewed Read Boundary. Use create only when a new Read draft is needed.",
    "For read_mode=create or revise, put only the requested read behavior in read_intent. Exclude proposal fields, approval rules, and apply/write instructions.",
    "Preserve every reviewed resource concept explicitly named in the operator's read request. Do not summarize a requested read area away.",
    `Keep read_intent within 500 characters and action_intent within ${PLANNED_ACTION_INTENT_MAX_CHARS} characters. These are concise routing intents, not explanations.`,
    "Use action_mode=create or revise only for requested structured changes. Use reuse only when existing Action authority already represents the requested change and should remain unchanged.",
    "An Action draft depends on an exact reviewed Read revision. When Action work is requested and an exact reusable Read revision exists, choose read_mode=reuse unless the operator explicitly asked to revise reads.",
    "Trusted tenant/principal/account association is injected by Runner and may be enforced by reviewed SQL scope or PostgreSQL RLS. Never request a source field merely to recreate trusted scope.",
    "Approval counts, rolling windows, and aggregate approval limits are evaluated from Runner's proposal ledger. Never request a source table or source field for approval history.",
    "When both modes are reuse or none, summarize the existing Read resources and Action capabilities from Current reviewed state. Do not merely repeat the operator request.",
    "If the job is genuinely ambiguous between Read and Action work, submit one concise clarification question. Do not guess.",
    "This plan grants no authority and cannot activate, approve, apply, execute SQL, or write source data.",
  ].join("\n");
  const run = (nextQuestion: string) => runAskProviderTurn({
    configuration,
    question: nextQuestion,
    history: modelAuthoringHistory(input.session.conversation),
    gateway,
    tools,
    signal: input.signal ?? new AbortController().signal,
    dependencies: input.session.dependencies,
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
  const initial = await runRequiredAuthoringToolCall({
    run,
    question,
    toolName: PLAN_BOUNDARY_JOB_TOOL,
  });
  let correctionUsed = initial.correction_used;
  if (!resolution && !correctionUsed) {
    correctionUsed = true;
    await run([
      "Runner rejected the first job split. Do not repeat it.",
      `Validation issue: ${issue.slice(0, 700)}`,
      "Submit one corrected create/reuse/revise/none plan or one clarification question.",
      question,
    ].join("\n"));
  }
  await gateway.close().catch(() => undefined);
  if (!resolution) throw new Error(`BOUNDARY_JOB_PLAN_INVALID: ${issue}`);
  const result = { ...resolution, correction_used: correctionUsed } as BoundaryJobPlan;
  const remembered = result.state === "clarification"
    ? result.question
    : result.summary;
  rememberModelAuthoringTurn(input.session.conversation, jobIntent, remembered);
  return result;
}

function jobPlanToolDefinition(state: BoundaryJobCurrentState): AskToolDefinition {
  const readModes = state.read.exact_reusable_revision_count > 0
    ? ["create", "reuse", "revise", "none"]
    : state.read.fully_reviewed
      ? ["create", "revise", "none"]
      : ["create", "none"];
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
          type: "object",
          additionalProperties: false,
          required: ["status", "read_mode", "action_mode", "summary"],
          properties: {
            status: { type: "string", enum: ["planned"] },
            read_mode: { type: "string", enum: readModes },
            read_intent: { type: "string", minLength: 1, maxLength: 500 },
            action_mode: { type: "string", enum: actionModes },
            action_intent: {
              type: "string",
              minLength: 1,
              maxLength: PLANNED_ACTION_INTENT_MAX_CHARS,
              description: "Concise Action-only routing intent. Runner validates the exact Action separately.",
            },
            summary: { type: "string", minLength: 1, maxLength: 700 },
          },
        },
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
): BoundaryJobPlanCore {
  if (value.status === "clarification") {
    return {
      state: "clarification",
      question: boundedText(value.question, "Boundary job clarification question", 500),
      authority_granted: false,
      source_database_changed: false,
    };
  }
  if (value.status !== "planned") {
    throw new Error("status must be planned or clarification.");
  }
  const readMode = boundedMode(value.read_mode, "read_mode", ["create", "reuse", "revise", "none"]);
  const actionMode = boundedMode(value.action_mode, "action_mode", ["create", "reuse", "revise", "none"]);
  if (readMode === "reuse" && state.read.exact_reusable_revision_count < 1) {
    throw new Error("read_mode=reuse requires one exact reusable local Read revision.");
  }
  if (readMode === "revise" && !state.read.fully_reviewed) {
    throw new Error("read_mode=revise requires an existing reviewed Read Boundary.");
  }
  if ((actionMode === "reuse" || actionMode === "revise") && !state.actions.length) {
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
    : boundedText(value.read_intent, "read_intent", 500);
  if ((readMode === "create" || readMode === "revise") && !readIntent) {
    throw new Error(`read_mode=${readMode} requires one bounded read_intent.`);
  }
  if ((readMode === "reuse" || readMode === "none") && readIntent) {
    throw new Error(`read_mode=${readMode} must not include read_intent.`);
  }
  if (explicitlyRequestedReadResources.length) {
    if (readMode === "none") {
      throw new Error(
        `read_mode=none omitted explicitly requested reviewed reads: ${explicitlyRequestedReadResources.join(", ")}.`,
      );
    }
    if (readMode === "reuse") {
      const existing = new Set(state.read.resource_ids);
      const missing = explicitlyRequestedReadResources.filter((resource) => !existing.has(resource));
      if (missing.length) {
        throw new Error(
          `read_mode=reuse does not contain explicitly requested reviewed reads: ${missing.join(", ")}. Choose revise or create.`,
        );
      }
    }
    if (readIntent) {
      const covered = new Set(requestedReadResourceIds(readIntent, explicitlyRequestedReadResources));
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
    : boundedText(value.action_intent, "action_intent", PLANNED_ACTION_INTENT_MAX_CHARS);
  if ((actionMode === "create" || actionMode === "revise") && !actionIntent) {
    throw new Error(`action_mode=${actionMode} requires one bounded action_intent.`);
  }
  if ((actionMode === "reuse" || actionMode === "none") && actionIntent) {
    throw new Error(`action_mode=${actionMode} must not include action_intent.`);
  }
  return {
    state: "planned",
    read_mode: readMode,
    ...(readIntent ? { read_intent: readIntent } : {}),
    action_mode: actionMode,
    ...(actionIntent ? { action_intent: actionIntent } : {}),
    summary: boundedText(value.summary, "Boundary job summary", 700),
    authority_granted: false,
    source_database_changed: false,
  };
}

function normalizeAvailableResourceIds(values: string[]): string[] {
  return [...new Set(values.map((value) => boundedText(value, "available resource id", 300)))].sort();
}

function requestedReadResourceIds(jobIntent: string, availableResourceIds: string[]): string[] {
  if (!availableResourceIds.length) return [];
  const readText = readOrientedJobText(jobIntent);
  if (!readText) return [];
  const words = normalizedSemanticWords(readText);
  const wordSet = new Set(words);
  const resourceWords = availableResourceIds.map((id) => ({
    id,
    words: normalizedSemanticWords(id.split(".").at(-1) ?? id),
  }));
  const tokenFrequency = new Map<string, number>();
  for (const resource of resourceWords) {
    for (const token of new Set(resource.words)) {
      tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
    }
  }
  return resourceWords.flatMap(({ id, words: candidateWords }) => {
    if (!candidateWords.length) return [];
    const fullNameMatched = containsWordSequence(words, candidateWords);
    const uniqueTokenMatched = candidateWords.some((token) =>
      token.length >= 4
      && !RESOURCE_MENTION_STOP_WORDS.has(token)
      && tokenFrequency.get(token) === 1
      && wordSet.has(token));
    return fullNameMatched || uniqueTokenMatched ? [id] : [];
  });
}

function readOrientedJobText(jobIntent: string): string {
  const fragments = jobIntent
    .split(/(?<=[.!?;])\s+/u)
    .flatMap((sentence) => {
      const readMatch = /\b(?:read|view|inspect|explore|analy[sz]e|understand|answer|report|show|list|summari[sz]e|explain)\b/iu.exec(sentence);
      if (!readMatch) return [];
      const afterRead = sentence.slice(readMatch.index);
      const actionConnector = /\b(?:and|then)\s+(?:(?:let|allow)\s+(?:the\s+)?(?:agent|model|user|customer|them|it)\s+)?(?:propos(?:e|ing)|update|insert|delete|write|apply|approve|change)\b/iu.exec(afterRead);
      return [actionConnector ? afterRead.slice(0, actionConnector.index) : afterRead];
    });
  return fragments.join(" ");
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
  const actions = input.actions.map((action) => ({
    capability: boundedText(action.capability, "Action capability", 200),
    ...(action.operation ? { operation: action.operation } : {}),
    ...(action.resource ? { resource: boundedText(action.resource, "Action resource id", 300) } : {}),
    authority: action.authority,
  })).sort((left, right) => left.capability.localeCompare(right.capability));
  if (!Number.isSafeInteger(input.read.exact_reusable_revision_count)
    || input.read.exact_reusable_revision_count < 0) {
    throw new Error("exact_reusable_revision_count must be a non-negative integer.");
  }
  return {
    read: {
      boundary_name: boundedText(input.read.boundary_name, "Read Boundary name", 80),
      authority: input.read.authority,
      fully_reviewed: input.read.fully_reviewed === true,
      resource_ids: resourceIds,
      exact_reusable_revision_count: input.read.exact_reusable_revision_count,
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
  const defaultKeyEnv = session.provider === "openai"
    ? "OPENAI_API_KEY"
    : session.provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : undefined;
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
    request_timeout_seconds: 120,
    max_output_tokens: 1_200,
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

import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  askToolSurfaceDigest,
  resolveAskProviderConfiguration,
  runAskProviderTurn,
  type AskProvider,
  type AskProviderDependencies,
  type AskToolDefinition,
  type AskToolGateway,
} from "./model-ask.js";
import {
  ACTION_SUGGESTION_VERSION,
  assessActionSuggestion,
  type ActionSuggestionAssessment,
} from "./action-design.js";
import type { GuidedActionOptions } from "./guided-action.js";
import { runRequiredAuthoringToolCall } from "./authoring-tool-call.js";
import {
  modelAuthoringHistory,
  type ModelAuthoringConversation,
} from "./model-authoring-conversation.js";
import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";

const SUBMIT_SUGGESTION_TOOL = "runner.suggest_safe_action";
const SUBMIT_SUGGESTION_SET_TOOL = "runner.suggest_safe_actions";

export type ModelActionSuggestionResult = {
  assessment: ActionSuggestionAssessment;
  provider: AskProvider;
  model: string;
  authority_granted: false;
  source_database_changed: false;
  model_message?: string;
  discarded_approval_policy_proposals?: number;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
};

export type ModelActionSuggestionSetResult = {
  assessments: ActionSuggestionAssessment[];
  provider: AskProvider;
  model: string;
  authority_granted: false;
  source_database_changed: false;
  model_message?: string;
  discarded_approval_policy_proposals?: number;
  usage?: ModelActionSuggestionResult["usage"];
};

/**
 * Sends only structural candidate metadata to a selected provider. The
 * ephemeral structured-output tool is not an MCP tool and cannot activate,
 * approve, apply, choose trusted identity, or select an executor.
 */
export async function generateModelActionSuggestion(input: {
  intent: string;
  provider: AskProvider;
  model: string;
  options: GuidedActionOptions;
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  egressAcknowledged: boolean;
  dependencies?: AskProviderDependencies;
  conversation?: ModelAuthoringConversation;
  /** The outer authoring session will narrate the combined validated draft. */
  deferNarration?: boolean;
  signal?: AbortSignal;
}): Promise<ModelActionSuggestionResult> {
  const intent = safeIntent(input.intent);
  const catalog = suggestionCatalog(input.options);
  const serializedCatalog = JSON.stringify(catalog);
  if (Buffer.byteLength(serializedCatalog) > 64 * 1024) {
    throw new Error("ACTION_SUGGESTION_CATALOG_TOO_LARGE: narrow the active Read Boundary or import a bounded suggestion file instead.");
  }
  const tools: AskToolDefinition[] = [suggestionToolDefinition(catalog)];
  const authorityDigest = askToolSurfaceDigest(tools);
  const defaultKeyEnv = input.provider === "openai"
    ? "OPENAI_API_KEY"
    : input.provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : undefined;
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
    request_timeout_seconds: 120,
    max_output_tokens: 2_400,
  }, input.env ?? process.env, new Date());

  let assessment: ActionSuggestionAssessment | undefined;
  let callCount = 0;
  const gateway: AskToolGateway = {
    mode: "authoring",
    listTools: () => tools,
    async callTool(name, args) {
      callCount += 1;
      if (name !== SUBMIT_SUGGESTION_TOOL || callCount > 2) {
        return {
          ok: false,
          value: {
            error_code: "ACTION_SUGGESTION_CALL_REFUSED",
            message: "Runner accepts one initial suggestion and, only after a refusal, one corrected suggestion.",
            source_database_changed: false,
          },
          error_code: "ACTION_SUGGESTION_CALL_REFUSED",
        };
      }
      assessment = assessActionSuggestion({
        schema_version: ACTION_SUGGESTION_VERSION,
        ...args,
        suggested_by: {
          kind: "model",
          provider: input.provider,
          model: input.model,
        },
      }, input.options.resources);
      return {
        ok: assessment.status === "suggested",
        value: {
          status: assessment.status,
          blockers: assessment.blockers,
          authority_granted: false,
          source_database_changed: false,
        },
        ...(assessment.status === "blocked" ? { error_code: "ACTION_SUGGESTION_BLOCKED" } : {}),
      };
    },
    async close() {},
  };
  const baseQuestion = [
    "Create exactly one untrusted Safe Action suggestion for this operator intent.",
    `Intent: ${intent}`,
    "Call runner.suggest_safe_action exactly once. Copy only exact resource and field ids from the structural candidate catalog.",
    "Select the resource whose exact id, label, or description matches the requested changed object. Never substitute a related resource merely because it is available.",
    "You may optionally propose a deterministic approval policy for INSERT or UPDATE using only the fixed policy grammar in the tool schema.",
    "A policy proposal is only operator-review input. Never propose auto-approval for DELETE, identity values, execution, writeback, credentials, SQL, activation, approval decisions, or apply authority.",
    `Structural candidate catalog: ${serializedCatalog}`,
  ].join("\n");
  const providerSystemPrompt = [
    "You produce one non-authoritative Synapsor Safe Action suggestion through the provided structured tool.",
    "Copy exact ids only from the candidate catalog in the user message and match the requested changed object to the resource before choosing fields.",
    "An optional deterministic approval-policy proposal may use only reviewed fields and fixed operators. It remains untrusted operator-review input.",
    "Never propose SQL, credentials, trusted tenant/principal values, execution, writeback, activation, an approval decision, apply, or worker authority. Never auto-approve DELETE.",
    "Call the tool exactly once. Do not claim that the suggestion is active, approved, executable, or applied.",
  ].join(" ");
  const run = (question: string) => runAskProviderTurn({
    configuration,
    question,
    history: modelAuthoringHistory(input.conversation),
    gateway,
    tools,
    signal: input.signal ?? new AbortController().signal,
    dependencies: input.dependencies,
    authorityDigest,
    providerSystemPrompt,
    skipRunnerQuestionContext: true,
    requiredInitialToolName: SUBMIT_SUGGESTION_TOOL,
    completeAfterRequiredTool: true,
    authorityGuard: () => {
      const current = suggestionCatalog(input.options).digest;
      return current === catalog.digest ? authorityDigest : canonicalJsonDigest({ stale: current });
    },
  });
  const initial = await runRequiredAuthoringToolCall({
    run,
    question: baseQuestion,
    toolName: SUBMIT_SUGGESTION_TOOL,
  });
  const firstResult = initial.result;
  if (!assessment) {
    throw new Error("ACTION_SUGGESTION_NOT_SUBMITTED: the model did not submit one bounded structured suggestion.");
  }
  let usage = firstResult.usage;
  if (assessment.status === "blocked" && !initial.correction_used) {
    const blockers = assessment.blockers.slice(0, 12).map((blocker) => blocker.slice(0, 700));
    const retryResult = await run([
        "Your first non-authoritative Safe Action suggestion was refused by Runner validation. Do not repeat it.",
        "Submit one complete corrected suggestion with the required tool exactly once.",
        "Use the exact target resource and fields named by the operator intent; if no exact candidate supports it, do not invent a substitute.",
        `Validation issues: ${JSON.stringify(blockers)}`,
        baseQuestion,
      ].join("\n"));
    usage = mergeUsage(firstResult.usage, retryResult.usage);
  }
  const recovered = recoverSuggestionWithoutInvalidApprovalPolicy(assessment, input.options.resources);
  assessment = recovered.assessment;
  const modelMessage = assessment.status === "suggested" && !input.deferNarration
    ? await narrateValidatedAuthoringStep({
        session: narrationSession(input),
        operatorMessage: intent,
        validatedFacts: actionSuggestionNarrationFacts([assessment], input.options),
        env: input.env,
        egressAcknowledged: input.egressAcknowledged,
        signal: input.signal,
      })
    : undefined;
  return {
    assessment,
    provider: input.provider,
    model: input.model,
    authority_granted: false,
    source_database_changed: false,
    ...(modelMessage ? { model_message: modelMessage } : {}),
    ...(recovered.discarded ? { discarded_approval_policy_proposals: 1 } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * Decomposes one operator job into at most eight distinct, independently
 * reviewable action suggestions. This is authoring metadata only; every item
 * still passes the same deterministic assessment as the single-action path.
 */
export async function generateModelActionSuggestionSet(input: {
  jobIntent: string;
  provider: AskProvider;
  model: string;
  options: GuidedActionOptions;
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  egressAcknowledged: boolean;
  dependencies?: AskProviderDependencies;
  conversation?: ModelAuthoringConversation;
  /** The outer authoring session will narrate the combined validated draft. */
  deferNarration?: boolean;
  signal?: AbortSignal;
}): Promise<ModelActionSuggestionSetResult> {
  const jobIntent = safeIntent(input.jobIntent);
  const catalog = suggestionCatalog(input.options);
  const serializedCatalog = JSON.stringify(catalog);
  if (Buffer.byteLength(serializedCatalog) > 64 * 1024) {
    throw new Error("ACTION_SUGGESTION_CATALOG_TOO_LARGE: narrow the disabled mapping catalog or use explicit action intents instead.");
  }
  const tools: AskToolDefinition[] = [suggestionSetToolDefinition(catalog)];
  const authorityDigest = askToolSurfaceDigest(tools);
  const defaultKeyEnv = input.provider === "openai"
    ? "OPENAI_API_KEY"
    : input.provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : undefined;
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
    request_timeout_seconds: 120,
    max_output_tokens: 4_800,
  }, input.env ?? process.env, new Date());

  let assessments: ActionSuggestionAssessment[] | undefined;
  let submissionIssues: string[] = [];
  let callCount = 0;
  const gateway: AskToolGateway = {
    mode: "authoring",
    listTools: () => tools,
    async callTool(name, args) {
      callCount += 1;
      if (name !== SUBMIT_SUGGESTION_SET_TOOL || callCount > 2) {
        return suggestionSetRefusal("Runner accepts one action set and, only after a refusal, one corrected set.");
      }
      const submitted = args.suggestions;
      if (!Array.isArray(submitted) || submitted.length < 1 || submitted.length > 8
        || submitted.some((candidate) => !isRecord(candidate))) {
        assessments = undefined;
        submissionIssues = ["Submit 1 through 8 complete suggestion objects in suggestions."];
        return suggestionSetRefusal(submissionIssues[0]!);
      }
      try {
        const current = submitted.map((candidate) => assessActionSuggestion({
          schema_version: ACTION_SUGGESTION_VERSION,
          ...candidate,
          suggested_by: {
            kind: "model",
            provider: input.provider,
            model: input.model,
          },
        }, input.options.resources));
        submissionIssues = suggestionSetIssues(current);
        assessments = current;
        return {
          ok: submissionIssues.length === 0,
          value: {
            status: submissionIssues.length ? "blocked" : "suggested",
            count: current.length,
            blockers: submissionIssues.slice(0, 24),
            authority_granted: false,
            source_database_changed: false,
          },
          ...(submissionIssues.length ? { error_code: "ACTION_SUGGESTION_SET_BLOCKED" } : {}),
        };
      } catch (error) {
        assessments = undefined;
        submissionIssues = [error instanceof Error ? error.message : "The submitted action set was invalid."];
        return suggestionSetRefusal(submissionIssues[0]!);
      }
    },
    async close() {},
  };
  const baseQuestion = [
    "Decompose this operator job into the distinct database changes the agent may propose.",
    `Job: ${jobIntent}`,
    "Call runner.suggest_safe_actions exactly once with 1 through 8 suggestions. Use one suggestion per distinct changed object or operation; do not combine unrelated effects and do not duplicate effects.",
    "Do not invent a write for read-only analytics clauses. Copy only exact resource and field ids from the structural candidate catalog.",
    "Each INSERT or UPDATE may optionally include one deterministic approval-policy proposal using only the fixed grammar. DELETE must never include auto-approval.",
    "Every item is untrusted review input. Never include identity values, execution, writeback, credentials, SQL, activation, approval decisions, or apply authority.",
    `Structural candidate catalog: ${serializedCatalog}`,
  ].join("\n");
  const providerSystemPrompt = [
    "You decompose one job into a bounded set of non-authoritative Synapsor Safe Action suggestions through the required structured tool.",
    "Return one item per distinct requested database effect and copy exact ids only from the catalog.",
    "Never invent an action for an analytics-only clause or substitute a related resource for the changed object.",
    "Policy proposals remain untrusted operator-review input; DELETE is human-only.",
    "Never propose SQL, credentials, trusted identity, execution, writeback, activation, approval decisions, apply, or worker authority.",
  ].join(" ");
  const run = (question: string) => runAskProviderTurn({
    configuration,
    question,
    history: modelAuthoringHistory(input.conversation),
    gateway,
    tools,
    signal: input.signal ?? new AbortController().signal,
    dependencies: input.dependencies,
    authorityDigest,
    providerSystemPrompt,
    skipRunnerQuestionContext: true,
    requiredInitialToolName: SUBMIT_SUGGESTION_SET_TOOL,
    completeAfterRequiredTool: true,
    authorityGuard: () => {
      const current = suggestionCatalog(input.options).digest;
      return current === catalog.digest ? authorityDigest : canonicalJsonDigest({ stale: current });
    },
  });
  const initial = await runRequiredAuthoringToolCall({
    run,
    question: baseQuestion,
    toolName: SUBMIT_SUGGESTION_SET_TOOL,
  });
  const firstResult = initial.result;
  let usage = firstResult.usage;
  if ((!assessments || submissionIssues.length) && !initial.correction_used) {
    const retryResult = await run([
      "Runner refused the first action set. Submit one corrected complete set and do not repeat the rejected shape.",
      `Validation issues: ${JSON.stringify(submissionIssues.slice(0, 24).map((issue) => issue.slice(0, 700)))}`,
      baseQuestion,
    ].join("\n"));
    usage = mergeUsage(firstResult.usage, retryResult.usage);
  }
  if (!assessments) {
    throw new Error("ACTION_SUGGESTION_SET_NOT_SUBMITTED: the model did not submit one bounded structured action set.");
  }
  let discardedApprovalPolicyProposals = 0;
  if (submissionIssues.length) {
    const recovered = assessments.map((assessment) => {
      const result = recoverSuggestionWithoutInvalidApprovalPolicy(assessment, input.options.resources);
      if (result.discarded) discardedApprovalPolicyProposals += 1;
      return result.assessment;
    });
    const recoveredIssues = suggestionSetIssues(recovered);
    if (discardedApprovalPolicyProposals > 0 && recoveredIssues.length === 0) {
      assessments = recovered;
      submissionIssues = [];
    }
  }
  if (submissionIssues.length) {
    throw new Error(
      `ACTION_SUGGESTION_SET_BLOCKED: ${submissionIssues.slice(0, 8).join(" ")}`,
    );
  }
  const modelMessage = input.deferNarration
    ? undefined
    : await narrateValidatedAuthoringStep({
        session: narrationSession(input),
        operatorMessage: jobIntent,
        validatedFacts: actionSuggestionNarrationFacts(assessments, input.options),
        env: input.env,
        egressAcknowledged: input.egressAcknowledged,
        signal: input.signal,
      });
  return {
    assessments,
    provider: input.provider,
    model: input.model,
    authority_granted: false,
    source_database_changed: false,
    ...(modelMessage ? { model_message: modelMessage } : {}),
    ...(discardedApprovalPolicyProposals
      ? { discarded_approval_policy_proposals: discardedApprovalPolicyProposals }
      : {}),
    ...(usage ? { usage } : {}),
  };
}

function narrationSession(input: {
  provider: AskProvider;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  dependencies?: AskProviderDependencies;
  conversation?: ModelAuthoringConversation;
}) {
  return {
    provider: input.provider,
    model: input.model,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
    ...(input.conversation ? { conversation: input.conversation } : {}),
  };
}

function actionSuggestionNarrationFacts(
  assessments: ActionSuggestionAssessment[],
  options: GuidedActionOptions,
): string[] {
  const resources = new Map(options.resources.map((resource) => [resource.id, resource]));
  return [
    `${assessments.length} Action suggestion${assessments.length === 1 ? "" : "s"} passed exact catalog validation.`,
    ...assessments.map((assessment) => {
      const suggestion = assessment.suggestion;
      const fields = suggestion.fields?.length ? suggestion.fields.join(", ") : "no agent-supplied fields";
      const resource = suggestion.resource ? resources.get(suggestion.resource) : undefined;
      const scope = resource?.principal_key
        ? `trusted tenant plus principal scope (${resource.tenant_key} + ${resource.principal_key})`
        : resource?.principal_rls_setting
          ? `trusted tenant plus PostgreSQL RLS principal scope (${resource.tenant_key} + ${resource.principal_rls_setting})`
        : resource?.tenant_key
          ? `trusted tenant-only scope (${resource.tenant_key}); no principal row limit is configured`
          : resource?.organization_scope
            ? "reviewed whole-organization scope; no principal row limit is configured"
            : "reviewed scope posture";
      return `${(suggestion.operation ?? "propose").toUpperCase()} ${suggestion.resource ?? "reviewed target"}; agent fields: ${fields}; ${scope}.`;
    }),
    "Every suggestion is still a disabled proposal-only draft. Approval, apply, and source writes remain off.",
    "This record describes only the Action-suggestion step. The separately validated Read draft remains unchanged; do not describe its reads as absent or rolled back.",
    "If a requested business change is absent from these Action targets or fields, explain that mismatch now instead of treating another action as a substitute.",
  ];
}

function suggestionSetIssues(assessments: ActionSuggestionAssessment[]): string[] {
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const [index, assessment] of assessments.entries()) {
    const suggestion = assessment.suggestion;
    const identity = canonicalJsonDigest({
      operation: suggestion.operation,
      resource: suggestion.resource,
      fields: suggestion.fields ?? [],
    });
    if (seen.has(identity)) issues.push(`Suggestion ${index + 1} duplicates another action effect.`);
    seen.add(identity);
    issues.push(...assessment.blockers.map((blocker) => `Suggestion ${index + 1}: ${blocker}`));
  }
  return issues;
}

function recoverSuggestionWithoutInvalidApprovalPolicy(
  assessment: ActionSuggestionAssessment,
  resources: GuidedActionOptions["resources"],
): { assessment: ActionSuggestionAssessment; discarded: boolean } {
  if (assessment.status !== "blocked" || !assessment.suggestion.approval_policy_proposal) {
    return { assessment, discarded: false };
  }
  const { approval_policy_proposal: _discarded, ...suggestion } = assessment.suggestion;
  const recovered = assessActionSuggestion(suggestion, resources);
  return recovered.status === "suggested"
    ? { assessment: recovered, discarded: true }
    : { assessment, discarded: false };
}

function suggestionCatalog(options: GuidedActionOptions) {
  const resources = options.resources.map((resource) => ({
    id: resource.id,
    ...(resource.label ? { label: resource.label } : {}),
    ...(resource.description ? { description: resource.description } : {}),
    operations: Object.fromEntries(Object.entries(resource.operation_availability).map(([operation, posture]) => [
      operation,
      { available: posture.available, reason: posture.reason },
    ])),
    structurally_eligible_fields: resource.structurally_eligible_fields.map((field) => ({
      id: field.name,
      ...(field.label ? { label: field.label } : {}),
      ...(field.description ? { description: field.description } : {}),
      type: field.data_type,
      ...(field.enum_values.length
        ? {
            enum: field.enum_values,
            enum_source: "schema_declared_enum_or_check",
          }
        : {}),
      required_for_insert: field.required_for_insert,
      ...(field.suggested_numeric_minimum !== undefined
        ? { suggested_numeric_minimum: field.suggested_numeric_minimum }
        : {}),
      ...(field.suggested_numeric_maximum !== undefined
        ? { suggested_numeric_maximum: field.suggested_numeric_maximum }
        : {}),
    })),
    trusted_limit_scopes: [
      "tenant",
      ...(resource.principal_key || resource.principal_rls_setting ? ["tenant_principal"] : []),
      "tenant_object",
    ],
  }));
  const core = {
    schema_version: "synapsor.action-suggestion-catalog.v1",
    boundary_digest: options.boundary_digest,
    resources,
  };
  return { ...core, digest: canonicalJsonDigest(core) };
}

function suggestionToolDefinition(catalog: ReturnType<typeof suggestionCatalog>): AskToolDefinition {
  return {
    name: SUBMIT_SUGGESTION_TOOL,
    title: "Submit one non-authoritative Safe Action suggestion",
    description: "Submit one bounded candidate using exact reviewed ids. This never grants authority, activates a tool, approves a proposal, applies a change, or selects trusted identity.",
    input_schema: suggestionObjectSchema(catalog),
    metadata: {
      "synapsor.authority_granted": false,
      "synapsor.source_database_changed": false,
    },
  };
}

function suggestionSetToolDefinition(catalog: ReturnType<typeof suggestionCatalog>): AskToolDefinition {
  return {
    name: SUBMIT_SUGGESTION_SET_TOOL,
    title: "Submit distinct non-authoritative Safe Action suggestions",
    description: "Submit 1 through 8 distinct structural action candidates. Every item remains disabled operator-review input and grants no authority.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["suggestions"],
      properties: {
        suggestions: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: suggestionObjectSchema(catalog),
        },
      },
    },
    metadata: {
      "synapsor.authority_granted": false,
      "synapsor.source_database_changed": false,
    },
  };
}

function suggestionObjectSchema(catalog: ReturnType<typeof suggestionCatalog>): Record<string, unknown> {
  const resourceIds = catalog.resources.map((resource) => resource.id);
  const fieldIds = [...new Set(catalog.resources.flatMap((resource) =>
    resource.structurally_eligible_fields.map((field) => field.id)))].sort();
  return {
    type: "object",
    additionalProperties: false,
    required: ["intent", "operation", "resource"],
    properties: {
      intent: { type: "string", minLength: 1, maxLength: 500 },
      operation: { type: "string", enum: ["insert", "update", "delete"] },
      resource: { type: "string", enum: resourceIds },
      fields: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        uniqueItems: true,
        items: fieldIds.length
          ? { type: "string", enum: fieldIds }
          : { type: "string", minLength: 1, maxLength: 256 },
      },
      rationale: { type: "string", minLength: 1, maxLength: 500 },
      approval_policy_proposal: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "conditions", "max_per_day"],
        properties: {
          mode: { type: "string", enum: ["deterministic"] },
          conditions: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["field", "operator"],
              properties: {
                source: { type: "string", enum: ["patch", "before"] },
                field: { type: "string", minLength: 1, maxLength: 256 },
                operator: { type: "string", enum: ["lte", "gte", "eq", "in", "max_length"] },
                value: { type: ["string", "number", "boolean"] },
                values: {
                  type: "array",
                  minItems: 1,
                  maxItems: 64,
                  items: { type: ["string", "number", "boolean"] },
                },
              },
            },
          },
          max_per_day: { type: "integer", minimum: 1, maximum: 1_000_000 },
          max_total_per_day: { type: "integer", minimum: 1, maximum: 1_000_000_000 },
          total_field: { type: "string", minLength: 1, maxLength: 256 },
          shared_limits: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "scope", "maximum", "window_seconds"],
              properties: {
                kind: { type: "string", enum: ["count", "total"] },
                scope: { type: "string", enum: ["tenant", "tenant_principal", "tenant_object"] },
                maximum: { type: "integer", minimum: 1 },
                window_seconds: { type: "integer", minimum: 60, maximum: 31_536_000 },
                field: { type: "string", minLength: 1, maxLength: 256 },
              },
            },
          },
          rationale: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
  };
}

function suggestionSetRefusal(message: string): Awaited<ReturnType<AskToolGateway["callTool"]>> {
  return {
    ok: false,
    value: {
      error_code: "ACTION_SUGGESTION_SET_BLOCKED",
      message,
      authority_granted: false,
      source_database_changed: false,
    },
    error_code: "ACTION_SUGGESTION_SET_BLOCKED",
  };
}

function mergeUsage(
  left: ModelActionSuggestionResult["usage"],
  right: ModelActionSuggestionResult["usage"],
): ModelActionSuggestionResult["usage"] {
  if (!left && !right) return undefined;
  const merged: NonNullable<ModelActionSuggestionResult["usage"]> = {};
  const add = (key: keyof NonNullable<ModelActionSuggestionResult["usage"]>) => {
    const values = [left?.[key], right?.[key]].filter((value): value is number => typeof value === "number");
    if (values.length) merged[key] = values.reduce((sum, value) => sum + value, 0);
  };
  add("input_tokens");
  add("output_tokens");
  add("total_tokens");
  return merged;
}

function safeIntent(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 500 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("ACTION_SUGGESTION_INTENT_INVALID: intent must be 1 through 500 safe characters.");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

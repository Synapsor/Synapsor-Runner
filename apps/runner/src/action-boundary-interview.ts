import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionBoundarySharedLimitV1 } from "@synapsor-runner/protocol";
import type { ArgumentSpec, JsonScalar } from "@synapsor/spec";
import { runRequiredAuthoringToolCall } from "./authoring-tool-call.js";
import type {
  GuidedActionAutoApprovalCondition,
  GuidedActionAutoApprovalInput,
  GuidedActionInput,
  GuidedActionResourceOption,
} from "./guided-action.js";
import type { QuickProposalDecision, QuickProposalDecisions } from "./guided-action-quick.js";
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
  modelAuthoringHistory,
  rememberModelAuthoringTurn,
  type ModelAuthoringConversation,
} from "./model-authoring-conversation.js";
import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";

const INTERPRET_DECISION_TOOL = "runner.interpret_action_boundary_answer";
const INTERPRET_POLICY_TOOL = "runner.interpret_action_approval_policy";
const INTERPRET_REHEARSAL_TOOL = "runner.interpret_action_rehearsal_values";

export type ActionBoundaryInterviewSession = {
  provider: AskProvider;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  dependencies?: AskProviderDependencies;
  conversation?: ModelAuthoringConversation;
};

export type OperatorApprovedValueContext = {
  field: string;
  values: string[];
  egressAcknowledged: true;
};

export type ActionBoundaryDecisionResolution =
  | {
      state: "resolved";
      decisions: QuickProposalDecisions;
      summary: string;
      rationale?: string;
      model_message?: string;
      correction_used: boolean;
      authority_granted: false;
      source_database_changed: false;
    }
  | {
      state: "clarification";
      question: string;
      model_message?: string;
      correction_used: boolean;
      authority_granted: false;
      source_database_changed: false;
    }
  | {
      state: "value_request";
      field: string;
      reason: string;
      question: string;
      model_message?: string;
      correction_used: boolean;
      authority_granted: false;
      source_database_changed: false;
    };

export type ActionBoundaryPolicyResolution =
  | {
      state: "resolved";
      auto_approval: GuidedActionAutoApprovalInput;
      shared_limits: Array<Omit<ActionBoundarySharedLimitV1, "id" | "capability">>;
      rationale?: string;
      model_message?: string;
      correction_used: boolean;
      authority_granted: false;
      source_database_changed: false;
    }
  | {
      state: "clarification";
      question: string;
      model_message?: string;
      correction_used: boolean;
      authority_granted: false;
      source_database_changed: false;
    }
  | {
      state: "value_request";
      field: string;
      reason: string;
      question: string;
      model_message?: string;
      correction_used: boolean;
      authority_granted: false;
      source_database_changed: false;
    };

export type ActionRehearsalResolution =
  | {
      state: "resolved";
      args: Record<string, JsonScalar>;
      summary: string[];
      rationale?: string;
      model_message?: string;
      correction_used: boolean;
      authority_granted: false;
      source_database_changed: false;
    }
  | {
      state: "clarification";
      question: string;
      model_message?: string;
      correction_used: boolean;
      authority_granted: false;
      source_database_changed: false;
    };

export function actionBoundaryDecisionQuestion(
  decision: Exclude<QuickProposalDecision, { kind: "delete_confirmation" }>,
  target?: string,
): { label: string; context: string[] } {
  if (decision.kind === "numeric_bounds") {
    const action = target ?? "this proposal action";
    return {
      label: `What is the smallest and largest ${humanizeIdentifier(decision.field)} the agent may propose?`,
      context: [
        ...(target ? [`Action: ${target}`] : []),
        `Reviewed proposal field: ${decision.field}`,
        `Where used: every ${action} proposal may supply ${decision.field} only inside the confirmed range.`,
        "Outside this range: Runner refuses the proposal before approval. Auto-approval may use a narrower range later.",
        "Answer in ordinary language. State both ends and include the business unit when it matters.",
        "Result: one disabled proposal bound for your exact confirmation; no activation or database write.",
      ],
    };
  }
  if (decision.kind === "fields") {
    return {
      label: "Which business values should the agent be allowed to supply?",
      context: [
        ...(target ? [`Action: ${target}`] : []),
        `Reviewed choices: ${decision.choices.map((choice) => choice.label).join("; ")}`,
        "Where used: confirmed fields become the only business values the agent may supply in this proposal action.",
        "Trusted tenant/principal scope, approval, and apply remain Runner-controlled.",
        "Describe the needed values in ordinary language. Runner will show the exact reviewed field IDs before saving them.",
      ],
    };
  }
  const usage = decision.kind === "operation"
    ? "Where used: this selects the proposal effect (INSERT, UPDATE, or DELETE); it does not execute that effect."
    : decision.kind === "resource"
      ? "Where used: this selects the one reviewed table the proposal action may target."
      : "Where used: this reviewed key prevents duplicate INSERT proposals or detects a stale UPDATE proposal.";
  return {
    label: decision.title,
    context: [
      ...(target ? [`Action: ${target}`] : []),
      decision.help,
      `Reviewed choices: ${decision.choices.map((choice) => choice.label).join("; ")}`,
      usage,
      "Answer in ordinary language. Runner will show the exact reviewed choice before saving it.",
    ],
  };
}

/**
 * Converts one operator answer into one typed authoring decision. The model
 * receives only that answer and the bounded reviewed choice/range metadata.
 * Runner validates the tool payload and the caller still confirms it.
 */
export async function interpretActionBoundaryDecision(input: {
  session: ActionBoundaryInterviewSession;
  decision: Exclude<QuickProposalDecision, { kind: "delete_confirmation" }>;
  answer: string;
  intent: string;
  target?: string;
  env?: NodeJS.ProcessEnv;
  egressAcknowledged: boolean;
  operatorApprovedValues?: OperatorApprovedValueContext;
  signal?: AbortSignal;
}): Promise<ActionBoundaryDecisionResolution> {
  const answer = safeOperatorText(input.answer, "Action Boundary answer", 2_000);
  const intent = safeOperatorText(input.intent, "Action intent", 1_000);
  const catalog = decisionCatalog(input.decision);
  const approvedValues = validateOperatorApprovedValues(
    input.operatorApprovedValues,
    new Set(decisionValueFields(input.decision)),
  );
  const tools: AskToolDefinition[] = [decisionToolDefinition(input.decision)];
  const authorityDigest = askToolSurfaceDigest(tools);
  const configuration = interviewConfiguration(input.session, authorityDigest, input.egressAcknowledged, input.env);
  let resolution: ActionBoundaryDecisionResolution | undefined;
  let issue = "The model did not submit a complete interpretation.";
  let callCount = 0;
  const gateway: AskToolGateway = {
    mode: "authoring",
    listTools: () => tools,
    async callTool(name, args) {
      callCount += 1;
      if (name !== INTERPRET_DECISION_TOOL || callCount > 2) {
        return interviewRefusal("Runner accepts one interpretation and one bounded correction only.");
      }
      try {
        resolution = parseDecisionResolution(input.decision, args);
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
        return interviewRefusal(issue);
      }
    },
    async close() {},
  };
  const baseQuestion = [
    "Interpret one operator answer for one unresolved Synapsor Action Boundary decision.",
    `Business action: ${intent}`,
    ...(input.target ? [`Exact reviewed target: ${input.target}`] : []),
    `Unresolved decision: ${JSON.stringify(catalog)}`,
    `Operator answer: ${JSON.stringify(answer)}`,
    ...(approvedValues
      ? [`Separately approved value context for ${approvedValues.field}: ${JSON.stringify(approvedValues.values)}`]
      : ["Separately approved observed-value context: none."]),
    `Call ${INTERPRET_DECISION_TOOL} exactly once.`,
    "If the answer has one unambiguous meaning inside the reviewed choices, submit status resolved and only the exact bounded value(s).",
    "For a numeric field whose identifier or label names a unit, convert ordinary units to that reviewed unit (for example two hours to 120 minutes).",
    "If the answer is ambiguous or contradictory, submit status clarification with one short business-language question. Never guess.",
    "If and only if observed source values are indispensable, submit status value_request with one exact reviewed field, a reason, and a question. Runner has not queried or sent those values and will ask the operator separately.",
    "Do not emit SQL, identity values, approval decisions, activation, execution, or apply authority.",
  ].join("\n");
  const run = (question: string) => runAskProviderTurn({
    configuration,
    question,
    history: modelAuthoringHistory(input.session.conversation),
    gateway,
    tools,
    signal: input.signal ?? new AbortController().signal,
    dependencies: input.session.dependencies,
    authorityDigest,
    providerSystemPrompt: [
      "You translate one human business-policy answer into one bounded authoring tool call.",
      "Use only the exact choices and types supplied by Runner. Ask for clarification instead of guessing.",
      approvedValues
        ? "Use only the separately approved exact value context when needed. Do not infer, request, or emit any other database value."
        : "Do not infer, request, or emit database values; request one exact field through the structured value_request state only when indispensable.",
      "You do not grant authority and must not emit SQL, credentials, trusted identity, activation, approval decisions, execution, or apply instructions.",
    ].join(" "),
    skipRunnerQuestionContext: true,
    requiredInitialToolName: INTERPRET_DECISION_TOOL,
    completeAfterRequiredTool: true,
    authorityGuard: () => canonicalJsonDigest(catalog) === canonicalJsonDigest(decisionCatalog(input.decision))
      ? authorityDigest
      : canonicalJsonDigest({ stale: true }),
  });
  const initial = await runRequiredAuthoringToolCall({
    run,
    question: baseQuestion,
    toolName: INTERPRET_DECISION_TOOL,
  });
  let correctionUsed = initial.correction_used;
  if (!resolution && !correctionUsed) {
    correctionUsed = true;
    await run([
      "Runner rejected the first interpretation. Do not repeat it.",
      `Validation issue: ${issue.slice(0, 700)}`,
      "Call the required tool once with a corrected bounded interpretation, or ask one clarification question.",
      baseQuestion,
    ].join("\n"));
  }
  if (!resolution) {
    throw new Error(`ACTION_BOUNDARY_INTERVIEW_INVALID: ${issue}`);
  }
  const modelMessage = await decisionModelMessage({
    session: input.session,
    resolution,
    answer,
    intent,
    target: input.target,
    env: input.env,
    egressAcknowledged: input.egressAcknowledged,
    signal: input.signal,
  });
  return {
    ...resolution,
    correction_used: correctionUsed,
    ...(modelMessage ? { model_message: modelMessage } : {}),
  };
}

/**
 * Interprets one natural-language approval rule into the fixed deterministic
 * policy grammar. Numeric intersection with proposal bounds is performed by
 * the quick-action compiler after this structural validation.
 */
export async function interpretActionBoundaryPolicy(input: {
  session: ActionBoundaryInterviewSession;
  action: GuidedActionInput;
  resource: GuidedActionResourceOption;
  answer: string;
  current?: {
    auto_approval: GuidedActionAutoApprovalInput;
    shared_limits: ActionBoundarySharedLimitV1[];
  };
  env?: NodeJS.ProcessEnv;
  egressAcknowledged: boolean;
  operatorApprovedValues?: OperatorApprovedValueContext;
  signal?: AbortSignal;
}): Promise<ActionBoundaryPolicyResolution> {
  if (input.action.operation === "delete") {
    throw new Error("ACTION_BOUNDARY_INTERVIEW_DELETE_REFUSED: hard DELETE cannot use deterministic auto-approval.");
  }
  const answer = safeOperatorText(input.answer, "Approval-policy answer", 3_000);
  const catalog = policyCatalog(input.action, input.resource, input.current);
  const requiredLimitScope = requiredTrustedPolicyScope(answer, input.resource);
  const approvedValues = validateOperatorApprovedValues(
    input.operatorApprovedValues,
    new Set(catalog.action.fields.map((field) => field.id)),
  );
  const tools: AskToolDefinition[] = [policyToolDefinition(catalog)];
  const authorityDigest = askToolSurfaceDigest(tools);
  const configuration = interviewConfiguration(input.session, authorityDigest, input.egressAcknowledged, input.env);
  let resolution: ActionBoundaryPolicyResolution | undefined;
  let issue = "The model did not submit a complete deterministic policy interpretation.";
  let callCount = 0;
  const gateway: AskToolGateway = {
    mode: "authoring",
    listTools: () => tools,
    async callTool(name, args) {
      callCount += 1;
      if (name !== INTERPRET_POLICY_TOOL || callCount > 2) {
        return interviewRefusal("Runner accepts one policy interpretation and one bounded correction only.");
      }
      try {
        resolution = parsePolicyResolution(args, input.action, input.resource, requiredLimitScope, answer);
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
        return interviewRefusal(issue);
      }
    },
    async close() {},
  };
  const baseQuestion = [
    "Interpret the operator's business rule as one deterministic Synapsor auto-approval policy.",
    `Exact bounded action catalog: ${JSON.stringify(catalog)}`,
    `Operator answer: ${JSON.stringify(answer)}`,
    ...(approvedValues
      ? [`Separately approved value context for ${approvedValues.field}: ${JSON.stringify(approvedValues.values)}`]
      : ["Separately approved observed-value context: none."]),
    `Call ${INTERPRET_POLICY_TOOL} exactly once.`,
    "Every model-controlled proposal field must have at least one condition. Use the full reviewed proposal envelope for a field when the operator does not narrow it.",
    "All conditions are ANDed. A failed, missing, or indeterminate condition falls back to human review.",
    "Use max_per_day as a per-action rolling 24-hour circuit breaker. Use shared_limits only with the listed trusted scopes; the model never supplies scope identity values.",
    ...(requiredLimitScope
      ? [`The operator explicitly scoped the limit ${requiredLimitScope.phrase}. Include at least one shared_limits entry with scope ${requiredLimitScope.scope}; max_per_day alone does not preserve that trusted scope.`]
      : []),
    "If the business rule does not state enough information to choose exact thresholds or circuit breakers, submit one clarification question. Never invent a number.",
    "If and only if observed source values are indispensable, submit status value_request with one exact proposal field, a reason, and a question. Runner has not queried or sent those values and will ask the operator separately.",
    "Do not approve a proposal, activate authority, execute, apply, emit SQL, or include tenant/principal values.",
  ].join("\n");
  const run = (question: string) => runAskProviderTurn({
    configuration,
    question,
    history: modelAuthoringHistory(input.session.conversation),
    gateway,
    tools,
    signal: input.signal ?? new AbortController().signal,
    dependencies: input.session.dependencies,
    authorityDigest,
    providerSystemPrompt: [
      "You translate one operator business rule into the fixed deterministic approval-policy tool schema.",
      "Use exact reviewed field ids, values, operators, and trusted limit scopes only. Ask one clarification question instead of inventing a threshold.",
      approvedValues
        ? "Use only the separately approved exact value context when needed. Do not infer, request, or emit any other database value."
        : "Do not infer, request, or emit database values; use value_request for one exact proposal field only when indispensable.",
      "The result is untrusted review input and grants no approval, activation, execution, apply, SQL, credential, or trusted-identity authority.",
    ].join(" "),
    skipRunnerQuestionContext: true,
    requiredInitialToolName: INTERPRET_POLICY_TOOL,
    completeAfterRequiredTool: true,
    authorityGuard: () => canonicalJsonDigest(catalog) === canonicalJsonDigest(policyCatalog(input.action, input.resource, input.current))
      ? authorityDigest
      : canonicalJsonDigest({ stale: true }),
  });
  const initial = await runRequiredAuthoringToolCall({
    run,
    question: baseQuestion,
    toolName: INTERPRET_POLICY_TOOL,
  });
  let correctionUsed = initial.correction_used;
  if (!resolution && !correctionUsed) {
    correctionUsed = true;
    await run([
      "Runner rejected the first policy interpretation. Do not repeat it.",
      `Validation issue: ${issue.slice(0, 700)}`,
      "Call the required tool once with a complete corrected policy, or ask one clarification question.",
      baseQuestion,
    ].join("\n"));
  }
  if (!resolution) {
    throw new Error(`ACTION_BOUNDARY_POLICY_INTERVIEW_INVALID: ${issue}`);
  }
  const modelMessage = await policyModelMessage({
    session: input.session,
    resolution,
    answer,
    action: input.action,
    env: input.env,
    egressAcknowledged: input.egressAcknowledged,
    signal: input.signal,
  });
  return {
    ...resolution,
    correction_used: correctionUsed,
    ...(modelMessage ? { model_message: modelMessage } : {}),
  };
}

/**
 * Converts one ordinary-language rehearsal example into the exact scalar
 * arguments already defined by the compiled disabled contract. This creates
 * no proposal and grants no authority; the caller separately confirms and
 * executes the disposable rehearsal.
 */
export async function interpretActionRehearsalArgs(input: {
  session: ActionBoundaryInterviewSession;
  capability: string;
  target: string;
  args: Record<string, ArgumentSpec>;
  answer: string;
  env?: NodeJS.ProcessEnv;
  egressAcknowledged: boolean;
  signal?: AbortSignal;
}): Promise<ActionRehearsalResolution> {
  const answer = safeOperatorText(input.answer, "Action rehearsal answer", 3_000);
  const catalog = rehearsalCatalog(input.capability, input.target, input.args);
  const tools: AskToolDefinition[] = [rehearsalToolDefinition(catalog)];
  const authorityDigest = askToolSurfaceDigest(tools);
  const configuration = interviewConfiguration(
    input.session,
    authorityDigest,
    input.egressAcknowledged,
    input.env,
  );
  let resolution: ActionRehearsalResolution | undefined;
  let issue = "The model did not submit complete rehearsal values.";
  let callCount = 0;
  const gateway: AskToolGateway = {
    mode: "authoring",
    listTools: () => tools,
    async callTool(name, args) {
      callCount += 1;
      if (name !== INTERPRET_REHEARSAL_TOOL || callCount > 2) {
        return interviewRefusal("Runner accepts one rehearsal interpretation and one bounded correction only.");
      }
      try {
        resolution = parseRehearsalResolution(args, input.args);
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
        return interviewRefusal(issue);
      }
    },
    async close() {},
  };
  const baseQuestion = [
    "Translate one operator-provided disposable rehearsal example into exact arguments for one disabled Synapsor proposal action.",
    `Capability: ${input.capability}`,
    `Target: ${input.target}`,
    `Exact compiled argument catalog: ${JSON.stringify(catalog.arguments)}`,
    `Operator answer: ${JSON.stringify(answer)}`,
    `Call ${INTERPRET_REHEARSAL_TOOL} exactly once.`,
    "Submit every exact argument key in the catalog and no other key.",
    "Use only listed enum values and stay inside every numeric and text bound.",
    "If one required value is missing or ambiguous, submit one short clarification question instead of inventing it.",
    "These are disposable proposal arguments only. Do not emit or request trusted tenant/principal values, credentials, SQL, approval, activation, apply, or source-write authority.",
  ].join("\n");
  const run = (question: string) => runAskProviderTurn({
    configuration,
    question,
    history: modelAuthoringHistory(input.session.conversation),
    gateway,
    tools,
    signal: input.signal ?? new AbortController().signal,
    dependencies: input.session.dependencies,
    authorityDigest,
    providerSystemPrompt: [
      "You translate one natural-language example into one required typed rehearsal tool call.",
      "Use only the exact compiled argument names, types, enum values, and bounds supplied by Runner.",
      "Ask one concise clarification question rather than guessing a missing value.",
      "Never include trusted identity, credentials, SQL, authority, approval, apply, or source-write instructions.",
    ].join(" "),
    skipRunnerQuestionContext: true,
    requiredInitialToolName: INTERPRET_REHEARSAL_TOOL,
    completeAfterRequiredTool: true,
    authorityGuard: () => canonicalJsonDigest(catalog) === canonicalJsonDigest(
      rehearsalCatalog(input.capability, input.target, input.args),
    ) ? authorityDigest : canonicalJsonDigest({ stale: true }),
  });
  const initial = await runRequiredAuthoringToolCall({
    run,
    question: baseQuestion,
    toolName: INTERPRET_REHEARSAL_TOOL,
  });
  let correctionUsed = initial.correction_used;
  if (!resolution && !correctionUsed) {
    correctionUsed = true;
    await run([
      "Runner rejected the first rehearsal interpretation. Do not repeat it.",
      `Validation issue: ${issue.slice(0, 700)}`,
      "Call the required tool once with corrected exact arguments, or ask one clarification question.",
      baseQuestion,
    ].join("\n"));
  }
  if (!resolution) throw new Error(`ACTION_REHEARSAL_INTERVIEW_INVALID: ${issue}`);
  if (resolution.state === "clarification") {
    return {
      ...resolution,
      model_message: resolution.question,
      correction_used: correctionUsed,
    };
  }
  const modelMessage = await narrateValidatedAuthoringStep({
    session: input.session,
    operatorMessage: answer,
    validatedFacts: [
      `Disposable rehearsal target: ${input.target}`,
      ...resolution.summary,
      "Runner will inject trusted context separately; it was not supplied by the model.",
      "No proposal, authority, approval, apply, source query, or source write has occurred.",
    ],
    nextQuestion: "Should I run this exact disposable rehearsal?",
    env: input.env,
    egressAcknowledged: input.egressAcknowledged,
    signal: input.signal,
  });
  return {
    ...resolution,
    ...(modelMessage ? { model_message: modelMessage } : {}),
    correction_used: correctionUsed,
  };
}

async function decisionModelMessage(input: {
  session: ActionBoundaryInterviewSession;
  resolution: ActionBoundaryDecisionResolution;
  answer: string;
  intent: string;
  target?: string;
  env?: NodeJS.ProcessEnv;
  egressAcknowledged: boolean;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  if (input.resolution.state !== "resolved") {
    rememberModelAuthoringTurn(
      input.session.conversation,
      input.answer,
      input.resolution.question,
    );
    return input.resolution.question;
  }
  const narration = await narrateValidatedAuthoringStep({
    session: input.session,
    operatorMessage: input.answer,
    validatedFacts: [
      `Business action: ${input.intent}`,
      ...(input.target ? [`Current exact action target: ${input.target}`] : []),
      `Runner accepted this interpretation for the disabled draft: ${input.resolution.summary}`,
      "No authority was granted and no source row changed.",
    ],
    nextQuestion: "Should I use this exact interpretation in the disabled draft?",
    env: input.env,
    egressAcknowledged: input.egressAcknowledged,
    signal: input.signal,
  });
  return narration ?? input.resolution.rationale;
}

async function policyModelMessage(input: {
  session: ActionBoundaryInterviewSession;
  resolution: ActionBoundaryPolicyResolution;
  answer: string;
  action: GuidedActionInput;
  env?: NodeJS.ProcessEnv;
  egressAcknowledged: boolean;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  if (input.resolution.state !== "resolved") {
    rememberModelAuthoringTurn(
      input.session.conversation,
      input.answer,
      input.resolution.question,
    );
    return input.resolution.question;
  }
  const target = `${input.action.operation.toUpperCase()} ${input.action.resource}`;
  const conditions = input.resolution.auto_approval.conditions ?? [];
  const narration = await narrateValidatedAuthoringStep({
    session: input.session,
    operatorMessage: input.answer,
    validatedFacts: [
      `Current exact action target: ${target}.`,
      `${conditions.length} deterministic condition${conditions.length === 1 ? "" : "s"} passed Runner validation.`,
      `Per-action rolling 24-hour maximum: ${input.resolution.auto_approval.max_per_day}.`,
      ...input.resolution.shared_limits.map((limit) =>
        `Trusted ${limit.scope} ${limit.kind} limit: ${limit.maximum} per ${limit.window_seconds} seconds${limit.kind === "total" ? ` on ${limit.field}` : ""}.`),
      "Any failed, missing, or uncertain check falls back to human review. Approval and apply authority remain off.",
    ],
    nextQuestion: "Should I use this exact policy in the disabled draft?",
    env: input.env,
    egressAcknowledged: input.egressAcknowledged,
    signal: input.signal,
  });
  return narration ?? input.resolution.rationale;
}

function interviewConfiguration(
  session: ActionBoundaryInterviewSession,
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
    max_output_tokens: 1_600,
  }, env, new Date());
}

function decisionCatalog(decision: Exclude<QuickProposalDecision, { kind: "delete_confirmation" }>) {
  return {
    schema_version: "synapsor.action-boundary-interview-decision.v1",
    kind: decision.kind,
    title: decision.title,
    help: decision.help,
    ...(decision.kind === "numeric_bounds"
      ? {
          field: decision.field,
          suggested_minimum: decision.suggested_minimum ?? null,
          suggested_maximum: decision.suggested_maximum ?? null,
        }
      : {
          choices: decision.choices.map((choice) => ({
            value: choice.value,
            label: choice.label,
            detail: choice.detail ?? null,
          })),
        }),
  };
}

function decisionToolDefinition(
  decision: Exclude<QuickProposalDecision, { kind: "delete_confirmation" }>,
): AskToolDefinition {
  const choiceValues = decision.kind === "numeric_bounds"
    ? []
    : decision.choices.map((choice) => choice.value);
  const rationale = { type: "string", minLength: 1, maxLength: 500 };
  const resolved = decision.kind === "numeric_bounds"
    ? {
        type: "object",
        additionalProperties: false,
        required: ["status", "minimum", "maximum"],
        properties: {
          status: { type: "string", enum: ["resolved"] },
          minimum: { type: "number" },
          maximum: { type: "number" },
          rationale,
        },
      }
    : decision.kind === "fields"
      ? {
          type: "object",
          additionalProperties: false,
          required: ["status", "values"],
          properties: {
            status: { type: "string", enum: ["resolved"] },
            values: {
              type: "array",
              minItems: 1,
              maxItems: Math.max(1, choiceValues.length),
              uniqueItems: true,
              items: { type: "string", enum: choiceValues },
            },
            rationale,
          },
        }
      : {
          type: "object",
          additionalProperties: false,
          required: ["status", "value"],
          properties: {
            status: { type: "string", enum: ["resolved"] },
            value: { type: "string", enum: choiceValues },
            rationale,
          },
        };
  const valueFields = decisionValueFields(decision);
  return {
    name: INTERPRET_DECISION_TOOL,
    title: "Interpret one Action Boundary answer",
    description: "Submit one bounded interpretation or one clarification question. This never grants authority or changes source data.",
    input_schema: {
      oneOf: [
        resolved,
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "question"],
          properties: {
            status: { type: "string", enum: ["clarification"] },
            question: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        ...(valueFields.length
          ? [{
              type: "object",
              additionalProperties: false,
              required: ["status", "requested_field", "value_reason", "question"],
              properties: {
                status: { type: "string", enum: ["value_request"] },
                requested_field: { type: "string", enum: valueFields },
                value_reason: { type: "string", minLength: 1, maxLength: 500 },
                question: { type: "string", minLength: 1, maxLength: 500 },
              },
            }]
          : []),
      ],
    },
    metadata: {
      "synapsor.authority_granted": false,
      "synapsor.source_database_changed": false,
    },
  };
}

function parseDecisionResolution(
  decision: Exclude<QuickProposalDecision, { kind: "delete_confirmation" }>,
  value: Record<string, unknown>,
): ActionBoundaryDecisionResolution {
  if (value.status === "clarification") {
    return {
      state: "clarification",
      question: interpretationQuestion(value),
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    };
  }
  if (value.status === "value_request") {
    const field = requiredShortText(value.requested_field, "requested_field");
    const allowedFields = new Set(decisionValueFields(decision));
    if (!allowedFields.has(field)) {
      throw new Error("requested_field must be one exact field in this unresolved decision.");
    }
    return {
      state: "value_request",
      field,
      reason: requiredShortText(value.value_reason, "value_reason"),
      question: interpretationQuestion(value),
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    };
  }
  if (value.status !== "resolved") {
    throw new Error("status must be resolved, clarification, or value_request.");
  }
  const rationale = optionalShortText(value.rationale, "rationale");
  if (decision.kind === "numeric_bounds") {
    const minimum = finiteNumber(value.minimum, "minimum");
    const maximum = finiteNumber(value.maximum, "maximum");
    if (minimum > maximum) throw new Error("minimum must be less than or equal to maximum.");
    return {
      state: "resolved",
      decisions: { numeric_bounds: { [decision.field]: { minimum, maximum } } },
      summary: `${decision.field}: ${minimum} through ${maximum}`,
      ...(rationale ? { rationale } : {}),
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    };
  }
  const allowed = new Set(decision.choices.map((choice) => choice.value));
  if (decision.kind === "fields") {
    if (!Array.isArray(value.values)) throw new Error("values must contain one or more reviewed field ids.");
    const values = [...new Set(value.values.map((item) => String(item)))];
    if (!values.length || values.some((item) => !allowed.has(item))) {
      throw new Error("values must contain only exact reviewed field ids.");
    }
    return {
      state: "resolved",
      decisions: { fields: values },
      summary: `Model-supplied proposal fields: ${values.join(", ")}`,
      ...(rationale ? { rationale } : {}),
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    };
  }
  const selected = requiredShortText(value.value, "value");
  if (!allowed.has(selected)) throw new Error("value must be one exact reviewed choice.");
  const decisions: QuickProposalDecisions = decision.kind === "resource"
    ? { resource: selected }
    : decision.kind === "operation"
      ? { operation: selected as QuickProposalDecisions["operation"] }
      : { guard_column: selected };
  return {
    state: "resolved",
    decisions,
    summary: `${humanizeIdentifier(decision.kind)}: ${selected}`,
    ...(rationale ? { rationale } : {}),
    correction_used: false,
    authority_granted: false,
    source_database_changed: false,
  };
}

function rehearsalCatalog(
  capability: string,
  target: string,
  args: Record<string, ArgumentSpec>,
) {
  const entries = Object.entries(args);
  if (!entries.length || entries.length > 64) {
    throw new Error("ACTION_REHEARSAL_ARGUMENTS_INVALID: a guided rehearsal needs 1 through 64 scalar arguments.");
  }
  return {
    schema_version: "synapsor.action-rehearsal-interview.v1",
    capability,
    target,
    arguments: Object.fromEntries(entries.map(([name, definition]) => {
      if (definition.type === "object_array") {
        throw new Error("ACTION_REHEARSAL_ARGUMENT_SHAPE_UNSUPPORTED: conversational rehearsal accepts scalar arguments only.");
      }
      return [name, {
        type: definition.type,
        required: true,
        ...(definition.description ? { description: definition.description.slice(0, 500) } : {}),
        ...(definition.enum?.length ? { enum: definition.enum } : {}),
        ...(definition.minimum !== undefined ? { minimum: definition.minimum } : {}),
        ...(definition.maximum !== undefined ? { maximum: definition.maximum } : {}),
        ...(definition.max_length !== undefined ? { max_length: definition.max_length } : {}),
      }];
    })),
  };
}

function rehearsalToolDefinition(
  catalog: ReturnType<typeof rehearsalCatalog>,
): AskToolDefinition {
  const properties = Object.fromEntries(Object.entries(catalog.arguments).map(([name, definition]) => [
    name,
    {
      type: definition.type,
      ...(definition.enum?.length ? { enum: definition.enum } : {}),
      ...(definition.minimum !== undefined ? { minimum: definition.minimum } : {}),
      ...(definition.maximum !== undefined ? { maximum: definition.maximum } : {}),
      ...(definition.max_length !== undefined ? { maxLength: definition.max_length } : {}),
      ...(definition.description ? { description: definition.description } : {}),
    },
  ]));
  return {
    name: INTERPRET_REHEARSAL_TOOL,
    title: "Interpret one disposable Action rehearsal example",
    description: "Submit exact compiled proposal arguments or one clarification question. This never creates authority or changes source data.",
    input_schema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "arguments"],
          properties: {
            status: { type: "string", enum: ["resolved"] },
            arguments: {
              type: "object",
              additionalProperties: false,
              required: Object.keys(catalog.arguments),
              properties,
            },
            rationale: { type: "string", minLength: 1, maxLength: 500 },
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

function parseRehearsalResolution(
  value: Record<string, unknown>,
  definitions: Record<string, ArgumentSpec>,
): ActionRehearsalResolution {
  if (value.status === "clarification") {
    return {
      state: "clarification",
      question: interpretationQuestion(value),
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    };
  }
  if (value.status !== "resolved") throw new Error("status must be resolved or clarification.");
  const submittedArguments = value.arguments;
  if (!isRecord(submittedArguments)) throw new Error("arguments must be one exact object.");
  const expected = Object.keys(definitions);
  const actual = Object.keys(submittedArguments);
  const missing = expected.filter((name) => !Object.hasOwn(submittedArguments, name));
  const extra = actual.filter((name) => !Object.hasOwn(definitions, name));
  if (missing.length || extra.length) {
    throw new Error([
      missing.length ? `missing ${missing.join(", ")}` : "",
      extra.length ? `unexpected ${extra.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  }
  const args = Object.fromEntries(expected.map((name) => [
    name,
    parseRehearsalArgument(name, submittedArguments[name], definitions[name]!),
  ]));
  const rationale = optionalShortText(value.rationale, "rationale");
  return {
    state: "resolved",
    args,
    summary: Object.entries(args).map(([name, argument]) =>
      `${name}: ${typeof argument === "string" ? JSON.stringify(argument) : String(argument)}`),
    ...(rationale ? { rationale } : {}),
    correction_used: false,
    authority_granted: false,
    source_database_changed: false,
  };
}

function parseRehearsalArgument(
  name: string,
  value: unknown,
  definition: ArgumentSpec,
): JsonScalar {
  if (definition.type === "object_array") {
    throw new Error(`${name} uses an unsupported object-array argument.`);
  }
  if (definition.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
    if (definition.minimum !== undefined && value < definition.minimum) {
      throw new Error(`${name} must be at least ${definition.minimum}.`);
    }
    if (definition.maximum !== undefined && value > definition.maximum) {
      throw new Error(`${name} must be at most ${definition.maximum}.`);
    }
  } else if (definition.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${name} must be true or false.`);
  } else {
    if (typeof value !== "string") throw new Error(`${name} must be text.`);
    if (definition.max_length !== undefined && value.length > definition.max_length) {
      throw new Error(`${name} exceeds ${definition.max_length} characters.`);
    }
  }
  if (definition.enum?.length && !definition.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`${name} must be one exact reviewed enum value.`);
  }
  return value as JsonScalar;
}

function policyCatalog(
  action: GuidedActionInput,
  resource: GuidedActionResourceOption,
  current?: {
    auto_approval: GuidedActionAutoApprovalInput;
    shared_limits: ActionBoundarySharedLimitV1[];
  },
) {
  const fieldByName = new Map(resource.structurally_eligible_fields.map((field) => [field.name, field]));
  const fields = (action.patches ?? [])
    .filter((patch) => patch.value_source === "argument")
    .map((patch) => {
      const field = fieldByName.get(patch.column);
      return {
        id: patch.column,
        label: field?.label ?? null,
        type: field?.data_type ?? "reviewed",
        enum_values: field?.enum_values ?? [],
        minimum: patch.minimum ?? null,
        maximum: patch.maximum ?? null,
        max_length: patch.max_length ?? null,
      };
    });
  return {
    schema_version: "synapsor.action-boundary-policy-interview.v1",
    action: {
      operation: action.operation,
      resource: action.resource,
      capability: action.capability_name,
      fields,
    },
    trusted_limit_scopes: trustedLimitScopes(resource),
    current_policy: current
      ? {
          auto_approval: current.auto_approval,
          shared_limits: current.shared_limits.map(({ kind, scope, maximum, window_seconds, field }) => ({
            kind,
            scope,
            maximum,
            window_seconds,
            ...(field ? { field } : {}),
          })),
        }
      : null,
  };
}

function policyToolDefinition(catalog: ReturnType<typeof policyCatalog>): AskToolDefinition {
  const fieldIds = catalog.action.fields.map((field) => field.id);
  const conditionSchema = {
    type: "object",
    additionalProperties: false,
    required: ["field", "operator"],
    properties: {
      field: { type: "string", enum: fieldIds },
      operator: { type: "string", enum: ["lte", "gte", "eq", "in", "max_length"] },
      value: { type: ["string", "number", "boolean"] },
      values: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: { type: ["string", "number", "boolean"] },
      },
    },
  };
  const sharedLimitSchema = {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "scope", "maximum", "window_seconds"],
        properties: {
          kind: { type: "string", enum: ["count"] },
          scope: { type: "string", enum: catalog.trusted_limit_scopes },
          maximum: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000_000 },
          window_seconds: { type: "integer", minimum: 60, maximum: 31_536_000 },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "scope", "maximum", "window_seconds", "field"],
        properties: {
          kind: { type: "string", enum: ["total"] },
          scope: { type: "string", enum: catalog.trusted_limit_scopes },
          maximum: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000_000 },
          window_seconds: { type: "integer", minimum: 60, maximum: 31_536_000 },
          field: { type: "string", enum: fieldIds },
        },
      },
    ],
  };
  return {
    name: INTERPRET_POLICY_TOOL,
    title: "Interpret one deterministic Action Boundary policy",
    description: "Submit exact deterministic conditions and circuit breakers or one clarification question. This never approves, activates, executes, applies, or changes source data.",
    input_schema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "conditions", "max_per_day"],
          properties: {
            status: { type: "string", enum: ["resolved"] },
            conditions: { type: "array", minItems: 1, maxItems: 16, items: conditionSchema },
            max_per_day: { type: "integer", minimum: 1, maximum: 1_000_000 },
            max_total_per_day: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000_000 },
            total_field: { type: "string", enum: fieldIds },
            shared_limits: { type: "array", maxItems: 8, items: sharedLimitSchema },
            rationale: { type: "string", minLength: 1, maxLength: 500 },
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
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "requested_field", "value_reason", "question"],
          properties: {
            status: { type: "string", enum: ["value_request"] },
            requested_field: { type: "string", enum: fieldIds },
            value_reason: { type: "string", minLength: 1, maxLength: 500 },
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

function parsePolicyResolution(
  value: Record<string, unknown>,
  action: GuidedActionInput,
  resource: GuidedActionResourceOption,
  requiredLimitScope?: RequiredTrustedPolicyScope,
  operatorAnswer?: string,
): ActionBoundaryPolicyResolution {
  if (value.status === "clarification") {
    return {
      state: "clarification",
      question: interpretationQuestion(value),
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    };
  }
  if (value.status === "value_request") {
    const field = requiredShortText(value.requested_field, "requested_field");
    const exactFields = new Set((action.patches ?? [])
      .filter((patch) => patch.value_source === "argument")
      .map((patch) => patch.column));
    if (!exactFields.has(field)) throw new Error("requested_field must be one exact proposal field.");
    return {
      state: "value_request",
      field,
      reason: requiredShortText(value.value_reason, "value_reason"),
      question: interpretationQuestion(value),
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    };
  }
  if (value.status !== "resolved") throw new Error("status must be resolved, clarification, or value_request.");
  if (!Array.isArray(value.conditions) || !value.conditions.length || value.conditions.length > 16) {
    throw new Error("conditions must contain 1 through 16 deterministic conditions.");
  }
  const patches = new Map((action.patches ?? [])
    .filter((patch) => patch.value_source === "argument")
    .map((patch) => [patch.column, patch]));
  const fields = new Map(resource.structurally_eligible_fields.map((field) => [field.name, field]));
  const conditions = value.conditions.map((candidate, index) =>
    parsePolicyCondition(candidate, index, patches, fields));
  const uncovered = [...patches.keys()].find((field) => !conditions.some((condition) => condition.field === field));
  if (uncovered) throw new Error(`conditions do not cover model-controlled field ${uncovered}.`);
  const maxPerDay = positiveInteger(value.max_per_day, "max_per_day", 1_000_000);
  const maxTotal = value.max_total_per_day === undefined
    ? undefined
    : positiveFinite(value.max_total_per_day, "max_total_per_day", 1_000_000_000);
  const totalField = value.total_field === undefined
    ? undefined
    : requiredShortText(value.total_field, "total_field");
  if ((maxTotal === undefined) !== (totalField === undefined)) {
    throw new Error("max_total_per_day and total_field must be supplied together.");
  }
  if (totalField) {
    const patch = patches.get(totalField);
    if (!patch || patch.minimum === undefined || patch.maximum === undefined) {
      throw new Error("total_field must be one bounded numeric proposal field.");
    }
  }
  const allowedScopes = new Set(trustedLimitScopes(resource));
  const sharedLimits = value.shared_limits === undefined
    ? []
    : parseSharedLimits(value.shared_limits, patches, allowedScopes);
  if (requiredLimitScope
    && !sharedLimits.some((limit) => limit.scope === requiredLimitScope.scope)) {
    throw new Error(
      `The operator said ${requiredLimitScope.phrase}, so shared_limits must include trusted scope ${requiredLimitScope.scope}; max_per_day alone is not scoped that way.`,
    );
  }
  assertExplicitPolicyDurationsPreserved(operatorAnswer, sharedLimits, Boolean(requiredLimitScope));
  const rationale = optionalShortText(value.rationale, "rationale");
  return {
    state: "resolved",
    auto_approval: {
      conditions,
      max_per_day: maxPerDay,
      ...(maxTotal === undefined ? {} : { max_total_per_day: maxTotal, total_field: totalField }),
    },
    shared_limits: sharedLimits,
    ...(rationale ? { rationale } : {}),
    correction_used: false,
    authority_granted: false,
    source_database_changed: false,
  };
}

function assertExplicitPolicyDurationsPreserved(
  operatorAnswer: string | undefined,
  sharedLimits: Array<Omit<ActionBoundarySharedLimitV1, "id" | "capability">>,
  requireSharedLimitMatch: boolean,
): void {
  if (!operatorAnswer) return;
  const explicit = explicitDurationSeconds(operatorAnswer);
  if (!explicit.length) return;
  const available = new Set(sharedLimits.map((limit) => limit.window_seconds));
  if (!requireSharedLimitMatch) available.add(86_400); // max_per_day is always a rolling 24-hour action limit.
  const missing = explicit.find((duration) => !available.has(duration.seconds));
  if (!missing) return;
  const interpreted = [...available].map(formatDurationSeconds).join(", ") || "no matching window";
  throw new Error(
    `The operator explicitly stated a window of ${formatDurationSeconds(missing.seconds)} (${missing.phrase}), but the interpreted policy uses ${interpreted}. Preserve the exact duration in window_seconds or ask for clarification.`,
  );
}

function explicitDurationSeconds(value: string): Array<{ seconds: number; phrase: string }> {
  const multipliers: Record<string, number> = {
    second: 1,
    sec: 1,
    minute: 60,
    min: 60,
    hour: 3_600,
    hr: 3_600,
    day: 86_400,
    week: 604_800,
  };
  const found = new Map<number, string>();
  const duration = "(\\d+(?:\\.\\d+)?)\\s*(?:-|\\s)?\\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)";
  const patterns = [
    new RegExp(`\\b(?:rolling|per|every|within|over|during|in\\s+(?:the\\s+)?last|last)\\s+${duration}\\b`, "gi"),
    new RegExp(`\\b${duration}\\s+(?:rolling\\s+)?(?:window|period)\\b`, "gi"),
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const amount = Number(match[1]);
      const unit = String(match[2]).toLowerCase().replace(/s$/, "");
      const multiplier = multipliers[unit];
      const seconds = multiplier === undefined ? NaN : amount * multiplier;
      if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 31_536_000) continue;
      found.set(seconds, match[0]);
    }
  }
  return [...found].map(([seconds, phrase]) => ({ seconds, phrase }));
}

function formatDurationSeconds(seconds: number): string {
  if (seconds % 604_800 === 0) return `${seconds / 604_800} week${seconds === 604_800 ? "" : "s"}`;
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} seconds`;
}

function parsePolicyCondition(
  value: unknown,
  index: number,
  patches: Map<string, NonNullable<GuidedActionInput["patches"]>[number]>,
  fields: Map<string, GuidedActionResourceOption["structurally_eligible_fields"][number]>,
): GuidedActionAutoApprovalCondition {
  if (!isRecord(value)) throw new Error(`conditions[${index}] must be an object.`);
  const field = requiredShortText(value.field, `conditions[${index}].field`);
  const patch = patches.get(field);
  const metadata = fields.get(field);
  if (!patch || !metadata) throw new Error(`conditions[${index}].field is outside the exact proposal fields.`);
  const operator = requiredShortText(value.operator, `conditions[${index}].operator`);
  if (!["lte", "gte", "eq", "in", "max_length"].includes(operator)) {
    throw new Error(`conditions[${index}].operator is outside the deterministic grammar.`);
  }
  if (["lte", "gte"].includes(operator)) {
    if (patch.minimum === undefined || patch.maximum === undefined) {
      throw new Error(`${field} is not a bounded numeric field.`);
    }
    return { field, operator: operator as "lte" | "gte", value: finiteNumber(value.value, `${field}.${operator}`) };
  }
  if (operator === "max_length") {
    if (!patch.max_length) throw new Error(`${field} has no reviewed text-length envelope.`);
    return { field, operator, value: positiveInteger(value.value, `${field}.max_length`, 100_000) };
  }
  if (operator === "in") {
    if (!Array.isArray(value.values) || !value.values.length || value.values.length > 64) {
      throw new Error(`${field}.in needs 1 through 64 values.`);
    }
    validatePolicyValues(field, value.values, patch, metadata);
    return { field, operator, values: structuredClone(value.values) as Array<string | number | boolean | null> };
  }
  validatePolicyValues(field, [value.value], patch, metadata);
  return { field, operator: "eq", value: value.value as string | number | boolean | null };
}

function validatePolicyValues(
  field: string,
  values: unknown[],
  patch: NonNullable<GuidedActionInput["patches"]>[number],
  metadata: GuidedActionResourceOption["structurally_eligible_fields"][number],
): void {
  if (values.some((item) => item === undefined || (typeof item === "object" && item !== null))) {
    throw new Error(`${field} policy values must be scalar values.`);
  }
  if (metadata.enum_values.length
    && values.some((item) => typeof item !== "string" || !metadata.enum_values.includes(item))) {
    throw new Error(`${field} policy values must come from its reviewed enum.`);
  }
  if (patch.minimum !== undefined && patch.maximum !== undefined
    && values.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`${field} policy values must be finite numbers.`);
  }
  if (patch.max_length !== undefined
    && values.some((item) => typeof item !== "string" || item.length > patch.max_length!)) {
    throw new Error(`${field} policy text exceeds its reviewed proposal length.`);
  }
}

function parseSharedLimits(
  value: unknown,
  patches: Map<string, NonNullable<GuidedActionInput["patches"]>[number]>,
  allowedScopes: Set<string>,
): Array<Omit<ActionBoundarySharedLimitV1, "id" | "capability">> {
  if (!Array.isArray(value) || value.length > 8) throw new Error("shared_limits must contain at most eight limits.");
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`shared_limits[${index}] must be an object.`);
    const kind = requiredShortText(candidate.kind, `shared_limits[${index}].kind`);
    const scope = requiredShortText(candidate.scope, `shared_limits[${index}].scope`);
    if (!(["count", "total"] as string[]).includes(kind)) throw new Error(`shared_limits[${index}].kind is invalid.`);
    if (!allowedScopes.has(scope)) throw new Error(`shared_limits[${index}].scope is outside the trusted scopes for this action.`);
    const maximum = positiveFinite(candidate.maximum, `shared_limits[${index}].maximum`, 1_000_000_000);
    const windowSeconds = positiveInteger(candidate.window_seconds, `shared_limits[${index}].window_seconds`, 31_536_000);
    if (windowSeconds < 60) throw new Error(`shared_limits[${index}].window_seconds must be at least 60.`);
    const field = kind === "total"
      ? requiredShortText(candidate.field, `shared_limits[${index}].field`)
      : undefined;
    if (kind === "total") {
      const patch = field ? patches.get(field) : undefined;
      if (!patch || patch.minimum === undefined || patch.maximum === undefined) {
        throw new Error(`shared_limits[${index}] total must name one bounded numeric proposal field.`);
      }
    }
    return {
      kind: kind as "count" | "total",
      scope: scope as ActionBoundarySharedLimitV1["scope"],
      maximum,
      window_seconds: windowSeconds,
      ...(field ? { field } : {}),
    };
  });
}

function trustedLimitScopes(resource: GuidedActionResourceOption): ActionBoundarySharedLimitV1["scope"][] {
  if (resource.organization_scope) return ["capability", "boundary"];
  return [
    ...(resource.principal_key ? ["tenant_principal" as const] : []),
    ...(resource.tenant_key ? ["tenant" as const, "tenant_object" as const] : []),
    "capability",
  ];
}

type RequiredTrustedPolicyScope = {
  scope: ActionBoundarySharedLimitV1["scope"];
  phrase: string;
};

function requiredTrustedPolicyScope(
  answer: string,
  resource: GuidedActionResourceOption,
): RequiredTrustedPolicyScope | undefined {
  const principalMatch = answer.match(
    /\b(?:per|for\s+each|for\s+every|each|every)\s+(?:authenticated\s+)?(?:agent|operator|principal|user|customer)\b/i,
  );
  const tenantMatch = answer.match(
    /\b(?:per|for\s+each|for\s+every|each|every)\s+(?:tenant|org|organization|organisation)\b/i,
  );
  if (principalMatch) {
    if (!trustedLimitScopes(resource).includes("tenant_principal")) {
      throw new Error(
        "ACTION_BOUNDARY_POLICY_SCOPE_UNAVAILABLE: the rule is scoped per principal, but this reviewed action has no trusted tenant+principal accounting scope.",
      );
    }
    return { scope: "tenant_principal", phrase: JSON.stringify(principalMatch[0]) };
  }
  if (tenantMatch) {
    if (!trustedLimitScopes(resource).includes("tenant")) {
      throw new Error(
        "ACTION_BOUNDARY_POLICY_SCOPE_UNAVAILABLE: the rule is scoped per tenant, but this reviewed action has no trusted tenant accounting scope.",
      );
    }
    return { scope: "tenant", phrase: JSON.stringify(tenantMatch[0]) };
  }
  return undefined;
}

function decisionValueFields(
  decision: Exclude<QuickProposalDecision, { kind: "delete_confirmation" }>,
): string[] {
  if (decision.kind === "numeric_bounds") return [decision.field];
  if (decision.kind === "fields") return decision.choices.map((choice) => choice.value);
  return [];
}

function validateOperatorApprovedValues(
  input: OperatorApprovedValueContext | undefined,
  allowedFields: Set<string>,
): OperatorApprovedValueContext | undefined {
  if (!input) return undefined;
  if (input.egressAcknowledged !== true) {
    throw new Error("Observed value context requires a separate explicit egress acknowledgement.");
  }
  if (!allowedFields.has(input.field)) {
    throw new Error("Observed value context must name one exact field in the current reviewed decision.");
  }
  const values = [...new Set(input.values.map((value) => value.trim()).filter(Boolean))];
  if (!values.length || values.length > 32 || values.some((value) => value.length > 200)) {
    throw new Error("Observed value context must contain 1 through 32 values of at most 200 characters each.");
  }
  if (JSON.stringify(values).length > 4_000) {
    throw new Error("Observed value context is too large for one bounded interpretation request.");
  }
  if (values.some((value) => /(?:postgres(?:ql)?|mysql):\/\/|BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]+/i.test(value))) {
    throw new Error("Observed value context appears to contain credential or secret material.");
  }
  return { field: input.field, values, egressAcknowledged: true };
}

function interviewRefusal(message: string): Awaited<ReturnType<AskToolGateway["callTool"]>> {
  return {
    ok: false,
    value: {
      error_code: "ACTION_BOUNDARY_INTERVIEW_REFUSED",
      message,
      authority_granted: false,
      source_database_changed: false,
    },
    error_code: "ACTION_BOUNDARY_INTERVIEW_REFUSED",
  };
}

function safeOperatorText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters.`);
  if (/(?:postgres(?:ql)?|mysql):\/\/|BEGIN [A-Z ]*PRIVATE KEY|api[_ -]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]+/i.test(normalized)) {
    throw new Error(`${label} appears to contain credential or secret material.`);
  }
  return normalized;
}

function interpretationQuestion(value: Record<string, unknown>): string {
  return requiredShortText(value.question ?? value.clarification_question, "question");
}

function requiredShortText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500) {
    throw new Error(`${label} must be a non-empty string of at most 500 characters.`);
  }
  return value.trim();
}

function optionalShortText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredShortText(value, label);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function positiveFinite(value: unknown, label: string, maximum: number): number {
  const parsed = finiteNumber(value, label);
  if (parsed <= 0 || parsed > maximum) throw new Error(`${label} must be greater than zero and at most ${maximum}.`);
  return parsed;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  const parsed = positiveFinite(value, label, maximum);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be an integer.`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function humanizeIdentifier(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { runRequiredAuthoringToolCall } from "./authoring-tool-call.js";
import {
  askToolSurfaceDigest,
  resolveAskProviderConfiguration,
  runAskProviderTurn,
  type AskToolDefinition,
  type AskToolGateway,
} from "./model-ask.js";
import {
  modelAuthoringHistory,
  type ModelAuthoringConversation,
} from "./model-authoring-conversation.js";
import type { ModelAuthoringNarrationSession } from "./model-authoring-narration.js";

const REVIEW_PRINCIPAL_SCOPE_TOOL = "runner.review_principal_scope_answer";

export type ModelPrincipalScopeOption = {
  id: string;
  kind: "direct" | "derived" | "postgres_rls";
  value: string;
  label: string;
};

type ModelPrincipalScopeResolutionCore =
  | {
      state: "resolved";
      option_id: string;
      rationale?: string;
    }
  | {
      state: "none";
      rationale?: string;
    }
  | {
      state: "clarification";
      question: string;
    };

export type ModelPrincipalScopeResolution = ModelPrincipalScopeResolutionCore & {
  correction_used: boolean;
};

export async function interpretPrincipalScopeAnswer(input: {
  session: ModelAuthoringNarrationSession & { conversation?: ModelAuthoringConversation };
  resourceId: string;
  options: ModelPrincipalScopeOption[];
  answer: string;
  env?: NodeJS.ProcessEnv;
  egressAcknowledged: boolean;
  signal?: AbortSignal;
  scopeKind?: "organization_and_person";
}): Promise<ModelPrincipalScopeResolution> {
  const answer = boundedText(input.answer, "Principal-scope answer", input.scopeKind ? 12_000 : 1_000);
  if (!input.options.length) throw new Error("Principal-scope review requires at least one exact option.");
  if (new Set(input.options.map((option) => option.id)).size !== input.options.length) {
    throw new Error("Principal-scope review option IDs must be unique.");
  }
  const catalog = input.options.map((option) => ({ ...option }));
  const tools: AskToolDefinition[] = [principalScopeTool(catalog)];
  const authorityDigest = askToolSurfaceDigest(tools);
  const configuration = principalScopeConfiguration(
    input.session,
    authorityDigest,
    input.egressAcknowledged,
    input.env,
  );
  let resolution: ModelPrincipalScopeResolutionCore | undefined;
  let issue = "The model did not submit one bounded principal-scope interpretation.";
  let callCount = 0;
  const gateway: AskToolGateway = {
    mode: "authoring",
    listTools: () => tools,
    async callTool(name, args) {
      callCount += 1;
      if (name !== REVIEW_PRINCIPAL_SCOPE_TOOL || callCount > 2) {
        return refusal("Runner accepts one interpretation and one bounded correction only.");
      }
      try {
        resolution = parseResolution(args, new Set(catalog.map((option) => option.id)));
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
    input.scopeKind
      ? "Interpret the operator's policy to distinguish organization scope from authenticated-person scope. Each candidate is one complete orientation of both existing columns and their inspected session settings."
      : "Translate one operator answer about authenticated-person row scope.",
    `Exact reviewed resource: ${input.resourceId}`,
    `Exact Runner candidates: ${JSON.stringify(catalog)}`,
    `Operator answer: ${JSON.stringify(answer)}`,
    `Call ${REVIEW_PRINCIPAL_SCOPE_TOOL} exactly once.`,
    "Resolve only when the answer uniquely identifies one exact candidate and confirms that trusted authenticated-principal context has that meaning.",
    ...(input.scopeKind ? ["Structural proof does not establish business orientation. If the policy does not distinguish the organization and person, ask which is which. Runner will separately ask the operator to confirm the exact proposed mapping before saving it."] : []),
    "If the operator says none, rejects all candidates, or says this resource is not per-person, submit status none.",
    "If the answer is ambiguous, asks a question, or does not establish the business meaning, submit one concise clarification question. Never guess from an identifier.",
    "Do not emit SQL, credentials, tenant or principal values, activation, approval, or write authority.",
  ].join("\n");
  const run = (nextQuestion: string) => runAskProviderTurn({
    configuration,
    question: nextQuestion,
    history: modelAuthoringHistory(input.session.conversation, input.session),
    gateway,
    tools,
    signal: input.signal ?? new AbortController().signal,
    dependencies: input.session.dependencies,
    authorityDigest,
    providerSystemPrompt: [
      "You translate one business-language identity-scope answer into one exact Runner candidate.",
      "The candidate list is closed. Identifiers and labels are not proof; use the operator's stated semantics and ask for clarification instead of guessing.",
      "You cannot grant authority, choose trusted identity values, activate a Boundary, execute SQL, approve, apply, or write.",
    ].join(" "),
    skipRunnerQuestionContext: true,
    requiredInitialToolName: REVIEW_PRINCIPAL_SCOPE_TOOL,
    completeAfterRequiredTool: true,
    authorityGuard: () => canonicalJsonDigest(catalog) === canonicalJsonDigest(input.options)
      ? authorityDigest
      : canonicalJsonDigest({ stale: true }),
  });
  const initial = await runRequiredAuthoringToolCall({
    run,
    question,
    toolName: REVIEW_PRINCIPAL_SCOPE_TOOL,
  });
  let correctionUsed = initial.correction_used;
  if (!resolution && !correctionUsed) {
    correctionUsed = true;
    await run([
      "Runner rejected the first interpretation. Do not repeat it.",
      `Validation issue: ${issue.slice(0, 700)}`,
      "Submit one corrected exact candidate, none, or one clarification question.",
      question,
    ].join("\n"));
  }
  await gateway.close().catch(() => undefined);
  if (!resolution) throw new Error(`PRINCIPAL_SCOPE_INTERPRETATION_INVALID: ${issue}`);
  return { ...resolution, correction_used: correctionUsed } as ModelPrincipalScopeResolution;
}

function principalScopeTool(options: ModelPrincipalScopeOption[]): AskToolDefinition {
  return {
    name: REVIEW_PRINCIPAL_SCOPE_TOOL,
    title: "Interpret one reviewed principal-scope answer",
    description: "Select one exact reviewed scope candidate, none, or ask one clarification. This grants no authority.",
    input_schema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "option_id"],
          properties: {
            status: { type: "string", enum: ["resolved"] },
            option_id: { type: "string", enum: options.map((option) => option.id) },
            rationale: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["none"] },
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

function parseResolution(
  value: Record<string, unknown>,
  optionIds: Set<string>,
): ModelPrincipalScopeResolutionCore {
  if (value.status === "resolved") {
    const optionId = boundedText(value.option_id, "option_id", 200);
    if (!optionIds.has(optionId)) throw new Error("option_id must be one exact current candidate.");
    const rationale = optionalText(value.rationale, "rationale", 500);
    return {
      state: "resolved",
      option_id: optionId,
      ...(rationale ? { rationale } : {}),
    };
  }
  if (value.status === "none") {
    const rationale = optionalText(value.rationale, "rationale", 500);
    return { state: "none", ...(rationale ? { rationale } : {}) };
  }
  if (value.status === "clarification") {
    return {
      state: "clarification",
      question: boundedText(value.question, "question", 500),
    };
  }
  throw new Error("status must be resolved, none, or clarification.");
}

function principalScopeConfiguration(
  session: ModelAuthoringNarrationSession,
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
    request_timeout_seconds: 120,
    max_output_tokens: 800,
  }, env, new Date());
}

function refusal(message: string): Awaited<ReturnType<AskToolGateway["callTool"]>> {
  return {
    ok: false,
    value: {
      error_code: "PRINCIPAL_SCOPE_INTERPRETATION_REFUSED",
      message,
      authority_granted: false,
      source_database_changed: false,
    },
    error_code: "PRINCIPAL_SCOPE_INTERPRETATION_REFUSED",
  };
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > maximum) {
    throw new Error(`${label} must be 1-${maximum} characters.`);
  }
  const normalized = value.trim();
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  return normalized;
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedText(value, label, maximum);
}
import { defaultProviderKeyEnv } from "./hosted-provider-settings.js";

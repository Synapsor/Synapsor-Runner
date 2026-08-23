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

const SUBMIT_SUGGESTION_TOOL = "runner.suggest_safe_action";

export type ModelActionSuggestionResult = {
  assessment: ActionSuggestionAssessment;
  provider: AskProvider;
  model: string;
  authority_granted: false;
  source_database_changed: false;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
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
  signal?: AbortSignal;
}): Promise<ModelActionSuggestionResult> {
  const intent = safeIntent(input.intent);
  const catalog = suggestionCatalog(input.options);
  const serializedCatalog = JSON.stringify(catalog);
  if (Buffer.byteLength(serializedCatalog) > 64 * 1024) {
    throw new Error("ACTION_SUGGESTION_CATALOG_TOO_LARGE: narrow the active Read Boundary or import a bounded suggestion file instead.");
  }
  const tools: AskToolDefinition[] = [suggestionToolDefinition()];
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
    max_output_tokens: 1_200,
  }, input.env ?? process.env, new Date());

  let assessment: ActionSuggestionAssessment | undefined;
  let callCount = 0;
  const gateway: AskToolGateway = {
    mode: "authoring",
    listTools: () => tools,
    async callTool(name, args) {
      callCount += 1;
      if (name !== SUBMIT_SUGGESTION_TOOL || callCount > 1) {
        return {
          ok: false,
          value: {
            error_code: "ACTION_SUGGESTION_CALL_REFUSED",
            message: "Exactly one bounded suggestion may be submitted.",
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
  const result = await runAskProviderTurn({
    configuration,
    question: [
      "Create exactly one untrusted Safe Action suggestion for this operator intent.",
      `Intent: ${intent}`,
      "Call runner.suggest_safe_action exactly once. Copy only exact resource and field ids from the structural candidate catalog.",
      "Do not choose approval, execution, writeback, policy, credentials, SQL, tenant, or principal authority.",
      `Structural candidate catalog: ${serializedCatalog}`,
    ].join("\n"),
    history: [],
    gateway,
    tools,
    signal: input.signal ?? new AbortController().signal,
    dependencies: input.dependencies,
    authorityDigest,
    providerSystemPrompt: [
      "You produce one non-authoritative Synapsor Safe Action suggestion through the provided structured tool.",
      "Copy exact ids only from the candidate catalog in the user message.",
      "Never propose SQL, credentials, trusted tenant/principal values, approval policy, execution, writeback, activation, apply, or worker authority.",
      "Call the tool exactly once. Do not claim that the suggestion is active, approved, executable, or applied.",
    ].join(" "),
    skipRunnerQuestionContext: true,
    requiredInitialToolName: SUBMIT_SUGGESTION_TOOL,
    completeAfterRequiredTool: true,
    authorityGuard: () => {
      const current = suggestionCatalog(input.options).digest;
      return current === catalog.digest ? authorityDigest : canonicalJsonDigest({ stale: current });
    },
  });
  if (!assessment) {
    throw new Error("ACTION_SUGGESTION_NOT_SUBMITTED: the model did not submit one bounded structured suggestion.");
  }
  return {
    assessment,
    provider: input.provider,
    model: input.model,
    authority_granted: false,
    source_database_changed: false,
    ...(result.usage ? { usage: result.usage } : {}),
  };
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
      ...(field.enum_values.length ? { enum: field.enum_values } : {}),
      required_for_insert: field.required_for_insert,
    })),
  }));
  const core = {
    schema_version: "synapsor.action-suggestion-catalog.v1",
    boundary_digest: options.boundary_digest,
    resources,
  };
  return { ...core, digest: canonicalJsonDigest(core) };
}

function suggestionToolDefinition(): AskToolDefinition {
  return {
    name: SUBMIT_SUGGESTION_TOOL,
    title: "Submit one non-authoritative Safe Action suggestion",
    description: "Submit one bounded candidate using exact reviewed ids. This never grants authority, activates a tool, approves a proposal, applies a change, or selects trusted identity.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["intent", "operation", "resource"],
      properties: {
        intent: { type: "string", minLength: 1, maxLength: 500 },
        operation: { type: "string", enum: ["insert", "update", "delete"] },
        resource: { type: "string", minLength: 1, maxLength: 256 },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 256 },
        },
        rationale: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
    metadata: {
      "synapsor.authority_granted": false,
      "synapsor.source_database_changed": false,
    },
  };
}

function safeIntent(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 500 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("ACTION_SUGGESTION_INTENT_INVALID: intent must be 1 through 500 safe characters.");
  }
  return normalized;
}

import { describe, expect, it, vi } from "vitest";
import {
  createModelAuthoringConversation,
  modelAuthoringHistory,
  rememberModelAuthoringTurn,
} from "./model-authoring-conversation.js";
import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";
import { AskError, type AskProviderDependencies } from "./model-ask.js";
import { authoringExplanationFailure } from "./authoring-explanation-failure.js";

describe("model-assisted Boundary authoring conversation", () => {
  it.each([
    { provider: "openai" as const, model: "gpt-5.6-luna" },
    { provider: "anthropic" as const, model: "claude-test" },
    { provider: "openai_compatible" as const, model: "qwen-local", baseUrl: "http://127.0.0.1:11434/v1" },
  ])("retains prior turns and uses a tool-free validated narration with $provider", async ({ provider, model, baseUrl }) => {
    const conversation = createModelAuthoringConversation();
    rememberModelAuthoringTurn(
      conversation,
      "Help customers understand tickets and request refunds.",
      "I will map the reviewed Read and Action structure first.",
    );
    const requests: Array<Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]> = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(request);
      const text = "I mapped the refund request to the reviewed refund action. It is still disabled.";
      return provider === "openai"
        ? {
            status: 200,
            body: {
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text }],
              }],
            },
          }
        : provider === "anthropic"
          ? { status: 200, body: { content: [{ type: "text", text }] } }
          : {
              status: 200,
              body: {
                choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
              },
            };
    });

    await expect(narrateValidatedAuthoringStep({
      session: {
        provider,
        model,
        ...(baseUrl ? { baseUrl } : { apiKey: "memory-key" }),
        dependencies: { requestJson },
        conversation,
      },
      operatorMessage: "Prepare a bounded refund request.",
      validatedFacts: [
        "INSERT support_ops.refund_requests passed exact catalog validation.",
        "Proposal, approval, apply, and source writes remain off.",
      ],
      egressAcknowledged: true,
    })).resolves.toBe(
      "I mapped the refund request to the reviewed refund action. It is still disabled.",
    );

    expect(requestJson).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(requests[0]?.body);
    expect(serialized).toContain("Help customers understand tickets and request refunds.");
    expect(serialized).toContain("Prepare a bounded refund request.");
    expect(serialized).toContain("support_ops.refund_requests");
    expect(serialized).not.toContain("memory-key");
    expect(requests[0]?.body).not.toHaveProperty("tools");
    expect(modelAuthoringHistory(conversation)).toEqual([
      {
        question: "Help customers understand tickets and request refunds.",
        answer: "I will map the reviewed Read and Action structure first.",
      },
      {
        question: "Prepare a bounded refund request.",
        answer: "I mapped the refund request to the reviewed refund action. It is still disabled.",
      },
    ]);
  });

  it("does not invent model prose or mutate history when the narration request fails", async () => {
    const conversation = createModelAuthoringConversation();
    const requestJson = vi.fn(async () => { throw new Error("provider unavailable"); });

    await expect(narrateValidatedAuthoringStep({
      session: {
        provider: "openai",
        model: "gpt-5.6-luna",
        apiKey: "memory-key",
        dependencies: { requestJson },
        conversation,
      },
      operatorMessage: "Continue.",
      validatedFacts: ["The disabled draft remains unchanged."],
      egressAcknowledged: true,
    })).resolves.toBeUndefined();
    expect(modelAuthoringHistory(conversation)).toEqual([]);
  });

  it.each([
    ["ASK_PROVIDER_TIMEOUT", true],
    ["ASK_PROVIDER_AUTHENTICATION_FAILED", false],
    ["ASK_PROVIDER_RATE_LIMITED", true],
    ["ASK_PROVIDER_RESPONSE_INVALID", true],
    ["ASK_PROVIDER_STREAM_FAILED", true],
  ])("preserves sanitized narration failure %s without changing history", async (code, retryable) => {
    const conversation = createModelAuthoringConversation();
    const onFailure = vi.fn();
    const result = await narrateValidatedAuthoringStep({
      session: { provider: "openai", model: "gpt-5.6-terra", apiKey: "memory-key", conversation,
        dependencies: { requestJson: async () => { throw new AskError(String(code), "secret-token https://private-provider.example/"); } } },
      operatorMessage: "Explain the pending authority.", validatedFacts: ["Read authority is disabled."],
      egressAcknowledged: true, onFailure,
    });
    expect(result).toBeUndefined();
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ code, retryable }));
    expect(JSON.stringify(onFailure.mock.calls)).not.toMatch(/secret-token|private-provider/);
    expect(modelAuthoringHistory(conversation)).toEqual([]);
  });

  it("does not expose arbitrary provider errors as review diagnostics", () => {
    expect(authoringExplanationFailure(new AskError("PRIVATE_URL_secret", "secret-token"))).toMatchObject({
      code: "NARRATION_UNAVAILABLE", retryable: true,
    });
    expect(JSON.stringify(authoringExplanationFailure(new Error("secret-token")))).not.toContain("secret-token");
  });

  it("keeps local review available when the saved provider credential is missing", async () => {
    const onFailure = vi.fn();
    const requestJson = vi.fn();
    await expect(narrateValidatedAuthoringStep({
      session: { provider: "openai", model: "gpt-5.6-terra", conversation: createModelAuthoringConversation(), dependencies: { requestJson } },
      env: {}, operatorMessage: "Explain this Read review.", validatedFacts: ["Read authority remains disabled."],
      egressAcknowledged: true, onFailure,
    })).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "ASK_KEY_REQUIRED", retryable: false }));
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("keeps a validated pre-job greeting short and question-led", async () => {
    const conversation = createModelAuthoringConversation();
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        choices: [{
          message: {
            role: "assistant",
            content: "I am ready to help draft reviewed boundaries while Runner validates each decision. What should this agent be able to read or propose?",
          },
          finish_reason: "stop",
        }],
      },
    }));

    await expect(narrateValidatedAuthoringStep({
      session: {
        provider: "openai_compatible",
        model: "qwen2.5:7b",
        baseUrl: "http://127.0.0.1:11434/v1",
        dependencies: { requestJson },
        conversation,
      },
      operatorMessage: "Start a new model-guided job.",
      validatedFacts: [
        "Metadata egress was explicitly approved.",
        "No Read or Action authority was activated.",
      ],
      nextQuestion: "What should this agent be able to read or propose?",
      responseStyle: "opening",
      egressAcknowledged: true,
    })).resolves.toContain("What should this agent be able to read or propose?");
    expect(modelAuthoringHistory(conversation)).toHaveLength(1);
  });

  it("discards a local-model greeting that invents capability or proposal limits", async () => {
    const conversation = createModelAuthoringConversation();
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        choices: [{
          message: {
            role: "assistant",
            content: "The agent should be able to read metadata but not propose changes. At most one proposal is allowed. What should this agent be able to read or propose?",
          },
          finish_reason: "stop",
        }],
      },
    }));

    await expect(narrateValidatedAuthoringStep({
      session: {
        provider: "openai_compatible",
        model: "qwen2.5:7b",
        baseUrl: "http://127.0.0.1:11434/v1",
        dependencies: { requestJson },
        conversation,
      },
      operatorMessage: "Start a new model-guided job.",
      validatedFacts: [
        "Metadata egress was explicitly approved.",
        "No Read or Action authority was activated.",
      ],
      nextQuestion: "What should this agent be able to read or propose?",
      responseStyle: "opening",
      egressAcknowledged: true,
    })).resolves.toBeUndefined();
    expect(modelAuthoringHistory(conversation)).toEqual([]);
  });

  it("drops model narration that contradicts Runner-validated scope and authority facts", async () => {
    const conversation = createModelAuthoringConversation();
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "The target scope remains incomplete and Action authority has been granted.",
          }],
        }],
      },
    }));

    await expect(narrateValidatedAuthoringStep({
      session: {
        provider: "openai",
        model: "gpt-5.6-luna",
        apiKey: "memory-key",
        dependencies: { requestJson },
        conversation,
      },
      operatorMessage: "Use version as the stale-row guard.",
      validatedFacts: [
        "Target row identity and trusted tenant/principal scope are separate Runner-validated controls and are already resolved.",
        "No authority was granted and no source row changed.",
      ],
      egressAcknowledged: true,
    })).resolves.toBeUndefined();
    expect(modelAuthoringHistory(conversation)).toEqual([]);
  });

  it("drops model narration that reopens an already resolved trusted-scope decision", async () => {
    const conversation = createModelAuthoringConversation();
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "Should I use version, and is the trusted customer scope already resolved?",
          }],
        }],
      },
    }));

    await expect(narrateValidatedAuthoringStep({
      session: {
        provider: "openai",
        model: "gpt-5.6-luna",
        apiKey: "memory-key",
        dependencies: { requestJson },
        conversation,
      },
      operatorMessage: "Why is version needed?",
      validatedFacts: [
        "Target row identity and trusted tenant/principal scope are separate Runner-validated controls and are already resolved.",
        "The pending reviewed decision is conflict guard version.",
      ],
      egressAcknowledged: true,
    })).resolves.toBeUndefined();
    expect(modelAuthoringHistory(conversation)).toEqual([]);
  });

  it("drops narration that turns an approval ceiling into a threshold", async () => {
    const conversation = createModelAuthoringConversation();
    const failure = vi.fn();
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "This action becomes eligible after 10 approvals in 24 hours. Should I use it?",
          }],
        }],
      },
    }));

    await expect(narrateValidatedAuthoringStep({
      session: {
        provider: "openai",
        model: "gpt-5.6-luna",
        apiKey: "memory-key",
        dependencies: { requestJson },
        conversation,
      },
      operatorMessage: "Review this policy.",
      onFailure: failure,
      validatedFacts: [
        "This action | 24 hours | 10 approvals",
        "Anything above the reviewed ceiling requires human review.",
      ],
      egressAcknowledged: true,
    })).resolves.toBeUndefined();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({
      code: "NARRATION_VALIDATION_REJECTED", mismatch: expect.stringMatching(/ceiling/iu),
    }));
    expect(modelAuthoringHistory(conversation)).toEqual([]);
  });

  it("drops narration that falsely erases an operator's earlier confirmations", async () => {
    const conversation = createModelAuthoringConversation();
    rememberModelAuthoringTurn(
      conversation,
      "Use this exact disabled deterministic policy.",
      "The disabled policy is confirmed and remains inactive.",
    );
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "No operator decision was supplied beyond requesting an explanation. Would you like to review the Read Boundary now?",
          }],
        }],
      },
    }));

    await expect(narrateValidatedAuthoringStep({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        apiKey: "memory-key",
        dependencies: { requestJson },
        conversation,
      },
      operatorMessage: "Explain the next unchanged permission.",
      validatedFacts: [
        "The disabled deterministic policy was confirmed and saved.",
        "Read and Action authority remain separate and disabled.",
      ],
      nextQuestion: "Would you like to review the Read Boundary now?",
      egressAcknowledged: true,
      responseStyle: "permission",
    })).resolves.toBeUndefined();
    expect(modelAuthoringHistory(conversation)).toHaveLength(1);
  });

  it("drops narration that invents principal isolation for a tenant-only record", async () => {
    const conversation = createModelAuthoringConversation();
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "The action is isolated by both tenant and principal and is ready for review.",
          }],
        }],
      },
    }));

    await expect(narrateValidatedAuthoringStep({
      session: {
        provider: "openai",
        model: "gpt-5.6-luna",
        apiKey: "memory-key",
        dependencies: { requestJson },
        conversation,
      },
      operatorMessage: "Summarize the validated draft.",
      validatedFacts: [
        "Trusted tenant-only scope (tenant_id); no principal row limit is configured.",
        "Action authority remains disabled and source data is unchanged.",
      ],
      egressAcknowledged: true,
    })).resolves.toBeUndefined();
    expect(modelAuthoringHistory(conversation)).toEqual([]);
  });
});

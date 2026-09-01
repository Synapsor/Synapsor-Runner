import { describe, expect, it, vi } from "vitest";
import {
  createModelAuthoringConversation,
  modelAuthoringHistory,
  rememberModelAuthoringTurn,
} from "./model-authoring-conversation.js";
import { narrateValidatedAuthoringStep } from "./model-authoring-narration.js";
import type { AskProviderDependencies } from "./model-ask.js";

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
});

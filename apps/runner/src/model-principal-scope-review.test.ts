import { describe, expect, it, vi } from "vitest";
import { interpretPrincipalScopeAnswer } from "./model-principal-scope-review.js";

describe("model-assisted principal-scope review", () => {
  it("translates an opaque setting explanation into one exact reviewed candidate", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_principal_scope",
          name: "runner__review_principal_scope_answer",
          arguments: JSON.stringify({
            status: "resolved",
            option_id: "candidate_1",
            rationale: "The operator said this setting carries the signed-in customer identity.",
          }),
        }],
      },
    }));

    await expect(interpretPrincipalScopeAnswer({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      resourceId: "telecom.accounts",
      options: [{
        id: "candidate_1",
        kind: "postgres_rls",
        value: "app.viewer_context",
        label: "PostgreSQL RLS setting app.viewer_context",
      }],
      answer: "Yes. app.viewer_context is set from the authenticated customer's signed session.",
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "resolved",
      option_id: "candidate_1",
      correction_used: false,
    });
  });

  it("asks for clarification instead of guessing between opaque candidates", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_principal_clarification",
          name: "runner__review_principal_scope_answer",
          arguments: JSON.stringify({
            status: "clarification",
            question: "Which setting is populated from the authenticated person's session?",
          }),
        }],
      },
    }));

    await expect(interpretPrincipalScopeAnswer({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      resourceId: "opaque.x7",
      options: [
        {
          id: "candidate_1",
          kind: "postgres_rls",
          value: "app.ctx_a",
          label: "PostgreSQL RLS setting app.ctx_a",
        },
        {
          id: "candidate_2",
          kind: "postgres_rls",
          value: "app.ctx_b",
          label: "PostgreSQL RLS setting app.ctx_b",
        },
      ],
      answer: "Use the context setting.",
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "clarification",
      question: "Which setting is populated from the authenticated person's session?",
      correction_used: false,
    });
  });
});

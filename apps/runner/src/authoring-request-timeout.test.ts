import { describe, expect, it } from "vitest";
import { authoringRequestTimeoutSeconds, withAuthoringRequestTimeout } from "./authoring-request-timeout.js";
import { reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { authoringDestination, newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { narrateValidatedAuthoringStep, type ModelAuthoringNarrationSession } from "./model-authoring-narration.js";
import { AskError, resolveAskProviderConfiguration, type AskProvider } from "./model-ask.js";

describe("operator authoring timeout", () => {
  it.each([0, -1, 601, 1.5, NaN, Infinity])("rejects invalid %s before the journey starts", seconds => {
    let started = false;
    expect(() => withAuthoringRequestTimeout(seconds, () => { started = true; })).toThrow("whole number from 1 through 600");
    expect(started).toBe(false);
    expect(authoringRequestTimeoutSeconds()).toBe(120);
  });

  it("isolates concurrent invocations and restores the caller after failure", async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const first = withAuthoringRequestTimeout(300, async () => {
      await barrier;
      expect(authoringRequestTimeoutSeconds()).toBe(300);
      await expect(withAuthoringRequestTimeout(600, async () => {
        await Promise.resolve();
        expect(authoringRequestTimeoutSeconds()).toBe(600);
        throw new AskError("ASK_CANCELLED", "Cancelled fixture.");
      })).rejects.toMatchObject({ code: "ASK_CANCELLED" });
      expect(authoringRequestTimeoutSeconds()).toBe(300);
    });
    await withAuthoringRequestTimeout(undefined, async () => {
      expect(authoringRequestTimeoutSeconds()).toBe(120);
      release();
      await first;
      expect(authoringRequestTimeoutSeconds()).toBe(120);
    });
    expect(authoringRequestTimeoutSeconds()).toBe(120);
  });

  it.each<AskProvider>(["openai", "anthropic", "openrouter", "openai_compatible"])(
    "carries the override to %s coverage and narration without changing Ask defaults", async provider => {
      const source = policyTextSnapshot(Buffer.from("Read permitted rows."), "fixture.txt");
      const conversation = createModelAuthoringConversation();
      conversation.policySources = newPolicySourceSession();
      conversation.policySources.snapshots = [source]; conversation.policySources.active = source.version;
      const observed: number[] = [];
      const session: ModelAuthoringNarrationSession = { provider,
        model: provider === "openrouter" ? "vendor/fixture" : "fixture", apiKey: "fixture-only-key",
        ...(provider === "openai_compatible" ? { baseUrl: "http://127.0.0.1:11434/v1" } : {}), conversation,
        dependencies: { requestJson: async request => {
          observed.push(request.timeoutMs!);
          // Stop at the real transport seam: no provider or fabricated successful review.
          throw new AskError("ASK_CANCELLED", "Cancelled fixture transport.");
        } },
      };
      conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination(session) }];
      for (const seconds of [undefined, 300]) {
        observed.length = 0;
        await withAuthoringRequestTimeout(seconds, async () => {
          await expect(reviewPolicyCoverage({ source, draft: {}, session, env: {} })).rejects.toThrow();
          const reviewCalls = observed.length;
          expect(reviewCalls).toBeGreaterThan(0);
          await expect(narrateValidatedAuthoringStep({ session, operatorMessage: "Review the rules.",
            validatedFacts: ["The draft remains disabled."], egressAcknowledged: true, env: {} })).resolves.toBeUndefined();
          expect(observed.length).toBeGreaterThan(reviewCalls);
          expect(observed.every(value => value === (seconds ?? 120) * 1000)).toBe(true);
          const ask = resolveAskProviderConfiguration({ provider: "openai", model: "fixture", api_key: "fixture-only-key",
            authority_digest: `sha256:${"a".repeat(64)}`, egress_acknowledged: true }, {}, new Date());
          expect(ask.request_timeout_seconds).toBe(30);
        });
      }
      expect(authoringRequestTimeoutSeconds()).toBe(120);
    });
});

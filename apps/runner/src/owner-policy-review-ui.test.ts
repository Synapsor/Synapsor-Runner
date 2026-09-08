import { describe, expect, it, vi } from "vitest";
import type { AnalyticsShellIo } from "./analytics-shell.js";
import type { LocalOwnerPolicyReview } from "./owner-policy-runtime.js";
import { renderOwnerRuleReview, reviewOwnerRules } from "./owner-policy-review-ui.js";

type PreparedReview = Awaited<ReturnType<LocalOwnerPolicyReview["prepare"]>>;

function reviewSummary() {
  return {
    scope: { level: "principal", tenant_id: "acme", principal: "maya" },
    agents: ["billing-agent", "support-agent"],
    source_database_changed: false,
    actions: [
      {
        outcome: "refund.approve",
        require: {
          kind: "all",
          conditions: [
            { kind: "compare", fact: "refund.amount_cents", operator: "lte", value: 5000 },
            { kind: "is_present", fact: "customer.account_id" },
          ],
        },
        approval: "inherit",
        auto_approve_when: { kind: "one_of", fact: "customer.tier", values: ["gold", "platinum"] },
      },
      {
        outcome: "invoice.send_reminder",
        require: { kind: "not", condition: { kind: "compare", fact: "invoice.status", operator: "eq", value: "paid" } },
        approval: "human",
      },
    ],
    hard_budget_limits: [
      { meter: "refund_count", maximum: 8 },
      { meter: "message_count", maximum: 40 },
    ],
    parent_budget_contracts: [
      { meter: "refund_count", title: "Refund approvals", unit: "refunds", window_ms: 3_600_000, scope: "principal", maximum: 10 },
      { meter: "message_count", title: "Outbound messages", unit: "messages", window_ms: 86_400_000, scope: "tenant", maximum: 100 },
      { meter: "export_count", title: "Customer exports", unit: "exports", window_ms: 86_400_000, scope: "tenant", maximum: 1 },
    ],
    previous_definition: {
      agents: ["billing-agent", "compliance-agent"],
      rules: [
        {
          outcome: "refund.approve",
          require: { kind: "compare", fact: "refund.amount_cents", operator: "lte", value: 1000 },
          approval: "inherit",
          auto_approve_when: { kind: "one_of", fact: "customer.tier", values: ["platinum"] },
        },
        {
          outcome: "export.customer_list",
          require: { kind: "compare", fact: "request.purpose", operator: "eq", value: "audit" },
          approval: "human",
        },
      ],
      budget_limits: [
        { meter: "refund_count", maximum: 3 },
        { meter: "export_count", maximum: 1 },
      ],
    },
  };
}

function policyError(code: string, secret = "human-review-secret") {
  return Object.assign(new Error(`credential ${secret} failed`), { code });
}

function fakeIo(input: { choices?: Array<string | undefined>; columns?: number; review?: AnalyticsShellIo["review"] } = {}) {
  const writes: string[] = [];
  const choices = [...(input.choices ?? [])];
  const io: AnalyticsShellIo = {
    read: async () => choices.shift(),
    choose: async () => choices.shift(),
    write: (value) => writes.push(value),
    columns: () => input.columns ?? 100,
    onInterrupt: () => () => undefined,
    close() {},
    isTerminal: () => false,
    review: input.review,
  };
  return { io, writes };
}

function fakeReview(prepared: PreparedReview): LocalOwnerPolicyReview {
  return { prepare: vi.fn(async () => prepared) };
}

function visibleLines(value: string): string[] {
  return value.replace(/\u001b\[[0-9;]*m/gu, "").split("\n").filter(Boolean);
}

describe("owner policy review UI", () => {
  it.each([
    ["Enter", ""],
    ["Escape", undefined],
  ])("keeps the prepared draft disabled on %s", async (_key, choice) => {
    const confirm = vi.fn(async () => undefined), cancel = vi.fn();
    const review = fakeReview({ summary: reviewSummary(), confirm, cancel });
    const { io, writes } = fakeIo({ choices: [choice] });

    await reviewOwnerRules(io, review);

    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(writes.join("\n")).toContain("Draft kept disabled. Your active rules are unchanged.");
    expect(writes.join("\n")).not.toContain("Agent rules activated.");
  });

  it("shows exact details from the prepared revision without another prepare or model call", async () => {
    const summary = reviewSummary(), confirm = vi.fn(async () => undefined), cancel = vi.fn();
    const prepared = { summary, confirm, cancel };
    const review = fakeReview(prepared);
    const modelCall = vi.fn();
    const humanAuthorization = vi.fn(async () => undefined);
    confirm.mockImplementation(async () => { await humanAuthorization(); });
    const detailViews: Array<{ title: string; lines: string[]; returnTo?: string }> = [];
    const { io, writes } = fakeIo({ choices: ["details", "activate"], review: async (title, lines, returnTo) => {
      detailViews.push({ title, lines, returnTo });
    } });

    await reviewOwnerRules(io, review);

    expect(review.prepare).toHaveBeenCalledOnce();
    expect(detailViews).toEqual([{ title: "Exact agent-rule revision", lines: JSON.stringify(summary, null, 2).split("\n"), returnTo: "Agent-rule confirmation" }]);
    expect(confirm).toHaveBeenCalledOnce();
    expect(humanAuthorization).toHaveBeenCalledOnce();
    expect(modelCall).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(writes.join("\n")).toContain("Agent rules activated.");
  });

  it("activates only after the explicit choice and only once", async () => {
    const confirm = vi.fn(async () => undefined), cancel = vi.fn();
    const review = fakeReview({ summary: reviewSummary(), confirm, cancel });
    const { io } = fakeIo({ choices: ["activate"] });

    await reviewOwnerRules(io, review);

    expect(confirm).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    ["prepare", "POLICY_CREDENTIAL_REQUIRED"],
    ["confirmation", "POLICY_AUTHENTICATION_FAILED"],
  ])("sanitizes %s authentication failures without exposing credentials", async (stage, code) => {
    const secret = "never-print-this-human-token";
    const confirm = vi.fn(async () => { throw policyError(code, secret); });
    const cancel = vi.fn();
    const review: LocalOwnerPolicyReview = stage === "prepare"
      ? { prepare: vi.fn(async () => { throw policyError(code, secret); }) }
      : fakeReview({ summary: reviewSummary(), confirm, cancel });
    const { io, writes } = fakeIo({ choices: ["activate"] });

    await reviewOwnerRules(io, review);

    const output = writes.join("\n");
    expect(output).toContain("separate human-review sign-in is missing or expired");
    expect(output).toContain(`Review status: ${code}.`);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("credential ");
    if (stage === "confirmation") expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not claim success when a stale prepared revision is rejected and cleans it up", async () => {
    const confirm = vi.fn(async () => { throw policyError("POLICY_REVIEW_INVALID"); });
    const cancel = vi.fn();
    const review = fakeReview({ summary: reviewSummary(), confirm, cancel });
    const { io, writes } = fakeIo({ choices: ["activate"] });

    await reviewOwnerRules(io, review);

    expect(confirm).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(writes.join("\n")).toContain("a stale review cannot activate a newer draft");
    expect(writes.join("\n")).not.toContain("Agent rules activated.");
  });

  it("replaces a malformed status code so an embedded credential is never displayed", async () => {
    const secret = "credential-payload-must-not-reach-the-terminal";
    const confirm = vi.fn(async () => { throw policyError(`POLICY_AUTHENTICATION_FAILED_${secret}`, secret); });
    const cancel = vi.fn();
    const review = fakeReview({ summary: reviewSummary(), confirm, cancel });
    const { io, writes } = fakeIo({ choices: ["activate"] });

    await reviewOwnerRules(io, review);

    const output = writes.join("\n");
    expect(output).toContain("Review status: POLICY_REVIEW_UNAVAILABLE.");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("POLICY_AUTHENTICATION_FAILED_");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels the exact prepared continuation after viewing details and choosing disabled", async () => {
    const confirm = vi.fn(async () => undefined), cancel = vi.fn();
    const review = fakeReview({ summary: reviewSummary(), confirm, cancel });
    const { io } = fakeIo({ choices: ["details", "cancel"], review: async () => undefined });

    await reviewOwnerRules(io, review);

    expect(review.prepare).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("wraps the human review consistently at narrow and wide terminal widths", async () => {
    const narrow = fakeIo({ choices: ["cancel"], columns: 28 });
    const wide = fakeIo({ choices: ["cancel"], columns: 160 });
    const makeReview = () => fakeReview({ summary: reviewSummary(), confirm: vi.fn(async () => undefined), cancel: vi.fn() });

    await reviewOwnerRules(narrow.io, makeReview());
    await reviewOwnerRules(wide.io, makeReview());

    const narrowLines = visibleLines(narrow.writes[0]!);
    const wideLines = visibleLines(wide.writes[0]!);
    expect(narrowLines.every((line) => line.length <= 24)).toBe(true);
    expect(wideLines.every((line) => line.length <= 156)).toBe(true);
    expect(narrowLines.length).toBeGreaterThan(wideLines.length);
    expect(wideLines).toContain("Parent safeguards and spent/reserved allowance remain enforced.");
  });

  it("renders predicates and every material before-and-after rule, approval, and allowance change", () => {
    const rendered = renderOwnerRuleReview(reviewSummary()).join("\n");

    expect(rendered).toContain("Required: (refund.amount_cents <= 5000 AND customer.account_id is present)");
    expect(rendered).toContain("To defer to the Action approval policy: customer.tier is one of \"gold\", \"platinum\"; otherwise human review required");
    expect(rendered).toContain("Previously required: refund.amount_cents <= 1000");
    expect(rendered).toContain("Approval: human review required");
    expect(rendered).toContain("Previous conditional deferral: customer.tier is one of \"platinum\"; otherwise human review required");
    expect(rendered).toContain("invoice.send_reminder (new)");
    expect(rendered).toContain("Removed permission: export.customer_list");
    expect(rendered).toContain("Applies to: billing-agent, support-agent");
    expect(rendered).toContain("Previously applied to: billing-agent, compliance-agent");
    expect(rendered).toContain("Hard allowance Refund approvals: 8 refunds per rolling 1 hour (owner across agents; parent cap 10)");
    expect(rendered).toContain("Hard allowance Outbound messages: 40 messages per rolling 1 day (shared account; parent cap 100)");
    expect(rendered).toContain("Inherited allowance Customer exports: 1 exports per rolling 1 day (shared account)");
    expect(rendered).toContain("Previous allowance refund_count: 3; revised above");
    expect(rendered).toContain("Previous allowance export_count: 1; now inherits the parent cap");
    expect(rendered).toContain("Allowances measure successful effects plus outstanding reservations, not approval counts.");
  });
});

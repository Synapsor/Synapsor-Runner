import { describe, expect, it, vi } from "vitest";
import {
  planModelBoundaryJob,
  type BoundaryJobCurrentState,
} from "./boundary-job-model.js";

const reusableState: BoundaryJobCurrentState = {
  read: {
    boundary_name: "reviewed_staging",
    authority: "disabled",
    fully_reviewed: true,
    resource_ids: ["telecom.accounts", "telecom.billing_preferences"],
    exact_reusable_revision_count: 1,
  },
  actions: [],
  control_plane: {
    trusted_scope: "runner_injected",
    approval_history: "runner_proposal_ledger",
    model_may_supply_scope_values: false,
    model_may_supply_approval_history: false,
  },
};

describe("model Boundary job planning", () => {
  it("reuses an exact Read revision and routes an action-only continuation to Action drafting", async () => {
    const requests: string[] = [];
    const requestJson = vi.fn(async (request) => {
      requests.push(JSON.stringify(request.body));
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: "call_boundary_job",
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "reuse",
              action_mode: "create",
              action_intent: "Propose changing only monthly_spend_alert_cents with reviewed bounds and rolling approval limits.",
              summary: "I will keep the reviewed reads unchanged and prepare only the requested proposal action.",
            }),
          }],
        },
      };
    });

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Reuse the existing Read Boundary and add only a bounded spend-alert proposal.",
      currentState: reusableState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "create",
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    });
    expect(requests[0]).toContain("Runner's proposal ledger");
    expect(requests[0]).toContain("read_mode=reuse");
    expect(requests[0]).not.toContain("memory-key");
  });

  it("accepts a bounded expanded Action routing intent without changing the operator job limit", async () => {
    const expandedIntent = `Propose only the reviewed spend-alert update. ${"Keep proposal-only policy detail. ".repeat(18)}`.trim();
    expect([...expandedIntent].length).toBeGreaterThan(500);
    expect([...expandedIntent].length).toBeLessThanOrEqual(1_000);
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_expanded_action_intent",
          name: "runner__plan_boundary_job",
          arguments: JSON.stringify({
            status: "planned",
            read_mode: "reuse",
            action_mode: "create",
            action_intent: expandedIntent,
            summary: "Keep the reviewed Read revision and prepare only the proposal action.",
          }),
        }],
      },
    }));

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Reuse the reviewed reads and add only the bounded spend-alert proposal.",
      currentState: reusableState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "create",
      action_intent: expandedIntent,
    });
  });

  it("splits fresh Read and Action intent instead of sending policy wording as a Read question", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_boundary_job",
          name: "runner__plan_boundary_job",
          arguments: JSON.stringify({
            status: "planned",
            read_mode: "create",
            read_intent: "Let the authenticated customer inspect their own account and invoices.",
            action_mode: "create",
            action_intent: "Propose a bounded update to monthly_spend_alert_cents with rolling approval limits.",
            summary: "I separated customer reads from the spend-alert proposal.",
          }),
        }],
      },
    }));

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Read my account and propose a spend-alert update, but never apply it.",
      availableResourceIds: ["telecom.accounts", "telecom.billing_preferences"],
      currentState: {
        ...reusableState,
        read: {
          ...reusableState.read,
          fully_reviewed: false,
          exact_reusable_revision_count: 0,
          resource_ids: [],
        },
      },
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "create",
      read_intent: "Let the authenticated customer inspect their own account and invoices.",
      action_mode: "create",
      action_intent: "Propose a bounded update to monthly_spend_alert_cents with rolling approval limits.",
    });
  });

  it("repairs a job split that silently omits one explicitly requested reviewed read area", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const readIntent = attempt === 1
        ? "Let the authenticated customer read their own account, subscription, service lines, invoices, payments, billing preferences, and support cases."
        : "Let the authenticated customer read their own account, subscription, service lines, recent usage, invoices, payments, billing preferences, and support cases.";
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_boundary_job_${attempt}`,
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "create",
              read_intent: readIntent,
              action_mode: "create",
              action_intent: "Propose changing only monthly_spend_alert_cents with reviewed bounds and human approval.",
              summary: attempt === 1
                ? "I prepared seven customer read areas and one proposal action."
                : "I preserved all eight requested read areas, including recent usage, and separated the proposal action.",
            }),
          }],
        },
      };
    });

    const result = await planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Let the authenticated telecom customer read only their own account, subscription, service lines, recent usage, invoices, payments, billing preferences, and support cases. Let the agent propose changing only monthly_spend_alert_cents. Never apply or write source changes.",
      availableResourceIds: [
        "telecom.account_memberships",
        "telecom.accounts",
        "telecom.billing_preferences",
        "telecom.invoices",
        "telecom.payments",
        "telecom.service_lines",
        "telecom.subscribers",
        "telecom.subscriptions",
        "telecom.support_case_notes",
        "telecom.support_cases",
        "telecom.usage_daily",
      ],
      currentState: {
        ...reusableState,
        read: {
          ...reusableState.read,
          fully_reviewed: false,
          exact_reusable_revision_count: 0,
          resource_ids: [],
        },
      },
      egressAcknowledged: true,
    });

    expect(result).toMatchObject({
      state: "planned",
      correction_used: true,
      read_mode: "create",
      read_intent: expect.stringContaining("recent usage"),
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requests[1]).toContain("telecom.usage_daily");
    expect(requests[1]).toContain("omitted explicitly requested reviewed reads");
  });

  it("returns one model clarification rather than inventing a source field", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_boundary_job",
          name: "runner__plan_boundary_job",
          arguments: JSON.stringify({
            status: "clarification",
            question: "Should the existing reviewed customer reads remain unchanged while I add only the spend-alert proposal?",
          }),
        }],
      },
    }));

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Continue the customer setup.",
      currentState: reusableState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "clarification",
      question: expect.stringContaining("remain unchanged"),
      authority_granted: false,
      source_database_changed: false,
    });
  });

  it("gives a new conversation both live authority and disabled Action changes without exposing values", async () => {
    let requestBody = "";
    const requestJson = vi.fn(async (request) => {
      requestBody = JSON.stringify(request.body);
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: "call_existing_state",
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "reuse",
              action_mode: "reuse",
              summary: "I will keep the live Read authority and the existing Action revisions unchanged.",
            }),
          }],
        },
      };
    });

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Keep the current customer reads and spend-alert action unchanged.",
      currentState: {
        ...reusableState,
        read: {
          ...reusableState.read,
          authority: "active_with_disabled_changes",
        },
        actions: [
          {
            capability: "billing_preference.propose_update",
            operation: "update",
            resource: "telecom.billing_preferences",
            authority: "active",
          },
          {
            capability: "billing_preference.propose_update",
            operation: "update",
            resource: "telecom.billing_preferences",
            authority: "disabled",
          },
        ],
      },
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "reuse",
      authority_granted: false,
      source_database_changed: false,
    });
    expect(requestBody).toContain("active_with_disabled_changes");
    expect(requestBody.match(/billing_preference\.propose_update/gu)).toHaveLength(2);
    expect(requestBody).toContain("Do not merely repeat the operator request");
    expect(requestBody).not.toContain("memory-key");
  });
});

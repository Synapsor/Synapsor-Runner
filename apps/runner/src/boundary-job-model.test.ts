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
  it("resumes an exact disabled Read mapping instead of asking the model to map it again", async () => {
    let requestBody = "";
    const requestJson = vi.fn(async (request) => {
      requestBody = JSON.stringify(request.body);
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: "call_resume_boundary_job",
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "resume",
              action_mode: "create",
              action_intent: "Continue the bounded spend-alert proposal against the already mapped customer reads.",
              action_strategy: "discretionary",
              summary: "I will keep the exact disabled Read mapping and continue only its pending Action setup.",
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
      jobIntent: "Continue the saved customer setup and finish its spend-alert proposal.",
      currentState: {
        ...reusableState,
        read: {
          ...reusableState.read,
          fully_reviewed: false,
          exact_reusable_revision_count: 0,
          resumable_draft_count: 1,
          resumable_resource_ids: ["telecom.accounts", "telecom.billing_preferences"],
        },
      },
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "resume",
      action_mode: "create",
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    });
    expect(requestBody).toContain("resumable_draft_count");
    expect(requestBody).toContain("read_mode=resume");
    expect(requestBody).toContain("branches of ONE business action, not separate action_intents");
    expect(requestBody).toContain("never create a refusal-only or approval-routing-only action");
    expect(requestBody).not.toContain("memory-key");
  });

  it("keeps Action thresholds out of job routing and repairs to a focused Action intent", async () => {
    let attempt = 0;
    const requestJson = vi.fn(async () => {
      attempt += 1;
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_policy_routing_${attempt}`,
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify(attempt === 1
              ? {
                  status: "clarification",
                  question: "What maximum approval count and rolling window should apply to this proposal?",
                }
              : {
                  status: "planned",
                  read_mode: "reuse",
                  action_mode: "create",
                  action_intent: "Prepare the bounded spend-alert proposal and retain its unresolved rolling approval policy for focused Action authoring.",
                  action_strategy: "discretionary",
                  summary: "I will keep the reviewed reads and continue the requested Action setup.",
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
      jobIntent: "Keep the current reads and add a spend-alert proposal with a rolling approval limit.",
      currentState: reusableState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "create",
      correction_used: true,
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("routes new outcomes to fixed tools even when a model uses the legacy strategy label", async () => {
    let attempt = 0;
    const requestBodies: string[] = [];
    const requestJson = vi.fn(async (request: { body: unknown }) => {
      attempt += 1;
      requestBodies.push(JSON.stringify(request.body));
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_exact_refund_${attempt}`,
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "reuse",
              action_mode: "create",
              action_intent: "For a selected posted charge confirmed as duplicate, request an exact refund equal to that charge.",
              action_strategy: attempt === 1 ? "discretionary" : "rule_derived",
              summary: "Keep the reviewed reads and prepare one disabled exact-refund outcome.",
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
      jobIntent: "For a selected posted charge that is authoritatively confirmed as duplicate, let the agent request an exact refund equal to that charge.",
      currentState: reusableState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "create",
      action_strategy: "rule_derived",
      correction_used: false,
    });
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestBodies[0]).toContain("bounded business inputs");
  });

  it("routes a copied source-row refund through verified Action Rules", async () => {
    let attempt = 0;
    const requestBodies: string[] = [];
    const requestJson = vi.fn(async (request: { body: unknown }) => {
      attempt += 1;
      requestBodies.push(JSON.stringify(request.body));
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_copied_refund_${attempt}`,
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "create",
              read_intent: "Let the authenticated customer inspect only their own account, tickets, and charges.",
              action_mode: "create",
              action_intent: "For a posted duplicate-confirmed charge at most 2500 cents, insert one submitted account-credit refund copying the charge and amount.",
              action_strategy: attempt === 1 ? "discretionary" : "rule_derived",
              summary: "Prepare scoped customer reads and one disabled verified refund outcome.",
            }),
          }],
        },
      };
    });
    const job = "Let an authenticated support customer inspect only their own account, tickets, and charges. For a posted, duplicate-confirmed charge at most 2500 cents, let the agent propose one submitted account-credit refund copying the charge and amount. Auto-approve at most 100 per 24 hours and one per trusted tenant plus principal per 15 days; otherwise require one support_reviewer. Proposal only; never apply or write source data.";

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: job,
      currentState: {
        ...reusableState,
        read: {
          ...reusableState.read,
          fully_reviewed: false,
          resource_ids: [],
          exact_reusable_revision_count: 0,
        },
      },
      availableResourceIds: [
        "support_ops.charges",
        "support_ops.customer_accounts",
        "support_ops.refund_requests",
        "support_ops.support_tickets",
      ],
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "create",
      action_mode: "create",
      action_strategy: "rule_derived",
      correction_used: false,
    });
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestBodies[0]).toContain("bounded business inputs");
  });

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

  it("accepts a bounded expanded Action routing intent", async () => {
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

  it("plans a realistic job longer than 500 characters without truncating policy intent", async () => {
    const job = [
      "Let an authenticated support customer inspect only their own account, tickets, charges, and refund history.",
      "For a selected posted charge that Runner verifies as duplicate and still refundable, let the agent propose one submitted refund request that copies the exact charge amount and account association.",
      "Allow account credit or original payment method, but never let the model supply a tenant, principal, account key, charge key, SQL fragment, approval decision, or source patch.",
      "Auto-approve only duplicate-charge refunds at or below 2500 cents, at most 100 for this outcome per rolling 24 hours and one per trusted tenant plus principal per rolling 15 days.",
      "Anything missing, stale, ineligible, or outside those limits requires one support_reviewer, and source writeback must remain disabled.",
    ].join(" ");
    expect([...job].length).toBeGreaterThan(500);
    expect([...job].length).toBeLessThanOrEqual(2_000);
    const requestBodies: string[] = [];
    const requestJson = vi.fn(async (request: { body: unknown }) => {
      requestBodies.push(JSON.stringify(request.body));
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: "call_long_job",
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "create",
              read_intent: "Let the authenticated customer inspect only their own account, tickets, charges, and refund history.",
              action_mode: "create",
              action_intent: "For a selected posted duplicate charge, propose one exact bounded refund. Auto-approve at most 100 per rolling 24 hours and one per trusted tenant plus principal per rolling 15 days; otherwise require one support_reviewer. Keep writeback disabled.",
              action_strategy: "rule_derived",
              summary: "Prepare customer-scoped reads and one verified refund proposal outcome.",
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
      jobIntent: job,
      currentState: {
        ...reusableState,
        read: {
          ...reusableState.read,
          fully_reviewed: false,
          resource_ids: [],
          exact_reusable_revision_count: 0,
        },
      },
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "create",
      action_mode: "create",
      action_strategy: "rule_derived",
    });
    expect(requestBodies[0]).toContain(job);
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

  it("selects one exact semantic outcome for a natural-language revision", async () => {
    let attempt = 0;
    const requestJson = vi.fn(async () => {
      attempt += 1;
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_action_revision_${attempt}`,
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "reuse",
              action_mode: "revise",
              action_intent: "Keep the pause outcome but require two billing reviewers.",
              action_strategy: "rule_derived",
              ...(attempt === 1 ? {} : { action_outcome: "billing.pause_account" }),
              summary: "Keep the Read Boundary and prepare a disabled replacement for the pause policy.",
            }),
          }],
        },
      };
    });
    const currentState: BoundaryJobCurrentState = {
      ...reusableState,
      actions: [
        {
          capability: "app.request_change",
          kind: "rule_derived",
          action_boundary_name: "billing_actions",
          outcome: "billing.pause_account",
          operation: "update",
          resource: "billing.accounts",
          authority: "active",
        },
        {
          capability: "app.request_change",
          kind: "rule_derived",
          action_boundary_name: "billing_actions",
          outcome: "billing.request_refund",
          operation: "insert",
          resource: "billing.refund_requests",
          authority: "active",
        },
      ],
    };

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Change the account pause policy to require two billing reviewers.",
      currentState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "revise",
      action_strategy: "rule_derived",
      action_outcome: "billing.pause_account",
      correction_used: true,
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("canonicalizes a redundant Read intent while revising the sole semantic outcome", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_existing_refund_revision",
          name: "runner__plan_boundary_job",
          arguments: JSON.stringify({
            status: "planned",
            read_mode: "reuse",
            read_intent: "Keep the current customer Read Boundary unchanged.",
            action_mode: "revise",
            action_intent: "Require two support_reviewer approvals for the existing refund request outcome.",
            action_strategy: "discretionary",
            summary: "Keep the current reads and prepare one disabled approval-policy replacement.",
          }),
        }],
      },
    }));
    const currentState: BoundaryJobCurrentState = {
      ...reusableState,
      read: { ...reusableState.read, authority: "active" },
      actions: [{
        capability: "app.request_change",
        kind: "rule_derived",
        action_boundary_name: "support_actions",
        outcome: "support.refund_request.proposed",
        operation: "insert",
        resource: "support.refund_requests",
        authority: "active",
      }],
    };

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Keep the active Read boundary unchanged. Change only the existing refund request outcome to require two support_reviewer approvals.",
      currentState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "revise",
      action_outcome: "support.refund_request.proposed",
      action_strategy: "rule_derived",
      correction_used: false,
    });
    const result = await planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Keep the active Read boundary unchanged. Change only the existing refund request outcome to require two support_reviewer approvals.",
      currentState,
      egressAcknowledged: true,
    });
    expect(result).not.toHaveProperty("read_intent");
  });

  it("routes an explicit policy-only edit of the sole semantic outcome without a fragile model split", async () => {
    const requestJson = vi.fn(async () => {
      throw new Error("The general planner must not be needed for an exact sole-outcome revision.");
    });
    const jobIntent = "Change only the existing refund outcome's human fallback quorum from one reviewer to two reviewers. Keep the active Read and Action baseline, scopes, eligibility, copied fields, reason, method, status, automatic approval threshold, limits, proposal-only behavior, and every unrelated policy and effect unchanged.";

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent,
      currentState: {
        ...reusableState,
        read: { ...reusableState.read, authority: "active" },
        actions: [{
          capability: "app.request_change",
          kind: "rule_derived",
          action_boundary_name: "support_actions",
          outcome: "support.refund_request_submitted",
          operation: "insert",
          resource: "support_ops.refund_requests",
          authority: "active",
        }],
      },
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "revise",
      action_outcome: "support.refund_request_submitted",
      action_strategy: "rule_derived",
      action_intent: jobIntent,
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    });
    expect(requestJson).not.toHaveBeenCalled();
  });
});

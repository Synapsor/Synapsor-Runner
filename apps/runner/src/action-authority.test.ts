import { describe, expect, it } from "vitest";
import {
  actionAuthorityForCapability,
  classifyActionAuthorityTransition,
  resolveActionAuthority,
} from "./action-authority.js";

describe("Safe Action authority revisions", () => {
  it("defaults to proposal-only authority", () => {
    expect(resolveActionAuthority({})).toEqual({
      posture: "proposal_only",
      writeback: { mode: "none" },
      supervised_worker_execution: false,
      source_database_can_change_after_separate_execution: false,
    });
  });

  it("keeps execution and supervision explicit", () => {
    expect(resolveActionAuthority({
      authority_posture: "executable",
      writeback: { mode: "direct_sql" },
    })).toMatchObject({
      posture: "executable",
      writeback: { mode: "direct_sql" },
      supervised_worker_execution: false,
    });
    expect(resolveActionAuthority({
      authority_posture: "supervised_execution",
      writeback: { mode: "direct_sql" },
      supervised_worker_execution: true,
    })).toMatchObject({
      posture: "supervised_execution",
      supervised_worker_execution: true,
    });
  });

  it("refuses contradictory authority combinations", () => {
    expect(() => resolveActionAuthority({
      authority_posture: "proposal_only",
      writeback: { mode: "direct_sql" },
    })).toThrow(/PROPOSAL_ONLY_WRITEBACK_FORBIDDEN/);
    expect(() => resolveActionAuthority({
      authority_posture: "supervised_execution",
      writeback: { mode: "app_handler", executor: "billing_handler" },
      supervised_worker_execution: true,
    })).toThrow(/SUPERVISED_DIRECT_SQL_REQUIRED/);
    expect(() => resolveActionAuthority({
      authority_posture: "executable",
      writeback: { mode: "app_handler" },
    })).toThrow(/HANDLER_REQUIRED/);
  });

  it("classifies promotion as a new revision and never retrofits old proposals", () => {
    const proposalOnly = resolveActionAuthority({});
    const executable = resolveActionAuthority({
      authority_posture: "executable",
      writeback: { mode: "direct_sql" },
    });
    expect(classifyActionAuthorityTransition(proposalOnly, executable)).toEqual({
      kind: "promotion",
      requires_new_revision: true,
      old_proposals_gain_execution_authority: false,
    });
  });

  it("classifies canonical contract capabilities", () => {
    expect(actionAuthorityForCapability({
      name: "billing.propose_credit",
      kind: "proposal",
      context: "operator",
      source: "billing",
      subject: { schema: "public", table: "accounts", primary_key: "id", tenant_key: "tenant_id" },
      args: {},
      visible_fields: ["id"],
      evidence: { required: true },
      proposal: {
        action: "credit",
        allowed_fields: ["credit_cents"],
        patch: { credit_cents: { fixed: 10 } },
        approval: { mode: "human", required_role: "billing_reviewer" },
        writeback: { mode: "none" },
      },
    })).toMatchObject({ posture: "proposal_only", writeback: { mode: "none" } });
  });
});

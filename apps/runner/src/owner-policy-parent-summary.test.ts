import { describe, expect, it } from "vitest";
import { ownerPolicyTestFixture } from "../../../packages/mcp-server/src/owner-policy-test-fixture.js";
import type { OperatorParentReview } from "./owner-policy-parent-review.js";
import { parentReviewLines } from "./owner-policy-parent-summary.js";

describe("operator parent decision summary", () => {
  it.each([52, 80, 120])("shows scope, editable facts and approval changes without JSON at %i columns", (width) => {
    const fixture = ownerPolicyTestFixture();
    const after: OperatorParentReview["after"] = { schema_version: "synapsor.policy-management-parent.v1", delegation: fixture.parent,
      managers: [{ subject: "reviewer", actor_kind: "human", tenant_id: "acme", scope: { mode: "personal" }, permissions: ["inspect", "draft", "activate"] }],
      agent_owners: [{ agent: "agent-a", scope: { level: "principal", tenant_id: "acme", principal: "maya" } }] };
    const before = structuredClone(after);
    before.delegation.outcomes[0]!.allow_automatic_approval = false;
    after.delegation.outcomes[0]!.allow_automatic_approval = true;
    const lines = parentReviewLines({ name: "inventory_rules", before, after, expected_epoch: 2,
      before_revision: "old", digest: `sha256:${"a".repeat(64)}`, expires_at: "2026-09-08T14:00:00Z" }, width);
    expect(lines.every((line) => line.length <= width)).toBe(true);
    const text = lines.join("\n");
    for (const label of ["Who may edit", "Agent owners", "Business action", "Editable facts", "Always required", "Approval change"]) expect(text).toContain(label);
    expect(text).not.toContain('"schema_version"');
    expect(text).toContain("acme / maya");
    expect(text).toContain("Human review only ->");
    expect(text).toContain("Runtime bindings: 0");
    for (const fact of fixture.parent.outcomes[0]!.facts) expect(text.replace(/\s+/gu, " ")).toContain(fact.title);
  });
});

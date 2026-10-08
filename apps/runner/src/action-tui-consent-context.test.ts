import { expect, it, vi } from "vitest";
import { proposalActivationView } from "./authoring-activation-view.js";
const io = vi.hoisted(() => ({ activate: vi.fn(), design: {
  capability_name: "work.propose_update", description: "Propose the selected update", business_object: "item", resource: "work.items", operation: "update",
  conflict_column: "version", patches: [{ column: "status", value_source: "fixed", fixed_value: "reviewed" }], approval_role: "reviewer",
  required_approvals: 1, authority_posture: "proposal_only", writeback: { mode: "none" }, confirmed_trusted_scope: true,
}, resource: { id: "work.items", schema: "work", table: "items", primary_key: "id", tenant_key: "tenant_id", principal_key: "principal_id",
  writable_fields: [], structurally_eligible_fields: [{ name: "status", data_type: "text", enum_values: ["reviewed"], nullable: false }], version_columns: ["version"] } }));
vi.mock("./guided-action.js", async importOriginal => ({ ...await importOriginal<typeof import("./guided-action.js")>(),
  readGuidedActionDesignInput: async () => io.design,
  guidedActionOptions: async () => ({ boundary_state: "active", resources: [io.resource] }),
  guidedActionStatus: async () => ({ action_boundary: { active: { name: "reviewed", authority: { shared_limits: [] } } } }),
  activateGuidedAction: io.activate,
}));
import { reviewActionDraft, type ActionControlPrompter } from "./action-tui.js";
it("passes typed activation context from the real proposal prompt without changing default-No or enabling it", async () => {
  const choose = vi.fn<ActionControlPrompter["choose"]>(async () => "back");
  const result = await reviewActionDraft({ projectRoot: "/not-accessed-by-this-port-test", inspection: {} as never,
    draft: { capability: io.design.capability_name, authority_posture: "proposal_only", effect_preview: { source_database_changed: false },
      action_boundary_digest: `sha256:${"a".repeat(64)}` } as never,
    quickStart: true, env: {}, prompter: { choose, text: async () => undefined, confirm: async () => false, message: async () => {} } });
  expect(result).toBeUndefined(); expect(choose).toHaveBeenCalledOnce();
  const args = choose.mock.calls[0]!;
  expect(args[1].map(choice => choice.value)).toEqual(["activate", "advanced", "back"]);
  expect(args[3]).toBe("back");
  expect(args[4]).toEqual({ decisionKind: "activation", activationView: proposalActivationView() });
  expect(io.activate).not.toHaveBeenCalled();
});

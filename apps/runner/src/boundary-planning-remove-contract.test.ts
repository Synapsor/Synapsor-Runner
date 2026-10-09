import { expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { planModelBoundaryJob, type BoundaryJobCurrentState } from "./boundary-job-model.js";
import { AskError } from "./model-ask.js";
import { READ_SCOPE_PROTOCOL, readScopeProposalSchema } from "./read-structured-scope.js";

it("advertises the required typed Read scope on the actual outgoing Remove planning branch", async () => {
  // Declared structural state supplied to the real planner. This tests its
  // outgoing contract, not saved authority or the success of a removal.
  const job = "Remove the existing reserve_item outcome while leaving data access unchanged.";
  const currentState: BoundaryJobCurrentState = {
    read: { boundary_name: "warehouse", authority: "disabled", fully_reviewed: false,
      resource_ids: ["warehouse.items"], exact_reusable_revision_count: 0 },
    actions: [{ capability: "reserve_item", kind: "rule_derived", action_boundary_name: "warehouse-actions",
      outcome: "reserve_item", operation: "update", resource: "warehouse.items", authority: "disabled" }],
    control_plane: { trusted_scope: "runner_injected", approval_history: "runner_proposal_ledger",
      model_may_supply_scope_values: false, model_may_supply_approval_history: false },
  };
  let requestBody: unknown, sends = 0;
  await expect(planModelBoundaryJob({ jobIntent: job, currentState, availableResourceIds: ["warehouse.items"],
    egressAcknowledged: true, structuredScope: { protocol: READ_SCOPE_PROTOCOL,
      current: () => ({ binding: { request_digest: d(job), source_digest: d(null), catalog_digest: d("declared catalog"),
        meaning_digest: d("declared meaning"), applicability_digest: d("declared use"), operation_digest: d("declared current state") },
      references: [{ id: "job", kind: "request" as const, digest: d(job), text: job }],
      catalog: { resources: [{ id: "warehouse.items", fields: [{ id: "label" }] }], relationships: [] } }) },
    session: { provider: "openai", model: "controlled-contract", apiKey: "inert-local-credential",
      dependencies: { requestJson: async request => { sends++; requestBody = request.body;
        throw new AskError("ASK_PROVIDER_REQUEST_INVALID", "EXPECTED_OFFLINE_CONTRACT_CAPTURE", 400); } } },
  })).rejects.toBeDefined();
  expect(sends).toBe(1);
  const branches: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const object = value as Record<string, unknown>, properties = object.properties as Record<string, { enum?: string[] }> | undefined;
      if (properties?.action_mode?.enum?.includes("remove")) branches.push(object);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(requestBody); expect(branches).toHaveLength(1);
  expect(branches[0]!.required).toContain("read_scope");
  expect((branches[0]!.properties as Record<string, unknown>).read_scope).toEqual(readScopeProposalSchema);
  expect(branches[0]!.additionalProperties).toBe(false);
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { probeTryEmbeddedScope, runTryExperience, TryExperienceError } from "./try-experience.js";
import { resolveTryStateLocation } from "./try-state.js";

describe("Synapsor try experience", () => {
  it("keeps the embedded source unchanged when the operator rejects", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-try-reject-"));
    const result = await runTryExperience({
      root_dir: root,
      review: async () => "reject",
    });

    expect(result.ok).toBe(true);
    expect(result.proposal.state).toBe("rejected");
    expect(result.proposal.source_database_changed_before_approval).toBe(false);
    expect(result.receipt).toBeUndefined();
    expect(result.source_after.late_fee_cents).toBe(5500);
    expect(result.replay.receipts).toHaveLength(0);
    expect(result.model_tools).not.toContain("execute_sql");
    expect(result.model_tools).not.toContain("approve");
    expect(result.model_tools).not.toContain("apply");
    expect(JSON.stringify(result)).not.toMatch(/internal_risk_note|internal_agent_note/);
  });

  it("applies only after approval and proves retry, collision, stale, and replay behavior", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-try-prove-"));
    const managedRoot = resolveTryStateLocation(root).root;
    let sourceChangedAtReview = true;
    const result = await runTryExperience({
      root_dir: root,
      prove: true,
      review: async (context) => {
        const source = JSON.parse(await fs.readFile(path.join(managedRoot, "source.json"), "utf8"));
        sourceChangedAtReview = source.invoices["INV-3001"].late_fee_cents !== 5500;
        expect(context.proposal.state).toBe("pending_review");
        expect(context.proposed_effect).toEqual({
          field: "late_fee_cents",
          before: 5500,
          after: 0,
        });
        return "approve";
      },
    });

    expect(sourceChangedAtReview).toBe(false);
    expect(result.proposal.state).toBe("applied");
    expect(result.receipt).toMatchObject({
      status: "applied",
      rows_affected: 1,
      idempotency_key: "op_try_waive_INV_3001_v1",
      source_database_mutated: true,
    });
    expect(result.source_after).toMatchObject({
      tenant_id: "acme",
      late_fee_cents: 0,
      updated_at: "2026-07-19T09:01:00.000Z",
    });
    expect(result.proof).toEqual({
      restart_safe_retry: true,
      retry_status: "already_applied",
      duplicate_mutations: 0,
      changed_intent_rejected: true,
      changed_intent_error_code: "IDEMPOTENCY_IDENTITY_CONFLICT",
      changed_intent_components: {
        tenant: true,
        principal: true,
        capability: true,
        target: true,
        expected_version: true,
        effect: true,
      },
      stale_apply_rejected: true,
      stale_status: "conflict",
      stale_overwrite: false,
      replay_mutated_source: false,
      unknown_auto_retried: false,
    });
    const source = JSON.parse(await fs.readFile(path.join(managedRoot, "source.json"), "utf8"));
    expect(source.invoices["INV-GLOBEX-1"].late_fee_cents).toBe(9900);
    expect(source.invoices["INV-3001"].waiver_reason).toBe("Courtesy waiver supported by SUP-184");
    expect(Object.keys(source.operations)).toEqual(["op_try_waive_INV_3001_v1"]);

    const config = JSON.parse(await fs.readFile(path.join(managedRoot, "synapsor.runner.json"), "utf8"));
    expect(config.capabilities.map((capability: { name: string }) => capability.name)).toEqual([
      "billing.inspect_invoice",
      "billing.propose_late_fee_waiver",
    ]);
    expect(JSON.stringify(config)).not.toMatch(/internal_risk_note|internal_agent_note|execute_sql|approve|apply|commit/);
    const activation = JSON.parse(await fs.readFile(path.join(managedRoot, "activation.json"), "utf8"));
    expect(activation).toMatchObject({
      schema_version: "synapsor.try-activation.v1",
      mode: "embedded_synthetic_proof",
      telemetry_transmitted: false,
    });
    expect(activation.product_activation_ms).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it("enforces trusted tenant and principal scope in the embedded source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-try-scope-"));
    const result = await runTryExperience({
      root_dir: root,
      review: async () => "reject",
    });

    await expect(probeTryEmbeddedScope(result.paths.source, {
      tenant_id: "globex",
      principal: "support-agent-demo",
      invoice_id: "INV-3001",
    })).rejects.toMatchObject({ code: "NOT_FOUND_IN_TENANT" } satisfies Partial<TryExperienceError>);
    await expect(probeTryEmbeddedScope(result.paths.source, {
      tenant_id: "acme",
      principal: "model-forged-principal",
      invoice_id: "INV-3001",
    })).rejects.toMatchObject({ code: "PRINCIPAL_SCOPE_DENIED" } satisfies Partial<TryExperienceError>);
    await expect(probeTryEmbeddedScope(result.paths.source, {
      tenant_id: "acme",
      principal: "support-agent-demo",
      invoice_id: "INV-GLOBEX-1",
    })).rejects.toMatchObject({ code: "NOT_FOUND_IN_TENANT" } satisfies Partial<TryExperienceError>);
  });
});

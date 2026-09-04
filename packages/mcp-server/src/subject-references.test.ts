import { describe, expect, it } from "vitest";
import {
  compileActionRule,
  createActionRuleRegistry,
  type ActionRuleCatalogV1,
} from "@synapsor-runner/action-rules";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type {
  ActionRuleSpecV1,
  DerivedEffectEnvelopeSpecV1,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import { createSubjectReferenceService } from "./subject-references.js";

const lock = `sha256:${"a".repeat(64)}` as const;
const readBoundary = `sha256:${"b".repeat(64)}` as const;
const actionBoundary = `sha256:${"c".repeat(64)}` as const;
const tenantScope = `sha256:${"d".repeat(64)}` as const;
const principalScope = `sha256:${"e".repeat(64)}` as const;
const idType = { kind: "string", max_length: 64, comparison: "exact" } as const;
const integer = { kind: "integer" } as const;

function registry() {
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [{
      name: "billing.preferences",
      source: "local_postgres",
      engine: "postgres",
      schema: "billing",
      table: "preferences",
      primary_key: "preference_id",
      tenant_key: "tenant_id",
      principal_scope_key: "principal_id",
      version_field: "version",
      fields: [
        { name: "preference_id", type: idType, nullable: false },
        { name: "tenant_id", type: idType, nullable: false },
        { name: "principal_id", type: idType, nullable: false },
        { name: "alert_cents", type: integer, nullable: false },
        { name: "version", type: integer, nullable: false },
      ],
    }],
    relationships: [],
  };
  const verification_boundary: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1",
    name: "billing.preference_verification",
    source: "local_postgres",
    context: "trusted_context",
    generation_lock_fingerprint: lock,
    resources: [{
      binding: "preference",
      resource: "billing.preferences",
      source: { kind: "subject_ref" },
      primary_key: "preference_id",
      version_field: "version",
      fields: catalog.resources[0]!.fields.map(({ name, type, nullable }) => ({ name, type, nullable })),
      scope: { mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" },
      cardinality: "one",
      max_rows: 1,
      overflow: "unsupported",
      lock: "for_update",
    }],
    lock_order: ["preference"],
    transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const effect_envelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1",
    name: "billing.preference_effect",
    source: "local_postgres",
    operation: "update",
    target_resource: "billing.preferences",
    target_binding: "preference",
    primary_key: "preference_id",
    tenant_key: "tenant_id",
    principal_scope_key: "principal_id",
    conflict_key: "version",
    max_rows: 1,
    allowed_fields: [{ name: "alert_cents", type: integer }],
    version_advance: { column: "version", strategy: "integer_increment" },
    approval_classes: ["billing.preference_change"],
    writeback: { mode: "direct_sql", supervised_worker: "allowed" },
  };
  const rule: ActionRuleSpecV1 = {
    schema_version: "synapsor.action-rule.v1",
    name: "billing.set_reviewed_alert",
    outcome: "billing.set_reviewed_alert",
    context: "trusted_context",
    source: "local_postgres",
    verification_boundary_ref: verification_boundary.name,
    effect_envelope_ref: effect_envelope.name,
    subjects: [{ binding: "preference", resource: "billing.preferences", input: "opaque_subject_ref" }],
    require: {
      kind: "compare",
      operator: "gte",
      left: { kind: "field", binding: "preference", field: "alert_cents" },
      right: { kind: "literal", value: 0, value_type: integer },
    },
    derive: {},
    effect: {
      operation: "update",
      target_resource: "billing.preferences",
      target_binding: "preference",
      set: { alert_cents: { kind: "literal", value: 2500, value_type: integer } },
    },
    approval_class: "billing.preference_change",
    ttl_seconds: 300,
  };
  const compiled = compileActionRule({ catalog, verification_boundary, effect_envelope, rule });
  return createActionRuleRegistry({
    name: "billing_actions",
    rules: [{
      read_boundary_name: "reviewed_billing",
      read_boundary_digest: readBoundary,
      action_boundary_name: "billing_action_boundary",
      action_boundary_digest: actionBoundary,
      compiled,
      activated_at: "2026-09-02T12:00:00.000Z",
    }],
  });
}

function context() {
  return {
    source_id: "local_postgres",
    read_boundary_digest: readBoundary,
    generation_lock_fingerprint: lock,
    tenant_scope_fingerprint: tenantScope,
    principal_scope_fingerprint: principalScope,
    workflow_session_id: "mcp_workflow_subject_test",
  };
}

function deterministicBytes() {
  let counter = 0;
  return (size: number) => Buffer.alloc(size, ++counter);
}

describe("subject reference issuer and resolver", () => {
  it("requires exact observed-version provenance for a versioned subject", async () => {
    const store = new ProposalStore();
    try {
      const service = createSubjectReferenceService({
        store,
        registry: registry(),
        key: Buffer.alloc(32, 8),
        random_bytes: deterministicBytes(),
      });
      await expect(service.issue({
        ...context(),
        resource: "billing.preferences",
        evidence_bundle_id: "ev_explore_missing_version",
        observations: [{ row_index: 0, primary_key_value: "raw-preference-41" }],
        now: "2026-09-02T12:01:00.000Z",
      })).rejects.toMatchObject({
        code: "SUBJECT_REFERENCE_UNAVAILABLE",
        message: "One or more observed subjects are unavailable for this request. Re-read the reviewed row and try again.",
      });
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM observed_subject_references").get())
        .toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("mints random-looking model handles while protecting source identity", async () => {
    const store = new ProposalStore();
    try {
      const service = createSubjectReferenceService({
        store,
        registry: registry(),
        key: Buffer.alloc(32, 9),
        random_bytes: deterministicBytes(),
      });
      await expect(service.observationRequirement("billing.preferences")).resolves.toEqual({
        resource: "billing.preferences",
        primary_key: "preference_id",
        version_field: "version",
        outcomes: ["billing.set_reviewed_alert"],
      });
      await expect(service.observationRequirement("billing.invoices")).resolves.toBeUndefined();

      const first = await service.issue({
        ...context(),
        resource: "billing.preferences",
        evidence_bundle_id: "ev_explore_first",
        observations: [{ row_index: 0, primary_key_value: "raw-preference-42", observed_version_value: 7 }],
        now: "2026-09-02T12:01:00.000Z",
      });
      const second = await service.issue({
        ...context(),
        resource: "billing.preferences",
        evidence_bundle_id: "ev_explore_second",
        observations: [{ row_index: 0, primary_key_value: "raw-preference-42", observed_version_value: 7 }],
        now: "2026-09-02T12:01:01.000Z",
      });
      expect(first[0]?.ref).toMatch(/^obj_[A-Za-z0-9_-]{43}$/);
      expect(second[0]?.ref).not.toBe(first[0]?.ref);
      expect(Object.keys(first[0]!)).toEqual(["row_index", "resource", "ref", "expires_at"]);

      const raw = store.db.prepare("SELECT record_json FROM observed_subject_references").all() as Array<{ record_json: string }>;
      expect(JSON.stringify(raw)).not.toContain("raw-preference-42");
      expect(JSON.stringify(raw)).not.toContain("tenant-northstar");
      expect(JSON.stringify(raw)).not.toContain("principal-maya");

      const resolved = await service.claim({
        ...context(),
        outcome: "billing.set_reviewed_alert",
        subject_refs: { preference: first[0]!.ref },
        now: "2026-09-02T12:02:00.000Z",
      });
      expect(resolved.subjects).toEqual([{
        binding: "preference",
        resource: "billing.preferences",
        primary_key: { column: "preference_id", value: "raw-preference-42" },
        subject_ref_digest: expect.stringMatching(/^sha256:/),
      }]);
      expect(resolved.proposal_id).toMatch(/^wrp_rule_[a-f0-9]{32}$/);
      expect(resolved.claimed_at).toBe("2026-09-02T12:02:00.000Z");
      const storedRow = store.db.prepare(
        "SELECT record_json FROM observed_subject_references WHERE subject_ref = ?",
      ).get(first[0]!.ref) as { record_json: string };
      const stored = JSON.parse(storedRow.record_json) as {
        subject_ref_digest: `sha256:${string}`;
        evidence_bundle_id: string;
        observed_version_digest: `sha256:${string}`;
      };
      expect(resolved.evidence_provenance_digest).toBe(canonicalJsonDigest([{
        binding: "preference",
        resource: "billing.preferences",
        subject_ref_digest: stored.subject_ref_digest,
        evidence_bundle_id: stored.evidence_bundle_id,
        observed_version_digest: stored.observed_version_digest,
      }]));

      const retry = await service.claim({
        ...context(),
        outcome: "billing.set_reviewed_alert",
        subject_refs: { preference: first[0]!.ref },
        now: "2026-09-02T12:02:01.000Z",
      });
      expect(retry.proposal_id).toBe(resolved.proposal_id);
      expect(retry.claimed_at).toBe(resolved.claimed_at);
    } finally {
      store.close();
    }
  });

  it("collapses a wrong key, forged handle, wrong binding, and wrong scope", async () => {
    const store = new ProposalStore();
    try {
      const service = createSubjectReferenceService({
        store,
        registry: registry(),
        key: Buffer.alloc(32, 4),
        random_bytes: deterministicBytes(),
      });
      const [issued] = await service.issue({
        ...context(),
        resource: "billing.preferences",
        evidence_bundle_id: "ev_explore_refusal",
        observations: [{ row_index: 0, primary_key_value: "raw-preference-99", observed_version_value: 1 }],
        now: "2026-09-02T12:01:00.000Z",
      });
      const attempts = [
        () => service.claim({ ...context(), outcome: "billing.set_reviewed_alert", subject_refs: { preference: `obj_${"z".repeat(43)}` }, now: "2026-09-02T12:02:00.000Z" }),
        () => service.claim({ ...context(), outcome: "billing.set_reviewed_alert", subject_refs: { wrong: issued!.ref }, now: "2026-09-02T12:02:00.000Z" }),
        () => service.claim({ ...context(), tenant_scope_fingerprint: `sha256:${"f".repeat(64)}`, outcome: "billing.set_reviewed_alert", subject_refs: { preference: issued!.ref }, now: "2026-09-02T12:02:00.000Z" }),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({ code: "SUBJECT_REFERENCE_UNAVAILABLE" });
      }

      const wrongKey = createSubjectReferenceService({
        store,
        registry: registry(),
        key: Buffer.alloc(32, 5),
      });
      await expect(wrongKey.claim({
        ...context(),
        outcome: "billing.set_reviewed_alert",
        subject_refs: { preference: issued!.ref },
        now: "2026-09-02T12:02:00.000Z",
      })).rejects.toMatchObject({ code: "SUBJECT_REFERENCE_UNAVAILABLE" });
    } finally {
      store.close();
    }
  });
});

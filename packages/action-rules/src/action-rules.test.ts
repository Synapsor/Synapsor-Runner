import { describe, expect, it } from "vitest";
import type {
  ActionRuleScalarTypeSpecV1,
  ActionRuleSpecV1,
  DerivedEffectEnvelopeSpecV1,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import {
  canonicalJsonDigest,
  eligibilityProofDigest,
  type NormalizedWritebackJobV5,
} from "@synapsor-runner/protocol";
import { ActionRuleError } from "./errors.js";
import {
  createActionRuleAuthority,
  parseActionRuleAuthority,
} from "./authority.js";
import { compileActionRule, createActionRuleCompiler } from "./compile.js";
import { ACTION_AUTHORITY_LIMITS } from "./limits.js";
import { evaluateActionRule } from "./evaluate.js";
import { loadActionRuleFacts, normalizeActionRuleDatabaseValue, type ActionRuleFactQueryV1 } from "./fact-loader.js";
import {
  actionRuleDigest,
  normalizeActionRuleCatalog,
} from "./normalize.js";
import {
  createActionRuleApprovalClasses,
  createActionRuleRegistry,
  resolveActivatedApprovalClass,
  resolveActivatedActionRule,
} from "./registry.js";
import {
  createSemanticActionVerifier,
  evaluateSemanticActionEligibility,
} from "./runtime.js";
import type {
  ActionRuleCatalogV1,
  ActionRuleApprovalClassSourceV1,
  ActionRuleFactSetV1,
} from "./types.js";

const lock = `sha256:${"a".repeat(64)}` as const;
const provenance = `sha256:${"b".repeat(64)}` as const;
const stringId = { kind: "string", max_length: 64, comparison: "exact" } as const;
const accountId = { kind: "string", max_length: 64, comparison: "exact" } as const;
const timestamp = { kind: "timestamp" } as const;
const integer = { kind: "integer" } as const;

function automaticReschedulePolicy(): ActionRuleApprovalClassSourceV1 {
  return {
    name: "field_service.standard_reschedule",
    mode: "policy",
    rules: [{
      outcome: "field_service.reschedule_to_offered_slot",
      auto_approve_when: {
        kind: "compare",
        operator: "eq",
        left: { kind: "field", binding: "appointment", field: "slot_id" },
        right: { kind: "literal", value: "slot_old", value_type: stringId },
      },
    }],
    required_role: "field_service_reviewer",
    required_approvals: 1,
    shared_limits: [
      {
        id: "reschedule_action_24h",
        kind: "count",
        scope: "capability",
        maximum: 100,
        window_seconds: 86_400,
        capability: "field_service.reschedule_to_offered_slot",
      },
      {
        id: "reschedule_customer_24h",
        kind: "count",
        scope: "tenant_principal",
        maximum: 3,
        window_seconds: 86_400,
        capability: "field_service.reschedule_to_offered_slot",
      },
    ],
  };
}

function fieldServiceFixture(): {
  catalog: ActionRuleCatalogV1;
  boundary: RuleVerificationBoundarySpecV1;
  envelope: DerivedEffectEnvelopeSpecV1;
  rule: ActionRuleSpecV1;
  facts: ActionRuleFactSetV1;
} {
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [
      {
        name: "field_service.appointments",
        source: "local_postgres",
        engine: "postgres",
        schema: "field_service",
        table: "appointments",
        primary_key: "appointment_id",
        tenant_key: "account_id",
        principal_scope_key: "principal_id",
        version_field: "version",
        fields: [
          { name: "appointment_id", type: stringId, nullable: false },
          { name: "account_id", type: accountId, nullable: false },
          { name: "principal_id", type: accountId, nullable: false },
          { name: "request_id", type: stringId, nullable: false },
          { name: "status", type: { kind: "string", max_length: 32, comparison: "exact", enum: ["scheduled", "canceled"] }, nullable: false },
          { name: "dispatch_status", type: { kind: "string", max_length: 32, comparison: "exact", enum: ["not_dispatched", "en_route"] }, nullable: false },
          { name: "slot_id", type: stringId, nullable: false },
          { name: "scheduled_start_at", type: timestamp, nullable: false },
          { name: "scheduled_end_at", type: timestamp, nullable: false },
          { name: "version", type: integer, nullable: false },
        ],
      },
      {
        name: "field_service.service_requests",
        source: "local_postgres",
        engine: "postgres",
        schema: "field_service",
        table: "service_requests",
        primary_key: "request_id",
        tenant_key: "account_id",
        principal_scope_key: "principal_id",
        version_field: "version",
        fields: [
          { name: "request_id", type: stringId, nullable: false },
          { name: "account_id", type: accountId, nullable: false },
          { name: "principal_id", type: accountId, nullable: false },
          { name: "service_type", type: { kind: "string", max_length: 40, comparison: "exact" }, nullable: false },
          { name: "location_zone", type: { kind: "string", max_length: 40, comparison: "exact" }, nullable: false },
          { name: "automatic_change_hold", type: { kind: "boolean" }, nullable: false },
          { name: "version", type: integer, nullable: false },
        ],
      },
      {
        name: "field_service.appointment_slot_offers",
        source: "local_postgres",
        engine: "postgres",
        schema: "field_service",
        table: "appointment_slot_offers",
        primary_key: "offer_id",
        tenant_key: "account_id",
        principal_scope_key: "principal_id",
        version_field: "version",
        fields: [
          { name: "offer_id", type: stringId, nullable: false },
          { name: "account_id", type: accountId, nullable: false },
          { name: "principal_id", type: accountId, nullable: false },
          { name: "appointment_id", type: stringId, nullable: false },
          { name: "slot_id", type: stringId, nullable: false },
          { name: "service_type", type: { kind: "string", max_length: 40, comparison: "exact" }, nullable: false },
          { name: "location_zone", type: { kind: "string", max_length: 40, comparison: "exact" }, nullable: false },
          { name: "offered_start_at", type: timestamp, nullable: false },
          { name: "offered_end_at", type: timestamp, nullable: false },
          { name: "status", type: { kind: "string", max_length: 16, comparison: "exact", enum: ["held", "released"] }, nullable: false },
          { name: "expires_at", type: timestamp, nullable: false },
          { name: "version", type: integer, nullable: false },
        ],
      },
    ],
    relationships: [
      {
        name: "appointments_request_fk",
        from_resource: "field_service.appointments",
        to_resource: "field_service.service_requests",
        local_field: "request_id",
        target_field: "request_id",
        cardinality: "many_to_one",
        nullable: false,
        target_unique: true,
      },
    ],
  };
  const boundary: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1",
    name: "field_service.reschedule_verification",
    source: "local_postgres",
    context: "trusted_context",
    generation_lock_fingerprint: lock,
    resources: [
      {
        binding: "appointment",
        resource: "field_service.appointments",
        source: { kind: "subject_ref" },
        primary_key: "appointment_id",
        version_field: "version",
        fields: catalog.resources[0]!.fields.map(({ name, type, nullable }) => ({ name, type, nullable })),
        scope: { mode: "columns", tenant_field: "account_id", principal_field: "principal_id" },
        cardinality: "one",
        max_rows: 1,
        overflow: "unsupported",
        lock: "for_update",
      },
      {
        binding: "request",
        resource: "field_service.service_requests",
        source: {
          kind: "relationship",
          from_binding: "appointment",
          relationship: "appointments_request_fk",
          local_field: "request_id",
          target_field: "request_id",
          direction: "forward",
        },
        primary_key: "request_id",
        version_field: "version",
        fields: catalog.resources[1]!.fields.map(({ name, type, nullable }) => ({ name, type, nullable })),
        scope: { mode: "columns", tenant_field: "account_id", principal_field: "principal_id" },
        cardinality: "one",
        max_rows: 1,
        overflow: "unsupported",
        lock: "for_update",
      },
      {
        binding: "offer",
        resource: "field_service.appointment_slot_offers",
        source: { kind: "subject_ref" },
        primary_key: "offer_id",
        version_field: "version",
        fields: catalog.resources[2]!.fields.map(({ name, type, nullable }) => ({ name, type, nullable })),
        scope: { mode: "columns", tenant_field: "account_id", principal_field: "principal_id" },
        cardinality: "one",
        max_rows: 1,
        overflow: "unsupported",
        lock: "for_update",
      },
    ],
    lock_order: ["appointment", "request", "offer"],
    transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const envelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1",
    name: "field_service.reschedule_effect",
    source: "local_postgres",
    operation: "update",
    target_resource: "field_service.appointments",
    target_binding: "appointment",
    primary_key: "appointment_id",
    tenant_key: "account_id",
    principal_scope_key: "principal_id",
    conflict_key: "version",
    max_rows: 1,
    allowed_fields: [
      { name: "slot_id", type: stringId },
      { name: "scheduled_start_at", type: timestamp },
      { name: "scheduled_end_at", type: timestamp },
    ],
    version_advance: { column: "version", strategy: "integer_increment" },
    approval_classes: ["field_service.standard_reschedule"],
    writeback: { mode: "direct_sql", supervised_worker: "allowed" },
  };
  const field = (binding: string, name: string) => ({ kind: "field", binding, field: name } as const);
  const literal = (value: string, values: string[]) => ({
    kind: "literal",
    value,
    value_type: { kind: "string", max_length: 32, comparison: "exact", enum: values },
  } as const);
  const rule: ActionRuleSpecV1 = {
    schema_version: "synapsor.action-rule.v1",
    name: "field_service.reschedule_to_offered_slot",
    outcome: "field_service.reschedule_to_offered_slot",
    context: "trusted_context",
    source: "local_postgres",
    verification_boundary_ref: boundary.name,
    effect_envelope_ref: envelope.name,
    subjects: [
      { binding: "appointment", resource: "field_service.appointments", input: "opaque_subject_ref" },
      { binding: "offer", resource: "field_service.appointment_slot_offers", input: "opaque_subject_ref" },
    ],
    require: {
      kind: "all",
      expressions: [
        { kind: "compare", operator: "eq", left: field("appointment", "status"), right: literal("scheduled", ["scheduled", "canceled"]) },
        { kind: "compare", operator: "eq", left: field("appointment", "dispatch_status"), right: literal("not_dispatched", ["not_dispatched", "en_route"]) },
        { kind: "compare", operator: "eq", left: field("offer", "appointment_id"), right: field("appointment", "appointment_id") },
        { kind: "compare", operator: "eq", left: field("offer", "status"), right: literal("held", ["held", "released"]) },
        { kind: "compare", operator: "gt", left: field("offer", "expires_at"), right: { kind: "trusted", binding: "transaction_time" } },
        { kind: "compare", operator: "eq", left: field("offer", "service_type"), right: field("request", "service_type") },
        { kind: "compare", operator: "eq", left: field("offer", "location_zone"), right: field("request", "location_zone") },
        { kind: "compare", operator: "eq", left: field("request", "automatic_change_hold"), right: { kind: "literal", value: false, value_type: { kind: "boolean" } } },
        { kind: "compare", operator: "neq", left: field("offer", "offered_start_at"), right: field("appointment", "scheduled_start_at") },
      ],
    },
    derive: {
      next_slot: field("offer", "slot_id"),
      next_start: field("offer", "offered_start_at"),
      next_end: field("offer", "offered_end_at"),
    },
    effect: {
      operation: "update",
      target_resource: "field_service.appointments",
      target_binding: "appointment",
      set: {
        slot_id: { kind: "derived", name: "next_slot" },
        scheduled_start_at: { kind: "derived", name: "next_start" },
        scheduled_end_at: { kind: "derived", name: "next_end" },
      },
    },
    approval_class: "field_service.standard_reschedule",
    ttl_seconds: 300,
  };
  const facts: ActionRuleFactSetV1 = {
    bindings: {
      appointment: { rows: [{
        appointment_id: "appt_1",
        account_id: "acct_1",
        principal_id: "customer_1",
        request_id: "request_1",
        status: "scheduled",
        dispatch_status: "not_dispatched",
        slot_id: "slot_old",
        scheduled_start_at: "2026-09-11T15:00:00.000Z",
        scheduled_end_at: "2026-09-11T19:00:00.000Z",
        version: 7,
      }] },
      request: { rows: [{
        request_id: "request_1",
        account_id: "acct_1",
        principal_id: "customer_1",
        service_type: "meter_inspection",
        location_zone: "west_4",
        automatic_change_hold: false,
        version: 3,
      }] },
      offer: { rows: [{
        offer_id: "offer_1",
        account_id: "acct_1",
        principal_id: "customer_1",
        appointment_id: "appt_1",
        slot_id: "slot_tuesday",
        service_type: "meter_inspection",
        location_zone: "west_4",
        offered_start_at: "2026-09-15T20:00:00.000Z",
        offered_end_at: "2026-09-16T00:00:00.000Z",
        status: "held",
        expires_at: "2026-09-03T18:00:00.000Z",
        version: 4,
      }] },
    },
    trusted: {
      tenant: "acct_1",
      principal: "customer_1",
      transaction_time: "2026-09-02T20:00:00.000Z",
    },
    subject_provenance_digest: provenance,
  };
  return { catalog, boundary, envelope, rule, facts };
}

function inventoryFixture() {
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [
      {
        name: "inventory.orders", source: "local_mysql", engine: "mysql", schema: "inventory", table: "orders",
        primary_key: "order_id", tenant_key: "tenant_id", principal_scope_key: "principal_id", version_field: "version", storage_engine: "InnoDB",
        fields: [
          { name: "order_id", type: stringId, nullable: false }, { name: "tenant_id", type: accountId, nullable: false },
          { name: "principal_id", type: accountId, nullable: false }, { name: "sku", type: stringId, nullable: false },
          { name: "requested_units", type: { kind: "integer", unit: "units" }, nullable: false }, { name: "version", type: integer, nullable: false },
        ],
      },
      {
        name: "inventory.stock_holds", source: "local_mysql", engine: "mysql", schema: "inventory", table: "stock_holds",
        primary_key: "hold_id", version_field: "version", storage_engine: "InnoDB",
        fields: [
          { name: "hold_id", type: stringId, nullable: false }, { name: "order_id", type: stringId, nullable: false },
          { name: "status", type: { kind: "string", max_length: 16, comparison: "exact", enum: ["active", "released"] }, nullable: false },
          { name: "held_units", type: { kind: "integer", unit: "units" }, nullable: false }, { name: "version", type: integer, nullable: false },
        ],
      },
      {
        name: "inventory.reservations", source: "local_mysql", engine: "mysql", schema: "inventory", table: "reservations",
        primary_key: "reservation_id", tenant_key: "tenant_id", principal_scope_key: "principal_id", version_field: "version", storage_engine: "InnoDB",
        fields: [
          { name: "reservation_id", type: stringId, nullable: false }, { name: "tenant_id", type: accountId, nullable: false },
          { name: "principal_id", type: accountId, nullable: false }, { name: "order_id", type: stringId, nullable: false },
          { name: "reserved_units", type: { kind: "integer", unit: "units" }, nullable: false }, { name: "version", type: integer, nullable: false },
        ],
      },
    ],
    relationships: [{
      name: "stock_holds_order_fk", from_resource: "inventory.stock_holds", to_resource: "inventory.orders",
      local_field: "order_id", target_field: "order_id", cardinality: "many_to_one", nullable: false, target_unique: true,
    }],
  };
  const boundary: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1", name: "inventory.reserve_verification", source: "local_mysql", context: "trusted_context", generation_lock_fingerprint: lock,
    resources: [
      {
        binding: "order", resource: "inventory.orders", source: { kind: "subject_ref" }, primary_key: "order_id", version_field: "version",
        fields: catalog.resources[0]!.fields.map(({ name, type, nullable }) => ({ name, type, nullable })),
        scope: { mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" }, cardinality: "one", max_rows: 1, overflow: "unsupported", lock: "for_update",
      },
      {
        binding: "holds", resource: "inventory.stock_holds",
        source: { kind: "relationship", from_binding: "order", relationship: "stock_holds_order_fk", local_field: "order_id", target_field: "order_id", direction: "inverse" },
        primary_key: "hold_id", version_field: "version",
        fields: catalog.resources[1]!.fields.map(({ name, type, nullable }) => ({ name, type, nullable })),
        scope: { mode: "inherited", from_binding: "order" }, cardinality: "many", max_rows: 5, overflow: "ineligible",
        deterministic_order: [{ field: "hold_id", direction: "asc" }], lock: "for_update",
      },
    ],
    lock_order: ["order", "holds"], transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const envelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1", name: "inventory.reserve_effect", source: "local_mysql", operation: "insert",
    target_resource: "inventory.reservations", primary_key: "reservation_id", tenant_key: "tenant_id", principal_scope_key: "principal_id", max_rows: 1,
    allowed_fields: [{ name: "order_id", type: stringId }, { name: "reserved_units", type: { kind: "integer", unit: "units" }, minimum: 1, maximum: 50 }],
    deduplication: { components: [{ column: "reservation_id", source: "proposal_id" }, { column: "tenant_id", source: "trusted_tenant" }] },
    approval_classes: ["inventory.standard_reservation"], writeback: { mode: "none", supervised_worker: "disabled" },
  };
  const rule: ActionRuleSpecV1 = {
    schema_version: "synapsor.action-rule.v1", name: "inventory.reserve_held_stock", outcome: "inventory.reserve_held_stock", context: "trusted_context", source: "local_mysql",
    verification_boundary_ref: boundary.name, effect_envelope_ref: envelope.name,
    subjects: [{ binding: "order", resource: "inventory.orders", input: "opaque_subject_ref" }],
    require: { kind: "exists", binding: "holds", where: { kind: "all", expressions: [
      { kind: "compare", operator: "eq", left: { kind: "field", binding: "holds", field: "status" }, right: { kind: "literal", value: "active", value_type: { kind: "string", max_length: 16, comparison: "exact", enum: ["active", "released"] } } },
      { kind: "compare", operator: "gte", left: { kind: "field", binding: "holds", field: "held_units" }, right: { kind: "field", binding: "order", field: "requested_units" } },
    ] } },
    derive: { order_key: { kind: "field", binding: "order", field: "order_id" }, units: { kind: "field", binding: "order", field: "requested_units" } },
    effect: { operation: "insert", target_resource: "inventory.reservations", set: { order_id: { kind: "derived", name: "order_key" }, reserved_units: { kind: "derived", name: "units" } } },
    approval_class: "inventory.standard_reservation", ttl_seconds: 120,
  };
  const facts: ActionRuleFactSetV1 = {
    bindings: {
      order: { rows: [{ order_id: "order_1", tenant_id: "tenant_1", principal_id: "buyer_1", sku: "SKU-7", requested_units: 3, version: 2 }] },
      holds: { rows: [
        { hold_id: "hold_2", order_id: "order_1", status: "released", held_units: 1, version: 1 },
        { hold_id: "hold_1", order_id: "order_1", status: "active", held_units: 4, version: 3 },
      ] },
    },
    trusted: { tenant: "tenant_1", principal: "buyer_1", transaction_time: "2026-09-02T20:00:00.000Z" }, subject_provenance_digest: provenance,
  };
  return { catalog, boundary, envelope, rule, facts };
}

function customerSupportFixture(): {
  catalog: ActionRuleCatalogV1;
  boundary: RuleVerificationBoundarySpecV1;
  envelope: DerivedEffectEnvelopeSpecV1;
  rule: ActionRuleSpecV1;
  facts: ActionRuleFactSetV1;
} {
  const money = { kind: "money_minor", currency: "USD" } as const;
  const chargeStatus: ActionRuleScalarTypeSpecV1 = {
    kind: "string",
    max_length: 24,
    comparison: "exact",
    enum: ["settled", "disputed", "refunded"],
  };
  const refundReason: ActionRuleScalarTypeSpecV1 = {
    kind: "string",
    max_length: 32,
    comparison: "exact",
    enum: ["duplicate_charge", "billing_error"],
  };
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [
      {
        name: "support.charges",
        source: "local_postgres",
        engine: "postgres",
        schema: "support",
        table: "charges",
        primary_key: "charge_id",
        tenant_key: "tenant_id",
        principal_scope_key: "customer_id",
        version_field: "version",
        fields: [
          { name: "charge_id", type: stringId, nullable: false },
          { name: "tenant_id", type: accountId, nullable: false },
          { name: "customer_id", type: accountId, nullable: false },
          { name: "status", type: chargeStatus, nullable: false },
          { name: "refundable_amount", type: money, nullable: false },
          { name: "version", type: integer, nullable: false },
        ],
      },
      {
        name: "support.refund_requests",
        source: "local_postgres",
        engine: "postgres",
        schema: "support",
        table: "refund_requests",
        primary_key: "refund_request_id",
        tenant_key: "tenant_id",
        principal_scope_key: "customer_id",
        fields: [
          { name: "refund_request_id", type: stringId, nullable: false },
          { name: "tenant_id", type: accountId, nullable: false },
          { name: "customer_id", type: accountId, nullable: false },
          { name: "charge_id", type: stringId, nullable: false },
          { name: "amount", type: money, nullable: false },
          { name: "reason", type: refundReason, nullable: false },
        ],
      },
    ],
    relationships: [],
  };
  const boundary: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1",
    name: "support.request_small_refund_verification",
    source: "local_postgres",
    context: "trusted_context",
    generation_lock_fingerprint: lock,
    resources: [{
      binding: "charge",
      resource: "support.charges",
      source: { kind: "subject_ref" },
      primary_key: "charge_id",
      version_field: "version",
      fields: catalog.resources[0]!.fields,
      scope: { mode: "columns", tenant_field: "tenant_id", principal_field: "customer_id" },
      cardinality: "one",
      max_rows: 1,
      overflow: "unsupported",
      lock: "for_update",
    }],
    lock_order: ["charge"],
    transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const envelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1",
    name: "support.request_small_refund_effect",
    source: "local_postgres",
    operation: "insert",
    target_resource: "support.refund_requests",
    primary_key: "refund_request_id",
    tenant_key: "tenant_id",
    principal_scope_key: "customer_id",
    max_rows: 1,
    allowed_fields: [
      { name: "charge_id", type: stringId },
      { name: "amount", type: money, minimum: 1, maximum: 2_500 },
      { name: "reason", type: refundReason, values: ["duplicate_charge", "billing_error"] },
    ],
    deduplication: {
      components: [
        { column: "refund_request_id", source: "proposal_id" },
        { column: "tenant_id", source: "trusted_tenant" },
      ],
    },
    approval_classes: ["support.small_refund_review"],
    writeback: { mode: "none", supervised_worker: "disabled" },
  };
  const field = (name: string) => ({ kind: "field", binding: "charge", field: name } as const);
  const rule: ActionRuleSpecV1 = {
    schema_version: "synapsor.action-rule.v1",
    name: "support.request_small_refund",
    outcome: "support.request_small_refund",
    context: "trusted_context",
    source: "local_postgres",
    verification_boundary_ref: boundary.name,
    effect_envelope_ref: envelope.name,
    subjects: [{ binding: "charge", resource: "support.charges", input: "opaque_subject_ref" }],
    require: {
      kind: "all",
      expressions: [
        {
          kind: "compare",
          operator: "eq",
          left: field("status"),
          right: { kind: "literal", value: "settled", value_type: chargeStatus },
        },
        {
          kind: "compare",
          operator: "gte",
          left: field("refundable_amount"),
          right: { kind: "literal", value: 1, value_type: money },
        },
        {
          kind: "compare",
          operator: "lte",
          left: field("refundable_amount"),
          right: { kind: "literal", value: 2_500, value_type: money },
        },
      ],
    },
    derive: {
      charge_key: field("charge_id"),
      refund_amount: field("refundable_amount"),
    },
    effect: {
      operation: "insert",
      target_resource: "support.refund_requests",
      set: {
        charge_id: { kind: "derived", name: "charge_key" },
        amount: { kind: "derived", name: "refund_amount" },
        reason: { kind: "literal", value: "duplicate_charge", value_type: refundReason },
      },
    },
    approval_class: "support.small_refund_review",
    ttl_seconds: 180,
  };
  const facts: ActionRuleFactSetV1 = {
    bindings: {
      charge: { rows: [{
        charge_id: "charge_1042",
        tenant_id: "northstar_mobile",
        customer_id: "customer_7",
        status: "settled",
        refundable_amount: 2_100,
        version: 4,
      }] },
    },
    trusted: {
      tenant: "northstar_mobile",
      principal: "customer_7",
      transaction_time: "2026-09-03T20:00:00.000Z",
    },
    subject_provenance_digest: provenance,
  };
  return { catalog, boundary, envelope, rule, facts };
}

describe("portable Action Rule compiler and evaluator", () => {
  it("derives a customer-selected refund amount through reviewed business inputs", () => {
    const fixture = customerSupportFixture();
    fixture.rule.inputs = [{ name: "requested_amount", description: "Refund amount in USD cents", type: { kind: "money_minor", currency: "USD" }, minimum: 1, maximum: 2500 }];
    fixture.rule.effect.set.amount = { kind: "input", name: "requested_amount" };
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const evaluate = (inputs: Record<string, unknown>) => evaluateActionRule({ compiled, facts: fixture.facts, proposal_id: "input_refund", inputs });
    const result = evaluate({ requested_amount: 1200 });
    expect(result).toMatchObject({ result: "eligible", effect: { set: { amount: 1200 }, tenant_guard: { value: "northstar_mobile" } } });
    for (const inputs of [{}, { requested_amount: 0 }, { requested_amount: 2501 }, { requested_amount: "1200" }, { requested_amount: 1.5 }, { requested_amount: 1200, tenant: "attacker" }]) {
      expect(evaluate(inputs)).not.toHaveProperty("effect");
    }
    expect(evaluate({ requested_amount: 1 }).result).toBe("eligible");
    expect(evaluate({ requested_amount: 2500 }).result).toBe("eligible");
  });

  it("refuses undeclared input expressions and unbounded business numbers", () => {
    const fixture = customerSupportFixture();
    fixture.rule.effect.set.amount = { kind: "input", name: "requested_amount" };
    const compile = () => compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    expect(compile).toThrow(/input/i);
    fixture.rule.inputs = [{ name: "requested_amount", description: "Refund amount", type: { kind: "money_minor", currency: "USD" } }];
    expect(compile).toThrow(/bound|minimum|maximum/i);
  });

  it.each([false, true])("refuses business inputs as related-row identity (indirect: %s)", (indirect) => {
    const fixture = customerSupportFixture();
    fixture.catalog.relationships.push({ name: "refund_charge_fk", from_resource: "support.refund_requests", to_resource: "support.charges",
      local_field: "charge_id", target_field: "charge_id", cardinality: "many_to_one", nullable: false, target_unique: true });
    fixture.rule.inputs = [{ name: "charge", description: "Untrusted nominated charge", type: stringId }];
    fixture.rule.derive.charge_key = { kind: "input", name: "charge" };
    fixture.rule.effect.set.charge_id = indirect ? { kind: "derived", name: "charge_key" } : { kind: "input", name: "charge" };
    expect(() => compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog }))
      .toThrow(/Relationship identity.*business input/u);
  });

  it("rejects an unknown untrusted boolean AST kind before canonical hashing", () => {
    const fixture = fieldServiceFixture();
    fixture.rule.require = { kind: "and", expressions: [] } as unknown as ActionRuleSpecV1["require"];
    expect(() => compileActionRule({
      catalog: fixture.catalog,
      verification_boundary: fixture.boundary,
      effect_envelope: fixture.envelope,
      rule: fixture.rule,
    })).toThrow(/boolean expression kind and is unsupported/u);
  });

  it("derives the exact field-service update without a domain-specific handler", () => {
    const fixture = fieldServiceFixture();
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const result = evaluateActionRule({ compiled, facts: fixture.facts, proposal_id: "grant_reschedule_1" });
    expect(result.result).toBe("eligible");
    if (result.result !== "eligible") return;
    expect(result.effect).toMatchObject({
      operation: "single_row_update",
      resource: "field_service.appointments",
      primary_key: { column: "appointment_id", value: "appt_1" },
      tenant_guard: { column: "account_id", value: "acct_1" },
      principal_scope: { column: "principal_id", value: "customer_1" },
      expected_version: { column: "version", value: 7 },
      set: {
        slot_id: "slot_tuesday",
        scheduled_start_at: "2026-09-15T20:00:00.000Z",
        scheduled_end_at: "2026-09-16T00:00:00.000Z",
      },
    });
    expect(result.dependencies).toHaveLength(3);
  });

  it("refuses field-service rescheduling after dispatch without deriving an effect", () => {
    const fixture = fieldServiceFixture();
    fixture.facts.bindings.appointment!.rows[0]!.dispatch_status = "en_route";
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const result = evaluateActionRule({ compiled, facts: fixture.facts, proposal_id: "grant_reschedule_2" });
    expect(result).toMatchObject({ result: "ineligible", safe_code: "ACTION_RULE_NOT_ELIGIBLE" });
    expect(result).not.toHaveProperty("effect");
  });

  it("treats wrong trusted principal scope as unknown and produces no effect", () => {
    const fixture = fieldServiceFixture();
    fixture.facts.trusted.principal = "customer_2";
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const result = evaluateActionRule({ compiled, facts: fixture.facts, proposal_id: "grant_reschedule_3" });
    expect(result).toMatchObject({ result: "unknown", safe_code: "ACTION_RULE_SCOPE_UNPROVEN" });
    expect(result).not.toHaveProperty("effect");
  });

  it("treats a row outside trusted tenant scope as unknown and produces no effect", () => {
    const fixture = fieldServiceFixture();
    fixture.facts.trusted = {
      tenant: "different_account",
      principal: "customer_7",
      transaction_time: "2026-09-02T20:02:00.000Z",
    };
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const result = evaluateActionRule({ compiled, facts: fixture.facts, proposal_id: "grant_wrong_tenant" });
    expect(result).toMatchObject({ result: "unknown", safe_code: "ACTION_RULE_SCOPE_UNPROVEN" });
    expect(result).not.toHaveProperty("effect");
  });

  it("treats a null required authoritative fact as unknown and produces no effect", () => {
    const fixture = fieldServiceFixture();
    fixture.facts.bindings.appointment!.rows[0]!.dispatch_status = null;
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const result = evaluateActionRule({ compiled, facts: fixture.facts, proposal_id: "grant_null_fact" });
    expect(result.result).toBe("unknown");
    expect(result).not.toHaveProperty("effect");
  });

  it("derives a deterministic MySQL insert from bounded supporting rows", () => {
    const fixture = inventoryFixture();
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const first = evaluateActionRule({ compiled, facts: fixture.facts, proposal_id: "grant_inventory_1" });
    const second = evaluateActionRule({ compiled, facts: structuredClone(fixture.facts), proposal_id: "grant_inventory_1" });
    expect(first).toEqual(second);
    expect(first.result).toBe("eligible");
    if (first.result !== "eligible") return;
    expect(first.effect).toMatchObject({
      operation: "single_row_insert",
      schema: "inventory",
      table: "reservations",
      primary_key: { column: "reservation_id", value: "grant_inventory_1" },
      set: { order_id: "order_1", reserved_units: 3 },
      deduplication: { components: [
        { column: "reservation_id", source: "proposal_id", value: "grant_inventory_1" },
        { column: "tenant_id", source: "trusted_tenant", value: "tenant_1" },
      ] },
    });
  });

  it("derives a bounded customer-support refund request without a domain handler", () => {
    const fixture = customerSupportFixture();
    const compiled = compileActionRule({
      rule: fixture.rule,
      verification_boundary: fixture.boundary,
      effect_envelope: fixture.envelope,
      catalog: fixture.catalog,
    });
    const result = evaluateActionRule({
      compiled,
      facts: fixture.facts,
      proposal_id: "refund_proposal_1042",
    });
    expect(result.result).toBe("eligible");
    if (result.result !== "eligible") return;
    expect(result.effect).toMatchObject({
      operation: "single_row_insert",
      resource: "support.refund_requests",
      primary_key: { column: "refund_request_id", value: "refund_proposal_1042" },
      set: {
        charge_id: "charge_1042",
        amount: 2_100,
        reason: "duplicate_charge",
      },
    });
  });

  it("refuses a customer-support refund outside the reviewed monetary bound", () => {
    const fixture = customerSupportFixture();
    fixture.facts.bindings.charge!.rows[0]!.refundable_amount = 2_501;
    const compiled = compileActionRule({
      rule: fixture.rule,
      verification_boundary: fixture.boundary,
      effect_envelope: fixture.envelope,
      catalog: fixture.catalog,
    });
    const result = evaluateActionRule({
      compiled,
      facts: fixture.facts,
      proposal_id: "refund_proposal_over_limit",
    });
    expect(result).toMatchObject({ result: "ineligible", safe_code: "ACTION_RULE_NOT_ELIGIBLE" });
    expect(result).not.toHaveProperty("effect");
  });

  it("fails closed when a bounded many-side verification overflows", () => {
    const fixture = inventoryFixture();
    const row = fixture.facts.bindings.holds!.rows[0]!;
    fixture.facts.bindings.holds!.rows = Array.from({ length: 6 }, (_, index) => ({ ...row, hold_id: `hold_${index}` }));
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const result = evaluateActionRule({ compiled, facts: fixture.facts, proposal_id: "grant_inventory_2" });
    expect(result).toMatchObject({ result: "ineligible", safe_code: "ACTION_RULE_NOT_ELIGIBLE" });
    expect(result).not.toHaveProperty("effect");
  });

  it("rejects an unbounded many-row relationship at compile time", () => {
    const fixture = inventoryFixture();
    delete fixture.boundary.resources[1]!.deterministic_order;
    expect(() => compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog }))
      .toThrowError(expect.objectContaining({ code: "ACTION_RULE_UNBOUNDED" }));
  });

  it("rejects aggregate-derived decisions until authority includes phantom prevention", () => {
    const fixture = inventoryFixture();
    fixture.rule.require = {
      kind: "compare",
      operator: "gte",
      left: { kind: "aggregate", operation: "count", binding: "holds" },
      right: { kind: "literal", value: 1, value_type: { kind: "integer", unit: "rows" } },
    };
    expect(() => compileActionRule({
      rule: fixture.rule,
      verification_boundary: fixture.boundary,
      effect_envelope: fixture.envelope,
      catalog: fixture.catalog,
    })).toThrowError(expect.objectContaining({
      code: "ACTION_RULE_UNBOUNDED",
      message: expect.stringContaining("phantom-prevention"),
    }));
  });

  it("rejects negative existence until authority includes phantom prevention", () => {
    const fixture = inventoryFixture();
    fixture.rule.require = { kind: "not", expression: fixture.rule.require };
    expect(() => compileActionRule({
      rule: fixture.rule,
      verification_boundary: fixture.boundary,
      effect_envelope: fixture.envelope,
      catalog: fixture.catalog,
    })).toThrowError(expect.objectContaining({
      code: "ACTION_RULE_UNBOUNDED",
      message: expect.stringContaining("negative existence"),
    }));
  });

  it("rejects a derived field outside the reviewed effect envelope", () => {
    const fixture = fieldServiceFixture();
    fixture.rule.effect.set.dispatch_status = { kind: "field", binding: "appointment", field: "dispatch_status" };
    expect(() => compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog }))
      .toThrowError(expect.objectContaining({ code: "ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY" }));
  });

  it("rejects schema drift before evaluation", () => {
    const fixture = fieldServiceFixture();
    fixture.boundary.generation_lock_fingerprint = `sha256:${"c".repeat(64)}`;
    expect(() => compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog }))
      .toThrowError(expect.objectContaining({ code: "ACTION_RULE_AUTHORITY_STALE" }));
  });

  it("rejects malformed typed literals and ambiguous effect constraints at compile time", () => {
    const cases: Array<{
      label: string;
      mutate: (fixture: ReturnType<typeof fieldServiceFixture>) => void;
    }> = [
      {
        label: "non-canonical timestamp",
        mutate: (fixture) => {
          fixture.rule.effect.set.scheduled_start_at = {
            kind: "literal",
            value: "2026-09-11T15:00:00Z",
            value_type: { kind: "timestamp" },
          };
        },
      },
      {
        label: "nullable exact effect",
        mutate: (fixture) => {
          fixture.rule.effect.set.slot_id = {
            kind: "literal",
            value: null,
            value_type: { kind: "string", max_length: 80, comparison: "exact" },
          };
        },
      },
      {
        label: "numeric bound on string",
        mutate: (fixture) => { fixture.envelope.allowed_fields[0]!.minimum = 1; },
      },
      {
        label: "duplicate effect allowlist",
        mutate: (fixture) => { fixture.envelope.allowed_fields[0]!.values = ["slot_1", "slot_1"]; },
      },
    ];

    for (const testCase of cases) {
      const fixture = fieldServiceFixture();
      testCase.mutate(fixture);
      expect(
        () => compileActionRule({
          rule: fixture.rule,
          verification_boundary: fixture.boundary,
          effect_envelope: fixture.envelope,
          catalog: fixture.catalog,
        }),
        testCase.label,
      ).toThrowError(expect.objectContaining({
        code: expect.stringMatching(/^ACTION_RULE_(TYPE_MISMATCH|EFFECT_OUTSIDE_BOUNDARY)$/),
      }));
    }
  });

  it("turns malformed recognized expression variants into bounded Action Rule errors", () => {
    const cases: Array<{
      label: string;
      require: unknown;
      path: string;
    }> = [
      {
        label: "all without expressions",
        require: { kind: "all" },
        path: "rule.require.expressions",
      },
      {
        label: "comparison without a right operand",
        require: {
          kind: "compare",
          operator: "eq",
          left: { kind: "field", binding: "appointment", field: "status" },
        },
        path: "rule.require.right",
      },
      {
        label: "math without inputs",
        require: {
          kind: "compare",
          operator: "gte",
          left: { kind: "math", operation: "add" },
          right: { kind: "literal", value: 1, value_type: integer },
        },
        path: "rule.require.left.inputs",
      },
      {
        label: "known variant with a cross-variant field",
        require: {
          kind: "all",
          expressions: [{
            kind: "null_check",
            operator: "is_not_null",
            value: { kind: "field", binding: "appointment", field: "status" },
            where: { kind: "all", expressions: [] },
          }],
        },
        path: "rule.require.expressions[0].where",
      },
    ];

    for (const testCase of cases) {
      const fixture = fieldServiceFixture();
      fixture.rule.require = testCase.require as ActionRuleSpecV1["require"];
      expect(
        () => compileActionRule({
          rule: fixture.rule,
          verification_boundary: fixture.boundary,
          effect_envelope: fixture.envelope,
          catalog: fixture.catalog,
        }),
        testCase.label,
      ).toThrowError(expect.objectContaining({
        name: "ActionRuleError",
        code: "ACTION_RULE_INVALID",
        path: testCase.path,
      }));
    }
  });

  it("normalizes order-insensitive catalog and rule sets to stable digests", () => {
    const fixture = fieldServiceFixture();
    const reversedCatalog = structuredClone(fixture.catalog);
    reversedCatalog.resources.reverse();
    reversedCatalog.resources.forEach((resource) => resource.fields.reverse());
    reversedCatalog.relationships.reverse();
    const reversedRule = structuredClone(fixture.rule);
    if (reversedRule.require.kind === "all") reversedRule.require.expressions.reverse();
    expect(normalizeActionRuleCatalog(reversedCatalog)).toEqual(normalizeActionRuleCatalog(fixture.catalog));
    expect(actionRuleDigest(reversedRule)).toBe(actionRuleDigest(fixture.rule));
  });

  it("keeps compiled authority stable across equivalent authoring permutations", () => {
    const fixture = fieldServiceFixture();
    const baseline = compileActionRule({
      rule: fixture.rule,
      verification_boundary: fixture.boundary,
      effect_envelope: fixture.envelope,
      catalog: fixture.catalog,
    });
    for (let variant = 0; variant < 12; variant += 1) {
      const catalog = structuredClone(fixture.catalog);
      const boundary = structuredClone(fixture.boundary);
      const envelope = structuredClone(fixture.envelope);
      const rule = structuredClone(fixture.rule);
      if (variant & 1) catalog.resources.reverse();
      if (variant & 2) catalog.resources.forEach((resource) => resource.fields.reverse());
      if (variant & 4) boundary.resources.reverse();
      if (variant & 8) boundary.resources.forEach((resource) => resource.fields.reverse());
      envelope.allowed_fields.reverse();
      envelope.approval_classes.reverse();
      rule.subjects.reverse();
      if (rule.require.kind === "all") rule.require.expressions.reverse();
      rule.derive = Object.fromEntries(Object.entries(rule.derive).reverse());
      rule.effect.set = Object.fromEntries(Object.entries(rule.effect.set).reverse());
      const compiled = compileActionRule({ rule, verification_boundary: boundary, effect_envelope: envelope, catalog });
      expect(compiled).toEqual(baseline);
      expect(compiled.compiled_plan_digest).toBe(baseline.compiled_plan_digest);
    }
  });

  it("pins canonical digests for three unrelated semantic rule packs", () => {
    const fieldService = fieldServiceFixture();
    const inventory = inventoryFixture();
    const support = customerSupportFixture();
    const compile = (fixture: ReturnType<typeof fieldServiceFixture>) => compileActionRule({
      rule: fixture.rule,
      verification_boundary: fixture.boundary,
      effect_envelope: fixture.envelope,
      catalog: fixture.catalog,
    });
    expect([
      compile(fieldService).compiled_plan_digest,
      compile(inventory as ReturnType<typeof fieldServiceFixture>).compiled_plan_digest,
      compile(support as ReturnType<typeof fieldServiceFixture>).compiled_plan_digest,
    ]).toEqual([
      "sha256:e2340913c74579406afe11d8beb8b701b9c5874e68942752b340e07888f812c8",
      "sha256:a1c004ee0a02bbb8025032a58a29fd89f209ad202136c0285abcbc5b969dbc7e",
      "sha256:43a8bc82edf789e818af1785671dda2104d957401b7eecbbc2510b5b1f58970c",
    ]);
  });

  it("fails closed across authority, scope, relationship, and effect-envelope mutations", () => {
    const cases: Array<{
      label: string;
      mutate: (fixture: ReturnType<typeof fieldServiceFixture>) => void;
      code: string;
    }> = [
      {
        label: "unknown verification field",
        mutate: (fixture) => { fixture.boundary.resources[0]!.fields[0]!.name = "missing_identity"; },
        code: "ACTION_RULE_AUTHORITY_STALE",
      },
      {
        label: "wrong trusted tenant column",
        mutate: (fixture) => {
          const scope = fixture.boundary.resources[0]!.scope;
          if (scope.mode === "columns") scope.tenant_field = "principal_id";
        },
        code: "ACTION_RULE_SCOPE_UNPROVEN",
      },
      {
        label: "unreviewed relationship column",
        mutate: (fixture) => {
          const source = fixture.boundary.resources[1]!.source;
          if (source.kind === "relationship") source.local_field = "appointment_id";
        },
        code: "ACTION_RULE_INVALID",
      },
      {
        label: "effect target drift",
        mutate: (fixture) => { fixture.envelope.target_resource = "field_service.service_requests"; },
        code: "ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY",
      },
      {
        label: "write to guard field",
        mutate: (fixture) => {
          fixture.envelope.allowed_fields.push({ name: "version", type: integer });
          fixture.rule.effect.set.version = { kind: "literal", value: 8, value_type: integer };
        },
        code: "ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY",
      },
    ];
    for (const testCase of cases) {
      const fixture = fieldServiceFixture();
      testCase.mutate(fixture);
      expect(
        () => compileActionRule({
          rule: fixture.rule,
          verification_boundary: fixture.boundary,
          effect_envelope: fixture.envelope,
          catalog: fixture.catalog,
        }),
        testCase.label,
      ).toThrowError(expect.objectContaining({ code: testCase.code }));
    }
  });

  it("detects compiled-rule tampering before evaluating facts", () => {
    const fixture = fieldServiceFixture();
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    compiled.rule.ttl_seconds = 999;
    expect(() => evaluateActionRule({ compiled, facts: fixture.facts, proposal_id: "grant_tampered" }))
      .toThrowError(expect.objectContaining({ code: "ACTION_RULE_AUTHORITY_STALE" }));
  });

  it("loads only reviewed facts in canonical relationship and lock order", async () => {
    const fixture = fieldServiceFixture();
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const rowsByTable = new Map([
      ["appointments", fixture.facts.bindings.appointment!.rows],
      ["service_requests", fixture.facts.bindings.request!.rows],
      ["appointment_slot_offers", fixture.facts.bindings.offer!.rows],
    ]);
    const seen: ActionRuleFactQueryV1[] = [];
    const loaded = await loadActionRuleFacts({
      compiled,
      subjects: [
        { binding: "offer", resource: "field_service.appointment_slot_offers", primary_key: { column: "offer_id", value: "offer_1" }, subject_ref_digest: `sha256:${"2".repeat(64)}` },
        { binding: "appointment", resource: "field_service.appointments", primary_key: { column: "appointment_id", value: "appt_1" }, subject_ref_digest: `sha256:${"1".repeat(64)}` },
      ],
      trusted: fixture.facts.trusted,
      mode: "transaction_reverify",
      adapter: {
        engine: "postgres",
        async load(query) {
          seen.push(query);
          return structuredClone(rowsByTable.get(query.table) ?? []);
        },
      },
    });
    expect(seen.map((query) => query.binding)).toEqual(["appointment", "request", "offer"]);
    expect(seen.every((query) => query.lock === "for_update" && query.limit === 2)).toBe(true);
    expect(seen[1]?.predicates).toContainEqual({ operation: "eq", column: "request_id", value: "request_1" });
    expect(loaded.subject_bindings.map((subject) => subject.binding)).toEqual(["appointment", "offer"]);
    expect(evaluateActionRule({ compiled, facts: loaded.facts, proposal_id: "grant_loaded" }).result).toBe("eligible");
  });

  it.each(["postgres", "mysql"] as const)("loads complete composite tuples and rechecks them for %s", async (engine) => {
    const fixture = fieldServiceFixture();
    for (const resource of fixture.catalog.resources) resource.engine = engine;
    const old = fixture.catalog.relationships[0]!;
    const { local_field: _local, target_field: _target, ...base } = old;
    const field_pairs = [{ local_field: "account_id", target_field: "account_id" }, { local_field: "request_id", target_field: "request_id" }];
    fixture.catalog.relationships[0] = { ...base, field_pairs };
    fixture.boundary.resources[1]!.source = { kind: "relationship", from_binding: "appointment", relationship: old.name, direction: "forward", field_pairs };
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const subjects = [
      { binding: "offer", resource: "field_service.appointment_slot_offers", primary_key: { column: "offer_id", value: "offer_1" }, subject_ref_digest: `sha256:${"2".repeat(64)}` as const },
      { binding: "appointment", resource: "field_service.appointments", primary_key: { column: "appointment_id", value: "appt_1" }, subject_ref_digest: `sha256:${"1".repeat(64)}` as const },
    ];
    const adapter = { engine, async load(query: ActionRuleFactQueryV1) { return structuredClone(fixture.facts.bindings[query.binding]!.rows); } };
    const loaded = await loadActionRuleFacts({ compiled, subjects, trusted: fixture.facts.trusted, mode: "transaction_reverify", adapter });
    expect(loaded.queries[1]!.predicates[0]).toEqual({ operation: "tuple_in", columns: ["account_id", "request_id"],
      tuples: [[fixture.facts.trusted.tenant, "request_1"]] });
    expect(loaded.queries.every((query) => query.lock === "for_update")).toBe(true);
    expect(evaluateActionRule({ compiled, facts: loaded.facts, proposal_id: "composite_ok" }).result).toBe("eligible");
    loaded.facts.bindings.appointment!.rows[0]!.request_id = "different_request";
    expect(evaluateActionRule({ compiled, facts: loaded.facts, proposal_id: "stale_link" }).result).not.toBe("eligible");
    loaded.facts.bindings.appointment!.rows[0]!.request_id = "request_1";
    loaded.facts.bindings.request!.rows[0]!.account_id = "another_account";
    expect(evaluateActionRule({ compiled, facts: loaded.facts, proposal_id: "foreign_account" }).result).not.toBe("eligible");

    // Even a faulty adapter supplying multiple parents cannot create Cartesian predicates.
    fixture.facts.bindings.appointment!.rows.push({ ...fixture.facts.bindings.appointment!.rows[0]!, account_id: "another_account", request_id: "request_2" });
    const multiple = await loadActionRuleFacts({ compiled, subjects, trusted: fixture.facts.trusted, mode: "proposal_snapshot", adapter });
    expect(multiple.queries[1]!.predicates[0]).toMatchObject({ operation: "tuple_in", tuples: expect.arrayContaining([
      [fixture.facts.trusted.tenant, "request_1"], ["another_account", "request_2"],
    ]) });
    expect(evaluateActionRule({ compiled, facts: multiple.facts, proposal_id: "ambiguous_parent" }).result).not.toBe("eligible");
  });

  it("rejects mixed or incomplete relationship authority and preserves legacy digest material", () => {
    const fixture = fieldServiceFixture();
    expect(normalizeActionRuleCatalog(fixture.catalog).relationships).toEqual(fixture.catalog.relationships);
    const pairs = [{ local_field: "account_id", target_field: "account_id" }, { local_field: "request_id", target_field: "request_id" }];
    Object.assign(fixture.catalog.relationships[0]!, { field_pairs: pairs });
    expect(() => normalizeActionRuleCatalog(fixture.catalog)).toThrow(/mixed representations/);
    delete fixture.catalog.relationships[0]!.local_field;
    delete fixture.catalog.relationships[0]!.target_field;
    expect(() => compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog })).toThrow(/columns do not match/);
    pairs[1]!.local_field = "account_id";
    expect(() => normalizeActionRuleCatalog(fixture.catalog)).toThrow(/unique field pairs/);
  });

  it("enforces inverse composite links, inherited scope, null/no-match and many-row bounds", async () => {
    const fixture = inventoryFixture();
    const tenantField = { name: "tenant_id", type: accountId, nullable: false };
    fixture.catalog.resources[1]!.fields.push(tenantField);
    fixture.boundary.resources[1]!.fields.push(tenantField);
    for (const row of fixture.facts.bindings.holds!.rows) row.tenant_id = "tenant_1";
    const field_pairs = [{ local_field: "tenant_id", target_field: "tenant_id" }, { local_field: "order_id", target_field: "order_id" }];
    fixture.catalog.relationships[0] = { name: "stock_holds_order_fk", from_resource: "inventory.stock_holds", to_resource: "inventory.orders", field_pairs,
      cardinality: "many_to_one", nullable: false, target_unique: true };
    fixture.boundary.resources[1]!.source = { kind: "relationship", from_binding: "order", relationship: "stock_holds_order_fk", direction: "inverse", field_pairs };
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const loaded = await loadActionRuleFacts({ compiled, mode: "transaction_reverify", trusted: fixture.facts.trusted,
      subjects: [{ binding: "order", resource: "inventory.orders", primary_key: { column: "order_id", value: "order_1" }, subject_ref_digest: `sha256:${"1".repeat(64)}` }],
      adapter: { engine: "mysql", async load(query) { return fixture.facts.bindings[query.binding]!.rows; } } });
    expect(loaded.queries[1]!.predicates[0]).toEqual({ operation: "tuple_in", columns: ["tenant_id", "order_id"], tuples: [["tenant_1", "order_1"]] });
    expect(loaded.queries[1]!.limit).toBe(6);
    expect(evaluateActionRule({ compiled, facts: loaded.facts, proposal_id: "inverse_ok" }).result).toBe("eligible");
    const foreign = structuredClone(loaded.facts);
    foreign.bindings.holds!.rows[0]!.tenant_id = "tenant_2";
    expect(evaluateActionRule({ compiled, facts: foreign, proposal_id: "inverse_cross_tenant" }).result).not.toBe("eligible");
    foreign.bindings.holds!.rows[0]!.tenant_id = null;
    expect(evaluateActionRule({ compiled, facts: foreign, proposal_id: "inverse_null" }).result).not.toBe("eligible");
    const empty = structuredClone(loaded.facts);
    empty.bindings.holds!.rows = [];
    expect(evaluateActionRule({ compiled, facts: empty, proposal_id: "inverse_empty" }).result).not.toBe("eligible");
    const overflow = structuredClone(loaded.facts);
    overflow.bindings.holds!.rows = Array.from({ length: 6 }, (_, index) => ({ ...loaded.facts.bindings.holds!.rows[0]!, hold_id: `hold_${index}` }));
    expect(evaluateActionRule({ compiled, facts: overflow, proposal_id: "inverse_overflow" }).result).toBe("ineligible");
  });

  it("normalizes safe database scalar representations and rejects lossy integers", () => {
    expect(normalizeActionRuleDatabaseValue("42", { kind: "integer", unit: "items" }, false)).toBe(42);
    expect(normalizeActionRuleDatabaseValue(1, { kind: "boolean" }, false)).toBe(true);
    expect(normalizeActionRuleDatabaseValue("2026-09-02 20:00:00+00", { kind: "timestamp" }, false)).toBe("2026-09-02T20:00:00.000Z");
    expect(normalizeActionRuleDatabaseValue("2026-02-28", { kind: "date" }, false)).toBe("2026-02-28");
    expect(() => normalizeActionRuleDatabaseValue("2026-02-31", { kind: "date" }, false))
      .toThrowError(expect.objectContaining({ code: "ACTION_RULE_FACT_TYPE_MISMATCH" }));
    expect(() => normalizeActionRuleDatabaseValue("9007199254740993", { kind: "integer" }, false))
      .toThrowError(expect.objectContaining({ code: "ACTION_RULE_FACT_TYPE_MISMATCH" }));
  });

  it("derives a single-organization effect without inventing a tenant predicate", () => {
    const fixture = fieldServiceFixture();
    for (const resource of fixture.catalog.resources) delete resource.tenant_key;
    for (const resource of fixture.boundary.resources) {
      resource.scope = {
        mode: "single_organization",
        organization_id: "field-service-dev",
        ...(resource.resource === "field_service.service_requests" ? { principal_field: "principal_id" } : { principal_field: "principal_id" }),
      };
    }
    delete fixture.envelope.tenant_key;
    fixture.envelope.organization_scope = {
      mode: "single_organization",
      organization_id: "field-service-dev",
      acknowledgement: "all_rows_belong_to_one_organization",
    };
    fixture.facts.trusted = {
      organization_scope: { mode: "single_organization", organization_id: "field-service-dev" },
      principal: "customer_1",
      transaction_time: "2026-09-02T20:00:00.000Z",
    };
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const result = evaluateActionRule({ compiled, facts: fixture.facts, proposal_id: "grant_single_org" });
    expect(result.result).toBe("eligible");
    if (result.result !== "eligible") return;
    expect(result.effect.organization_scope).toEqual({ mode: "single_organization", organization_id: "field-service-dev" });
    expect(result.effect).not.toHaveProperty("tenant_guard");
  });

  it("rejects mixed tenant and single-organization verification authority", () => {
    const fixture = fieldServiceFixture();
    fixture.boundary.resources[1]!.scope = { mode: "single_organization", organization_id: "field-service-dev", principal_field: "principal_id" };
    expect(() => compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog }))
      .toThrowError(expect.objectContaining({ code: "ACTION_RULE_SCOPE_UNPROVEN" }));
  });
});

describe("activated semantic outcome registry", () => {
  it("resolves one activated outcome without adding an MCP tool per business action", () => {
    const fixture = fieldServiceFixture();
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const registry = createActionRuleRegistry({ name: "active_actions", rules: [{
      read_boundary_name: "reviewed_field_service",
      read_boundary_digest: `sha256:${"c".repeat(64)}`,
      action_boundary_name: "field_service_actions",
      action_boundary_digest: `sha256:${"d".repeat(64)}`,
      compiled,
      activated_at: "2026-09-02T20:00:00.000Z",
    }] });
    expect(resolveActivatedActionRule(registry, "field_service.reschedule_to_offered_slot").compiled.name).toBe(compiled.name);
    expect(() => resolveActivatedActionRule(registry, "field_service.cancel_everything")).toThrowError(ActionRuleError);
  });

  it("refuses duplicate active rules for one semantic outcome", () => {
    const fixture = fieldServiceFixture();
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const activated = {
      read_boundary_name: "reviewed_field_service",
      read_boundary_digest: `sha256:${"c".repeat(64)}` as const,
      action_boundary_name: "field_service_actions",
      action_boundary_digest: `sha256:${"d".repeat(64)}` as const,
      compiled,
      activated_at: "2026-09-02T20:00:00.000Z",
    };
    expect(() => createActionRuleRegistry({ name: "active_actions", rules: [activated, structuredClone(activated)] }))
      .toThrowError(expect.objectContaining({ code: "ACTION_RULE_AMBIGUOUS" }));
  });
});

describe("canonical Action Rule authority", () => {
  it("reuses an owned catalog index without changing compiler checks or digests", () => {
    const fixture = fieldServiceFixture();
    const input = { rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope };
    const compile = createActionRuleCompiler(fixture.catalog);
    const first = compile(input);
    expect(first).toEqual(compileActionRule({ ...input, catalog: fixture.catalog }));
    fixture.catalog.resources[0]!.primary_key = "tampered_key";
    expect(compile(input)).toEqual(first);
    expect(() => { first.bindings[0]!.resource.primary_key = "another_key"; }).toThrow();
    const changed = structuredClone(input);
    changed.verification_boundary.generation_lock_fingerprint = `sha256:${"f".repeat(64)}`;
    expect(() => compile(changed)).toThrow(/generation lock/);
  });

  it("bounds total rules and approval classes before compiling oversized bundles", () => {
    const fixture = fieldServiceFixture();
    const rule = { read_boundary_name: "reviewed_field_service", read_boundary_digest: `sha256:${"c".repeat(64)}` as const,
      verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, rule: fixture.rule,
      activated_at: "2026-09-02T20:00:00.000Z" };
    expect(() => createActionRuleAuthority({ name: "bounded", action_boundary_name: "bounded_actions", catalog: fixture.catalog,
      rules: Array.from({ length: ACTION_AUTHORITY_LIMITS.rules + 1 }, () => rule) })).toThrow(/4096 reviewed rules/);
    expect(() => createActionRuleApprovalClasses({ rules: [],
      sources: Array.from({ length: ACTION_AUTHORITY_LIMITS.approvalClasses + 1 }, () => ({
        name: "test.approval", mode: "human", rules: [], required_role: "reviewer", required_approvals: 1, shared_limits: [],
      })) })).toThrow(/4096 approval classes/);
    const [approvalClass] = createActionRuleApprovalClasses({ rules: [compileActionRule({
      catalog: fixture.catalog, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, rule: fixture.rule,
    })] });
    expect(() => createActionRuleRegistry({ name: "bounded", rules: [],
      approval_classes: Array.from({ length: ACTION_AUTHORITY_LIMITS.approvalClasses + 1 }, () => approvalClass!),
    })).toThrow(/4096 approval classes/);
  });

  it("rebuilds one immutable semantic Action Boundary and registry", () => {
    const fixture = fieldServiceFixture();
    const input = {
      name: "field_service_active_rules",
      action_boundary_name: "field_service_actions",
      catalog: fixture.catalog,
      rules: [{
        read_boundary_name: "reviewed_field_service",
        read_boundary_digest: `sha256:${"c".repeat(64)}` as const,
        verification_boundary: fixture.boundary,
        effect_envelope: fixture.envelope,
        rule: fixture.rule,
        activated_at: "2026-09-02T20:00:00.000Z",
      }],
    };
    const first = createActionRuleAuthority(input);
    const second = createActionRuleAuthority(structuredClone(input));

    expect(first.authority.digest).toBe(second.authority.digest);
    expect(first.authority.action_boundary.rules).toEqual([{
      outcome: "field_service.reschedule_to_offered_slot",
      effect_envelope_digest: first.registry.rules[0]!.compiled.effect_envelope_digest,
      action_rule_digest: first.registry.rules[0]!.compiled.rule_digest,
      compiled_plan_digest: first.registry.rules[0]!.compiled.compiled_plan_digest,
      approval_class: "field_service.standard_reschedule",
      approval_policy_digest: first.registry.rules[0]!.approval_policy_digest,
      approval_mode: "human",
      operation: "update",
      target_resource: "field_service.appointments",
      allowed_fields: ["scheduled_end_at", "scheduled_start_at", "slot_id"],
      max_rows: 1,
      writeback: { mode: "direct_sql", supervised_worker: "allowed" },
    }]);
    expect(parseActionRuleAuthority(first.authority, first.authority.digest).registry.digest)
      .toBe(first.registry.digest);
  });

  it("refuses a tampered source rule, semantic boundary, or expected digest", () => {
    const fixture = fieldServiceFixture();
    const loaded = createActionRuleAuthority({
      name: "field_service_active_rules",
      action_boundary_name: "field_service_actions",
      catalog: fixture.catalog,
      rules: [{
        read_boundary_name: "reviewed_field_service",
        read_boundary_digest: `sha256:${"c".repeat(64)}`,
        verification_boundary: fixture.boundary,
        effect_envelope: fixture.envelope,
        rule: fixture.rule,
        activated_at: "2026-09-02T20:00:00.000Z",
      }],
    });
    const changedRule = structuredClone(loaded.authority);
    changedRule.rules[0]!.rule.ttl_seconds += 1;
    const changedBoundary = structuredClone(loaded.authority);
    changedBoundary.action_boundary.rules[0]!.allowed_fields = ["slot_id"];

    for (const value of [changedRule, changedBoundary]) {
      expect(() => parseActionRuleAuthority(value))
        .toThrowError(expect.objectContaining({ code: "ACTION_RULE_AUTHORITY_STALE" }));
    }
    expect(() => parseActionRuleAuthority(
      loaded.authority,
      `sha256:${"f".repeat(64)}`,
    )).toThrowError(expect.objectContaining({ code: "ACTION_RULE_AUTHORITY_STALE" }));
  });
});

function fieldServiceRuntimeAdapter(
  fixture: ReturnType<typeof fieldServiceFixture>,
) {
  const rowsByTable = new Map([
    ["appointments", fixture.facts.bindings.appointment!.rows],
    ["service_requests", fixture.facts.bindings.request!.rows],
    ["appointment_slot_offers", fixture.facts.bindings.offer!.rows],
  ]);
  return {
    engine: "postgres" as const,
    async load(query: ActionRuleFactQueryV1) {
      return structuredClone(rowsByTable.get(query.table) ?? []);
    },
  };
}

async function eligibleFieldServiceRuntime(options: {
  approvalClasses?: ActionRuleApprovalClassSourceV1[];
  withInput?: boolean;
  delegationCheck?: import("./runtime.js").SemanticProposalDelegationCheck;
} = {}) {
  const fixture = fieldServiceFixture();
  if (options.withInput) {
    const type = fixture.catalog.resources[0]!.fields.find((field) => field.name === "status")!.type;
    fixture.envelope.allowed_fields.push({ name: "status", type });
    fixture.rule.inputs = [{ name: "requested_status", description: "Requested appointment status", type }];
    fixture.rule.effect.set.status = { kind: "input", name: "requested_status" };
  }
  const compiled = compileActionRule({
    rule: fixture.rule,
    verification_boundary: fixture.boundary,
    effect_envelope: fixture.envelope,
    catalog: fixture.catalog,
  });
  const actionBoundaryDigest = `sha256:${"d".repeat(64)}` as const;
  const approvalClasses = createActionRuleApprovalClasses({
    rules: [compiled],
    ...(options.approvalClasses === undefined ? {} : { sources: options.approvalClasses }),
  });
  const registry = createActionRuleRegistry({
    name: "active_actions",
    approval_classes: approvalClasses,
    rules: [{
      read_boundary_name: "reviewed_field_service",
      read_boundary_digest: `sha256:${"c".repeat(64)}`,
      action_boundary_name: "field_service.actions",
      action_boundary_digest: actionBoundaryDigest,
      compiled,
      activated_at: "2026-09-02T20:00:00.000Z",
    }],
  });
  const decision = await evaluateSemanticActionEligibility({
    registry,
    outcome: fixture.rule.outcome,
    ...(options.withInput ? { inputs: { requested_status: "scheduled" } } : {}),
    subjects: [
      {
        binding: "appointment",
        resource: "field_service.appointments",
        primary_key: { column: "appointment_id", value: "appt_1" },
        subject_ref_digest: `sha256:${"1".repeat(64)}`,
      },
      {
        binding: "offer",
        resource: "field_service.appointment_slot_offers",
        primary_key: { column: "offer_id", value: "offer_1" },
        subject_ref_digest: `sha256:${"2".repeat(64)}`,
      },
    ],
    trusted: fixture.facts.trusted,
    adapter: fieldServiceRuntimeAdapter(fixture),
    proposal_id: "wrp_reschedule_runtime_1",
    trusted_context_digest: `sha256:${"3".repeat(64)}`,
    evidence_provenance_digest: `sha256:${"4".repeat(64)}`,
    verified_at: "2026-09-02T20:00:00.000Z",
    check_delegation: options.delegationCheck,
  });
  if (decision.result !== "eligible") throw new Error("Expected eligible field-service fixture.");
  const effect = decision.semantic_authority.effect;
  const job: NormalizedWritebackJobV5 = {
    protocol_version: "5.0",
    job_id: "wbj_reschedule_runtime_1",
    proposal_id: "wrp_reschedule_runtime_1",
    approval_id: canonicalJsonDigest({ approval: "runtime_1" }),
    proposal_hash: canonicalJsonDigest({ proposal: "runtime_1" }),
    source_id: effect.source,
    engine: "postgres",
    operation: effect.operation,
    target: {
      schema: effect.schema,
      table: effect.table,
      primary_key: effect.primary_key,
      tenant_guard: effect.tenant_guard,
      principal_scope: {
        schema_version: "synapsor.principal-scope.v1",
        column: effect.principal_scope!.column,
        binding: "principal",
        provider: "environment",
        value_fingerprint: canonicalJsonDigest({ principal: effect.principal_scope!.value }),
        value: effect.principal_scope!.value,
      },
    },
    allowed_columns: effect.allowed_columns,
    patch: effect.set,
    conflict_guard: {
      kind: "version_column",
      column: effect.expected_version!.column,
      expected_value: effect.expected_version!.value,
    },
    version_advance: effect.version_advance,
    semantic_authority: decision.semantic_authority,
    idempotency_key: "semantic:wrp_reschedule_runtime_1",
    lease_expires_at: "2026-09-02T20:10:00.000Z",
    attempt_count: 1,
  };
  return { fixture, registry, decision, job };
}

describe("semantic Action eligibility and transaction re-verification", () => {
  it("binds delegated proof, narrows automatic approval, and limits its lifetime without changing the effect", async () => {
    const baseline = await eligibleFieldServiceRuntime({ approvalClasses: [automaticReschedulePolicy()] });
    const proof = { schema_version: "synapsor.delegation-proof.v1" as const, binding_digest: canonicalJsonDigest("binding"),
      policy_chain_digest: canonicalJsonDigest("chain"), actor_digest: canonicalJsonDigest("workload"), valid_until: "2026-09-02T20:01:00.000Z" };
    let checked = false;
    const delegated = await eligibleFieldServiceRuntime({ approvalClasses: [automaticReschedulePolicy()], delegationCheck: async (input) => {
      checked = true;
      expect(input.evaluation.effect).toEqual(baseline.decision.evaluation.effect);
      expect(input.facts.bindings.appointment!.rows).toHaveLength(1);
      return { proof, approval: "human" };
    } });
    expect(checked).toBe(true);
    expect(delegated.decision.approval.path).toBe("human_review");
    expect(delegated.decision.semantic_authority.proof).toMatchObject({ delegation: proof, valid_until: proof.valid_until });
    expect(delegated.decision.evaluation.effect).toEqual(baseline.decision.evaluation.effect);
    expect(delegated.decision.semantic_authority.proof.proof_digest).not.toBe(baseline.decision.semantic_authority.proof.proof_digest);
    let loaded = false;
    const verifier = createSemanticActionVerifier({ registry: delegated.registry, clock: () => "2026-09-02T20:00:30.000Z" });
    await expect(verifier({ job: delegated.job, factLoader: { engine: "postgres", async load() { loaded = true; return []; } } })).rejects.toThrow("required current delegation");
    expect(loaded).toBe(false);
  });

  it("requires current delegated verification and rejects stripped proofs before source reads", async () => {
    const proof = { schema_version: "synapsor.delegation-proof.v1" as const, binding_digest: canonicalJsonDigest("binding"),
      policy_chain_digest: canonicalJsonDigest("chain"), actor_digest: canonicalJsonDigest("workload"), valid_until: "2026-09-02T20:05:00.000Z" };
    const f = await eligibleFieldServiceRuntime({ delegationCheck: async () => ({ proof, approval: "inherit" }) });
    let calls = 0;
    const verifier = createSemanticActionVerifier({ registry: f.registry, clock: () => "2026-09-02T20:02:00.000Z", check_delegation: async ({ job, evaluation }) => {
      calls++; expect(job.semantic_authority.proof.delegation).toEqual(proof);
      expect(evaluation.effect.effect_digest).toBe(f.decision.evaluation.effect.effect_digest);
    } });
    await expect(verifier({ job: f.job, factLoader: fieldServiceRuntimeAdapter(f.fixture) })).resolves.toMatchObject({ status: "reverified" });
    expect(calls).toBe(1);
    const stripped = structuredClone(f.job); delete stripped.semantic_authority.proof.delegation;
    let loaded = false;
    await expect(verifier({ job: stripped, factLoader: { engine: "postgres", async load() { loaded = true; return []; } } })).rejects.toThrow("required current delegation");
    expect(loaded).toBe(false); expect(calls).toBe(1);
    const refused = createSemanticActionVerifier({ registry: f.registry, clock: () => "2026-09-02T20:02:00.000Z", check_delegation: async () => { throw new Error("current owner revoked"); } });
    await expect(refused({ job: f.job, factLoader: fieldServiceRuntimeAdapter(f.fixture) })).rejects.toThrow("current owner revoked");
  });

  it("does not admit an effect when current source facts fail and does not upgrade human approval", async () => {
    const proof = { schema_version: "synapsor.delegation-proof.v1" as const, binding_digest: canonicalJsonDigest("binding"),
      policy_chain_digest: canonicalJsonDigest("chain"), actor_digest: canonicalJsonDigest("workload"), valid_until: "2026-09-02T20:05:00.000Z" };
    const f = await eligibleFieldServiceRuntime({ delegationCheck: async () => ({ proof, approval: "inherit" }) });
    expect(f.decision.approval.path).toBe("human_review");
    let admitted = false;
    const verifier = createSemanticActionVerifier({ registry: f.registry, clock: () => "2026-09-02T20:02:00.000Z", check_delegation: async () => { admitted = true; } });
    await expect(verifier({ job: f.job, factLoader: { engine: "postgres", async load() { return []; } } })).rejects.toThrow();
    expect(admitted).toBe(false);
    await expect(eligibleFieldServiceRuntime({ delegationCheck: async () => ({ proof: { ...proof, valid_until: "2020-01-01T00:00:00.000Z" }, approval: "inherit" }) })).rejects.toThrow("delegation expired");
    await expect(eligibleFieldServiceRuntime({ delegationCheck: async () => undefined as never })).rejects.toThrow("delegation could not be verified");
  });

  it("binds reviewed business inputs into the proof and refuses tampering before fact loading", async () => {
    const { fixture, registry, decision, job } = await eligibleFieldServiceRuntime({ withInput: true });
    expect(decision.semantic_authority.business_inputs).toEqual({ requested_status: "scheduled" });
    expect(decision.semantic_authority.proof.business_inputs_digest)
      .toBe(canonicalJsonDigest({ requested_status: "scheduled" }));
    const verifier = createSemanticActionVerifier({ registry, clock: () => "2026-09-02T20:02:00.000Z" });
    expect(await verifier({ job, factLoader: fieldServiceRuntimeAdapter(fixture) })).toMatchObject({ status: "reverified" });
    const replacements: Array<Record<string, string> | undefined> = [undefined, {}, { requested_status: "canceled" }, { requested_status: "scheduled", tenant_id: "another" }];
    for (const inputs of replacements) {
      const changed = structuredClone(job);
      if (inputs === undefined) delete changed.semantic_authority.business_inputs;
      else changed.semantic_authority.business_inputs = inputs;
      let loaded = false;
      await expect(verifier({ job: changed, factLoader: { engine: "postgres", async load() { loaded = true; return []; } } }))
        .rejects.toBeDefined();
      expect(loaded).toBe(false);
    }
  });

  it("binds a separate exact policy and marks only a matching predicate automatic-eligible", async () => {
    const automatic = await eligibleFieldServiceRuntime({ approvalClasses: [automaticReschedulePolicy()] });
    expect(automatic.decision.approval).toMatchObject({
      path: "automatic_eligible",
      predicate_result: "match",
      authority: { mode: "policy", required_role: "field_service_reviewer" },
    });
    expect(automatic.decision.semantic_authority.proof).toMatchObject({
      approval_class: "field_service.standard_reschedule",
      approval_path: "automatic_eligible",
      approval_policy_digest: automatic.registry.rules[0]!.approval_policy_digest,
    });
    expect(resolveActivatedApprovalClass(automatic.registry, automatic.fixture.rule.outcome).digest)
      .toBe(automatic.registry.rules[0]!.approval_policy_digest);

    const human = await eligibleFieldServiceRuntime({
      approvalClasses: [{
        ...automaticReschedulePolicy(),
        rules: [{
          ...automaticReschedulePolicy().rules[0]!,
          auto_approve_when: {
            kind: "compare",
            operator: "eq",
            left: { kind: "field", binding: "appointment", field: "slot_id" },
            right: { kind: "literal", value: "a_different_slot", value_type: stringId },
          },
        }],
      }],
    });
    expect(human.decision.approval).toMatchObject({ path: "human_review", predicate_result: "no_match" });
    expect(human.decision.semantic_authority.proof.approval_path).toBe("human_review");
    expect(human.decision.semantic_authority.effect).toEqual(automatic.decision.semantic_authority.effect);
  });

  it("rejects automatic approval without both atomic circuit-breaker scopes", () => {
    const fixture = fieldServiceFixture();
    const compiled = compileActionRule({ rule: fixture.rule, verification_boundary: fixture.boundary, effect_envelope: fixture.envelope, catalog: fixture.catalog });
    const missingTrustedLimit = automaticReschedulePolicy();
    missingTrustedLimit.shared_limits = missingTrustedLimit.shared_limits.filter((limit) => limit.scope !== "tenant_principal");
    expect(() => createActionRuleApprovalClasses({ rules: [compiled], sources: [missingTrustedLimit] }))
      .toThrowError(expect.objectContaining({ code: "ACTION_RULE_INVALID" }));
  });

  it("builds a canonical proof and re-verifies the exact effect under current facts", async () => {
    const { fixture, registry, decision, job } = await eligibleFieldServiceRuntime();
    const verifier = createSemanticActionVerifier({
      registry,
      clock: () => "2026-09-02T20:02:00.000Z",
    });
    const result = await verifier({ job, factLoader: fieldServiceRuntimeAdapter(fixture) });
    expect(result).toMatchObject({
      status: "reverified",
      proof_digest: decision.semantic_authority.proof.proof_digest,
      effect_digest: decision.semantic_authority.effect.effect_digest,
      dependency_set_digest: decision.semantic_authority.proof.dependency_set_digest,
    });
  });

  it("refuses an eligibility proof at its exact expiry instant", async () => {
    const { fixture, registry, job } = await eligibleFieldServiceRuntime();
    const verifier = createSemanticActionVerifier({
      registry,
      clock: () => job.semantic_authority.proof.valid_until,
    });
    await expect(verifier({ job, factLoader: fieldServiceRuntimeAdapter(fixture) }))
      .rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
  });

  it("refuses changed authoritative facts instead of applying a stale effect", async () => {
    const { fixture, registry, job } = await eligibleFieldServiceRuntime();
    fixture.facts.bindings.offer!.rows[0]!.status = "released";
    const verifier = createSemanticActionVerifier({
      registry,
      clock: () => "2026-09-02T20:02:00.000Z",
    });
    await expect(verifier({ job, factLoader: fieldServiceRuntimeAdapter(fixture) }))
      .rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
  });

  it("refuses a proposal after its active Action Boundary authority changes", async () => {
    const { fixture, registry, job } = await eligibleFieldServiceRuntime();
    const changedRegistry = createActionRuleRegistry({
      name: registry.name,
      rules: registry.rules.map((entry) => ({
        ...entry,
        action_boundary_digest: `sha256:${"e".repeat(64)}`,
      })),
    });
    const verifier = createSemanticActionVerifier({
      registry: changedRegistry,
      clock: () => "2026-09-02T20:02:00.000Z",
    });
    await expect(verifier({ job, factLoader: fieldServiceRuntimeAdapter(fixture) }))
      .rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
  });

  it("refuses a changed transaction isolation posture before loading facts", async () => {
    const { fixture, registry, job } = await eligibleFieldServiceRuntime();
    const changed = structuredClone(job);
    changed.semantic_authority.proof.verification_transaction.isolation = "serializable";
    const { proof_digest: _proofDigest, ...unsigned } = changed.semantic_authority.proof;
    changed.semantic_authority.proof.proof_digest = eligibilityProofDigest(unsigned);
    let factLoads = 0;
    const verifier = createSemanticActionVerifier({
      registry,
      clock: () => "2026-09-02T20:02:00.000Z",
    });
    await expect(verifier({
      job: changed,
      factLoader: {
        ...fieldServiceRuntimeAdapter(fixture),
        async load(query) {
          factLoads += 1;
          return fieldServiceRuntimeAdapter(fixture).load(query);
        },
      },
    })).rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
    expect(factLoads).toBe(0);
  });
});

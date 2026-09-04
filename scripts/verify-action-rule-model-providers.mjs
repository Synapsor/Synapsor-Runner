#!/usr/bin/env node

import assert from "node:assert/strict";
import { generateModelActionRuleDraft } from "../apps/runner/dist/action-rule-model.js";
import { secureAskJsonRequest } from "../apps/runner/dist/model-ask.js";

const LOCK = `sha256:${"a".repeat(64)}`;
const READ_DIGEST = `sha256:${"b".repeat(64)}`;
const ROLE_DIGEST = `sha256:${"d".repeat(64)}`;
const AUTHORING_DIGEST = `sha256:${"c".repeat(64)}`;
const STRING_ID = { kind: "string", max_length: 64, comparison: "exact" };
const INTEGER = { kind: "integer" };
const TIMESTAMP = { kind: "timestamp" };

const argumentsMap = parseArguments(process.argv.slice(2));
const provider = argumentsMap.provider ?? "openai";
const model = argumentsMap.model
  ?? (provider === "openai" ? "gpt-5.6-terra" : "qwen2.5:7b");
const baseUrl = argumentsMap["base-url"]
  ?? (provider === "openai_compatible" ? "http://127.0.0.1:11434/v1" : undefined);
const requestedDomain = argumentsMap.domain;

if (provider !== "openai" && provider !== "anthropic" && provider !== "openai_compatible") {
  throw new Error("--provider must be openai, anthropic, or openai_compatible.");
}

const fixtures = [fieldServiceFixture(), customerSupportFixture(), inventoryFixture(), universityEnrollmentFixture()]
  .filter((fixture) => requestedDomain === undefined || fixture.id === requestedDomain);
if (!fixtures.length) {
  throw new Error(`Unknown --domain ${requestedDomain}. Use field-service, customer-support, inventory, or university-enrollment.`);
}

for (const fixture of fixtures) {
  const clarifications = [];
  const result = await generateModelActionRuleDraft({
    session: {
      provider,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(process.env.SYNAPSOR_MODEL_QUALIFICATION_DEBUG
        ? { dependencies: { requestJson: debugProviderRequest } }
        : {}),
    },
    intent: fixture.intent,
    builtCatalog: fixture.builtCatalog,
    readBoundary: fixture.readBoundary,
    readBoundaryDigest: READ_DIGEST,
    egressAcknowledged: true,
    askClarification: async (question) => {
      clarifications.push(question);
      process.stderr.write(`CLARIFICATION ${fixture.id} ${clarifications.length}: ${question}\n`);
      return fixture.clarification;
    },
  });

  assert.equal(result.authority_granted, false);
  assert.equal(result.source_database_changed, false);
  assert.equal(result.compiled.effect_envelope.operation, fixture.expected.operation);
  assert.equal(result.compiled.effect_envelope.target_resource, fixture.expected.target);
  assert.equal(result.compiled.rule.outcome.length > 0, true);
  assert.equal(result.compiled.loaded.registry.rules.length, 1);
  assert.equal(result.compiled.loaded.registry.approval_classes.length, 1);
  assert.equal(result.compiled.approval_class.mode, fixture.expected.approval ?? "human");
  for (const expectedLimit of fixture.expected.sharedLimits ?? []) {
    assert.equal(result.compiled.approval_class.shared_limits.some((limit) =>
      limit.kind === expectedLimit.kind
      && limit.scope === expectedLimit.scope
      && limit.maximum === expectedLimit.maximum
      && limit.window_seconds === expectedLimit.window_seconds
      && limit.capability === result.compiled.rule.outcome), true,
    `missing ${fixture.id} ${expectedLimit.scope} ${expectedLimit.kind} approval limit`);
  }
  assert.equal(clarifications.length <= 2, true);

  process.stdout.write([
    `PASS ${provider}[${model}] ${fixture.id}`,
    `${result.compiled.rule.outcome}`,
    `${fixture.expected.operation.toUpperCase()} ${fixture.expected.target}`,
    `approval=${result.compiled.approval_class.mode}`,
    `clarifications=${clarifications.length}`,
    `correction=${result.correction_used ? "used" : "not-used"}`,
    "authority=disabled",
    "source=unchanged",
  ].join(" | ") + "\n");
}

async function debugProviderRequest(input) {
  const response = await secureAskJsonRequest(input);
  const body = response.body;
  const output = Array.isArray(body.output) ? body.output : [];
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const message = choices[0]?.message;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  process.stderr.write(`PROVIDER_RESPONSE status=${response.status} output_types=${output.map((item) => item?.type).join(",") || "none"} tool_calls=${toolCalls.map((item) => item?.function?.name).join(",") || "none"} prose=${typeof message?.content === "string" ? message.content.length : 0}\n`);
  if (process.env.SYNAPSOR_MODEL_QUALIFICATION_DEBUG === "2") {
    process.stderr.write(`${JSON.stringify(response.body).slice(0, 8_000)}\n`);
  }
  return response;
}

function fieldServiceFixture() {
  const appointmentStatus = enumType(32, ["scheduled", "canceled"]);
  const dispatchStatus = enumType(32, ["not_dispatched", "en_route"]);
  const offerStatus = enumType(16, ["held", "released"]);
  const resources = [
    resource({
      name: "field_service.appointments", engine: "postgres",
      primaryKey: "appointment_id", tenantKey: "account_id", principalKey: "principal_id", versionField: "version",
      fields: [
        field("appointment_id", STRING_ID), field("account_id", STRING_ID), field("principal_id", STRING_ID),
        field("request_id", STRING_ID), field("status", appointmentStatus), field("dispatch_status", dispatchStatus),
        field("slot_id", STRING_ID), field("scheduled_start_at", TIMESTAMP), field("scheduled_end_at", TIMESTAMP),
        field("version", INTEGER),
      ],
      visible: ["status", "dispatch_status", "slot_id", "scheduled_start_at", "scheduled_end_at"],
      verificationOnly: [], writable: ["slot_id", "scheduled_start_at", "scheduled_end_at"], update: true,
    }),
    resource({
      name: "field_service.service_requests", engine: "postgres",
      primaryKey: "request_id", tenantKey: "account_id", principalKey: "principal_id", versionField: "version",
      fields: [
        field("request_id", STRING_ID), field("account_id", STRING_ID), field("principal_id", STRING_ID),
        field("service_type", exactString(40)), field("location_zone", exactString(40)),
        field("automatic_change_hold", { kind: "boolean" }), field("version", INTEGER),
      ],
      visible: ["service_type", "location_zone"], verificationOnly: ["automatic_change_hold"], writable: [], update: false,
    }),
    resource({
      name: "field_service.appointment_slot_offers", engine: "postgres",
      primaryKey: "offer_id", tenantKey: "account_id", principalKey: "principal_id", versionField: "version",
      fields: [
        field("offer_id", STRING_ID), field("account_id", STRING_ID), field("principal_id", STRING_ID),
        field("appointment_id", STRING_ID), field("slot_id", STRING_ID), field("service_type", exactString(40)),
        field("location_zone", exactString(40)), field("offered_start_at", TIMESTAMP), field("offered_end_at", TIMESTAMP),
        field("status", offerStatus), field("expires_at", TIMESTAMP), field("version", INTEGER),
      ],
      visible: ["slot_id", "offered_start_at", "offered_end_at", "status", "expires_at"],
      verificationOnly: ["appointment_id", "service_type", "location_zone"], writable: [], update: false,
    }),
  ];
  const relationships = [{
    name: "appointments_request_fk", from_resource: "field_service.appointments",
    to_resource: "field_service.service_requests", local_field: "request_id", target_field: "request_id",
    cardinality: "many_to_one", nullable: false, target_unique: true,
  }];
  return fixture({
    id: "field-service", engine: "postgres", readName: "field_service_read", resources, relationships,
    intent: [
      "Draft a proposal-only outcome that reschedules one authenticated customer's scheduled appointment to one held, unexpired offered slot.",
      "Use the appointment and offered slot as opaque subjects. Verify that dispatch has not started, the related service request has no automatic-change hold, and service type and location match.",
      "Derive slot_id, scheduled_start_at, and scheduled_end_at from the offered slot. Every eligible proposal requires one field_service_reviewer; do not auto-approve or enable writeback.",
    ].join(" "),
    clarification: "Use the appointment and offer as opaque subjects, appointments_request_fk for the service request, and require human review by one field_service_reviewer.",
    expected: { operation: "update", target: "field_service.appointments" },
  });
}

function customerSupportFixture() {
  const chargeStatus = enumType(24, ["settled", "disputed", "refunded"]);
  const refundReason = enumType(32, ["duplicate_charge", "billing_error"]);
  const money = { kind: "money_minor", currency: "USD" };
  const resources = [
    resource({
      name: "support.charges", engine: "postgres", primaryKey: "charge_id", tenantKey: "tenant_id",
      principalKey: "customer_id", versionField: "version",
      fields: [field("charge_id", STRING_ID), field("tenant_id", STRING_ID), field("customer_id", STRING_ID),
        field("status", chargeStatus), field("refundable_amount", money), field("version", INTEGER)],
      visible: ["status", "refundable_amount"], verificationOnly: [], writable: [], update: false,
    }),
    resource({
      name: "support.refund_requests", engine: "postgres", primaryKey: "refund_request_id", tenantKey: "tenant_id",
      principalKey: "customer_id",
      fields: [field("refund_request_id", STRING_ID), field("tenant_id", STRING_ID), field("customer_id", STRING_ID),
        field("charge_id", STRING_ID), field("amount", money), field("reason", refundReason)],
      visible: ["amount", "reason"], verificationOnly: [], writable: ["charge_id", "amount", "reason"],
      update: false, insert: true,
    }),
  ];
  return fixture({
    id: "customer-support", engine: "postgres", readName: "support_read", resources, relationships: [],
    intent: [
      "Draft a proposal-only outcome for an authenticated customer to request a refund for one opaque charge subject.",
      "The charge must be settled and refundable_amount must be between 1 and 2500 USD minor units inclusive.",
      "Insert one support.refund_requests row whose charge_id and amount are derived from the charge and whose reason is duplicate_charge.",
      "Require one support_reviewer. Automatically approve only eligible duplicate-charge requests, otherwise keep the eligible proposal for human review.",
      "Limit automatic approvals to 100 for this exact action in a rolling 24-hour window and one per trusted tenant plus principal in a rolling 15-day window. Do not enable writeback.",
    ].join(" "),
    clarification: "Use the opaque support.charges subject, derive charge_id and refundable_amount, use duplicate_charge, and retain the exact rolling action-wide and tenant-plus-principal automatic-approval limits stated in the job.",
    expected: {
      operation: "insert",
      target: "support.refund_requests",
      approval: "policy",
      sharedLimits: [
        { kind: "count", scope: "capability", maximum: 100, window_seconds: 86_400 },
        { kind: "count", scope: "tenant_principal", maximum: 1, window_seconds: 1_296_000 },
      ],
    },
  });
}

function inventoryFixture() {
  const holdStatus = enumType(16, ["active", "released"]);
  const resources = [
    resource({
      name: "inventory.orders", engine: "mysql", primaryKey: "order_id", tenantKey: "tenant_id", principalKey: "buyer_id", versionField: "version",
      fields: [field("order_id", STRING_ID), field("tenant_id", STRING_ID), field("buyer_id", STRING_ID),
        field("requested_units", { kind: "integer", unit: "units" }), field("version", INTEGER)],
      visible: ["requested_units"], verificationOnly: [], writable: [], update: false,
    }),
    resource({
      name: "inventory.stock_holds", engine: "mysql", primaryKey: "hold_id", tenantKey: "tenant_id", principalKey: "buyer_id", versionField: "version",
      fields: [field("hold_id", STRING_ID), field("tenant_id", STRING_ID), field("buyer_id", STRING_ID),
        field("order_id", STRING_ID), field("status", holdStatus), field("held_units", { kind: "integer", unit: "units" }), field("version", INTEGER)],
      visible: ["status", "held_units"], verificationOnly: [], writable: [], update: false,
    }),
    resource({
      name: "inventory.reservations", engine: "mysql", primaryKey: "reservation_id", tenantKey: "tenant_id", principalKey: "buyer_id",
      fields: [field("reservation_id", STRING_ID), field("tenant_id", STRING_ID), field("buyer_id", STRING_ID),
        field("order_id", STRING_ID), field("reserved_units", { kind: "integer", unit: "units" })],
      visible: ["reserved_units"], verificationOnly: [], writable: ["order_id", "reserved_units"], update: false, insert: true,
    }),
  ];
  const relationships = [{
    name: "stock_holds_order_fk", from_resource: "inventory.stock_holds", to_resource: "inventory.orders",
    local_field: "order_id", target_field: "order_id", cardinality: "many_to_one", nullable: false, target_unique: true,
  }];
  return fixture({
    id: "inventory", engine: "mysql", readName: "inventory_read", resources, relationships,
    intent: [
      "Draft a proposal-only outcome for one opaque inventory.orders subject.",
      "It is eligible only when at least one related active stock hold has held_units greater than or equal to the order requested_units.",
      "Insert one inventory.reservations row with order_id and reserved_units derived from the order.",
      "Use stock_holds_order_fk in the inverse direction with a maximum of 10 rows and deterministic hold_id ascending order.",
      "Require one inventory_reviewer and human review; do not auto-approve or enable writeback.",
    ].join(" "),
    clarification: "Use inventory.orders as the opaque subject and stock_holds_order_fk inverse to load at most 10 holds ordered by hold_id ascending. Require one inventory_reviewer.",
    expected: { operation: "insert", target: "inventory.reservations" },
  });
}

function universityEnrollmentFixture() {
  const registrationStatus = enumType(24, ["waitlisted", "enrolled", "dropped"]);
  const reviewKind = enumType(48, ["waitlist_offer", "erroneous_prerequisite_drop"]);
  const offerStatus = enumType(24, ["active", "expired", "consumed"]);
  const resources = [
    resource({
      name: "university.registration_cases", engine: "postgres", primaryKey: "registration_id",
      tenantKey: "institution_id", principalKey: "student_id", versionField: "version",
      fields: [
        field("registration_id", STRING_ID), field("institution_id", STRING_ID), field("student_id", STRING_ID),
        field("course_code", STRING_ID), field("term_code", STRING_ID), field("status", registrationStatus),
        field("version", INTEGER),
      ],
      visible: ["course_code", "term_code", "status"], verificationOnly: [], writable: ["status"], update: true,
    }),
    resource({
      name: "university.eligibility_reviews", engine: "postgres", primaryKey: "review_id",
      tenantKey: "institution_id", principalKey: "student_id", versionField: "version",
      fields: [
        field("review_id", STRING_ID), field("institution_id", STRING_ID), field("student_id", STRING_ID),
        field("registration_id", STRING_ID), field("case_kind", reviewKind), field("waitlist_position", INTEGER),
        field("offer_status", offerStatus), field("offer_expires_at", TIMESTAMP),
        field("seat_available", { kind: "boolean" }), field("prerequisite_satisfied", { kind: "boolean" }),
        field("registration_hold", { kind: "boolean" }), field("already_enrolled", { kind: "boolean" }),
        field("current_term", { kind: "boolean" }), field("version", INTEGER),
      ],
      visible: ["case_kind", "offer_status", "offer_expires_at"],
      verificationOnly: ["registration_id", "waitlist_position", "seat_available", "prerequisite_satisfied", "registration_hold", "already_enrolled", "current_term"],
      writable: [], update: false,
    }),
  ];
  const relationships = [{
    name: "eligibility_registration_fk", from_resource: "university.eligibility_reviews",
    to_resource: "university.registration_cases", local_field: "registration_id", target_field: "registration_id",
    cardinality: "many_to_one", nullable: false, target_unique: true,
  }];
  return fixture({
    id: "university-enrollment", engine: "postgres", readName: "university_registration_read",
    resources, relationships,
    intent: [
      "Draft a proposal-only outcome that promotes one authenticated student's active waitlist offer into enrolled status.",
      "Use university.eligibility_reviews as the opaque subject and follow eligibility_registration_fk forward to exactly one university.registration_cases row.",
      "Require case_kind waitlist_offer, current registration status waitlisted, waitlist_position 1, active unexpired offer, an available seat, satisfied prerequisites, no registration hold, not already enrolled, and current_term true.",
      "Derive only status enrolled on the related registration row. Require one university_registration_reviewer and human review; do not enable writeback or attempt a second row mutation.",
    ].join(" "),
    clarification: "Use eligibility_reviews as the opaque subject, eligibility_registration_fk forward for the exact registration, update only status to enrolled, and require one university_registration_reviewer with no automatic approval or writeback.",
    expected: { operation: "update", target: "university.registration_cases" },
  });
}

function fixture(input) {
  const source = input.engine === "postgres" ? "local_postgres" : "local_mysql";
  const catalogResources = input.resources.map((item) => item.catalog);
  const authoringResources = input.resources.map((item) => item.authoring);
  return {
    id: input.id, intent: input.intent, clarification: input.clarification, expected: input.expected,
    builtCatalog: {
      catalog: { schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: LOCK,
        resources: catalogResources, relationships: input.relationships },
      authoring: {
        schema_version: "synapsor.action-rule-authoring-catalog.v1", source, engine: input.engine,
        read_boundary_name: input.readName, generation_lock_fingerprint: LOCK, resources: authoringResources,
        relationships: input.relationships,
        supported_language: {
          comparisons: ["eq", "neq", "lt", "lte", "gt", "gte"],
          predicates: ["all", "any", "not", "null_check", "in", "exists"], aggregates: [],
          arithmetic: ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration"],
          effects: ["single_row_update", "single_row_insert"],
        },
        diagnostics: [], digest: AUTHORING_DIGEST,
      },
    },
    readBoundary: readBoundary(input.readName, source, catalogResources, input.relationships),
  };
}

function resource(input) {
  const [schema, table] = input.name.split(".");
  const source = input.engine === "postgres" ? "local_postgres" : "local_mysql";
  const guards = new Set([input.primaryKey, input.tenantKey, input.principalKey, input.versionField].filter(Boolean));
  const visible = new Set(input.visible);
  const verificationOnly = new Set(input.verificationOnly);
  const writable = new Set(input.writable);
  return {
    catalog: {
      name: input.name, source, engine: input.engine, schema, table, primary_key: input.primaryKey,
      tenant_key: input.tenantKey, principal_scope_key: input.principalKey,
      ...(input.versionField ? { version_field: input.versionField } : {}), fields: input.fields,
    },
    authoring: {
      name: input.name, primary_key: input.primaryKey, tenant_scope: "direct", tenant_key: input.tenantKey,
      principal_scope: "direct", principal_key: input.principalKey,
      version_candidates: input.versionField ? [input.versionField] : [],
      ...(input.versionField ? { selected_version_field: input.versionField } : {}),
      operations: { update: input.update, insert: input.insert === true },
      fields: input.fields.map((item) => ({
        ...item,
        role: guards.has(item.name) ? "guard" : verificationOnly.has(item.name)
          ? "runner_verification_only" : visible.has(item.name) ? "model_visible" : "runner_verification_only",
        writable: writable.has(item.name),
        ...(item.type.kind === "string" && Array.isArray(item.type.enum) ? { enum_source: "schema" } : {}),
      })),
    },
  };
}

function readBoundary(name, source, resources, relationships) {
  return {
    schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "production",
    source, compiler_version: "provider-qualification", spec_version: "provider-qualification",
    trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
    generation_lock_fingerprint: LOCK, role_posture_fingerprint: ROLE_DIGEST,
    pack: {
      name,
      resources: resources.map((item) => ({
        id: item.name, schema: item.schema, table: item.table, primary_key: item.primary_key,
        tenant_key: item.tenant_key, principal_key: item.principal_scope_key, field_types: {}, field_enums: {},
        selectable_fields: item.fields.map((candidate) => candidate.name)
          .filter((candidate) => ![item.primary_key, item.tenant_key, item.principal_scope_key, item.version_field].includes(candidate)),
        filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [], count_distinct_fields: [],
        time_bucket_fields: {}, kept_out_fields: item.fields.map((candidate) => candidate.name)
          .filter((candidate) => [item.tenant_key, item.principal_scope_key, item.version_field].includes(candidate)),
        relationships: relationships.filter((relationship) => relationship.from_resource === item.name).map((relationship) => relationship.name),
        minimum_cohort_size: 5, suppression_aware_totals: true,
      })),
    },
    budgets: {
      max_rows: 50, max_groups: 50, max_top_n: 25, max_measures: 3, max_dimensions: 3, max_time_ranges: 2,
      max_relationship_hops: 3, max_response_cells: 500, max_response_bytes: 65_536, statement_timeout_ms: 3_000,
      max_complexity: 24, max_queries_per_session: 1_000, max_extracted_cells_per_session: 4_000,
      max_differencing_queries: 16, rate_limit_per_minute: 120,
    },
    unresolved_decisions: [],
  };
}

function field(name, type, nullable = false) { return { name, type, nullable }; }
function enumType(maxLength, values) { return { kind: "string", max_length: maxLength, comparison: "exact", enum: values }; }
function exactString(maxLength) { return { kind: "string", max_length: maxLength, comparison: "exact" }; }

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current?.startsWith("--")) throw new Error(`Unexpected argument ${current}.`);
    const name = current.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}.`);
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

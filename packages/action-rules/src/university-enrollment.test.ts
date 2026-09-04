import { describe, expect, it } from "vitest";
import type {
  ActionRuleScalarTypeSpecV1,
  ActionRuleSpecV1,
  DerivedEffectEnvelopeSpecV1,
  JsonScalar,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import { compileActionRule } from "./compile.js";
import { evaluateActionRule } from "./evaluate.js";
import type { ActionRuleCatalogV1, ActionRuleFactSetV1 } from "./types.js";

const lock = `sha256:${"a".repeat(64)}` as const;
const provenance = `sha256:${"b".repeat(64)}` as const;
const stringId = { kind: "string", max_length: 64, comparison: "exact" } as const;
const integer = { kind: "integer" } as const;
const timestamp = { kind: "timestamp" } as const;
const booleanType = { kind: "boolean" } as const;
const registrationStatus = enumType(24, ["waitlisted", "enrolled", "dropped"]);
const caseKind = enumType(48, ["waitlist_offer", "erroneous_prerequisite_drop", "completed_advising_hold"]);
const offerStatus = enumType(24, ["active", "expired", "consumed"]);
const dropReason = enumType(32, ["prerequisite_missing", "system_error", "voluntary"]);
const holdType = enumType(24, ["advising", "financial", "disciplinary"]);
const holdStatus = enumType(24, ["active", "released"]);

function enumType(maxLength: number, values: string[]): ActionRuleScalarTypeSpecV1 {
  return { kind: "string", max_length: maxLength, comparison: "exact", enum: values };
}

function field(binding: string, name: string) {
  return { kind: "field", binding, field: name } as const;
}

function literal(value: JsonScalar, valueType: ActionRuleScalarTypeSpecV1) {
  return { kind: "literal", value, value_type: valueType } as const;
}

function universityFixture(outcome: "waitlist" | "restoration" | "hold_release"): {
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
        name: "university.registration_cases",
        source: "local_postgres",
        engine: "postgres",
        schema: "university",
        table: "registration_cases",
        primary_key: "registration_id",
        tenant_key: "institution_id",
        principal_scope_key: "student_id",
        version_field: "version",
        fields: [
          { name: "registration_id", type: stringId, nullable: false },
          { name: "institution_id", type: stringId, nullable: false },
          { name: "student_id", type: stringId, nullable: false },
          { name: "course_code", type: stringId, nullable: false },
          { name: "term_code", type: stringId, nullable: false },
          { name: "status", type: registrationStatus, nullable: false },
          { name: "version", type: integer, nullable: false },
        ],
      },
      {
        name: "university.eligibility_reviews",
        source: "local_postgres",
        engine: "postgres",
        schema: "university",
        table: "eligibility_reviews",
        primary_key: "review_id",
        tenant_key: "institution_id",
        principal_scope_key: "student_id",
        version_field: "version",
        fields: [
          { name: "review_id", type: stringId, nullable: false },
          { name: "institution_id", type: stringId, nullable: false },
          { name: "student_id", type: stringId, nullable: false },
          { name: "registration_id", type: stringId, nullable: false },
          { name: "hold_id", type: stringId, nullable: false },
          { name: "case_kind", type: caseKind, nullable: false },
          { name: "waitlist_position", type: integer, nullable: false },
          { name: "offer_status", type: offerStatus, nullable: false },
          { name: "offer_expires_at", type: timestamp, nullable: false },
          { name: "seat_available", type: booleanType, nullable: false },
          { name: "prerequisite_satisfied", type: booleanType, nullable: false },
          { name: "registration_hold", type: booleanType, nullable: false },
          { name: "already_enrolled", type: booleanType, nullable: false },
          { name: "drop_reason", type: dropReason, nullable: false },
          { name: "prerequisite_satisfied_before_drop", type: booleanType, nullable: false },
          { name: "restoration_window_active", type: booleanType, nullable: false },
          { name: "reserved_restoration_seat", type: booleanType, nullable: false },
          { name: "completion_evidence_verified", type: booleanType, nullable: false },
          { name: "release_authorized", type: booleanType, nullable: false },
          { name: "current_term", type: booleanType, nullable: false },
          { name: "version", type: integer, nullable: false },
        ],
      },
      {
        name: "university.student_holds",
        source: "local_postgres",
        engine: "postgres",
        schema: "university",
        table: "student_holds",
        primary_key: "hold_id",
        tenant_key: "institution_id",
        principal_scope_key: "student_id",
        version_field: "version",
        fields: [
          { name: "hold_id", type: stringId, nullable: false },
          { name: "institution_id", type: stringId, nullable: false },
          { name: "student_id", type: stringId, nullable: false },
          { name: "hold_type", type: holdType, nullable: false },
          { name: "status", type: holdStatus, nullable: false },
          { name: "version", type: integer, nullable: false },
        ],
      },
    ],
    relationships: [
      {
        name: "eligibility_registration_fk",
        from_resource: "university.eligibility_reviews",
        to_resource: "university.registration_cases",
        local_field: "registration_id",
        target_field: "registration_id",
        cardinality: "many_to_one",
        nullable: false,
        target_unique: true,
      },
      {
        name: "eligibility_hold_fk",
        from_resource: "university.eligibility_reviews",
        to_resource: "university.student_holds",
        local_field: "hold_id",
        target_field: "hold_id",
        cardinality: "many_to_one",
        nullable: false,
        target_unique: true,
      },
    ],
  };
  const targetIsHold = outcome === "hold_release";
  const targetBinding = targetIsHold ? "hold" : "registration";
  const targetResource = targetIsHold ? catalog.resources[2]! : catalog.resources[0]!;
  const targetRelationship = targetIsHold ? "eligibility_hold_fk" : "eligibility_registration_fk";
  const targetLocalField = targetIsHold ? "hold_id" : "registration_id";
  const boundary: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1",
    name: `university.${outcome}_verification`,
    source: "local_postgres",
    context: "trusted_context",
    generation_lock_fingerprint: lock,
    resources: [
      {
        binding: "review",
        resource: "university.eligibility_reviews",
        source: { kind: "subject_ref" },
        primary_key: "review_id",
        version_field: "version",
        fields: catalog.resources[1]!.fields,
        scope: { mode: "columns", tenant_field: "institution_id", principal_field: "student_id" },
        cardinality: "one",
        max_rows: 1,
        overflow: "unsupported",
        lock: "for_update",
      },
      {
        binding: targetBinding,
        resource: targetResource.name,
        source: {
          kind: "relationship",
          from_binding: "review",
          relationship: targetRelationship,
          local_field: targetLocalField,
          target_field: targetLocalField,
          direction: "forward",
        },
        primary_key: targetLocalField,
        version_field: "version",
        fields: targetResource.fields,
        scope: { mode: "columns", tenant_field: "institution_id", principal_field: "student_id" },
        cardinality: "one",
        max_rows: 1,
        overflow: "unsupported",
        lock: "for_update",
      },
    ],
    lock_order: ["review", targetBinding],
    transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const envelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1",
    name: `university.${outcome}_effect`,
    source: "local_postgres",
    operation: "update",
    target_resource: targetResource.name,
    target_binding: targetBinding,
    primary_key: targetLocalField,
    tenant_key: "institution_id",
    principal_scope_key: "student_id",
    conflict_key: "version",
    max_rows: 1,
    allowed_fields: [{
      name: "status",
      type: targetIsHold ? holdStatus : registrationStatus,
      values: [targetIsHold ? "released" : "enrolled"],
    }],
    version_advance: { column: "version", strategy: "integer_increment" },
    approval_classes: [targetIsHold ? "university.registrar_review" : "university.registration_correction"],
    writeback: { mode: "direct_sql", supervised_worker: "allowed" },
  };
  const waitlistRequirements: ActionRuleSpecV1["require"] = {
    kind: "all",
    expressions: [
      { kind: "compare", operator: "eq", left: field("review", "case_kind"), right: literal("waitlist_offer", caseKind) },
      { kind: "compare", operator: "eq", left: field("registration", "status"), right: literal("waitlisted", registrationStatus) },
      { kind: "compare", operator: "eq", left: field("review", "waitlist_position"), right: literal(1, integer) },
      { kind: "compare", operator: "eq", left: field("review", "offer_status"), right: literal("active", offerStatus) },
      { kind: "compare", operator: "gt", left: field("review", "offer_expires_at"), right: { kind: "trusted", binding: "transaction_time" } },
      { kind: "compare", operator: "eq", left: field("review", "seat_available"), right: literal(true, booleanType) },
      { kind: "compare", operator: "eq", left: field("review", "prerequisite_satisfied"), right: literal(true, booleanType) },
      { kind: "compare", operator: "eq", left: field("review", "registration_hold"), right: literal(false, booleanType) },
      { kind: "compare", operator: "eq", left: field("review", "already_enrolled"), right: literal(false, booleanType) },
      { kind: "compare", operator: "eq", left: field("review", "current_term"), right: literal(true, booleanType) },
    ],
  };
  const restorationRequirements: ActionRuleSpecV1["require"] = {
    kind: "all",
    expressions: [
      { kind: "compare", operator: "eq", left: field("review", "case_kind"), right: literal("erroneous_prerequisite_drop", caseKind) },
      { kind: "compare", operator: "eq", left: field("registration", "status"), right: literal("dropped", registrationStatus) },
      { kind: "compare", operator: "eq", left: field("review", "drop_reason"), right: literal("prerequisite_missing", dropReason) },
      { kind: "compare", operator: "eq", left: field("review", "prerequisite_satisfied_before_drop"), right: literal(true, booleanType) },
      { kind: "compare", operator: "eq", left: field("review", "registration_hold"), right: literal(false, booleanType) },
      { kind: "compare", operator: "eq", left: field("review", "restoration_window_active"), right: literal(true, booleanType) },
      { kind: "compare", operator: "eq", left: field("review", "reserved_restoration_seat"), right: literal(true, booleanType) },
      { kind: "compare", operator: "eq", left: field("review", "current_term"), right: literal(true, booleanType) },
    ],
  };
  const holdReleaseRequirements: ActionRuleSpecV1["require"] = {
    kind: "all",
    expressions: [
      { kind: "compare", operator: "eq", left: field("review", "case_kind"), right: literal("completed_advising_hold", caseKind) },
      { kind: "compare", operator: "eq", left: field("hold", "hold_type"), right: literal("advising", holdType) },
      { kind: "compare", operator: "eq", left: field("hold", "status"), right: literal("active", holdStatus) },
      { kind: "compare", operator: "eq", left: field("review", "completion_evidence_verified"), right: literal(true, booleanType) },
      { kind: "compare", operator: "eq", left: field("review", "release_authorized"), right: literal(true, booleanType) },
      { kind: "compare", operator: "eq", left: field("review", "current_term"), right: literal(true, booleanType) },
    ],
  };
  const ruleName = outcome === "waitlist"
    ? "university.promote_active_waitlist_offer"
    : outcome === "restoration"
      ? "university.restore_erroneous_prerequisite_drop"
      : "university.release_completed_advising_hold";
  const rule: ActionRuleSpecV1 = {
    schema_version: "synapsor.action-rule.v1",
    name: ruleName,
    outcome: ruleName,
    context: "trusted_context",
    source: "local_postgres",
    verification_boundary_ref: boundary.name,
    effect_envelope_ref: envelope.name,
    subjects: [{ binding: "review", resource: "university.eligibility_reviews", input: "opaque_subject_ref" }],
    require: outcome === "waitlist"
      ? waitlistRequirements
      : outcome === "restoration"
        ? restorationRequirements
        : holdReleaseRequirements,
    derive: {},
    effect: {
      operation: "update",
      target_resource: targetResource.name,
      target_binding: targetBinding,
      set: { status: literal(targetIsHold ? "released" : "enrolled", targetIsHold ? holdStatus : registrationStatus) },
    },
    approval_class: targetIsHold ? "university.registrar_review" : "university.registration_correction",
    ttl_seconds: 60,
  };
  const reviewId = outcome === "waitlist"
    ? "review_waitlist_1"
    : outcome === "restoration"
      ? "review_restore_1"
      : "review_hold_1";
  const registrationId = outcome === "waitlist" ? "registration_waitlist_1" : "registration_dropped_1";
  const facts: ActionRuleFactSetV1 = {
    bindings: {
      review: { rows: [{
        review_id: reviewId,
        institution_id: "university_1",
        student_id: "student_123",
        registration_id: registrationId,
        hold_id: "hold_advising_1",
        case_kind: outcome === "waitlist"
          ? "waitlist_offer"
          : outcome === "restoration"
            ? "erroneous_prerequisite_drop"
            : "completed_advising_hold",
        waitlist_position: outcome === "waitlist" ? 1 : 0,
        offer_status: outcome === "waitlist" ? "active" : "consumed",
        offer_expires_at: "2026-09-05T12:00:00.000Z",
        seat_available: outcome === "waitlist",
        prerequisite_satisfied: true,
        registration_hold: false,
        already_enrolled: false,
        drop_reason: "prerequisite_missing",
        prerequisite_satisfied_before_drop: true,
        restoration_window_active: true,
        reserved_restoration_seat: true,
        completion_evidence_verified: outcome === "hold_release",
        release_authorized: outcome === "hold_release",
        current_term: true,
        version: 3,
      }] },
      ...(targetIsHold
        ? {
            hold: { rows: [{
              hold_id: "hold_advising_1",
              institution_id: "university_1",
              student_id: "student_123",
              hold_type: "advising",
              status: "active",
              version: 5,
            }] },
          }
        : {
            registration: { rows: [{
              registration_id: registrationId,
              institution_id: "university_1",
              student_id: "student_123",
              course_code: "CS301",
              term_code: "2026-fall",
              status: outcome === "waitlist" ? "waitlisted" : "dropped",
              version: outcome === "waitlist" ? 7 : 11,
            }] },
          }),
    },
    trusted: {
      tenant: "university_1",
      principal: "student_123",
      transaction_time: "2026-09-03T12:00:00.000Z",
    },
    subject_provenance_digest: provenance,
  };
  return { catalog, boundary, envelope, rule, facts };
}

function evaluateFixture(fixture: ReturnType<typeof universityFixture>, proposalId: string) {
  const compiled = compileActionRule({
    catalog: fixture.catalog,
    verification_boundary: fixture.boundary,
    effect_envelope: fixture.envelope,
    rule: fixture.rule,
  });
  return { compiled, result: evaluateActionRule({ compiled, facts: fixture.facts, proposal_id: proposalId }) };
}

describe("portable university registration rules", () => {
  it("promotes one eligible active waitlist case without a university-specific handler", () => {
    const { result } = evaluateFixture(universityFixture("waitlist"), "waitlist_proposal_1");
    expect(result.result).toBe("eligible");
    if (result.result !== "eligible") return;
    expect(result.effect).toMatchObject({
      operation: "single_row_update",
      resource: "university.registration_cases",
      primary_key: { column: "registration_id", value: "registration_waitlist_1" },
      tenant_guard: { column: "institution_id", value: "university_1" },
      principal_scope: { column: "student_id", value: "student_123" },
      expected_version: { column: "version", value: 7 },
      set: { status: "enrolled" },
    });
    expect(result.dependencies).toHaveLength(2);
  });

  it.each([
    ["no seat", (fixture: ReturnType<typeof universityFixture>) => { fixture.facts.bindings.review!.rows[0]!.seat_available = false; }],
    ["expired offer", (fixture: ReturnType<typeof universityFixture>) => { fixture.facts.bindings.review!.rows[0]!.offer_expires_at = "2026-09-02T12:00:00.000Z"; }],
    ["registration hold", (fixture: ReturnType<typeof universityFixture>) => { fixture.facts.bindings.review!.rows[0]!.registration_hold = true; }],
    ["already enrolled", (fixture: ReturnType<typeof universityFixture>) => { fixture.facts.bindings.registration!.rows[0]!.status = "enrolled"; }],
  ])("refuses waitlist promotion with %s", (_label, mutate) => {
    const fixture = universityFixture("waitlist");
    mutate(fixture);
    const { result } = evaluateFixture(fixture, "waitlist_refused");
    expect(result).toMatchObject({ result: "ineligible", safe_code: "ACTION_RULE_NOT_ELIGIBLE" });
    expect(result).not.toHaveProperty("effect");
  });

  it("restores one eligible erroneous prerequisite drop", () => {
    const { result } = evaluateFixture(universityFixture("restoration"), "restore_proposal_1");
    expect(result.result).toBe("eligible");
    if (result.result !== "eligible") return;
    expect(result.effect).toMatchObject({
      operation: "single_row_update",
      primary_key: { column: "registration_id", value: "registration_dropped_1" },
      expected_version: { column: "version", value: 11 },
      set: { status: "enrolled" },
    });
  });

  it.each([
    ["wrong drop reason", (fixture: ReturnType<typeof universityFixture>) => { fixture.facts.bindings.review!.rows[0]!.drop_reason = "voluntary"; }],
    ["late prerequisite correction", (fixture: ReturnType<typeof universityFixture>) => { fixture.facts.bindings.review!.rows[0]!.prerequisite_satisfied_before_drop = false; }],
    ["closed restoration window", (fixture: ReturnType<typeof universityFixture>) => { fixture.facts.bindings.review!.rows[0]!.restoration_window_active = false; }],
    ["missing reserved seat", (fixture: ReturnType<typeof universityFixture>) => { fixture.facts.bindings.review!.rows[0]!.reserved_restoration_seat = false; }],
  ])("refuses erroneous-drop restoration with %s", (_label, mutate) => {
    const fixture = universityFixture("restoration");
    mutate(fixture);
    const { result } = evaluateFixture(fixture, "restore_refused");
    expect(result).toMatchObject({ result: "ineligible", safe_code: "ACTION_RULE_NOT_ELIGIBLE" });
    expect(result).not.toHaveProperty("effect");
  });

  it("releases one completed advising hold without granting a generic hold-removal operation", () => {
    const { compiled, result } = evaluateFixture(universityFixture("hold_release"), "hold_release_proposal_1");
    expect(compiled.rule.approval_class).toBe("university.registrar_review");
    expect(result.result).toBe("eligible");
    if (result.result !== "eligible") return;
    expect(result.effect).toMatchObject({
      operation: "single_row_update",
      resource: "university.student_holds",
      primary_key: { column: "hold_id", value: "hold_advising_1" },
      tenant_guard: { column: "institution_id", value: "university_1" },
      principal_scope: { column: "student_id", value: "student_123" },
      expected_version: { column: "version", value: 5 },
      set: { status: "released" },
    });
  });

  it.each([
    ["unverified completion evidence", (fixture: ReturnType<typeof universityFixture>) => { fixture.facts.bindings.review!.rows[0]!.completion_evidence_verified = false; }],
    ["missing registrar authorization", (fixture: ReturnType<typeof universityFixture>) => { fixture.facts.bindings.review!.rows[0]!.release_authorized = false; }],
    ["a financial hold", (fixture: ReturnType<typeof universityFixture>) => { fixture.facts.bindings.hold!.rows[0]!.hold_type = "financial"; }],
    ["an already released hold", (fixture: ReturnType<typeof universityFixture>) => { fixture.facts.bindings.hold!.rows[0]!.status = "released"; }],
  ])("refuses advising-hold release with %s", (_label, mutate) => {
    const fixture = universityFixture("hold_release");
    mutate(fixture);
    const { result } = evaluateFixture(fixture, "hold_release_refused");
    expect(result).toMatchObject({ result: "ineligible", safe_code: "ACTION_RULE_NOT_ELIGIBLE" });
    expect(result).not.toHaveProperty("effect");
  });

  it("treats a cross-student subject as unproven rather than deriving an effect", () => {
    const fixture = universityFixture("waitlist");
    fixture.facts.trusted.principal = "student_999";
    const { result } = evaluateFixture(fixture, "cross_student_refused");
    expect(result).toMatchObject({ result: "unknown", safe_code: "ACTION_RULE_SCOPE_UNPROVEN" });
    expect(result).not.toHaveProperty("effect");
  });

  it("keeps all university outcomes deterministic and independently digest-bound", () => {
    const waitlist = evaluateFixture(universityFixture("waitlist"), "waitlist_digest").compiled;
    const restoration = evaluateFixture(universityFixture("restoration"), "restoration_digest").compiled;
    const holdRelease = evaluateFixture(universityFixture("hold_release"), "hold_release_digest").compiled;
    expect(waitlist.compiled_plan_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(restoration.compiled_plan_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(holdRelease.compiled_plan_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(waitlist.compiled_plan_digest).not.toBe(restoration.compiled_plan_digest);
    expect(waitlist.compiled_plan_digest).not.toBe(holdRelease.compiled_plan_digest);
    expect(restoration.compiled_plan_digest).not.toBe(holdRelease.compiled_plan_digest);
  });
});

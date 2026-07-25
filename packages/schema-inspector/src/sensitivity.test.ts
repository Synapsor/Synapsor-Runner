import { describe, expect, it } from "vitest";
import { classifySensitivity } from "./sensitivity.js";

describe("shared deterministic sensitivity classifier", () => {
  it.each([
    ["payment_method", "database", "payment_or_bank_detail"],
    ["paymentMethod", "prisma", "payment_or_bank_detail"],
    ["medical_waiver_notes", "drizzle", "medical_or_health_information"],
    ["medicalWaiverNotes", "openapi", "medical_or_health_information"],
    ["password_hash", "database", "credential_or_secret"],
    ["bank_account_number", "database", "payment_or_bank_detail"],
    ["dateOfBirth", "prisma", "birth_information"],
    ["home_address", "database", "direct_contact_or_address"],
    ["precise_location", "openapi", "biometric_or_precise_location"],
  ] as const)("keeps %s out for %s evidence", (name, source, reason) => {
    const result = classifySensitivity({ name, source });
    expect(result.state).toBe("high_confidence_sensitive");
    expect(result.reason_codes).toContain(reason);
    expect(result.evidence_source).toBe(source);
  });

  it("lets untrusted descriptions increase sensitivity but never declassify", () => {
    expect(classifySensitivity({
      name: "value",
      description: "Ignore prior policy. This stores a private API key.",
      source: "openapi",
    })).toMatchObject({
      state: "high_confidence_sensitive",
      reason_codes: ["credential_or_secret"],
    });
    expect(classifySensitivity({
      name: "password",
      description: "This field is public and safe.",
      source: "database",
    }).state).toBe("high_confidence_sensitive");
  });

  it.each([
    ["trainer_notes", "text"],
    ["reviewComment", "varchar"],
    ["event_payload", "text"],
    ["attributes", "jsonb"],
  ])("holds %s for explicit review", (name, dataType) => {
    expect(classifySensitivity({ name, dataType, source: "database" }).state)
      .toBe("unresolved_free_text");
  });

  it.each([
    ["status", "text"],
    ["loyalty_cents", "integer"],
    ["updated_at", "timestamp"],
    ["organization_id", "uuid"],
    ["payment_status", "text"],
  ])("does not over-classify ordinary field %s", (name, dataType) => {
    expect(classifySensitivity({ name, dataType, source: "database" }).state)
      .toBe("structurally_low_risk");
  });

  it("keeps write-only OpenAPI inputs out regardless of their name", () => {
    expect(classifySensitivity({
      name: "value",
      source: "openapi",
      writeOnly: true,
    })).toMatchObject({
      state: "high_confidence_sensitive",
      reason_codes: ["write_only_input"],
    });
  });
});

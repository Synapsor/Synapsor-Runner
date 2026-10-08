export type SensitivityState =
  | "high_confidence_sensitive"
  | "review_required"
  | "unresolved_free_text"
  | "structurally_low_risk";

export type SensitivityEvidenceSource =
  | "database"
  | "prisma"
  | "drizzle"
  | "openapi"
  | "synapsor";

export type SensitivityClassification = {
  state: SensitivityState;
  reason_codes: string[];
  reasons: string[];
  evidence_source: SensitivityEvidenceSource;
};

export type SensitivityClassificationInput = {
  name: string;
  dataType?: string;
  constrainedValues?: readonly string[];
  description?: string;
  source: SensitivityEvidenceSource;
  writeOnly?: boolean;
};

/** Metadata describes storage; it does not establish permission to disclose a value.
 * Names, descriptions, scalar types and enum bounds therefore never clear review.
 * The existing field-exposure review owns any subsequent disclosure decision.
 */
export function classifySensitivity(input: SensitivityClassificationInput): SensitivityClassification {
  return input.writeOnly === true
    ? {
      state: "high_confidence_sensitive",
      reason_codes: ["write_only_input"],
      reasons: ["The source marks this field as write-only, so it must not become model-visible."],
      evidence_source: input.source,
    }
    : {
      state: "review_required",
      reason_codes: ["field_exposure_review_required"],
      reasons: ["Storage metadata does not establish field disclosure permission; an explicit field exposure review is required."],
      evidence_source: input.source,
    };
}

export type SensitivityState =
  | "high_confidence_sensitive"
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
  description?: string;
  source: SensitivityEvidenceSource;
  writeOnly?: boolean;
};

type NormalizedEvidence = {
  compact: string;
  tokens: Set<string>;
  descriptionCompact: string;
  descriptionTokens: Set<string>;
  dataType: string;
};

type Rule = {
  code: string;
  reason: string;
  matches: (value: NormalizedEvidence) => boolean;
};

const HIGH_CONFIDENCE_RULES: Rule[] = [
  rule(
    "credential_or_secret",
    "The field name or description indicates credentials, authentication material, or a secret.",
    [
      "password",
      "passwordhash",
      "passwd",
      "passphrase",
      "secret",
      "token",
      "apikey",
      "accesskey",
      "privatekey",
      "credential",
      "oauth",
      "cookie",
      "sessiontoken",
    ],
  ),
  rule(
    "payment_or_bank_detail",
    "The field name or description indicates a payment instrument or bank detail.",
    [
      "paymentmethod",
      "paymentinstrument",
      "paymentdetails",
      "paymentcard",
      "cardonfile",
      "cardholder",
      "cardholdername",
      "cardexpiry",
      "cardexpiration",
      "cardnumber",
      "fullpan",
      "creditcard",
      "debitcard",
      "cardtoken",
      "card",
      "cc",
      "ccnumber",
      "ccnum",
      "pan",
      "cvv",
      "cvc",
      "bankaccount",
      "accountnumber",
      "routingnumber",
      "iban",
      "swiftcode",
    ],
  ),
  rule(
    "government_identifier",
    "The field name or description indicates a government-issued or tax identifier.",
    [
      "ssn",
      "socialsecurity",
      "socialsecuritynumber",
      "taxid",
      "nationalid",
      "passport",
      "passportnumber",
      "driverslicense",
      "driverlicense",
    ],
  ),
  rule(
    "birth_information",
    "The field name or description indicates a date of birth or birth information.",
    ["dateofbirth", "birthdate", "dob"],
  ),
  rule(
    "medical_or_health_information",
    "The field name or description indicates medical or health information.",
    [
      "medical",
      "health",
      "diagnosis",
      "treatment",
      "medication",
      "prescription",
      "allergy",
      "clinical",
      "patientnote",
      "waivernote",
    ],
  ),
  rule(
    "direct_contact_or_address",
    "The field name or description indicates direct contact or address information.",
    [
      "email",
      "emailaddress",
      "phone",
      "phonenumber",
      "telephone",
      "address",
      "streetaddress",
      "homeaddress",
      "mailingaddress",
      "postalcode",
      "zipcode",
    ],
  ),
  rule(
    "biometric_or_precise_location",
    "The field name or description indicates biometric or precise-location information.",
    [
      "biometric",
      "fingerprint",
      "faceprint",
      "voiceprint",
      "geolocation",
      "gpscoordinate",
      "latitude",
      "longitude",
      "preciselocation",
    ],
  ),
  rule(
    "private_or_risk_information",
    "The field name or description indicates private notes, internal risk data, or a risk score.",
    ["privatenote", "privatedata", "internalrisk", "riskscore"],
  ),
];

const UNRESOLVED_NAME_TOKENS = new Set([
  "note",
  "notes",
  "comment",
  "comments",
  "description",
  "memo",
  "message",
  "payload",
  "body",
  "content",
  "details",
  "remarks",
  "metadata",
  "freeform",
]);

const UNRESOLVED_DATA_TYPES = new Set(["json", "jsonb", "xml", "object", "array"]);

export function classifySensitivity(input: SensitivityClassificationInput): SensitivityClassification {
  const evidence = normalizeEvidence(input);
  const matched = HIGH_CONFIDENCE_RULES.filter((candidate) => candidate.matches(evidence));
  if (input.writeOnly) {
    matched.push({
      code: "write_only_input",
      reason: "The source marks this field as write-only, so it must not become model-visible.",
      matches: () => true,
    });
  }
  if (matched.length > 0) {
    return classification(
      "high_confidence_sensitive",
      matched.map((item) => item.code),
      matched.map((item) => item.reason),
      input.source,
    );
  }

  const unresolved: Array<{ code: string; reason: string }> = [];
  if ([...evidence.tokens].some((token) => UNRESOLVED_NAME_TOKENS.has(token))) {
    unresolved.push({
      code: "unconstrained_free_text_name",
      reason: "The field name indicates unconstrained notes, comments, descriptions, or payload content.",
    });
  }
  if (UNRESOLVED_DATA_TYPES.has(evidence.dataType)) {
    unresolved.push({
      code: "unstructured_data_type",
      reason: `The ${evidence.dataType} data type can contain unreviewed nested or free-form content.`,
    });
  }
  if (unresolved.length > 0) {
    return classification(
      "unresolved_free_text",
      unresolved.map((item) => item.code),
      unresolved.map((item) => item.reason),
      input.source,
    );
  }

  return classification(
    "structurally_low_risk",
    ["no_sensitive_structural_signal"],
    ["No deterministic sensitive or unconstrained free-text signal was found in the available structural metadata."],
    input.source,
  );
}

function classification(
  state: SensitivityState,
  reasonCodes: string[],
  reasons: string[],
  evidenceSource: SensitivityEvidenceSource,
): SensitivityClassification {
  return {
    state,
    reason_codes: [...new Set(reasonCodes)].sort(),
    reasons: [...new Set(reasons)].sort(),
    evidence_source: evidenceSource,
  };
}

function rule(code: string, reason: string, patterns: string[]): Rule {
  return {
    code,
    reason,
    matches: (value) => patterns.some((pattern) => {
      if (pattern === "pan" || pattern === "cc" || pattern === "card") {
        return value.compact === pattern || value.descriptionTokens.has(pattern);
      }
      if (pattern.length <= 4) {
        return value.compact === pattern
          || value.tokens.has(pattern)
          || value.descriptionTokens.has(pattern);
      }
      return value.compact.includes(pattern) || value.descriptionCompact.includes(pattern);
    }),
  };
}

function normalizeEvidence(input: SensitivityClassificationInput): NormalizedEvidence {
  const identifier = splitIdentifier(input.name);
  const description = splitIdentifier(input.description ?? "");
  return {
    compact: identifier.replaceAll("_", ""),
    tokens: new Set(identifier.split("_").filter(Boolean)),
    descriptionCompact: description.replaceAll("_", ""),
    descriptionTokens: new Set(description.split("_").filter(Boolean)),
    dataType: String(input.dataType ?? "").trim().toLowerCase(),
  };
}

function splitIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

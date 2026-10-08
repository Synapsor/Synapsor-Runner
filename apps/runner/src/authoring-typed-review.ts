/** B64 host-owned view and operator event contract. These are not provider tool
 * arguments or a writable form schema. Domain adapters resolve every identity,
 * reparse literals and check currentness before their existing protected save. */
export type TypedReviewDigest = `sha256:${string}`;
export type TypedReviewBinding = Readonly<{
  proposal_id: string;
  proposal_revision: number;
  proposal_digest: TypedReviewDigest;
  applicability_digest: TypedReviewDigest;
  operation_id: string;
  view_digest: TypedReviewDigest;
}>;
export type TypedFieldValue =
  | Readonly<{ kind: "integer"; value: number }>
  | Readonly<{ kind: "money"; minor_units: number; currency: string; scale: number }>
  | Readonly<{ kind: "choice"; value: string }>;
export type TypedFieldOrigin = "saved_confirmed" | "saved_unconfirmed" | "model_proposal" | "operator_edit";
export type TypedFieldSelection = Readonly<{ value: TypedFieldValue; origin: TypedFieldOrigin }>;
type FieldIdentity = Readonly<{
  id: string;
  target_digest: TypedReviewDigest;
  dependencies_digest: TypedReviewDigest;
  label: string;
  explanation?: string;
  required: boolean;
  current?: TypedFieldSelection;
  suggestion?: TypedFieldSelection;
}>;
/** Currency scale and options are supplied by the domain owner, never inferred
 * from a name or model-generated schema. Money compiles to exact minor units. */
export type TypedReviewField = FieldIdentity & (
  | Readonly<{ kind: "integer"; minimum: number; maximum: number }>
  | Readonly<{ kind: "money"; currency: string; scale: number; minimum_minor: number; maximum_minor: number }>
  | Readonly<{ kind: "choice"; options: readonly Readonly<{ value: string; label: string }>[] }>
);
export type TypedFieldBinding = Readonly<{
  binding: TypedReviewBinding;
  field_id: string;
  target_digest: TypedReviewDigest;
  dependencies_digest: TypedReviewDigest;
}>;
/** Exact empty input is an event, not invented raw testimony or confirmation.
 * A decoded value from a client is deliberately absent: the domain reparses raw. */
export type TypedFieldEvent = TypedFieldBinding & (
  | Readonly<{ kind: "keep_suggestion" }>
  | Readonly<{ kind: "replace_literal"; raw: string }>
  | Readonly<{ kind: "select_option"; value: string }>
  | Readonly<{ kind: "leave_pending" }>
);
export type TypedReviewView = Readonly<{
  binding: TypedReviewBinding;
  decision_kind: "business_review";
  status: "proposed" | "unconfirmed";
  title: string;
  fields: readonly TypedReviewField[];
  /** Complete host-rendered proposal and diff, including noneditable duties. */
  normalized_lines: readonly string[];
  change_lines: readonly string[];
  /** Host-normalized exact details; bound in view_digest, disclosed only locally. */
  technical_lines?: readonly string[];
  unresolved: readonly string[];
}>;
export type TypedReviewResponse =
  | Readonly<{ kind: "field_event"; event: TypedFieldEvent }>
  | Readonly<{ kind: "review"; binding: TypedReviewBinding }>
  | Readonly<{ kind: "describe_correction"; binding: TypedReviewBinding; raw: string }>
  | Readonly<{ kind: "pause"; binding: TypedReviewBinding }>;
/** Returned only by the trusted operator adapter after a separate default-No
 * grouped review. It is not a model tool, Source save, activation or egress grant. */
export type TypedReviewConfirmation = Readonly<{
  kind: "decision";
  binding: TypedReviewBinding;
  accepted: boolean | null;
}>;

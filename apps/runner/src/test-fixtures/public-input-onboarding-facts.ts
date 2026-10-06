/** Declared fictional operator facts for the public Input acceptance fixture.
 * They are delivered at the ordinary Source attachment and raw-answer prompt;
 * stored question IDs, bindings and accepted records are never response inputs. */
export const PUBLIC_INPUT_FACTS = {
  sourceClause: "Every retained Action also requires a caller-supplied operator_note string. Its lower and upper length bounds require the current owner's answer; spaces count, and it is never trimmed or stored as a source effect.",
  outcomes: ["studio.pack_parcel_1", "studio.pack_parcel_2"],
  reviewClasses: ["studio.pack_parcel_1_review", "studio.pack_parcel_2_review"],
  question: "How short or long may the caller note be, counting spaces?",
  rawAnswer: "  The operator_note is 1 through 64 UTF-16 units; spaces count, including café 😀. Do not trim or store it as a Source effect.\t ",
  input: "operator_note",
  minimum: 1,
  maximum: 64,
  sourceLine: 7,
} as const;

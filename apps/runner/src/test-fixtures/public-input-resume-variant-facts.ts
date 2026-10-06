/** Fictional facts predeclared independently before this variant's launch.
 * Responses derive current IDs/targets from actual frames; this file contains
 * only normally transmitted Source text and declared operator words. No oracle. */
export const PUBLIC_INPUT_FACTS = {
  sourceClause: "Every retained Action also requires a caller-supplied handover_note string. Its lower and upper length bounds require the current owner's answer; spaces count, and it is never trimmed or stored as a source effect.",
  outcomes: ["dispatch_lab.pack_parcel_1", "dispatch_lab.pack_parcel_2"],
  reviewClasses: ["dispatch_lab.pack_parcel_1_review", "dispatch_lab.pack_parcel_2_review"],
  question: "How short or long may the handover note be, counting spaces?",
  rawAnswer: "  At least 4 and at most 31 UTF-16 units for the handover_note; count spaces and never trim it. Do not use these bounds for units.\t ",
  input: "handover_note", minimum: 4, maximum: 31, sourceLine: 7,
  editRequest: "No editing request is authorized in this variant.",
} as const;

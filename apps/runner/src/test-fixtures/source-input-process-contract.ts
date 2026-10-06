import { canonicalJsonDigest } from "@synapsor-runner/protocol";

/** Declared local fixture facts; no private policy oracle or imported result. */
export const INPUT_PROCESS_FACTS = {
  sourceText: "Hold a parcel with its note.\nAsk the operator to review the lower and upper note-length bounds before preparing its input contract.",
  raw: "  The note is 1 through 64 UTF-16 units; spaces count, including café 😀.\t ",
  question: "What are the smallest and largest permitted note lengths, counting spaces and UTF-16 units?",
  outcomes: ["work.hold"],
  job: "Hold a parcel with its note.",
} as const;
export const INPUT_PROCESS_BINDING = { boundary_name: "controlled_input_process", generation_lock_fingerprint: canonicalJsonDigest("controlled lock"),
  schema_fingerprint: canonicalJsonDigest("controlled schema"), role_posture_fingerprint: canonicalJsonDigest("controlled role") };

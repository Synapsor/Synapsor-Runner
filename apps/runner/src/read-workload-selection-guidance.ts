// Metadata matching is not evidence that a business policy permits a public read.
export const READ_SELECTION_GUIDANCE = [
  "Excluding a resource's questions can also remove it from private Action verification.",
  "Need private verification? Keep it in the disabled draft and review all public operations before activation.",
  "RUNNER ONLY withholds raw values, not analytical grants. Aggregates require explicit selection.",
] as const;

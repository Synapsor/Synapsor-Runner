/** Derived views of existing question records. Responses contain only words or
 * decisions; neither the view nor its presenter owns persistence or authority.
 * Each stage keeps its own binding and validates it in its production host. */
export type AuthoringQuestionInteraction<Binding, PendingDetails = unknown> =
  | { kind: "question"; binding: Binding; text: string; material: readonly string[];
      preserveWhitespace: true; recordPolicyAnswer: false }
  | { kind: "readback"; binding: Binding; lines: readonly string[]; defaultValue: false }
  | ({ kind: "pending"; binding: Binding; material: readonly string[];
      canAnswer: boolean; defaultValue: "keep" } & PendingDetails);

export type AuthoringQuestionResponse<Binding> =
  | { kind: "answer"; binding: Binding; raw: string | null }
  | { kind: "decision"; binding: Binding; accepted: boolean | null }
  | { kind: "pending"; binding: Binding; choice: "keep" | "answer" };

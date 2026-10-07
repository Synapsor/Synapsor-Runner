/** Terminal presentation only. Hosts still own the exact permission contract. */
export type AuthoringActivationView = {
  kind: "read" | "proposal" | "execution";
  title: string;
  message: string;
  labels: Readonly<Partial<Record<"activate" | "revise_model" | "details" | "finish" | "yes" | "no", string>>>;
};

export function readActivationView(input: {
  replacing: boolean;
  removedResources?: number;
  reducedGrants?: boolean;
  revisionModel?: "current" | "new";
}): AuthoringActivationView {
  const removed = input.removedResources ?? 0;
  return {
    kind: "read",
    title: input.replacing ? "REVIEW ACCESS CHANGES" : "REVIEW ACCESS",
    message: input.replacing
      ? "Replace the assistant's current reading permissions with the reviewed changes?"
      : "Allow the assistant to read the information shown above? This does not enable changes to the database.",
    labels: {
      activate: input.replacing
        ? removed
          ? `Replace current reading access (removes ${removed} table${removed === 1 ? "" : "s"})`
          : input.reducedGrants
            ? "Replace current reading access (reduces reviewed access)"
            : "Replace current reading access with this reviewed revision"
        : "Enable the reviewed reading access",
      ...(input.revisionModel === "current" ? { revise_model: "Change what the assistant can read" }
        : input.revisionModel === "new" ? { revise_model: "Revise saved read access with a model" } : {}),
      details: "Inspect exact reading permissions",
      finish: input.replacing
        ? "Keep current reading access and finish"
        : "Save without enabling access and finish",
    },
  };
}

export function proposalActivationView(): AuthoringActivationView {
  return {
    kind: "proposal",
    title: "REVIEW CHANGE REQUESTS",
    message: "Allow the reviewed change requests and approval rules? Database execution has a separate review.",
    labels: { yes: "Enable the reviewed change requests" },
  };
}

export function executionActivationView(outcome: string): AuthoringActivationView {
  return {
    kind: "execution",
    title: "PERMISSION REQUIRED",
    message: `Enable supervised source execution for ${outcome}?`,
    labels: {},
  };
}

/** Keep option values, order, disabled state and exact details untouched. */
export function activationDisplayOptions<T extends { value: string; label: string }>(
  options: readonly T[],
  view: AuthoringActivationView,
): T[] {
  return options.map((option) => {
    const label = Object.prototype.hasOwnProperty.call(view.labels, option.value)
      ? view.labels[option.value as keyof typeof view.labels]
      : undefined;
    return label === undefined ? option : { ...option, label };
  });
}

import type { AuthoringActivationView } from "./authoring-activation-view.js";

/** Presentation projection only: the caller retains permission/default/currentness ownership. */
export type AuthoringPermissionPresentationInput = {
  title: string;
  prompt: string;
  context: string[];
  explanationContext?: string[];
  choices: Array<{ value: string; label: string; detail?: string }>;
  decisionKind?: "business_review" | "disclosure" | "activation" | "recovery";
  activationView?: AuthoringActivationView;
};

function modelSafePermissionFacts(lines: string[], maxLines = 20): string[] {
  return lines
    .map((line) => /^Excluded fields:/u.test(line) ? "Excluded fields stay unavailable; their names are in local operator details." : line)
    .map((line) => line
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
      .replace(/sha256:[a-f0-9]+/giu, "[operator-only digest]")
      .trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/(?:fingerprint|\bdigest\b|proposal hash|credential|password|api[_ -]?key|endpoint|database url|\bsql\b)/iu.test(line))
    .filter((line) => !/\b(?:tenant|principal)(?:[_ -]?id)?\b/iu.test(line))
    .slice(0, maxLines);
}


export function authoringPermissionPresentation(request: AuthoringPermissionPresentationInput) {
  const activation = request.decisionKind === "activation" ? request.activationView : undefined;
  const unresolved = request.choices.some((choice) => choice.value === "resolve");
  const nextQuestion = unresolved
    ? "Would you like to review the unresolved requirements?"
    : activation?.message ?? "Would you like to allow this exact Runner permission now?";
  const safeContext = modelSafePermissionFacts(request.context);
  const safeChoices = modelSafePermissionFacts(
    request.choices.map((choice) => `Operator choice: ${choice.label}${choice.detail ? ` - ${choice.detail}` : ""}`),
  );
  return {
    nextQuestion,
    validatedFacts: [
      `Pending gate: ${request.title}`,
      ...(activation?.kind === "execution"
        ? ["This is the separate execution-authorization gate itself. Allowing enables the reviewed execution policy; it does not start a worker. A running worker and successful receipt are still required for completion."] : []),
      ...(activation?.kind === "proposal"
        ? ["This Action activation enables reviewed change requests only, under their exact eligibility and automatic-versus-human approval rules. It does not enable database execution. Automatic-approval limits do not limit human fallback."] : []),
      ...(unresolved
        ? ["Activation is unavailable: unresolved policy requirements are mandatory, not recommendations."] : []),
      ...safeContext,
      ...modelSafePermissionFacts(request.explanationContext ?? [], 256),
      ...safeChoices,
      "Trusted tenant and principal values remain Runner-injected and outside model arguments.",
      "Allowing changes only the exact authority in this gate; declining leaves current authority and source data unchanged.",
    ],
  };
}

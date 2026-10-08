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
      const positiveChoice = request.choices[0]?.label
        .replace(/\s+\[(?:recommended|ready[^\]]*|available)[^\]]*\]/giu, "")
        .trim();
      const isActionActivation = /\bactivat\w*\b/iu.test(request.prompt) && /\b(?:action|proposal)\b/iu.test(request.prompt);
      const nextQuestion = isActionActivation
        ? "Enable these change requests under the reviewed eligibility and approval rules? Database execution is a separate decision."
        : positiveChoice && positiveChoice !== "Allow this exact step"
        ? `Would you like Runner to ${positiveChoice.charAt(0).toLowerCase()}${positiveChoice.slice(1)}?`
        : /\bactivate\b/iu.test(request.prompt)
          ? "Would you like Runner to activate this exact reviewed authority now?"
          : /\bapprove\b/iu.test(request.prompt)
            ? "Would you like Runner to approve this exact reviewed action now?"
            : /\bapply\b/iu.test(request.prompt)
              ? "Would you like Runner to apply this exact reviewed action now?"
              : "Would you like to allow this exact Runner permission now?";
      const safeContext = modelSafePermissionFacts(request.context);
      const safeChoices = modelSafePermissionFacts(
        request.choices.map((choice) => `Operator choice: ${choice.label}${choice.detail ? ` - ${choice.detail}` : ""}`),
      );
  return {
    nextQuestion,
          validatedFacts: [
            `Pending gate: ${request.title}`,
            ...(/^Enable supervised source execution\b/iu.test(request.prompt)
              ? ["This is the separate execution-authorization gate itself. Allowing enables the reviewed execution policy; it does not start a worker. Do not describe another execution-authorization review as a later prerequisite. A running worker and successful receipt are still required for completion."] : []),
            ...(isActionActivation
              ? ["This Action activation enables reviewed change requests only, under their exact eligibility and automatic-versus-human approval rules. It does NOT enable database execution. Execution setup comes next when requested. Call this enabling change requests, not enabling a supervised operation. Automatic-approval limits do not limit human fallback."] : []),
            ...(request.choices.some((choice) => choice.value === "resolve")
              ? ["Activation is unavailable: unresolved policy requirements are mandatory, not recommendations. Explain the next business decision, never invite activation or claim these checks passed."] : []),
            ...safeContext,
            ...modelSafePermissionFacts(request.explanationContext ?? [], 256),
            ...safeChoices,
            "Trusted tenant and principal values remain Runner-injected and outside model arguments.",
            "Allowing changes only the exact authority in this gate; declining leaves current authority and source data unchanged.",
          ],
  };
}

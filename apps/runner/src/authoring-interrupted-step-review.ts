import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { AuthoringRecoveryView, AuthoringRecoveryResponse } from "./authoring-recovery-interaction.js";

/** Stateless CLI view. The shared host owns selection, freshness, consent
 * sequencing and recording; the presenter has no prepare or record ports. */
export async function presentAuthoringRecovery(view: AuthoringRecoveryView,
  session: Pick<BoundaryReviewInteractiveSession, "chooseOption" | "confirm" | "showReviewDetails">,
): Promise<AuthoringRecoveryResponse> {
  if (view.kind === "details") {
    await session.showReviewDetails?.(view.title, [...view.details]);
    return { kind: "details", binding: view.binding };
  }
  if (view.kind === "confirm") return { kind: "decision", binding: view.binding,
    accepted: await session.confirm(view.title, { defaultValue: false,
      context: [...view.lines], exactDetails: { title: "EXACT RECOVERY DECISION", lines: [...view.details] } }) ?? null };
  return { kind: "choice", binding: view.binding,
    value: await session.chooseOption?.(view.title, [...view.options ?? []], {
      initialValue: "pause", displayContext: true, context: [...view.lines],
    }) ?? null };
}

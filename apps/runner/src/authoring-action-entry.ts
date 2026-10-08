import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { AUTHORING_PROGRAM_CAPACITY } from "./authoring-program-capacity.js";
import { MAX_BOUNDARY_ACTION_INTENT_CHARACTERS } from "./boundary-authoring-limits.js";

async function promptDelegationActionIntents(
  session: BoundaryReviewInteractiveSession,
): Promise<string[] | undefined> {
  const intents: string[] = [];
  while (intents.length < AUTHORING_PROGRAM_CAPACITY.totalActions) {
    const answer = await session.promptText(
      intents.length === 0
        ? "What may the agent propose? Leave blank for a read-only job."
        : `Another proposal action ${intents.length + 1} (blank when done)`,
    );
    if (answer === undefined) return undefined;
    const normalized = answer.trim().replace(/\s+/g, " ");
    if (!normalized) return intents;
    if ([...normalized].length > MAX_BOUNDARY_ACTION_INTENT_CHARACTERS) {
      throw new Error(
        `Proposal action intents must be at most ${MAX_BOUNDARY_ACTION_INTENT_CHARACTERS} characters each.`,
      );
    }
    intents.push(normalized);
  }
  session.present?.("Complete selected program", [
    `All ${intents.length} selected Action intents are retained. This authoring path supports at most ${AUTHORING_PROGRAM_CAPACITY.totalActions} selected Actions.`,
    "Drafting and review use bounded work units; the complete program still needs validation and separate publication.",
  ]);
  return intents;
}

export async function promptJobFirstActionIntents(
  session: BoundaryReviewInteractiveSession,
  jobIntent: string,
): Promise<string[] | undefined> {
  const prepareActions = await session.confirm(
    "Should this job include an Action Boundary for structured proposals?",
    {
      defaultValue: false,
      context: [
        "READ AND ACTION BOUNDARIES",
        "Read Boundary: what the agent may inspect through Explore.",
        "Action Boundary: what structured change it may propose. Approval and apply remain separate.",
        "Choose No for a read-only job. You can add Action Boundaries later with Y.",
      ],
    },
  );
  if (prepareActions === undefined) return undefined;
  return prepareActions ? [jobIntent] : [];
}

/** Missing model planning is unresolved, never inferred from operator prose.
 * Manual routes use explicit choices; neither choice grants Action authority. */
export async function selectUnplannedActionIntents(input: {
  jobFirst: boolean; modelChat: boolean; session: BoundaryReviewInteractiveSession; jobIntent: string;
}): Promise<string[] | undefined> {
  if (input.jobFirst && input.modelChat)
    throw new Error("AUTHORING_TYPED_ACTION_PLAN_REQUIRED: Resume the saved planning question before selecting Actions; no intent was inferred from the job description.");
  return input.jobFirst ? promptJobFirstActionIntents(input.session, input.jobIntent)
    : promptDelegationActionIntents(input.session);
}

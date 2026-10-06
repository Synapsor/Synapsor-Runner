import { AskError } from "./model-ask.js";
import { beginAuthoringProducerInvocation, authoringInterruptedProducerCorrections,
  reserveAuthoringProducerCorrection, withAuthoringProducerCorrection } from "./authoring-generation-recovery.js";

export async function runRequiredAuthoringToolCall<T>(input: {
  run: (question: string) => Promise<T>;
  question: string;
  toolName: string;
  onCorrection?: () => void;
  /** A resumed multi-stage owner must durably reserve its one shared
   * correction. No callback/dispatch follows a refusal or failed save. */
  reserveCorrection?: () => Promise<boolean>;
}): Promise<{ result: T; correction_used: boolean }> {
  beginAuthoringProducerInvocation();
  const inherited = !input.reserveCorrection && authoringInterruptedProducerCorrections().correction_used;
  try {
    return {
      result: await input.run(input.question),
      correction_used: Boolean(inherited),
    };
  } catch (error) {
    if (!(error instanceof AskError)
      || !["ASK_REQUIRED_TOOL_NOT_CALLED", "ASK_PROVIDER_RESPONSE_INVALID", "ASK_TOOL_ARGUMENTS_INVALID"].includes(error.code)) {
      throw error;
    }
    if (input.reserveCorrection ? !await input.reserveCorrection()
      : inherited || !await reserveAuthoringProducerCorrection("semantic")) throw error;
    input.onCorrection?.();
    const correct = () => input.run([
      error.code === "ASK_REQUIRED_TOOL_NOT_CALLED"
        ? "Your previous response did not contain exactly the required structured tool call."
        : `Your previous response could not be parsed as a valid structured tool call (${error.code}). Return valid JSON arguments matching the tool schema.`,
      `Call ${input.toolName} exactly once now. Do not explain, summarize, emit SQL, or return ordinary text.`,
      "This is the only correction attempt. The result remains untrusted and grants no authority.",
      input.question,
    ].join("\n"));
    return {
      result: await (input.reserveCorrection ? correct() : withAuthoringProducerCorrection("semantic",correct)),
      correction_used: true,
    };
  }
}

import { AskError } from "./model-ask.js";

export async function runRequiredAuthoringToolCall<T>(input: {
  run: (question: string) => Promise<T>;
  question: string;
  toolName: string;
  onCorrection?: () => void;
}): Promise<{ result: T; correction_used: boolean }> {
  try {
    return {
      result: await input.run(input.question),
      correction_used: false,
    };
  } catch (error) {
    if (!(error instanceof AskError)
      || !["ASK_REQUIRED_TOOL_NOT_CALLED", "ASK_PROVIDER_RESPONSE_INVALID", "ASK_TOOL_ARGUMENTS_INVALID"].includes(error.code)) {
      throw error;
    }
    input.onCorrection?.();
    return {
      result: await input.run([
        error.code === "ASK_REQUIRED_TOOL_NOT_CALLED"
          ? "Your previous response did not contain exactly the required structured tool call."
          : `Your previous response could not be parsed as a valid structured tool call (${error.code}). Return valid JSON arguments matching the tool schema.`,
        `Call ${input.toolName} exactly once now. Do not explain, summarize, emit SQL, or return ordinary text.`,
        "This is the only correction attempt. The result remains untrusted and grants no authority.",
        input.question,
      ].join("\n")),
      correction_used: true,
    };
  }
}

import { AskError } from "./model-ask.js";

export async function runRequiredAuthoringToolCall<T>(input: {
  run: (question: string) => Promise<T>;
  question: string;
  toolName: string;
}): Promise<{ result: T; correction_used: boolean }> {
  try {
    return {
      result: await input.run(input.question),
      correction_used: false,
    };
  } catch (error) {
    if (!(error instanceof AskError) || error.code !== "ASK_REQUIRED_TOOL_NOT_CALLED") {
      throw error;
    }
    return {
      result: await input.run([
        "Your previous response was discarded because it returned prose instead of the required structured tool call.",
        `Call ${input.toolName} exactly once now. Do not explain, summarize, emit SQL, or return ordinary text.`,
        "This is the only correction attempt. The result remains untrusted and grants no authority.",
        input.question,
      ].join("\n")),
      correction_used: true,
    };
  }
}

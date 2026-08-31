import { describe, expect, it, vi } from "vitest";
import {
  createBoundaryAuthoringChat,
} from "./boundary-authoring-chat.js";
import type { AnalyticsShellIo } from "./analytics-shell.js";

function memoryIo(input: {
  reads?: Array<string | undefined>;
  choices?: Array<string | undefined>;
} = {}) {
  const writes: string[] = [];
  const prompts: string[] = [];
  const choices: Array<{ title: string; initialValue?: string; labels: string[] }> = [];
  const reads = [...(input.reads ?? [])];
  const selected = [...(input.choices ?? [])];
  const setStatus = vi.fn();
  const clearStatus = vi.fn();
  const close = vi.fn();
  const io: AnalyticsShellIo = {
    read: async (prompt) => {
      prompts.push(prompt);
      return reads.shift();
    },
    readWithEscape: async (prompt) => {
      prompts.push(prompt);
      return reads.shift();
    },
    choose: async (choice) => {
      choices.push({
        title: choice.title,
        ...(choice.initialValue ? { initialValue: choice.initialValue } : {}),
        labels: choice.options.map((option) => option.label),
      });
      return selected.shift();
    },
    write: (value) => writes.push(value),
    writeChunk: (value) => writes.push(value),
    setStatus,
    clearStatus,
    isTerminal: () => true,
    columns: () => 100,
    onInterrupt: () => () => undefined,
    close,
  };
  return { io, writes, prompts, choices, setStatus, clearStatus, close };
}

describe("Boundary authoring chat", () => {
  it("keeps operator, model, and Runner roles distinct in one transcript", async () => {
    const memory = memoryIo({ reads: ["Explain ticket trends and propose follow-ups."] });
    const chat = createBoundaryAuthoringChat({
      io: memory.io,
      modelLabel: "openai[gpt-5.6-luna]",
      color: false,
    });

    const answer = await chat.session.promptText("What job are you giving this agent?", {
      context: [
        "SET UP ONE AGENT JOB",
        "Describe reads and structured proposals in ordinary language.",
      ],
    });
    chat.model(["I mapped ticket trends to reviewed support tables."]);
    chat.runner("Runner validation", ["All identifiers are reviewed; authority remains off."], "success");
    chat.close();

    expect(answer).toBe("Explain ticket trends and propose follow-ups.");
    expect(memory.prompts).toEqual(["you> "]);
    const transcript = memory.writes.join("");
    expect(transcript).toContain("runner> BOUNDARY AUTHORING");
    expect(transcript).toContain("runner> SET UP ONE AGENT JOB");
    expect(transcript).toContain("runner> What job are you giving this agent?");
    expect(transcript).toContain("model> I mapped ticket trends");
    expect(transcript).not.toContain("synapsor>");
    expect(memory.close).toHaveBeenCalledOnce();
  });

  it("renders activation as an exact permission rather than a generic wizard confirmation", async () => {
    const memory = memoryIo({ choices: ["yes", "no", "back"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    await expect(chat.session.confirmActivation?.(
      'Activate "reviewed_support" exactly as shown now?',
      { context: ["READ BOUNDARY AUTHORITY", "3 tables; minimum cohort 5"] },
    )).resolves.toBe(true);
    await expect(chat.session.confirm(
      "Send reviewed structural metadata to openai[gpt-5.6-luna]?",
      { defaultValue: false },
    )).resolves.toBe(false);
    await expect(chat.actionPrompter.choose("ACTIVATE PROPOSAL ACTION", [
      { value: "activate", label: "Activate this exact proposal-only action" },
      { value: "advanced", label: "Open draft details" },
      { value: "back", label: "Leave disabled" },
    ], ["Proposal authority is currently disabled."])).resolves.toBe("back");

    expect(memory.choices).toEqual([
      expect.objectContaining({
        title: "PERMISSION REQUIRED",
        initialValue: "no",
        labels: ["Allow this exact step", "Not now; keep authority unchanged"],
      }),
      expect.objectContaining({
        title: "PERMISSION REQUIRED",
        initialValue: "no",
      }),
      expect.objectContaining({
        title: "PERMISSION REQUIRED",
        initialValue: "back",
      }),
    ]);
    expect(memory.writes.join("")).toContain("you> Allow this exact step");
    expect(memory.writes.join("")).toContain("you> Not now; keep authority unchanged");
    expect(memory.writes.join("")).toContain("runner> Permission request");
    expect(memory.writes.join("")).toContain("Activate \"reviewed_support\" exactly as shown now?");
  });

  it("presents model-interpreted business questions in chat and uses a spinner only during work", async () => {
    const memory = memoryIo({ reads: ["between five minutes and two hours"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    const answer = await chat.actionPrompter.text(
      "What is the smallest and largest duration the agent may propose?",
      {
        title: "SET PROPOSAL RANGE",
        context: [
          "Action: INSERT support.follow_up_tasks",
          "Interpreter: openai[gpt-5.6-luna]",
        ],
      },
    );
    await expect(chat.progress("Interpreting the reviewed range", async () => 120)).resolves.toBe(120);

    expect(answer).toBe("between five minutes and two hours");
    expect(memory.writes.join("")).toContain("model> What is the smallest and largest duration");
    expect(memory.setStatus).toHaveBeenCalledWith("Interpreting the reviewed range");
    expect(memory.clearStatus).toHaveBeenCalled();
    expect(memory.writes.join("")).not.toContain("runner> Completed");
  });

  it("strips inherited terminal formatting and emphasizes the validated value", () => {
    const memory = memoryIo();
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: true });

    chat.runner("READ REVIEW", [
      "\u001b[1mExact fingerprint:\u001b[0m \u001b[1;35msha256:abc123\u001b[0m",
      "Runner-validated interpretation: estimated_minutes: 5 through 120",
    ]);

    const transcript = memory.writes.join("");
    expect(transcript).not.toContain("\\u001b");
    expect(transcript.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, ""))
      .toContain("Runner-validated interpretation: estimated_minutes: 5 through 120");
    expect(transcript).toContain("\u001b[1;32m5 through 120\u001b[0m");
  });

  it("streams one retained role turn and exposes only provider liveness before validation", async () => {
    const memory = memoryIo();
    const chat = createBoundaryAuthoringChat({
      io: memory.io,
      modelLabel: "openai[gpt-5.6-luna]",
      color: false,
      streamLineDelayMs: 1,
    });
    const initialWrites = memory.writes.length;

    chat.providerStream({ phase: "started" });
    chat.providerStream({ phase: "tool_started", tool: "submit_boundary_draft" });
    chat.providerStream({ phase: "tool_delta", characters: 31 });
    chat.providerStream({ phase: "completed" });
    await chat.streamModel(["I drafted one reviewed read plan.", "- support.tickets: count(*)"]);
    await chat.streamRunner("Runner validation", [
      "The complete draft passed exact identifier and grammar checks.",
      "No authority is active.",
    ], "success");

    const streamed = memory.writes.slice(initialWrites).join("");
    expect(memory.writes.slice(initialWrites).length).toBeGreaterThan(8);
    expect(streamed.match(/model>/gu)).toHaveLength(1);
    expect(streamed.match(/runner>/gu)).toHaveLength(1);
    expect(streamed).toContain("support.tickets: count(*)");
    expect(streamed).not.toContain("submit_boundary_draft");
    expect(memory.setStatus).toHaveBeenCalledWith(
      "openai[gpt-5.6-luna] is responding... 31 characters received; Runner has not accepted them",
    );
    expect(memory.setStatus).toHaveBeenLastCalledWith("Runner is validating the complete streamed draft...");
  });
});

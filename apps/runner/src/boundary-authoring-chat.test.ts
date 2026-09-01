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
    expect(memory.writes.join("")).toContain("hard proposal range for INSERT support.follow_up_tasks");
    expect(memory.writes.join("")).not.toContain("runner> SET PROPOSAL RANGE");
    expect(memory.writes.join("")).not.toContain("runner> Action: INSERT");
    expect(memory.setStatus).toHaveBeenCalledWith("Interpreting the reviewed range");
    expect(memory.clearStatus).toHaveBeenCalled();
    expect(memory.writes.join("")).not.toContain("runner> Completed");
  });

  it("keeps interpreted decisions in the model conversation and reduces Runner to one verification checkpoint", async () => {
    const memory = memoryIo({ reads: [""] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    const answer = await chat.actionPrompter.text(
      "Press Enter to accept, or describe what should change",
      {
        defaultValue: "yes",
        title: "CONFIRM PROPOSAL RANGE",
        context: [
          "Operator answer: Between five minutes and two hours.",
          "Runner-validated interpretation: estimated_minutes: 5 through 120",
          "Where enforced: every INSERT support.follow_up_tasks proposal; values outside this range are refused before approval.",
          "Model rationale: Two hours converts to 120 minutes.",
          "Authority granted: no | source database changed: no",
          "Action: INSERT support.follow_up_tasks",
        ],
      },
    );

    expect(answer).toBe("yes");
    const transcript = memory.writes.join("");
    expect(transcript).toContain("model> I interpreted that as estimated_minutes: 5 through 120.");
    expect(transcript).toContain("Press Enter to use it, or tell me what should change.");
    expect(transcript).toContain("✓ Runner verified");
    expect(transcript).toContain("Hard range: INSERT support.follow_up_tasks");
    expect(transcript).not.toContain("runner> Operator answer:");
    expect(transcript).not.toContain("runner> CONFIRM PROPOSAL RANGE");
    expect(transcript).not.toContain("Model rationale:");
    expect(memory.prompts).toEqual(["you> [yes] "]);
  });

  it("renders routine Read handoffs as status checkpoints rather than new chat turns", () => {
    const memory = memoryIo();
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    chat.session.present?.("READ REVIEW COMPLETE - NOT ACTIVE", [
      "Read Boundary: reviewed_staging",
      "Next: continue this same job into Action Boundary decisions.",
      "EXPLORE OFF | PROPOSE OFF | APPROVE OFF | APPLY OFF",
      "Source database changed: no",
    ], "success");

    const transcript = memory.writes.join("");
    expect(transcript).toContain("✓ Read draft saved");
    expect(transcript).toContain("reviewed_staging · not active · source unchanged");
    expect(transcript).not.toContain("runner> READ REVIEW COMPLETE");
  });

  it("lets mixed model context finish before a quiet Runner checkpoint", async () => {
    const memory = memoryIo({ choices: ["yes"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    await chat.session.chooseOption?.(
      "USE THE INTERPRETATION",
      [
        { value: "yes", label: "Use it" },
        { value: "no", label: "Back" },
      ],
      {
        context: [
          "Validated interpretation",
          "Exact reviewed identifiers only.",
          "Model rationale: The requested label maps uniquely to support_tickets.",
        ],
      },
    );

    const transcript = memory.writes.join("");
    const modelIndex = transcript.indexOf("model> The requested label maps uniquely to support_tickets.");
    const checkpointIndex = transcript.indexOf("\u2713 Validated interpretation");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(checkpointIndex).toBeGreaterThan(modelIndex);
    expect(transcript).not.toContain("runner> Validated interpretation");
  });

  it("keeps model-assisted policy review in the conversation and hides the manual policy table", async () => {
    const memory = memoryIo({ reads: [""] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    const answer = await chat.actionPrompter.text(
      "Press Enter to accept, or describe what should change",
      {
        defaultValue: "yes",
        title: "CONFIRM AUTO-APPROVAL POLICY",
        conversation: {
          modelLines: [
            "I interpreted your auto-approval policy as:",
            "- estimated_minutes: <= 30",
            "- trusted tenant + principal: at most 3 approvals per 1 day",
            "Anything else requires human review.",
            "Press Enter to use it, or describe what should change.",
          ],
          checkpoint: {
            title: "Runner verified",
            lines: [
              "2 exact conditions stay inside the hard proposal envelope",
              "Disabled policy draft · approval off · apply off · source unchanged",
            ],
            tone: "success",
          },
        },
        context: [
          "Target: INSERT support.follow_up_tasks",
          "+--------------------+--------------------+",
          "| Field or scope     | Hard envelope      |",
          "+--------------------+--------------------+",
        ],
      },
    );

    expect(answer).toBe("yes");
    const transcript = memory.writes.join("");
    const modelIndex = transcript.indexOf("model> I interpreted your auto-approval policy as:");
    const checkpointIndex = transcript.indexOf("✓ Runner verified");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(checkpointIndex).toBeGreaterThan(modelIndex);
    expect(transcript).not.toContain("runner> CONFIRM AUTO-APPROVAL POLICY");
    expect(transcript).not.toContain("Field or scope");
    expect(memory.prompts).toEqual(["you> [yes] "]);
  });

  it("shows retained exact validation through /details without consuming the operator answer", async () => {
    const memory = memoryIo({ reads: ["/details", "Between five and thirty minutes."] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    chat.rememberDetails("Validated Action policy", [
      "Target: INSERT support.refund_requests",
      "Trusted tenant + principal: at most 1 approval per rolling 15 days",
      "Approval authority: disabled",
    ]);

    const answer = await chat.actionPrompter.text(
      "What policy should apply?",
      { title: "DESCRIBE THE AUTO-APPROVAL RULE" },
    );

    expect(answer).toBe("Between five and thirty minutes.");
    expect(memory.prompts).toEqual(["you> ", "you> "]);
    const transcript = memory.writes.join("");
    expect(transcript).toContain("DETAILS - Validated Action policy");
    expect(transcript).toContain("at most 1 approval per rolling 15 days");
    expect(transcript).toContain("Type /details at a you> prompt");
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
    chat.providerStream({ phase: "tool_delta", characters: 64 });
    chat.providerStream({ phase: "completed" });
    await chat.streamModel(["I drafted one reviewed read plan.", "- support.tickets: count(*)"]);
    await chat.streamCheckpoint("Runner verified", [
      "The complete draft passed exact identifier and grammar checks.",
      "No authority is active.",
    ], "success");

    const streamed = memory.writes.slice(initialWrites).join("");
    expect(memory.writes.slice(initialWrites).length).toBeGreaterThan(10);
    expect(streamed.match(/model>/gu)).toHaveLength(1);
    expect(streamed).toContain("✓ Runner verified");
    expect(streamed).not.toContain("runner>");
    expect(streamed).toContain("support.tickets: count(*)");
    expect(streamed).not.toContain("submit_boundary_draft");
    expect(memory.setStatus).toHaveBeenCalledWith(
      "openai[gpt-5.6-luna] is responding... 64 characters received; Runner has not accepted them",
    );
    expect(memory.setStatus).toHaveBeenLastCalledWith("Runner is validating the complete streamed draft...");
  });
});

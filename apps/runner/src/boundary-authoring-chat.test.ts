import { describe, expect, it, vi } from "vitest";
import {
  createBoundaryAuthoringChat,
} from "./boundary-authoring-chat.js";
import type { AnalyticsShellIo } from "./analytics-shell.js";

function memoryIo(input: {
  reads?: Array<string | undefined>;
  choices?: Array<string | undefined>;
  columns?: number | (() => number);
} = {}) {
  const writes: string[] = [];
  const prompts: string[] = [];
  const choices: Array<{ title: string; message: string; initialValue?: string; labels: string[] }> = [];
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
    readConversation: async (prompt) => {
      prompts.push(prompt);
      return reads.shift();
    },
    choose: async (choice) => {
      choices.push({
        title: choice.title,
        message: choice.message,
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
    columns: () => typeof input.columns === "function"
      ? input.columns()
      : input.columns ?? 100,
    onInterrupt: () => () => undefined,
    close,
  };
  return { io, writes, prompts, choices, setStatus, clearStatus, close };
}

describe("Boundary authoring chat", () => {
  it("caps wide transcripts and keeps continuation text aligned below the role", () => {
    const memory = memoryIo({ columns: 220 });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    chat.model([
      "The validated telecom draft covers accounts, subscriptions, service lines, recent usage, invoices, payments, preferences, and support cases while trusted scope stays outside model arguments.",
    ]);

    const lines = memory.writes.join("").split("\n").filter(Boolean);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(116);
    expect(lines.some((line) => /^ {9}\S/u.test(line))).toBe(true);
  });

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
    expect(transcript).toContain("Boundary drafting · openai[gpt-5.6-luna]");
    expect(transcript).not.toContain("runner> BOUNDARY DRAFTING");
    expect(transcript).not.toContain("runner> SET UP ONE AGENT JOB");
    expect(transcript).not.toContain("runner> What job are you giving this agent?");
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
        labels: [
          "Allow this exact step",
          "View exact Runner details",
          "Not now; keep authority unchanged",
        ],
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
    expect(memory.writes.join("")).not.toContain("runner> Permission request");
    expect(memory.choices[0]?.message).toContain("Activate \"reviewed_support\" exactly as shown now?");
    for (const choice of memory.choices) {
      expect(choice.message).not.toMatch(/[\r\n]/u);
    }
  });

  it("changes the selected model without printing a redundant checkpoint", () => {
    const memory = memoryIo();
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    chat.setModel("openai[gpt-5.6-luna]");

    const transcript = memory.writes.join("");
    expect(transcript).not.toContain("Drafting model selected");
    expect(transcript).not.toContain("openai[gpt-5.6-luna]");
  });

  it("lets the selected model explain a real permission and answer questions without becoming authority", async () => {
    const memory = memoryIo({
      choices: ["__ask_boundary_model__", "yes"],
      reads: ["Why does this need a separate activation?"],
    });
    const chat = createBoundaryAuthoringChat({
      io: memory.io,
      modelLabel: "openai[gpt-5.6-luna]",
      color: false,
    });
    const guide = vi.fn(async (input: { operatorQuestion?: string }) => input.operatorQuestion
      ? "Because this is the point where a reviewed draft becomes agent-readable authority. Runner will still require the exact unchanged permission."
      : "The Read draft is reviewed but still unavailable to the agent. Would you like Runner to activate this exact Read authority now?");
    chat.setPermissionGuide?.(guide);

    await expect(chat.session.confirmActivation?.(
      'Activate "reviewed_support" for local read-only Explore?',
      { context: ["READ BOUNDARY AUTHORITY", "3 reviewed tables; minimum cohort 5"] },
    )).resolves.toBe(true);

    expect(guide).toHaveBeenCalledTimes(2);
    expect(guide).toHaveBeenNthCalledWith(1, expect.objectContaining({
      prompt: expect.stringContaining('Activate "reviewed_support"'),
    }));
    expect(guide.mock.calls[0]?.[0]).not.toHaveProperty("operatorQuestion");
    expect(guide).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operatorQuestion: "Why does this need a separate activation?",
    }));
    expect(memory.choices).toHaveLength(2);
    for (const choice of memory.choices) {
      expect(choice.initialValue).toBe("no");
      expect(choice.labels).toEqual([
        "Allow this exact step",
        "Ask the model before deciding",
        "View exact Runner details",
        "Not now; keep authority unchanged",
      ]);
    }
    const transcript = memory.writes.join("");
    expect(transcript).toContain("model> The Read draft is reviewed");
    expect(transcript).toContain("you> Ask the model before deciding");
    expect(transcript).toContain("model> Because this is the point");
    expect(transcript).toContain("you> Allow this exact step");
    expect(transcript).not.toContain("runner> Permission request");
  });

  it("keeps an unavailable automatic narration out of the authority flow", async () => {
    const memory = memoryIo({ choices: ["yes"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    chat.setPermissionGuide?.(vi.fn(async () => undefined));

    await expect(chat.session.confirmActivation?.(
      'Activate "reviewed_support" for local read-only Explore?',
      { context: ["READ BOUNDARY AUTHORITY", "3 reviewed tables"] },
    )).resolves.toBe(true);

    const transcript = memory.writes.join("");
    expect(transcript).toContain("you> Allow this exact step");
    expect(transcript).not.toContain("Model explanation unavailable");
  });

  it("shows a compact Read dependency handoff after the Action draft is rehearsed", async () => {
    const memory = memoryIo();
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    await chat.streamRunner("NEXT AUTHORITY REVIEW - READ BOUNDARY", [
      "Read Boundary: reviewed_staging",
      "The job draft is complete. Review the exact Read authority now; activation remains your decision.",
      "After Read activation, Runner opens each rehearsed Action Boundary revision for its own separate confirmation.",
    ]);

    const transcript = memory.writes.join("");
    const compact = transcript.replace(/\s+/gu, " ");
    expect(compact).toContain("Action draft saved; Read dependency needs review");
    expect(compact).toContain("Read and Action activation remain separate decisions");
    expect(compact).not.toContain("The job draft is complete");
  });

  it("presents model-interpreted business questions in chat and uses a spinner only during work", async () => {
    const memory = memoryIo({ reads: ["between five minutes and two hours"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    const answer = await chat.actionPrompter.text(
      "What is the smallest and largest duration the agent may propose?",
      {
        title: "SET PROPOSAL RANGE",
        conversation: {
          modelLines: [
            "What is the smallest and largest duration the agent may propose?",
            "This is the hard proposal range for INSERT support.follow_up_tasks. Auto-approval can be narrower.",
          ],
        },
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

  it("never labels a deterministic fallback question as model output", async () => {
    const memory = memoryIo({ reads: ["between five and thirty"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    await expect(chat.actionPrompter.text(
      "What is the reviewed range?",
      {
        title: "SET PROPOSAL RANGE",
        context: ["The provider narration failed; Runner still needs this exact bound."],
      },
    )).resolves.toBe("between five and thirty");

    const transcript = memory.writes.join("");
    expect(transcript).toContain("runner> SET PROPOSAL RANGE");
    expect(transcript).toContain("runner> What is the reviewed range?");
    expect(transcript).not.toContain("model>");
  });

  it("keeps interpreted decisions in the model conversation and reduces Runner to one verification checkpoint", async () => {
    const memory = memoryIo({ reads: [""] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    const answer = await chat.actionPrompter.text(
      "Press Enter to accept, or describe what should change",
      {
        defaultValue: "yes",
        title: "CONFIRM PROPOSAL RANGE",
        conversation: {
          modelLines: [
            "I interpreted that as estimated_minutes: 5 through 120.",
            "Press Enter to use it, or tell me what should change.",
          ],
        },
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
    expect(transcript).not.toContain("✓ Runner verified");
    expect(transcript).not.toContain("runner> Operator answer:");
    expect(transcript).not.toContain("runner> CONFIRM PROPOSAL RANGE");
    expect(transcript).not.toContain("Model rationale:");
    expect(memory.prompts).toEqual(["you> [yes] "]);
  });

  it("keeps routine Read handoffs quiet and makes their exact record available through /details", async () => {
    const memory = memoryIo({ reads: ["/details", "continue"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    chat.session.present?.("READ REVIEW COMPLETE - NOT ACTIVE", [
      "Read Boundary: reviewed_staging",
      "Next: continue this same job into Action Boundary decisions.",
      "EXPLORE OFF | PROPOSE OFF | APPROVE OFF | APPLY OFF",
      "Source database changed: no",
    ], "success");

    await expect(chat.actionPrompter.text("What should happen next?", {
      conversation: { modelLines: ["The Read draft is ready. What would you like to do next?"] },
    })).resolves.toBe("continue");

    const transcript = memory.writes.join("");
    expect(transcript).not.toContain("✓ Read draft saved");
    expect(transcript).not.toContain("runner> READ REVIEW COMPLETE");
    expect(transcript).toContain("RUNNER DETAILS");
    expect(transcript).toContain("READ REVIEW COMPLETE - NOT ACTIVE");
    expect(transcript).toContain("reviewed_staging");
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
    expect(transcript).toContain("RUNNER DETAILS");
    expect(transcript).toContain("Validated Action policy");
    expect(transcript).toContain("at most 1 approval per rolling 15 days");
    expect(transcript).toContain("No model request, authority change, source query, or source write occurred.");
  });

  it("keeps incomplete and unknown slash commands out of business-policy answers", async () => {
    const memory = memoryIo({ reads: ["/d", "/de", "/unknown", "Use the existing reviewed policy."] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    chat.rememberDetails("Pending policy", ["Target: UPDATE telecom.billing_preferences"]);

    const answer = await chat.actionPrompter.text("What should change?", {
      conversation: { modelLines: ["What should change in this disabled policy?"] },
    });

    expect(answer).toBe("Use the existing reviewed policy.");
    expect(memory.prompts).toHaveLength(4);
    const transcript = memory.writes.join("");
    expect(transcript).toContain("Incomplete command: /d");
    expect(transcript).toContain("Matches: /details, /diff");
    expect(transcript).toContain("RUNNER DETAILS");
    expect(transcript).toContain("Unknown command: /unknown");
    expect(transcript).toContain("The pending question and disabled draft are unchanged.");
  });

  it("offers local diff and exact records without adding a model turn", async () => {
    const memory = memoryIo({ reads: ["/diff", "/exact", "continue"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    chat.rememberDetails("Validated combined draft", [
      "Boundary: reviewed_staging",
      "Action: INSERT support.refund_requests",
      "Agent supplies: amount, reason, method",
      "Approval: disabled deterministic policy",
      "Source database changed: no",
      "Exact fingerprint: sha256:operator-only",
    ]);

    await expect(chat.actionPrompter.text("What should happen next?", {
      conversation: { modelLines: ["The disabled drafts are ready. What would you like to do next?"] },
    })).resolves.toBe("continue");

    const transcript = memory.writes.join("");
    expect(transcript).toContain("LATEST REVIEWED CHANGE");
    expect(transcript).toContain("RUNNER DETAILS");
    expect(transcript).toContain("Agent supplies: amount, reason, method");
    expect(transcript).toContain("Exact fingerprint: sha256:operator-only");
    expect(transcript.match(/model>/gu)).toHaveLength(1);
    expect(memory.prompts).toHaveLength(3);
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

  it("renders a safe Markdown subset in model turns without exposing delimiters", () => {
    const memory = memoryIo();
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: true });

    chat.model([
      "## Reviewed proposal",
      "The **disabled proposal** constrains `amount`; *review it* before continuing.",
      "- `amount` stays between the reviewed bounds",
      "The stale-row guard is selected. ??Which column detects stale proposals?",
      "??**What is the smallest and largest amount the agent may propose?**",
      "?What exact rolling window should apply?",
      "Escaped \\**markers\\** remain literal.",
    ]);

    const transcript = memory.writes.join("");
    const plain = transcript.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    expect(plain).toContain("The disabled proposal constrains amount; review it before continuing.");
    expect(plain).toContain("Reviewed proposal");
    expect(plain).toContain("- amount stays between the reviewed bounds");
    expect(plain).toContain("The stale-row guard is selected. Which column detects stale proposals?");
    expect(plain).not.toContain("??Which column");
    expect(plain).not.toContain("## Reviewed proposal");
    expect(plain).toContain("Escaped **markers** remain literal.");
    expect(plain).toContain("What is the smallest and largest amount the agent may propose?");
    expect(plain).not.toContain("?What is the smallest");
    expect(plain).not.toContain("??What is the smallest");
    expect(plain).toContain("What exact rolling window should apply?");
    expect(plain).not.toContain("?What exact rolling window");
    expect(plain).not.toContain("`amount`");
    expect(plain).not.toContain("**disabled proposal**");
    expect(transcript).toMatch(/\u001b\[[0-9;]+mdisabled proposal\u001b\[0m/u);
    expect(transcript).toMatch(/\u001b\[[0-9;]+mamount\u001b\[0m/u);
    expect(transcript).toMatch(/\u001b\[[0-9;]+mreview it\u001b\[0m/u);
  });

  it("renders generated Action DSL as a highlighted, indented terminal artifact", async () => {
    const memory = memoryIo({ columns: () => 72 });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: true });
    const dsl = [
      "CREATE CAPABILITY refund_request.propose_insert_refund_requests",
      "ARG amount NUMBER REQUIRED MIN 0.01 MAX 25",
      "ON support_ops.refund_requests",
      "END",
    ].join("\n");

    await chat.actionPrompter.syntax?.(
      "GENERATED ACTION DSL",
      dsl,
      "synapsor-dsl",
      ["Authority: proposal_only", "Writeback: none"],
    );

    const transcript = memory.writes.join("");
    const plain = transcript.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    expect(plain).toContain("+-- GENERATED ACTION DSL");
    expect(plain).toContain("|   ARG amount NUMBER REQUIRED MIN 0.01 MAX 25");
    expect(plain).toContain("Authority: proposal_only");
    expect(transcript).toContain("\u001b[1;36mCREATE\u001b[0m");
    expect(transcript).toContain("\u001b[1;34msupport_ops.refund_requests\u001b[0m");
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
    expect(memory.writes.slice(initialWrites).length).toBeGreaterThan(5);
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

  it("wraps every retained role and detail line to the live terminal width", async () => {
    let columns = 46;
    const memory = memoryIo({ columns: () => columns });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    chat.model([
      "A long model explanation stays inside the terminal and continuation text aligns under the model content.",
    ]);
    columns = 58;
    chat.runner("REFUSAL", [
      "A later Runner explanation uses the resized terminal width and never begins a wrapped continuation at column zero.",
    ], "danger");
    chat.rememberDetails("EXACT REVIEW", [
      "Reviewed relationship: customer_accounts_support_tickets_interactions_messages",
    ]);
    chat.showDetails();

    const plain = memory.writes.join("").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    for (const line of plain.split("\n")) {
      expect(Array.from(line).length).toBeLessThanOrEqual(58);
    }
    const modelLines = plain.split("\n").filter((line) =>
      line.includes("A long model") || /^\s{9,}\S/u.test(line));
    expect(modelLines.length).toBeGreaterThan(1);
    expect(modelLines.slice(1)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\s{9,}\S/u),
    ]));
  });
});

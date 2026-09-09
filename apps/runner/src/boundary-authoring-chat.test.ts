import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import {
  createBoundaryAuthoringChat,
} from "./boundary-authoring-chat.js";
import { createTerminalAnalyticsShellIo, type AnalyticsShellIo } from "./analytics-shell.js";
import { AskError, askToolSurfaceDigest, resolveAskProviderConfiguration, runAskProviderTurn } from "./model-ask.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { readBoundaryReviewSections } from "./read-boundary-review-view.js";
import { terminalTheme } from "./boundary-cli-picker.js";

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
  it("retains the current phase in provider status and restores nested progress context", async () => {
    const memory = memoryIo();
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    try {
      await chat.progress("Preparing action 1 of 2", async () => {
        for (const phase of ["started", "tool_started", "tool_delta", "completed"] as const) {
          chat.providerStream({ phase, characters: 64 });
          expect(memory.setStatus.mock.lastCall?.[0]).toMatch(/^Preparing action 1 of 2 · /u);
        }
        await chat.progress("Checking attached rules", async () => {
          chat.providerStream({ phase: "started" });
          expect(memory.setStatus.mock.lastCall?.[0]).toMatch(/^Checking attached rules · /u);
        });
        expect(memory.setStatus).toHaveBeenLastCalledWith("Preparing action 1 of 2");
        chat.providerStream({ phase: "started" });
        expect(memory.setStatus.mock.lastCall?.[0]).toMatch(/^Preparing action 1 of 2 · /u);
      });
      expect(memory.clearStatus).toHaveBeenCalled();
      await chat.progress("Preparing action 2 of 2", async () => {
        chat.providerStream({ phase: "started" });
        expect(memory.setStatus.mock.lastCall?.[0]).toMatch(/^Preparing action 2 of 2 · /u);
      });
    } finally { chat.close(); }
  });
  it.each([
    ["escape", "structured"], ["ctrl-c", "structured"], ["escape", "prose"], ["ctrl-c", "prose"],
  ])("aborts a real pending provider stream through terminal %s (%s) without a late tool or next turn", async (key, responseKind) => {
    let started!: () => void, disconnected!: () => void;
    const streaming = new Promise<void>((resolve) => { started = resolve; });
    const connectionClosed = new Promise<void>((resolve) => { disconnected = resolve; });
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: responseKind === "prose"
          ? { content: "Checking the reviewed draft. " }
          : { tool_calls: [{ index: 0, id: "partial", function: { name: "runner__inspect_draft", arguments: "{" } }] } }] })}\n\n`);
        response.on("close", disconnected);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test listener unavailable");
    const readable = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(value: boolean) { this.isRaw = value; } });
    const writable = Object.assign(new PassThrough(), { isTTY: true, columns: 110, rows: 30 });
    const output: string[] = [];
    writable.on("data", (chunk) => output.push(String(chunk)));
    const io = createTerminalAnalyticsShellIo({ readable, writable, terminal: true });
    const chat = createBoundaryAuthoringChat({ io, color: false });
    const tools = [{ name: "runner.inspect_draft", description: "Inspect disabled metadata", input_schema: { type: "object", properties: {} } }];
    const authorityDigest = askToolSurfaceDigest(tools), callTool = vi.fn();
    const configuration = resolveAskProviderConfiguration({ provider: "openai_compatible", model: "fixture", base_url: `http://127.0.0.1:${address.port}/v1`,
      authority_digest: authorityDigest, egress_acknowledged: true }, {}, new Date());
    try {
      const pending = chat.progress("Drafting", () => runAskProviderTurn({ configuration, tools, authorityDigest,
        question: "Prepare a disabled draft", history: [], signal: new AbortController().signal, conversationalAuthoring: true,
        gateway: { mode: "authoring", listTools: () => tools, callTool, close: async () => undefined },
        dependencies: { signal: chat.signal, onStream: (event) => {
          chat.providerStream({ ...event, operator_text: responseKind === "prose" });
          if (event.phase === (responseKind === "prose" ? "text_delta" : "tool_delta")) started();
        } },
      }));
      const refused = expect(pending).rejects.toMatchObject({ code: "ASK_CANCELLED" });
      await streaming;
      if (responseKind === "prose") {
        await vi.waitFor(() => expect(output.join("")).toContain("Checking the reviewed draft."));
      }
      expect(output.join("")).toContain("esc to interrupt");
      if (key === "escape") readable.emit("keypress", "\u001b", { name: "escape" });
      else readable.write("\u0003");
      await refused;
      await connectionClosed;
      expect(chat.signal?.aborted).toBe(true);
      expect(callTool).not.toHaveBeenCalled(); expect(requests).toBe(1);
      const next = vi.fn();
      await expect(chat.progress("Next outcome", next)).rejects.toMatchObject({ code: "ASK_CANCELLED" });
      expect(next).not.toHaveBeenCalled();
      expect(output.join("")).toContain("Cancelling");
    } finally {
      chat.close(); readable.destroy(); writable.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["composer", "readline"])("Ctrl-C settles the current literal %s prompt without aborting the next question", async (surface) => {
    const readable = Object.assign(new PassThrough(), surface === "composer"
      ? { isTTY: true, isRaw: false, setRawMode(value: boolean) { this.isRaw = value; } } : { isTTY: true });
    const writable = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
    const output: string[] = [];
    writable.on("data", (chunk) => output.push(String(chunk)));
    const io = createTerminalAnalyticsShellIo({ readable, writable, terminal: true });
    const chat = createBoundaryAuthoringChat({ io, color: false });
    try {
      const pending = chat.progress("Clarifying", () => chat.readLiteral!("Current exact answer"));
      await vi.waitFor(() => expect(output.join("")).toContain("Current exact answer"));
      readable.write("\u0003");
      await expect(pending).resolves.toBeUndefined();
      expect(chat.signal?.aborted).toBe(false);
      const next = chat.readLiteral!("Next exact answer");
      await vi.waitFor(() => expect(output.join("")).toContain("Next exact answer"));
      readable.write("Reviewed answer\r");
      await expect(next).resolves.toBe("Reviewed answer");
    } finally { chat.close(); readable.destroy(); writable.destroy(); }
  });

  it("awaits cancellation cleanup and isolates another chat and a newly resumed chat", async () => {
    const memory = memoryIo(), otherMemory = memoryIo();
    let interrupt!: () => void;
    const unregister = vi.fn();
    memory.io.onInterrupt = (handler) => { interrupt = handler; return unregister; };
    const chat = createBoundaryAuthoringChat({ io: memory.io }), other = createBoundaryAuthoringChat({ io: otherMemory.io });
    let release!: () => void, settled = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const pending = chat.progress("Waiting", () => held).finally(() => { settled = true; });
    const refused = expect(pending).rejects.toMatchObject({ code: "ASK_CANCELLED" });
    interrupt();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await other.progress("Independent", async () => "ready")).toBe("ready");
    release(); await refused;
    chat.close(); other.close();
    expect(unregister).toHaveBeenCalledOnce();
    const resumed = createBoundaryAuthoringChat({ io: memoryIo().io });
    expect(await resumed.progress("Resume", async () => "ready")).toBe("ready");
    expect(resumed.signal?.aborted).toBe(false);
    resumed.close();
  });

  it("keeps Escape at an operator clarification as a pause, without poisoning a new chat", async () => {
    const readable = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(value: boolean) { this.isRaw = value; } });
    const writable = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    writable.resume();
    const chat = createBoundaryAuthoringChat({ io: createTerminalAnalyticsShellIo({ readable, writable, terminal: true }) });
    try {
      const pending = chat.progress("Clarifying", async () => {
        const answer = await chat.readOperator!();
        if (answer === undefined) throw new Error("ACTION_RULE_MODEL_DRAFT_CANCELLED");
        return answer;
      });
      const refused = expect(pending).rejects.toThrow("ACTION_RULE_MODEL_DRAFT_CANCELLED");
      await new Promise<void>((resolve) => setImmediate(resolve));
      readable.emit("keypress", "\u001b", { name: "escape" });
      await refused;
    } finally { chat.close(); readable.destroy(); writable.destroy(); }
    const resumed = createBoundaryAuthoringChat({ io: memoryIo({ reads: ["Reviewed answer"] }).io });
    expect(await resumed.progress("New clarification", () => resumed.readOperator!())).toBe("Reviewed answer");
    resumed.close();
  });

  it("keeps the concrete writer blocker on the primary recovery menu without model narration", async () => {
    const memory = memoryIo({ choices: ["pause"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    const guide = vi.fn(); chat.setPermissionGuide!(guide);
    await chat.session.chooseOption!("Execution needs a deployment fix", [{ value: "pause", label: "Save and pause" }], {
      displayContext: true, context: ["Writer has extra access and lacks private row-lock permissions.", "Use a dedicated writer; authority records are preserved."],
    });
    expect(memory.choices[0]!.message).toContain("lacks private row-lock permissions");
    expect(memory.choices[0]!.message).toContain("Use a dedicated writer");
    expect(memory.choices[0]!.message).not.toContain("\n");
    expect(guide).not.toHaveBeenCalled(); chat.close();
  });
  it("renders exact Action facts once and leaves explanation optional", async () => {
    const memory = memoryIo({ choices: ["no"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    const guide = vi.fn(); chat.setPermissionGuide!(guide);
    await chat.session.confirmActivation!("Activate verified Action Boundary sample?", {
      context: ["Action  plan.change", "Limits  At most 10 overall and 3 per account in any rolling 24 hours"],
    });
    expect(guide).not.toHaveBeenCalled();
    expect(memory.writes.join("").match(/At most 10 overall/gu)).toHaveLength(1);
    expect(memory.choices[0]!.labels).toContain("Ask the model before deciding"); chat.close();
  });
  it.each([false, true])("opens named privacy evidence directly and keeps the pending gate after explanation failure=%s", async (fail) => {
    const memory = memoryIo({ reads: ["Which field was flagged? Don't change anything."],
      choices: ["__ask_boundary_model__", "privacy_details", "finish"] });
    const review = vi.fn(async () => undefined);
    memory.io.review = review;
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    const recordPolicy = vi.fn(async () => undefined);
    chat.setSourceAnswerRecorder!(recordPolicy);
    const exact = { title: "Exact revision", lines: ["sha256:unchanged"], sections: [
      { id: "privacy_findings", title: "Privacy findings and recorded meanings", lines: ["support_cases.updated_at: customer-facing date, checked; access unchanged."] },
    ] };
    const before = structuredClone(exact);
    const guide = vi.fn(async () => { if (fail) throw new AskError("ASK_PROVIDER_TIMEOUT", "Unavailable"); return "It is the support-case update date. Your recorded answer already addresses that naming hint."; });
    chat.setPermissionGuide!(guide);
    const result = await chat.session.chooseOption!("ACTIVATE READ BOUNDARY", [
      { value: "activate", label: "Activate this revision" }, { value: "privacy_details", label: "Inspect privacy findings" },
      { value: "details", label: "View exact details" }, { value: "finish", label: "Leave disabled" },
    ], { initialValue: "finish", explainOnRequest: true, exactDetails: exact,
      context: ["Readable information: support cases."], explanationContext: ["support_cases.updated_at is the exact checked date finding; no access change needed."] });
    expect(result).toBe("finish");
    expect(exact).toEqual(before);
    expect(guide).toHaveBeenCalledOnce();
    expect(recordPolicy).not.toHaveBeenCalled();
    expect(guide).toHaveBeenCalledWith(expect.objectContaining({ operatorQuestion: "Which field was flagged? Don't change anything.",
      explanationContext: ["support_cases.updated_at is the exact checked date finding; no access change needed."] }));
    expect(review).toHaveBeenCalledWith("EXACT REVIEW - READ ONLY", expect.arrayContaining([
      "Privacy findings and recorded meanings", ...exact.sections[0]!.lines,
    ]), undefined);
    expect(memory.choices).toHaveLength(3); // No resource/submenu hunt, same pending permission every time.
    expect(memory.choices.every((choice) => choice.initialValue === "finish")).toBe(true);
    chat.close();
  });
  it("opens grouped changes directly without permission framing or unsolicited model narration", async () => {
    const memory = memoryIo({ choices: ["details", "section:0", "back", "save"] });
    const review = vi.fn(async () => undefined);
    memory.io.review = review;
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    const guide = vi.fn(async () => "Unused narration");
    chat.setPermissionGuide!(guide);
    expect(await chat.session.chooseOption!("SAVE DISABLED PRIVACY REVISION", [
      { value: "save", label: "Save disabled revision" }, { value: "details", label: "View exact privacy changes" },
      { value: "back", label: "Keep current draft" },
    ], { initialValue: "back", reviewOnly: true, explainOnRequest: true, context: ["Two internal fields hidden. No new access."],
      exactDetails: { title: "Privacy changes", lines: ["Full exact record"], sections: [
        { id: "reductions", title: "Information hidden", lines: ["account.id: visible -> private"] },
      ] } })).toBe("save");
    expect(guide).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledOnce();
    expect(memory.choices.map((choice) => choice.title)).not.toContain("PERMISSION REQUIRED");
    expect(memory.choices.some((choice) => choice.labels.includes("Information hidden"))).toBe(true);
    chat.close();
  });

  it("still records business answers and changed rules during a permission question", async () => {
    const memory = memoryIo({ reads: ["Keep the date visible.", "/attach replacement.txt", "Use these revised rules."],
      choices: ["__ask_boundary_model__", "finish"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    const recordPolicy = vi.fn(async () => undefined);
    const attach = vi.fn(async () => true);
    chat.setSourceAnswerRecorder!(recordPolicy);
    chat.setSourceCommandHandler!(attach, () => true);
    expect(await chat.readOperator!()).toBe("Keep the date visible.");
    chat.setPermissionGuide!(async () => "The replacement still needs review. No authority changed.");
    expect(await chat.session.chooseOption!("ACTIVATE READ BOUNDARY", [
      { value: "activate", label: "Activate this revision" }, { value: "finish", label: "Leave disabled" },
    ], { initialValue: "finish", explainOnRequest: true })).toBe("finish");
    expect(recordPolicy.mock.calls).toEqual([["Keep the date visible."], ["Use these revised rules."]]);
    expect(attach).toHaveBeenCalledWith("/attach", "replacement.txt");
    chat.close();
  });
  it("passes complete logical lines to the pager for narrow and wide reflow", async () => {
    const memory = memoryIo({ columns: 46 });
    const review = vi.fn(async (_title: string, _lines: string[]) => undefined);
    memory.io.review = review;
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    const line = "Scope: " + "long reviewed field and scope information ".repeat(4);
    await chat.session.showReviewDetails!("Exact field", [line]);
    expect(review.mock.calls[0]![1]).toContain(line.trim());
    chat.close();
  });
  it("opens real complete field permissions in one pager after exactly three forward selections", async () => {
    const boundary: ExplorationBoundaryDraft = { schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed",
      deployment_profile: "staging", source: "local_postgres", compiler_version: "1.8.0", spec_version: "1.11.0",
      trusted_context: { provider: "environment", tenant_env: "PRIVATE_TENANT_ENV", principal_env: "PRIVATE_PRINCIPAL_ENV" },
      generation_lock_fingerprint: `sha256:${"a".repeat(64)}`, role_posture_fingerprint: `sha256:${"b".repeat(64)}`,
      budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [], pack: { name: "stockroom", resources: [
        { id: "stockroom.items", label: "Stockroom items", schema: "stockroom", table: "items", primary_key: "item_id",
          tenant_key: "tenant_id", principal_key: "principal_id",
          field_types: { item_id: "uuid", tenant_id: "uuid", principal_id: "uuid", c7: "integer", quantity: "integer", category: "text", product_name: "text", version: "integer" },
          field_metadata: { c7: { label: "Internal replenishment score" } },
          field_enums: { category: ["routine", "special-review", ...Array.from({ length: 25 }, (_, index) => `CLASS_${index}`)] },
          selectable_fields: ["c7", "quantity", "category", "product_name"], kept_out_fields: ["tenant_id", "principal_id"], model_withheld_fields: ["c7"],
          filterable_fields: { c7: ["lte"], category: ["eq", "in"] }, sortable_fields: ["c7"], groupable_fields: ["category"],
          aggregate_measures: ["c7"], aggregate_measure_functions: { c7: ["avg"] }, count_distinct_fields: ["c7"],
          time_bucket_fields: {}, relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true },
        { id: "stockroom.locations", schema: "stockroom", table: "locations", primary_key: "location_id", tenant_key: "tenant_id",
          field_types: { location_id: "uuid", location_name: "text", tenant_id: "uuid" }, field_enums: {},
          selectable_fields: ["location_name"], kept_out_fields: ["tenant_id"], filterable_fields: {}, sortable_fields: [], groupable_fields: [],
          aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {}, relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true },
      ] } };
    const digest = canonicalJsonDigest(boundary), original = structuredClone(boundary);
    const sections = readBoundaryReviewSections({ boundary, digest });
    const resourcesIndex = sections.findIndex((section) => section.id === "resources"), resources = sections[resourcesIndex]!;
    const forwardSelections = ["details", `section:${resourcesIndex}`, "section:0"];
    const memory = memoryIo({ choices: [...forwardSelections, "back", "back", "finish"], columns: 52 });
    const forwardMenus: typeof memory.choices = [];
    const review = vi.fn(async (_title: string, _lines: string[], _returnTo?: string) => {
      forwardMenus.push(...structuredClone(memory.choices));
      expect(memory.choices).toHaveLength(3);
      expect(boundary).toEqual(original);
      expect(canonicalJsonDigest(boundary)).toBe(digest);
    });
    memory.io.review = review;
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: true });
    const guide = vi.fn(async () => "Model must not run for inspection"), recordPolicy = vi.fn(async () => undefined);
    chat.setPermissionGuide!(guide);
    chat.setSourceAnswerRecorder!(recordPolicy);
    const exact = { title: "Exact Read Boundary review", lines: JSON.stringify(boundary, null, 2).split("\n"), sections };
    const beforeExact = structuredClone(exact);
    try {
      expect(await chat.session.chooseOption!("ACTIVATE READ BOUNDARY", [
        { value: "activate", label: "Activate this exact Read Boundary" },
        { value: "details", label: "View exact Read Boundary details" },
        { value: "finish", label: "Leave disabled" },
      ], { initialValue: "finish", explainOnRequest: true, context: [`Pending reviewed revision: ${digest}`], exactDetails: exact })).toBe("finish");
      expect(forwardSelections).toHaveLength(3);
      expect(forwardMenus.map((choice) => choice.title)).toEqual(["PERMISSION REQUIRED", exact.title, resources.title]);
      expect(forwardMenus[0]!.labels).toContain("View exact Read Boundary details");
      expect(forwardMenus[1]!.labels).toContain(resources.title);
      expect(forwardMenus[2]!.labels).toEqual(["Overview", ...resources.children!.map((resource) => resource.title), "Return"]);
      expect(review).toHaveBeenCalledOnce();
      expect(review.mock.calls[0]![0]).toBe("EXACT REVIEW - READ ONLY");
      expect(review.mock.calls[0]![2]).toBe(`${resources.title} menu`);
      const styled = review.mock.calls[0]![1], plain = styled.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""));
      expect(plain).toEqual(["Overview", ...resources.lines, "", "No model request, authority change, source query, or source write occurred."]);
      for (const resource of boundary.pack.resources) {
        for (const field of Object.keys(resource.field_types)) {
          expect(plain.some((line) => line === `Field: ${field}` || line.startsWith(`Field: ${field} (`))).toBe(true);
          expect(resources.children!.find((section) => section.id === resource.id)!.children!.some((section) => section.id === field)).toBe(true);
        }
      }
      expect(plain).toContain("Field: c7 (Internal replenishment score)");
      expect(plain).toContain("Model-invocable analysis: filter:lte, sort, measure:avg, distinct");
      const allowlist = plain.find((line) => line.startsWith("Reviewed value allowlist:") && line.includes('"routine"'))!;
      for (const value of boundary.pack.resources[0]!.field_enums.category!) expect(allowlist).toContain(JSON.stringify(value));
      const theme = terminalTheme(true, { brand: true });
      for (const [access, style] of [["MODEL RAW", theme.visible], ["RUNNER ONLY", theme.runnerOnly],
        ["KEPT OUT", theme.keptOut], ["NO RAW RETURN", theme.dim]] as const) {
        expect(styled).toContain(`${theme.dim("Raw access:")} ${style(access)}`);
        expect(style(access)).toMatch(/\u001b\[/u);
      }
      expect(memory.choices).toHaveLength(6);
      expect(memory.choices.at(-1)).toEqual(memory.choices[0]);
      expect(memory.prompts).toEqual([]);
      expect(guide).not.toHaveBeenCalled(); expect(recordPolicy).not.toHaveBeenCalled();
      expect(memory.writes.join("")).not.toMatch(/Field:|Model-invocable analysis:/u);
      expect(memory.writes.join("") + plain.join("\n")).not.toMatch(/"schema_version"|"generation_lock_fingerprint"|PRIVATE_TENANT_ENV|PRIVATE_PRINCIPAL_ENV/u);
      expect(exact).toEqual(beforeExact);
      expect(boundary).toEqual(original);
      expect(canonicalJsonDigest(boundary)).toBe(digest);
    } finally { chat.close(); }
  });
  it("browses resources and diagnostics without dumping JSON or changing the pending decision", async () => {
    const memory = memoryIo({ choices: ["details", "section:0", "section:1", "back", "section:2", "back", "activate"] });
    const reviews: string[] = [];
    memory.io.review = async (_title, lines) => { reviews.push(lines.join("\n")); };
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: true });
    chat.setPermissionGuide!(async (request) => { request.onFailure?.({ code: "NARRATION_VALIDATION_REJECTED", category: "Explanation failed validation",
      retryable: true, guidance: "Use local review", mismatch: "Explanation claimed authority enabled." }); return undefined; });
    const options = { initialValue: "finish", context: ["Pending customer Read activation"], exactDetails: {
      title: "Reviewed revision", lines: ["RAW_JSON_MUST_NOT_BE_DUMPED"], sections: [
        { id: "resources", title: "Resources", lines: ["1 resource"], children: [
          { id: "r17", title: "r17 | RUNNER ONLY", lines: ["Raw access: Runner only", "Model analysis: none"] },
        ] },
        { id: "json", title: "Raw JSON", lines: ["RAW_JSON_MUST_NOT_BE_DUMPED"] },
      ],
    } };
    expect(await chat.session.chooseOption!("ACTIVATE READ BOUNDARY", [
      { value: "activate", label: "Activate" }, { value: "details", label: "View exact details" }, { value: "finish", label: "Leave disabled" },
    ], options)).toBe("activate");
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toContain("Model analysis:");
    expect(reviews[1]).toContain("Explanation claimed authority enabled.");
    expect(memory.writes.join("") + reviews.join("\n")).not.toContain("RAW_JSON_MUST_NOT_BE_DUMPED");
    expect(options.exactDetails.lines).toEqual(["RAW_JSON_MUST_NOT_BE_DUMPED"]);
    chat.close();
  });
  it("keeps exact authority details independent of summary and failed explanations", async () => {
    const memory = memoryIo({ choices: ["details", "__ask_boundary_model__", "details", "__retry_boundary_explanation__", "activate"],
      reads: ["What fields and customer scope are enabled?"] });
    const reviews: string[] = [];
    memory.io.review = async (_title, lines) => { reviews.push(lines.join("\n")); };
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    const guide = vi.fn(async () => { throw new AskError("ASK_PROVIDER_TIMEOUT", "secret-token https://private.example/provider"); });
    chat.setPermissionGuide!(guide);
    const exact = ["MODEL: account_name", "RUNNER: version", "KEPT: private_note", "Scope: authenticated customer RLS", "Query limit: 1000", `Fingerprint: sha256:${"a".repeat(64)}`];
    const options = { initialValue: "finish", context: ["Readable information: account summary.", "This Read gate cannot execute changes."],
      exactDetails: { title: "Exact Read Boundary review", lines: exact } };
    await expect(chat.session.chooseOption!("ACTIVATE READ BOUNDARY", [
      { value: "activate", label: "Activate this exact Read Boundary" },
      { value: "details", label: "View exact Read Boundary details" },
      { value: "finish", label: "Keep Read Boundary disabled and finish" },
    ], options)).resolves.toBe("activate");
    expect(guide).toHaveBeenCalledTimes(3); // initial, explicit question, explicit retry; never details
    expect(reviews).toHaveLength(2);
    for (const review of reviews) for (const line of exact) expect(review).toContain(line);
    expect(reviews[1]).toContain("ASK_PROVIDER_TIMEOUT");
    expect(reviews[1]).toContain("Retry possible: yes");
    expect(reviews.join("\n") + memory.writes.join("")).not.toMatch(/secret-token|private.example/);
    expect(memory.writes.join("")).toContain("Readable information: account summary.");
    expect(memory.writes.join("")).toContain("LOCAL REVIEW SUMMARY");
    expect(options.exactDetails.lines).toEqual(exact);
    expect(memory.choices.every((choice) => choice.initialValue === "finish")).toBe(true);
    chat.close();
  });

  it("renders actual text deltas before completion, formats split markup, and drains before input", async () => {
    let columns = 64;
    const memory = memoryIo({ reads: ["Why?"], columns: () => columns });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: true });
    chat.providerStream({ phase: "started", operator_text: true });
    chat.providerStream({ phase: "text_delta", operator_text: true, text: "The **reviewed ", characters: 15 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(memory.writes.join("")).toContain("The ");
    expect(memory.prompts).toHaveLength(0);
    chat.providerStream({ phase: "text_delta", operator_text: true, text: "range** for `amount` is 10 through 500. " });
    columns = 48;
    chat.providerStream({ phase: "text_delta", operator_text: true, text: "Would you like to review the details?" });
    chat.providerStream({ phase: "tool_delta", text: '{"private":true}', characters: 16 });
    chat.providerStream({ phase: "completed", operator_text: true });
    await chat.streamModel(["The **reviewed range** for `amount` is 10 through 500. Would you like to review the details?"]);
    expect(await chat.readOperator!()).toBe("Why?");
    const transcript = memory.writes.join("");
    const plain = transcript.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    expect(plain.match(/model>/gu)).toHaveLength(1);
    expect(plain).not.toMatch(/\*\*|`amount`|private/);
    expect(transcript).toContain("\u001b[");
    expect(plain).toContain("details?\n");
    expect(Math.max(...plain.split("\n").map((line) => line.length))).toBeLessThanOrEqual(64);
    expect(memory.prompts).toHaveLength(1);
  });

  it("uses the available width in a wide terminal instead of stopping at column 116", () => {
    const memory = memoryIo({ columns: 220 });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    chat.model([
      "The validated telecom draft covers accounts, subscriptions, service lines, recent usage, invoices, payments, preferences, and support cases while trusted scope stays outside model arguments.",
    ]);

    const lines = memory.writes.join("").split("\n").filter(Boolean);
    expect(Math.max(...lines.map((line) => line.length))).toBeGreaterThan(116);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(220);
    expect(lines.filter((line) => line.includes("validated telecom draft"))).toHaveLength(1);
  });

  it("renders adjacent provider fragments as one model turn until the operator responds", async () => {
    const memory = memoryIo({ reads: ["Use version."] });
    const chat = createBoundaryAuthoringChat({
      io: memory.io,
      color: false,
      streamLineDelayMs: 1,
    });

    await chat.streamModel(["I validated the Read draft."]);
    await chat.streamModel(["One stale-row safeguard remains."]);
    await chat.actionPrompter.text("Which reviewed field detects stale proposals?", {
      conversation: { modelLines: ["Which reviewed field detects stale proposals?"] },
    });
    await chat.streamModel(["I interpreted that as version."]);

    const transcript = memory.writes.join("");
    expect(transcript.match(/model>/gu)).toHaveLength(2);
    expect(transcript).toContain("model> I validated the Read draft.");
    expect(transcript).toContain("       One stale-row safeguard remains.");
    expect(transcript).toContain("       Which reviewed field detects stale proposals?");
    expect(transcript).toContain("model> I interpreted that as version.");
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
    expect(memory.writes.join("")).toContain("RUNNER-VERIFIED ACTION AUTHORITY");
    expect(memory.writes.join("")).toContain("Proposal authority is currently disabled.");
    expect(memory.writes.join("")).not.toContain("runner> Permission request");
    expect(memory.choices[0]?.message).toContain("Activate \"reviewed_support\" exactly as shown now?");
    for (const choice of memory.choices) {
      expect(choice.message).not.toMatch(/[\r\n]/u);
    }
  });

  it("offers exact details inside a reviewed-decision picker instead of advertising an unusable slash command", async () => {
    const memory = memoryIo({ choices: ["__view_runner_details__", "yes"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    chat.rememberDetails("REVIEW USER/OWNER SCOPE", [
      "support.charges: column principal_id [low-confidence candidate]",
      "support.refunds: column principal_id [low-confidence candidate]",
      "Agent authority changed: no",
    ]);

    await expect(chat.session.confirm(
      "For trusted user scope, does principal_id store the authenticated principal ID?",
      {
        defaultValue: false,
        context: ["Default is No because schema names alone are not authorization proof."],
      },
    )).resolves.toBe(true);

    expect(memory.choices).toHaveLength(2);
    expect(memory.choices[0]?.labels).toEqual([
      "Yes, continue",
      "View exact Runner details",
      "No; go back",
    ]);
    const transcript = memory.writes.join("");
    expect(transcript).toContain("RUNNER DETAILS");
    expect(transcript).toContain("support.charges: column principal_id");
    expect(transcript).toContain("you> View exact Runner details");
    expect(transcript).toContain("you> Yes, continue");
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
      "Dependent Action drafts: 1",
      "The job draft is complete. Review the exact Read authority now; activation remains your decision.",
      "After Read activation, Runner opens each rehearsed Action Boundary revision for its own separate confirmation.",
    ]);

    const transcript = memory.writes.join("");
    const compact = transcript.replace(/\s+/gu, " ");
    expect(compact).toContain("Action draft saved; Read dependency needs review");
    expect(compact).toContain("Read and Action activation remain separate decisions");
    expect(compact).not.toContain("The job draft is complete");
  });

  it("does not invent an Action dependency when a read-only job explicitly has none", async () => {
    const memory = memoryIo();
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    await chat.streamRunner("NEXT AUTHORITY REVIEW - READ BOUNDARY", [
      "Read Boundary: reviewed_staging", "Dependent Action drafts: 0",
      "This read-only job has no Action Boundary draft. Declining keeps the reviewed Read draft disabled.",
    ]);
    const output = memory.writes.join("").replace(/\s+/gu, " ");
    expect(output).toContain("Read draft ready for activation review");
    expect(output).not.toMatch(/Action draft saved|rehearsed Action draft|Read dependency needs review/u);
    chat.close();
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

  it("restores the pending model question after /details", async () => {
    const question = "Which reviewed refund method should the disabled draft store?";
    const memory = memoryIo({ reads: ["/details", "original_payment"] });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    chat.rememberDetails("Validated refund target", [
      "Target: INSERT support.refund_requests",
      "Authority granted: no",
    ]);

    const answer = await chat.actionPrompter.text(question, {
      conversation: { modelLines: [question] },
    });

    expect(answer).toBe("original_payment");
    const transcript = memory.writes.join("");
    expect(transcript.match(new RegExp(question.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(2);
    expect(transcript.match(/model>/gu)).toHaveLength(1);
    expect(transcript).toContain(`Pending: ${question}`);
    expect(transcript.indexOf("RUNNER DETAILS")).toBeLessThan(transcript.lastIndexOf(question));
    expect(memory.prompts).toEqual(["you> ", "you> "]);
  });

  it("does not repeat a context heading inside the retained details panel", () => {
    const memory = memoryIo();
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });
    chat.rememberDetails("SET UP ONE AGENT JOB", [
      "SET UP ONE AGENT JOB",
      "SET UP ONE AGENT JOB",
      "Describe one reviewed job in ordinary language.",
    ]);

    chat.showDetails();

    const transcript = memory.writes.join("");
    expect(transcript.match(/SET UP ONE AGENT JOB/gu)).toHaveLength(1);
    expect(transcript).toContain("Describe one reviewed job in ordinary language.");
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

  it("offers local diff and exact records while preserving one model turn", async () => {
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
      "These are possible mappings. ??Which candidate",
      "identifies the authenticated owner?",
      "??**What is the smallest and largest amount the agent may propose?**",
      "?What exact rolling window should apply?",
      "The draft is ready. ❓Should I use it?",
      "The draft is ready. ⁇Should I activate it?",
      "Escaped \\**markers\\** remain literal.",
    ]);

    const transcript = memory.writes.join("");
    const plain = transcript.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    expect(plain).toContain("The disabled proposal constrains amount; review it before continuing.");
    expect(plain).toContain("Reviewed proposal");
    expect(plain).toContain("- amount stays between the reviewed bounds");
    expect(plain).toContain("The stale-row guard is selected. Which column detects stale proposals?");
    expect(plain).not.toContain("??Which column");
    expect(plain).toContain("These are possible mappings. Which candidate");
    expect(plain).not.toContain("??Which candidate");
    expect(plain).not.toContain("## Reviewed proposal");
    expect(plain).toContain("Escaped **markers** remain literal.");
    expect(plain).toContain("What is the smallest and largest amount the agent may propose?");
    expect(plain).not.toContain("?What is the smallest");
    expect(plain).not.toContain("??What is the smallest");
    expect(plain).toContain("What exact rolling window should apply?");
    expect(plain).not.toContain("?What exact rolling window");
    expect(plain).toContain("The draft is ready. Should I use it?");
    expect(plain).toContain("The draft is ready. Should I activate it?");
    expect(plain).not.toContain("❓");
    expect(plain).not.toContain("⁇");
    expect(plain).not.toContain("`amount`");
    expect(plain).not.toContain("**disabled proposal**");
    expect(transcript).toMatch(/\u001b\[[0-9;]+mdisabled proposal\u001b\[0m/u);
    expect(transcript).toMatch(/\u001b\[[0-9;]+mamount\u001b\[0m/u);
    expect(transcript).toMatch(/\u001b\[[0-9;]+mreview it\u001b\[0m/u);
  });

  it("restores flattened scope candidates as readable lines", () => {
    const memory = memoryIo({ columns: 240 });
    const chat = createBoundaryAuthoringChat({ io: memory.io, color: false });

    chat.model([
      "Which candidate owns support_ops.refund_requests??Candidate 1: column principal_id [low-confidence candidate]?Candidate 2: catalog-proven mandatory path refund_requests -> charges.principal_id?Answer with the candidate number or exact reviewed name, or say none.",
    ]);

    const transcript = memory.writes.join("");
    expect(transcript).toContain("Which candidate owns support_ops.refund_requests?");
    expect(transcript).toMatch(/\n\s+Candidate 1: column principal_id/u);
    expect(transcript).toMatch(/\n\s+Candidate 2: catalog-proven mandatory path/u);
    expect(transcript).toMatch(/\n\s+Answer with the candidate number/u);
    expect(transcript).not.toMatch(/\?Candidate|\?Answer/u);
    expect(transcript.match(/model>/gu)).toHaveLength(1);
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

import readlineCore from "node:readline";
import readline from "node:readline/promises";
import path from "node:path";
import type {
  Readable,
  Writable,
} from "node:stream";
import {
  analysisJson,
  renderRefusedAttempts,
  type AnalyticsAnalysis,
  redactPlanLiterals,
  renderAnalyticsTurn,
  safeTerminalText,
} from "./analytics-shell-render.js";
import type {
  AskTurnResult,
} from "./model-ask.js";
import type {
  AskAccessGuidance,
  ReviewedAskAccessSummary,
} from "./ask-access-summary.js";
import type {
  ProtectedQueryDraft,
  ProtectedQueryActivation,
} from "./protect-query.js";
import type {
  OperatorCompiledExploreEvidence,
} from "./explore-operator-evidence.js";
import { terminalTheme } from "./boundary-cli-picker.js";
import {
  TERMINAL_BOTTOM_PADDING,
  padTerminalBlock,
  padTerminalLine,
  terminalContentWidth,
} from "./terminal-layout.js";

const COMMANDS = [
  "/help",
  "/analyses",
  "/protect",
  "/details",
  "/attempts",
  "/access",
  "/access-workbench",
  "/clear",
  "/exit",
];

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  "/help": "List shell actions",
  "/analyses": "List recent protectable analyses",
  "/protect": "Protect the latest eligible analysis",
  "/details": "Show safe execution metadata",
  "/attempts": "Inspect refused model attempts",
  "/access": "Add or edit reviewed boundaries",
  "/access-workbench": "Open the visual access editor",
  "/clear": "Clear this model conversation",
  "/exit": "Close the analytics shell",
};

export function slashCommandSuggestions(line: string): string[] {
  if (!line.startsWith("/")) return [];
  const normalized = line.toLowerCase();
  return COMMANDS.filter((command) => command.startsWith(normalized));
}

export function renderSlashCommandMenu(line: string, color = false): string {
  const matches = slashCommandSuggestions(line);
  if (!line.startsWith("/")) return "";
  const theme = terminalTheme(color);
  if (!matches.length) {
    return `${theme.warning("No matching action.")} ${theme.key("/help")} lists all actions.`;
  }
  return [
    ...matches.map((command) =>
      `${theme.key(command.padEnd(20))} ${theme.dim(COMMAND_DESCRIPTIONS[command] ?? "")}`),
    theme.dim("Keep typing or press Tab to complete."),
  ].join("\n");
}

export type AnalyticsShellExitReason = "exit" | "access";

export type ShellAnalysisRecord = {
  token: string;
  expires_at: string;
  boundary_digest: `sha256:${string}`;
  normalized_plan: NonNullable<AnalyticsAnalysis["plan"]>;
  created_at?: string;
  answer_id?: string;
  evidence_bundle_id?: string;
  query_audit_handle?: string;
  outcome?: string;
  returned_rows_or_groups?: number;
  returned_cells?: number;
  suppressed_groups?: number;
  minimum_cohort_override?: {
    resource: string;
    minimum_cohort_size: number;
    confirmation: string;
  };
  description: string;
  suggested_capability: string;
};

export type AnalyticsShellIo = {
  read(prompt: string): Promise<string | undefined>;
  readWithEscape?(prompt: string): Promise<string | undefined>;
  write(value: string): void;
  setStatus?(value: string): void;
  clearStatus?(): void;
  isTerminal?(): boolean;
  columns(): number;
  onInterrupt(handler: () => void): () => void;
  close(): void;
};

export type AnalyticsShellInput = {
  projectRoot?: string;
  providerLabel: string;
  modelLabel?: string;
  boundaryLabel?: string;
  profileLabel: string;
  reviewedDataAreas: number;
  accessSummary?: ReviewedAskAccessSummary;
  operatorLabel?: string;
  verboseAttempts?: boolean;
  io: AnalyticsShellIo;
  ask(
    question: string,
    onProgress?: (phase: "provider" | "tool") => void,
  ): Promise<{
    turn: AskTurnResult;
    analyses: AnalyticsAnalysis[];
    answer_id: string;
    access_guidance?: AskAccessGuidance;
  }>;
  listAnalyses(): Promise<ShellAnalysisRecord[]>;
  protect(input: {
    reference: string;
    capabilityName: string;
    minimumCohortConfirmation?: string;
    minimumCohortConfirmed?: true;
    minimumCohortActor?: string;
  }): Promise<{
    draft: ProtectedQueryDraft;
    dsl?: string;
    contract?: Record<string, unknown>;
    tests?: Record<string, unknown>;
  }>;
  activateProtected?(input: {
    capabilityName: string;
    reviewedDigest: string;
    actor: string;
    minimumCohortConfirmed?: true;
  }): Promise<ProtectedQueryActivation>;
  inspectAnalysis?(input: {
    record: ShellAnalysisRecord;
  }): Promise<OperatorCompiledExploreEvidence>;
  openAccessEditor?(): Promise<{ workbenchUrl: string }>;
  clearConversation(): void;
  cancel(): boolean;
};

export async function runAnalyticsShell(
  input: AnalyticsShellInput,
): Promise<AnalyticsShellExitReason> {
  let current: CurrentAnalyticsAnswer | undefined;
  const liveEvidence = new Map<string, LiveAnalysisEvidence>();
  let requestActive = false;
  let lastIdleInterruptAt = 0;
  let exitReason: AnalyticsShellExitReason = "exit";
  const removeInterrupt = input.io.onInterrupt(() => {
    if (requestActive && input.cancel()) {
      lastIdleInterruptAt = 0;
      input.io.clearStatus?.();
      input.io.write("\nCancelling the active request...\n");
      return;
    }
    const now = Date.now();
    if (lastIdleInterruptAt > 0 && now - lastIdleInterruptAt <= 2_000) {
      input.io.write("\n");
      input.io.close();
      return;
    }
    lastIdleInterruptAt = now;
    input.io.write("\nPress Ctrl+C again or Ctrl+D to exit.\n");
  });
  input.io.write(renderAnalyticsShellBanner({
    providerLabel: input.providerLabel,
    modelLabel: input.modelLabel,
    boundaryLabel: input.boundaryLabel,
    profileLabel: input.profileLabel,
    reviewedDataAreas: input.reviewedDataAreas,
    accessSummary: input.accessSummary,
  }, input.io.isTerminal?.() === true && !("NO_COLOR" in process.env)));
  try {
    while (true) {
      const raw = await input.io.read(renderAnalyticsPrompt(
        input.io.isTerminal?.() === true && !("NO_COLOR" in process.env),
      ));
      if (raw === undefined) break;
      lastIdleInterruptAt = 0;
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("/")) {
        const action = await handleShellCommand(line, input, current, liveEvidence);
        if (action === "exit") break;
        if (action === "access") {
          exitReason = "access";
          break;
        }
        if (line === "/clear") current = undefined;
        continue;
      }
      requestActive = true;
      let progressPhase: "provider" | "tool" | undefined;
      try {
        const response = await input.ask(line, (phase) => {
          if (phase === progressPhase) return;
          progressPhase = phase;
          input.io.setStatus?.(phase === "provider"
            ? "Waiting for the provider..."
            : "Running a reviewed data tool...");
        });
        input.io.clearStatus?.();
        current = {
          question: line,
          turn: response.turn,
          analyses: response.analyses,
          answer_id: response.answer_id,
        };
        for (const analysis of response.analyses) {
          if (!analysis.reference) continue;
          liveEvidence.set(analysis.reference, {
            question: line,
            answerId: response.answer_id,
            analysis,
          });
        }
        while (liveEvidence.size > 32) {
          const oldest = liveEvidence.keys().next().value as string | undefined;
          if (!oldest) break;
          liveEvidence.delete(oldest);
        }
        input.io.write(renderAnalyticsTurn(
          response.turn,
          response.analyses,
          input.io.columns(),
          {
            ansi: input.io.isTerminal?.() === true,
            includeAttempts: input.verboseAttempts === true,
            attemptsHint: "Type /attempts to inspect.",
            accessGuidance: response.access_guidance,
          },
        ));
      } catch (error) {
        input.io.clearStatus?.();
        input.io.write(`${safeShellError(error)}\n\n`);
      } finally {
        input.io.clearStatus?.();
        requestActive = false;
      }
    }
  } finally {
    removeInterrupt();
    input.io.close();
  }
  return exitReason;
}

export function renderAnalyticsShellBanner(input: {
  providerLabel: string;
  modelLabel?: string;
  boundaryLabel?: string;
  profileLabel: string;
  reviewedDataAreas: number;
  accessSummary?: ReviewedAskAccessSummary;
}, color = false): string {
  const theme = terminalTheme(color);
  const tableCount = `${input.reviewedDataAreas} ${input.reviewedDataAreas === 1 ? "table" : "tables"}`;
  return [
    theme.title("Synapsor Analytics"),
    theme.success(`Scoped Explore active - read-only ${safeTerminalText(input.profileLabel)} access`),
    `Provider: ${theme.key(safeTerminalText(input.providerLabel))}`,
    ...(input.modelLabel ? [`Model: ${theme.key(safeTerminalText(input.modelLabel))}`] : []),
    `Reviewed access: ${theme.scope(safeTerminalText(input.boundaryLabel ?? "active boundary"))} ${theme.dim(`(${tableCount})`)}`,
    ...(input.accessSummary?.resources.length
      ? [
        theme.title("Can ask now"),
        ...input.accessSummary.resources.slice(0, 3).map((resource) =>
          `  ${theme.key(safeTerminalText(resource.label))}: ${theme.dim(safeTerminalText(resource.capabilities.join("; ")))}`),
        ...(input.accessSummary.resources.length > 3
          ? [`  ${theme.dim(`+${input.accessSummary.resources.length - 3} more reviewed tables`)}`]
          : []),
      ]
      : []),
    ...(input.accessSummary?.suggestions[0]
      ? [`Try: ${theme.scope(`"${safeTerminalText(input.accessSummary.suggestions[0])}"`)}`]
      : []),
    "Ask a question. /access manages boundaries; /help lists actions; Ctrl+D exits.",
    "",
  ].join("\n");
}

export function renderAnalyticsPrompt(color = false): string {
  const theme = terminalTheme(color);
  return `${theme.key("synapsor")}${theme.dim(">")} `;
}

export function createTerminalAnalyticsShellIo(input: {
  readable?: Readable;
  writable?: Writable;
  terminal?: boolean;
} = {}): AnalyticsShellIo {
  const readable = input.readable ?? process.stdin;
  const writable = input.writable ?? process.stdout;
  const terminal = input.terminal ?? Boolean((readable as NodeJS.ReadStream).isTTY);
  let interrupt: (() => void) | undefined;
  const rl = readline.createInterface({
    input: readable,
    output: writable,
    terminal,
    historySize: 100,
    removeHistoryDuplicates: true,
    completer: (line: string): [string[], string] => {
      const matches = COMMANDS.filter((command) => command.startsWith(line));
      return [matches.length ? matches : COMMANDS, line];
    },
  });
  rl.on("SIGINT", () => interrupt?.());
  let closed = false;
  let questionActive = false;
  let activePrompt = "";
  let slashMenuVisible = false;
  let slashMenuRenderQueued = false;
  let escapeEnabled = false;
  let escapeSubmitted = false;
  let statusTimer: NodeJS.Timeout | undefined;
  let statusValue = "";
  let statusFrame = 0;
  const statusFrames = ["-", "\\", "|", "/"];
  const terminalColumns = () => {
    const columns = (writable as NodeJS.WriteStream).columns;
    return typeof columns === "number" && columns > 0 ? columns : 100;
  };
  const renderedRows = (value: string) => value.split("\n").reduce((rows, line) => {
    const width = line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").length;
    return rows + Math.max(1, Math.ceil(width / terminalColumns()));
  }, 0);
  const writeBottomPadding = () => {
    if (!terminal || TERMINAL_BOTTOM_PADDING <= 0) return;
    writable.write("\r\n".repeat(TERMINAL_BOTTOM_PADDING));
  };
  const reserveBottomPadding = (cursorColumn: number) => {
    if (!terminal || TERMINAL_BOTTOM_PADDING <= 0) return;
    writeBottomPadding();
    readlineCore.moveCursor(writable, 0, -TERMINAL_BOTTOM_PADDING);
    readlineCore.cursorTo(writable, cursorColumn);
  };
  const redrawInputSurface = (menu: string) => {
    if (!terminal) return;
    const cursor = rl.getCursorPos();
    const inputRows = renderedRows(`${activePrompt}${rl.line}`);
    const displayedMenu = padTerminalBlock(menu);

    // Redraw the prompt and popup as one owned surface. Saving a cursor at the
    // terminal's bottom row and then painting below it can scroll that saved
    // position, leaving stale menu rows behind. Rebuilding the complete region
    // keeps the prompt and popup together even when output wraps or scrolls.
    readlineCore.cursorTo(writable, 0);
    if (cursor.rows > 0) readlineCore.moveCursor(writable, 0, -cursor.rows);
    readlineCore.clearScreenDown(writable);

    writable.write(`${activePrompt}${rl.line}`);
    if (menu) {
      writable.write(`\n${displayedMenu}`);
      slashMenuVisible = true;
    } else {
      slashMenuVisible = false;
    }

    const menuRows = menu ? renderedRows(displayedMenu) : 0;
    const inputRowsAfterCursor = Math.max(0, inputRows - cursor.rows - 1);
    writeBottomPadding();
    const rowsBackToCursor = menuRows
      + inputRowsAfterCursor
      + TERMINAL_BOTTOM_PADDING;
    readlineCore.cursorTo(writable, 0);
    if (rowsBackToCursor > 0) {
      readlineCore.moveCursor(writable, 0, -rowsBackToCursor);
    }
    readlineCore.cursorTo(writable, cursor.cols);
  };
  const clearSlashMenuWhileEditing = () => {
    if (!slashMenuVisible) return;
    redrawInputSurface("");
  };
  const renderSlashMenu = () => {
    if (!questionActive || closed) return;
    const line = rl.line;
    const menu = renderSlashCommandMenu(
      line,
      terminal && !("NO_COLOR" in process.env),
    );
    if (!menu && !slashMenuVisible) return;
    redrawInputSurface(menu);
  };
  const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
    if (!questionActive) return;
    if (key.name === "return" || key.name === "enter"
      || (key.ctrl && (key.name === "c" || key.name === "d"))) {
      clearSlashMenuWhileEditing();
      return;
    }
    if (key.name === "escape") {
      clearSlashMenuWhileEditing();
      if (escapeEnabled) {
        escapeSubmitted = true;
        rl.write(null, { ctrl: true, name: "u" });
        rl.write(null, { name: "return" });
      }
      return;
    }
    if (slashMenuRenderQueued) return;
    slashMenuRenderQueued = true;
    queueMicrotask(() => {
      slashMenuRenderQueued = false;
      renderSlashMenu();
    });
  };
  if (terminal) {
    readlineCore.emitKeypressEvents(readable as NodeJS.ReadStream);
    // Run before readline's own key handler. Enter must clear the transient
    // menu while the cursor is still on the input row; ordinary keys schedule
    // their redraw in a microtask after readline has updated rl.line.
    readable.prependListener("keypress", onKeypress);
  }
  const clearStatus = () => {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = undefined;
    }
    if (terminal && statusValue) writable.write("\r\u001b[2K");
    statusValue = "";
    statusFrame = 0;
  };
  const renderStatus = () => {
    if (!terminal || !statusValue) return;
    const frame = statusFrames[statusFrame % statusFrames.length];
    statusFrame += 1;
    writable.write(
      `\r\u001b[2K\u001b[2m${padTerminalLine(`${frame} ${statusValue}`)}\u001b[0m`,
    );
  };
  const readQuestion = async (
    prompt: string,
    allowEscape: boolean,
  ): Promise<string | undefined> => {
      if (closed) return undefined;
      try {
        activePrompt = terminal ? padTerminalBlock(prompt) : prompt;
        escapeEnabled = allowEscape;
        escapeSubmitted = false;
        questionActive = true;
        const answerPromise = rl.question(activePrompt);
        reserveBottomPadding(rl.getCursorPos().cols);
        const answer = await answerPromise;
        const escaped = escapeSubmitted;
        questionActive = false;
        slashMenuVisible = false;
        escapeEnabled = false;
        escapeSubmitted = false;
        activePrompt = "";
        return escaped ? undefined : answer;
      } catch {
        if (questionActive) clearSlashMenuWhileEditing();
        questionActive = false;
        escapeEnabled = false;
        escapeSubmitted = false;
        activePrompt = "";
        return undefined;
      }
  };
  return {
    read: (prompt) => readQuestion(prompt, false),
    readWithEscape: (prompt) => readQuestion(prompt, true),
    write: (value) => {
      writable.write(terminal ? padTerminalBlock(value) : value);
    },
    setStatus: (value) => {
      if (!terminal) return;
      statusValue = safeTerminalText(value);
      statusFrame = 0;
      renderStatus();
      if (!statusTimer) {
        statusTimer = setInterval(renderStatus, 120);
        statusTimer.unref();
      }
    },
    clearStatus,
    isTerminal: () => terminal,
    columns: () => {
      const columns = (writable as NodeJS.WriteStream).columns;
      return terminal
        ? terminalContentWidth(columns)
        : typeof columns === "number"
          ? columns
          : 100;
    },
    onInterrupt: (handler) => {
      interrupt = handler;
      return () => {
        if (interrupt === handler) interrupt = undefined;
      };
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (questionActive) clearSlashMenuWhileEditing();
      questionActive = false;
      activePrompt = "";
      if (terminal) readable.off("keypress", onKeypress);
      clearStatus();
      rl.close();
    },
  };
}

async function handleShellCommand(
  line: string,
  input: AnalyticsShellInput,
  current: CurrentAnalyticsAnswer | undefined,
  liveEvidence: Map<string, LiveAnalysisEvidence>,
): Promise<"continue" | AnalyticsShellExitReason> {
  if (line === "/exit") return "exit";
  if (line === "/help") {
    input.io.write([
      "",
      "Actions",
      "  /analyses                    List recent protectable analyses",
      "  /protect                     Protect the latest eligible analysis",
      "  /protect A2 as <name>        Protect one explicit analysis",
      "  /details [last|A2]           Show what the model requested and Runner executed",
      "  /details [last|A2] --sql     Include redacted operator-only SQL",
      "  /attempts                    Show refused attempts from the latest answer",
      "  /access                      Add or edit reviewed boundaries",
      "  /access-workbench            Open the visual access editor",
      "  /clear                       Clear this model conversation",
      "  /exit                        Close the shell",
      "  Ctrl+D                       Close the shell (Ctrl+C twice also exits)",
      "",
    ].join("\n"));
    return "continue";
  }
  if (line === "/clear") {
    input.clearConversation();
    input.io.write("Conversation cleared. Durable evidence and protected drafts were not deleted.\n\n");
    return "continue";
  }
  if (line === "/analyses") {
    await showAnalyses(input, current);
    return "continue";
  }
  if (line === "/details" || line.startsWith("/details ")) {
    await showDetails(line, input, current, liveEvidence);
    return "continue";
  }
  if (line === "/attempts") {
    input.io.write([
      ...renderRefusedAttempts(current?.analyses ?? []),
      "",
      "",
    ].join("\n"));
    return "continue";
  }
  if (line === "/access") {
    input.io.write([
      "",
      "Opening the terminal boundary editor.",
      "Existing active boundaries stay available. A reviewed activation adds or updates one boundary.",
      "After activation, this shell resumes with the same provider, model, and in-memory key.",
      "",
    ].join("\n"));
    return "access";
  }
  if (line === "/access-workbench" || line === "/access workbench") {
    if (!input.openAccessEditor) {
      input.io.write(
        "Boundary editing is unavailable in this shell. Run `synapsor-runner start` to reopen the local access review.\n\n",
      );
      return "continue";
    }
    const opened = await input.openAccessEditor();
    input.io.write([
      "",
      "Review, add, or edit Explore boundaries in the secured local Workbench:",
      opened.workbenchUrl,
      "",
      "Changes remain disabled until a human reviews and activates the new exact fingerprint.",
      "",
    ].join("\n"));
    return "continue";
  }
  if (line === "/protect" || line.startsWith("/protect ")) {
    await protectAnalysis(line, input, current);
    return "continue";
  }
  input.io.write("Unknown action. Type /help for the available actions.\n\n");
  return "continue";
}

async function showAnalyses(
  input: AnalyticsShellInput,
  current: CurrentAnalyticsAnswer | undefined,
): Promise<void> {
  const analyses = await input.listAnalyses();
  if (analyses.length === 0) {
    input.io.write("No unexpired protectable analyses are available yet.\n\n");
    return;
  }
  const currentReferences = new Set(current?.analyses.flatMap((analysis) =>
    analysis.reference ? [analysis.reference] : []) ?? []);
  const exampleReference = analyses[0]!.token;
  input.io.write([
    "",
    "Recent analyses",
    "",
    ...analyses.map((analysis) =>
      `${analysis.token.padEnd(4)} ${safeTerminalText(analysis.description)}${currentReferences.has(analysis.token) ? "  latest" : ""}`),
    "",
    `Use /protect, /protect ${exampleReference}, or /details ${exampleReference}.`,
    "",
  ].join("\n"));
}

async function showDetails(
  line: string,
  input: AnalyticsShellInput,
  current: CurrentAnalyticsAnswer | undefined,
  liveEvidence: Map<string, LiveAnalysisEvidence>,
): Promise<void> {
  const detailArguments = line.slice("/details".length).trim().split(/\s+/).filter(Boolean);
  const includeSql = detailArguments.includes("--sql");
  const requested = detailArguments.find((argument) => argument !== "--sql") ?? "last";
  const analyses = await input.listAnalyses();
  const selected = resolveAnalysisReference(requested, analyses, current);
  if (!selected) {
    input.io.write("That analysis is unavailable, expired, or ambiguous. Run /analyses.\n\n");
    return;
  }
  const live = liveEvidence.get(selected.token);
  const toolArguments = live?.analysis.arguments;
  const liveResult = live?.analysis.result;
  const resultSemantics = asRecord(asRecord(liveResult?.outcome).result);
  const returned = asRecord(resultSemantics.returned);
  const suppression = asRecord(resultSemantics.suppression);
  const freshness = asRecord(resultSemantics.freshness);
  const boundaryName = stringRecordValue(liveResult?.boundary_name)
    ?? stringRecordValue(toolArguments?.boundary)
    ?? "recorded reviewed boundary";
  let operatorInspection: OperatorCompiledExploreEvidence | undefined;
  let inspectionFailure: string | undefined;
  if (input.inspectAnalysis && selected.normalized_plan) {
    try {
      operatorInspection = await input.inspectAnalysis({ record: selected });
    } catch (error) {
      inspectionFailure = safeShellError(error);
    }
  }
  const modelRequest = toolArguments
    ? JSON.stringify(toolArguments, null, 2)
    : JSON.stringify({ plan: redactPlanLiterals(selected.normalized_plan) }, null, 2);
  input.io.write([
    "",
    `ANALYSIS ${safeTerminalText(selected.token)}`,
    "",
    "QUESTION",
    live
      ? safeTerminalText(live.question)
      : "Original question unavailable. The MCP host or an earlier local session supplied this typed plan; Runner does not infer the missing conversation.",
    "",
    "WHAT THE MODEL REQUESTED",
    live?.analysis.tool ?? "app.explore_data",
    safeTerminalText(modelRequest),
    "",
    "WHAT RUNNER EXECUTED",
    `Plan validated: ${live?.analysis.status === "refused" ? "no" : "yes"}`,
    `Boundary: ${safeTerminalText(operatorInspection?.boundary_name ?? boundaryName)}`,
    `Boundary fingerprint: ${selected.boundary_digest}`,
    `Trusted tenant scope: ${safeTerminalText(operatorInspection?.trusted_scope.tenant ?? "bound outside model arguments")}`,
    `Trusted principal scope: ${safeTerminalText(operatorInspection?.trusted_scope.principal ?? "bound outside model arguments or not required")}`,
    `Database role: ${operatorInspection ? "verified read-only before execution" : "verified by the recorded Explore execution"}`,
    `Transaction: ${safeTerminalText(operatorInspection?.transaction ?? stringRecordValue(freshness.snapshot_consistency) ?? "single_read_only_transaction")}`,
    "Normalized validated plan:",
    JSON.stringify(redactPlanLiterals(selected.normalized_plan), null, 2),
    "",
    "WHAT RUNNER RETURNED",
    `Outcome: ${selected.outcome ?? stringRecordValue(asRecord(liveResult?.outcome).status) ?? "ok"}`,
    `Source query executed: ${live?.analysis.status === "refused" ? "no" : "yes"}`,
    "Raw source rows exposed: no",
    `Bounded rows/groups: ${numberRecordValue(returned.rows_or_groups) ?? selected.returned_rows_or_groups ?? "unknown"}`,
    `Returned cells: ${numberRecordValue(returned.cells) ?? selected.returned_cells ?? "unknown"}`,
    `Returned bytes: ${numberRecordValue(returned.bytes) ?? "unknown"}`,
    `Suppressed groups: ${numberRecordValue(suppression.suppressed_groups) ?? selected.suppressed_groups ?? 0}`,
    `Evidence: ${selected.evidence_bundle_id ?? "unavailable"}`,
    `Query audit: ${selected.query_audit_handle ?? "unavailable"}`,
    `Protectable until: ${selected.expires_at}`,
    "Source database changed: no",
    ...(inspectionFailure ? ["", `Advanced inspection unavailable: ${safeTerminalText(inspectionFailure)}`] : []),
    ...(includeSql
      ? operatorInspection
        ? [
            "",
            "COMPILED DATABASE STATEMENT",
            "Operator diagnostic only. The model never received this SQL. Parameter values are redacted and this view is not persisted.",
            ...operatorInspection.statements.flatMap((statement, index) => [
              `Statement ${index + 1}${statement.period ? ` (${statement.period})` : ""} - ${operatorInspection!.engine}`,
              safeTerminalText(statement.statement),
              `Parameter types: ${statement.parameter_types.join(", ") || "none"}`,
              "Parameter values: redacted",
            ]),
          ]
        : ["", "Compiled SQL is unavailable because the active reviewed artifacts could not be inspected."]
      : ["", "Use /details --sql for the local operator-only parameterized statement."]),
    "",
  ].join("\n"));
}

async function protectAnalysis(
  line: string,
  input: AnalyticsShellInput,
  current: CurrentAnalyticsAnswer | undefined,
): Promise<void> {
  const theme = terminalTheme(
    input.io.isTerminal?.() === true && !("NO_COLOR" in process.env),
  );
  const parsed = parseProtectCommand(line);
  if (parsed.reference === "__invalid__") {
    input.io.write("Use /protect, /protect last as <capability-name>, or /protect A2 as <capability-name>.\n\n");
    return;
  }
  const analyses = await input.listAnalyses();
  let selected: ShellAnalysisRecord | undefined;
  if (parsed.reference && parsed.reference !== "last") {
    selected = analyses.find((analysis) => analysis.token === parsed.reference);
  } else {
    const currentReferences = current?.analyses.flatMap((analysis) =>
      analysis.reference ? [analysis.reference] : []) ?? [];
    const currentCandidates = currentReferences
      .map((reference) => analyses.find((analysis) => analysis.token === reference))
      .filter((analysis): analysis is ShellAnalysisRecord => analysis !== undefined);
    if (currentCandidates.length === 1) {
      selected = currentCandidates[0];
    } else if (currentCandidates.length > 1) {
      input.io.write([
        "",
        `This answer used ${currentCandidates.length} protectable analyses:`,
        "",
        ...currentCandidates.map((analysis, index) =>
          `${index + 1}. ${safeTerminalText(analysis.description)}  (${analysis.token})`),
        "",
      ].join("\n"));
      if (parsed.reference === "last") {
        input.io.write("`last` is ambiguous for this answer. Choose an explicit analysis reference.\n\n");
        return;
      }
      const choice = await input.io.read(`Choose an analysis [1-${currentCandidates.length}]: `);
      const index = Number(choice);
      selected = Number.isInteger(index) && index >= 1 && index <= currentCandidates.length
        ? currentCandidates[index - 1]
        : undefined;
    } else if (parsed.reference === "last" && analyses.length > 0) {
      selected = analyses[0];
    } else if (analyses.length > 0 && parsed.reference !== "last") {
      const previous = analyses[0]!;
      const confirmation = await readOperatorPrompt(input.io,
        `This answer did not run a new analysis. Protect the previous eligible analysis "${safeTerminalText(previous.description)}"? [y/N] `,
      );
      if (confirmation?.trim().toLowerCase() === "y") selected = previous;
    }
  }
  if (!selected) {
    input.io.write("No single eligible analysis was selected. Run /analyses and choose an explicit reference.\n\n");
    return;
  }
  const suggested = parsed.capabilityName ?? selected.suggested_capability;
  input.io.write([
    "",
    "Protect the latest analysis:",
    "",
    safeTerminalText(selected.description),
    "",
  ].join("\n"));
  const capabilityAnswer = parsed.capabilityName
    ? suggested
    : await readOperatorPrompt(input.io, `Capability name [${suggested}] [Esc Back]: `);
  if (capabilityAnswer === undefined) {
    input.io.write("Protect cancelled. No capability was created or activated.\n\n");
    return;
  }
  const capabilityInput = parsed.capabilityName
    ? suggested
    : capabilityAnswer.trim() || suggested;
  let minimumCohortConfirmed: true | undefined;
  let minimumCohortActor: string | undefined;
  if (selected.minimum_cohort_override) {
    const cohort = selected.minimum_cohort_override;
    input.io.write([
      "",
      `This analysis uses an explicit owner override: minimum cohort ${cohort.minimum_cohort_size}.`,
      ...(cohort.minimum_cohort_size === 1
        ? ["A value of 1 disables small-group suppression; groups of one can identify individuals."]
        : []),
      "Protecting it requires a separate recorded human re-confirmation.",
      "",
    ].join("\n"));
    const accepted = parseDefaultYes(await readOperatorPrompt(input.io,
      "Keep this explicitly lowered threshold in the protected capability? [Y/n] [Esc Back]: ",
    ));
    if (!accepted) {
      input.io.write("Protect cancelled. No capability was created or activated.\n\n");
      return;
    }
    minimumCohortConfirmed = true;
    minimumCohortActor = input.operatorLabel ?? "local-developer";
  }
  const protectedResult = await input.protect({
    reference: selected.token,
    capabilityName: capabilityInput,
    ...(minimumCohortConfirmed ? { minimumCohortConfirmed } : {}),
    ...(minimumCohortActor ? { minimumCohortActor } : {}),
  });
  const actor = input.operatorLabel ?? "local-developer";
  const selectedLiveAnalysis = current?.analyses.find((analysis) => analysis.reference === selected.token);
  input.io.write([
    "",
    theme.title("PROTECT REVIEW"),
    "",
    theme.focus(safeTerminalText(selected.description)),
    "",
    `${theme.dim("Capability:")} ${theme.scope(safeTerminalText(protectedResult.draft.capability))}`,
    `${theme.dim("Authority:")} ${theme.success("read-only")} ${theme.dim("- only this successful analysis is frozen")}`,
    ...protectedPlanReviewLines(selected, theme),
    "",
    theme.bold("Provenance"),
    `  ${theme.dim("Question:")} ${theme.value(selectedLiveAnalysis && current ? safeTerminalText(current.question) : "unavailable from this local session")}`,
    `  ${theme.dim("Model request:")} ${theme.key(selectedLiveAnalysis?.tool ?? "app.explore_data")}`,
    `  ${theme.dim("Runner plan:")} ${theme.value(safeTerminalText(selected.description))}`,
    `  ${theme.dim("Boundary fingerprint:")} ${theme.dim(selected.boundary_digest)}`,
    `  ${theme.dim("Evidence:")} ${theme.dim(selected.evidence_bundle_id ?? "unavailable")}`,
    `  ${theme.dim("Query audit:")} ${theme.dim(selected.query_audit_handle ?? "unavailable")}`,
    `  ${theme.dim("Inspect exact request and runtime checks:")} ${theme.key(`/details ${selected.token}`)}`,
    "",
    theme.bold("Generated"),
    `  ${theme.dim("DSL:")} ${theme.value(safeTerminalText(generatedArtifactDisplayPath(input.projectRoot, protectedResult.draft.dsl_path)))}`,
    `  ${theme.dim("Contract:")} ${theme.value(safeTerminalText(generatedArtifactDisplayPath(input.projectRoot, protectedResult.draft.contract_path)))}`,
    `  ${theme.dim("Tests:")} ${theme.value(safeTerminalText(generatedArtifactDisplayPath(input.projectRoot, protectedResult.draft.tests_path)))}`,
    "",
    `${theme.dim("Agent authority activated:")} ${theme.warning("no")}`,
    "",
  ].join("\n"));
  if (!input.activateProtected) {
    input.io.write("Activation is unavailable in this shell. The generated capability remains disabled.\n\n");
    return;
  }
  const accepted = parseDefaultYes(await readOperatorPrompt(input.io,
    `Activate this reviewed read capability as ${safeTerminalText(actor)}? [Y/n] [Esc Back]: `,
  ));
  if (!accepted) {
    input.io.write("Capability left disabled. The current Explore session is unchanged.\n\n");
    return;
  }
  const active = await input.activateProtected({
    capabilityName: protectedResult.draft.capability,
    reviewedDigest: protectedResult.draft.contract_digest,
    actor,
    ...(protectedResult.draft.minimum_cohort_override
      ? { minimumCohortConfirmed: true }
      : {}),
  });
  input.io.write([
    "",
    `Protected capability active: ${safeTerminalText(active.capability)}`,
    "The same read-only Explore session remains available.",
    "",
  ].join("\n"));
}

function generatedArtifactDisplayPath(
  projectRoot: string | undefined,
  artifactPath: string,
): string {
  return projectRoot ? path.resolve(projectRoot, artifactPath) : artifactPath;
}

type CurrentAnalyticsAnswer = {
  question: string;
  turn: AskTurnResult;
  analyses: AnalyticsAnalysis[];
  answer_id: string;
};

type LiveAnalysisEvidence = {
  question: string;
  answerId: string;
  analysis: AnalyticsAnalysis;
};

function parseDefaultYes(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}

async function readOperatorPrompt(
  io: AnalyticsShellIo,
  prompt: string,
): Promise<string | undefined> {
  return io.readWithEscape ? io.readWithEscape(prompt) : io.read(prompt);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringRecordValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberRecordValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function protectedPlanReviewLines(
  selected: ShellAnalysisRecord,
  theme: ReturnType<typeof terminalTheme>,
): string[] {
  const plan = selected.normalized_plan;
  if (!plan) return [];
  if (plan.kind === "rows") {
    return [
      `${theme.dim("Resource:")} ${theme.value(safeTerminalText(plan.resource))}`,
      `${theme.dim("Fields:")} ${theme.value(plan.select.map(safeTerminalText).join(", "))}`,
      `${theme.dim("Maximum rows:")} ${theme.value(String(plan.limit))}`,
    ];
  }
  const measures = plan.measures.map((measure) =>
    measure.function === "count"
      ? "record count"
      : `${measure.function}(${safeTerminalText(measure.field ?? "value")})`);
  const groups = [
    ...(plan.dimensions ?? []).map((dimension) => safeTerminalText(dimension.field)),
    ...(plan.time_bucket
      ? [`${plan.time_bucket.bucket}(${safeTerminalText(plan.time_bucket.field)})`]
      : []),
  ];
  return [
    `${theme.dim("Resource:")} ${theme.value(safeTerminalText(plan.resource))}`,
    `${theme.dim("Measures:")} ${theme.value(measures.join(", "))}`,
    `${theme.dim("Grouping:")} ${theme.value(groups.length ? groups.join(", ") : "none")}`,
    `${theme.dim("Maximum groups:")} ${theme.value(String(plan.top_n))}`,
  ];
}

export function protectedCapabilityWorkbenchUrl(
  workbenchUrl: string,
  analysisReference: string,
  capabilityName: string,
): string {
  const url = new URL(workbenchUrl);
  url.searchParams.set("view", "protect");
  url.searchParams.set("query_ref", analysisReference);
  url.searchParams.set("capability", capabilityName);
  return url.toString();
}

function parseProtectCommand(line: string): {
  reference?: string;
  capabilityName?: string;
} {
  const rest = line.slice("/protect".length).trim();
  if (!rest) return {};
  const match = /^(last|A[1-9][0-9]*)(?:\s+as\s+([A-Za-z][A-Za-z0-9_.-]{0,127}))?$/.exec(rest);
  if (!match) return { reference: "__invalid__" };
  return {
    reference: match[1],
    ...(match[2] ? { capabilityName: match[2] } : {}),
  };
}

function resolveAnalysisReference(
  requested: string,
  analyses: ShellAnalysisRecord[],
  current: { analyses: AnalyticsAnalysis[]; answer_id: string } | undefined,
): ShellAnalysisRecord | undefined {
  if (requested !== "last") return analyses.find((analysis) => analysis.token === requested);
  const references = current?.analyses.flatMap((analysis) =>
    analysis.reference ? [analysis.reference] : []) ?? [];
  if (references.length > 1) return undefined;
  if (references.length === 1) {
    return analyses.find((analysis) => analysis.token === references[0]);
  }
  return analyses[0];
}

function safeShellError(error: unknown): string {
  const message = error instanceof Error ? error.message : "The request failed safely.";
  return safeTerminalText(message);
}

export function analyticsAnalysisJson(analysis: AnalyticsAnalysis): Record<string, unknown> {
  return analysisJson(analysis);
}

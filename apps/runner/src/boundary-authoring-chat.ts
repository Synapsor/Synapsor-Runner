import process from "node:process";
import type { ActionControlPrompter } from "./action-tui.js";
import {
  createTerminalAnalyticsShellIo,
  type AnalyticsShellIo,
  type SlashCommandSuggestion,
} from "./analytics-shell.js";
import { safeTerminalText } from "./analytics-shell-render.js";
import {
  terminalTheme,
  type BoundaryPromptChoice,
  type BoundaryReviewInteractiveSession,
} from "./boundary-cli-picker.js";
import type { AskProviderStreamEvent } from "./model-ask.js";
import {
  wrapStyledTerminalLine,
} from "./terminal-layout.js";
import { renderTerminalSynapsorDslFrame } from "./terminal-syntax.js";

export type BoundaryAuthoringSpeaker = "runner" | "model";
type BoundaryAuthoringTone = "normal" | "success" | "warning" | "danger";

export type BoundaryAuthoringPermissionGuideInput = {
  title: string;
  prompt: string;
  context: string[];
  choices: Array<Pick<BoundaryPromptChoice, "value" | "label" | "detail">>;
  operatorQuestion?: string;
};

export type BoundaryAuthoringPermissionGuide = (
  input: BoundaryAuthoringPermissionGuideInput,
) => Promise<string | undefined>;

export type BoundaryAuthoringChat = {
  session: BoundaryReviewInteractiveSession;
  actionPrompter: ActionControlPrompter;
  setModel(label: string): void;
  setPermissionGuide?(guide: BoundaryAuthoringPermissionGuide | undefined): void;
  runner(title: string, lines?: string[], tone?: BoundaryAuthoringTone): void;
  model(lines: string[]): void;
  checkpoint(title: string, lines?: string[], tone?: BoundaryAuthoringTone): void;
  streamRunner(title: string, lines?: string[], tone?: BoundaryAuthoringTone): Promise<void>;
  streamCheckpoint(title: string, lines?: string[], tone?: BoundaryAuthoringTone): Promise<void>;
  streamModel(lines: string[]): Promise<void>;
  rememberDetails(title: string, lines: string[]): void;
  showDetails(): void;
  providerStream(event: AskProviderStreamEvent): void;
  progress<T>(message: string, operation: () => Promise<T>): Promise<T>;
  close(): void;
};

export type BoundaryAuthoringChatFactory = (input: {
  modelLabel?: string;
}) => BoundaryAuthoringChat;

type ChoiceInput = {
  title: string;
  message: string;
  options: BoundaryPromptChoice[];
  initialValue?: string;
};

const DEFAULT_TRANSCRIPT_STREAM_DELAY_MS = 32;
const DEFAULT_TRANSCRIPT_STREAM_VISIBLE_CHARS = 14;
const AUTHORING_SLASH_SUGGESTIONS: SlashCommandSuggestion[] = [
  {
    label: "/details",
    completion: "/details",
    description: "Show the latest exact Runner validation; no model request",
  },
  {
    label: "/diff",
    completion: "/diff",
    description: "Show the latest concise reviewed change; no model request",
  },
  {
    label: "/exact",
    completion: "/exact",
    description: "Show the complete latest Runner record; no model request",
  },
  {
    label: "/help",
    completion: "/help",
    description: "Show Boundary-authoring chat controls",
  },
];

function stripTerminalAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function transcriptText(value: string): string {
  return safeTerminalText(stripTerminalAnsi(value));
}

function renderInlineModelMarkdown(
  value: string,
  theme: ReturnType<typeof terminalTheme>,
): string {
  // Some providers prefix a Markdown-formatted question with a stray `?`.
  // Treat it as a rendering artifact only when the remainder is itself a
  // complete question; ordinary punctuation elsewhere remains untouched.
  value = value.replace(
    /(^|\s)\?+\s*(?=(?:\*\*)?\p{Lu}[^?\n]*\?)/gu,
    "$1",
  );
  value = value.replace(/\?+\s*\*\*([^*\n]+\?)\*\*/gu, "**$1**");
  let rendered = "";
  let plain = "";
  const flush = () => {
    rendered += plain;
    plain = "";
  };
  for (let index = 0; index < value.length;) {
    if (value[index] === "\\" && (value.startsWith("**", index + 1)
      || value.startsWith("__", index + 1))) {
      plain += value.slice(index + 1, index + 3);
      index += 3;
      continue;
    }
    if (value[index] === "\\" && index + 1 < value.length
      && ["*", "_", "`", "\\"].includes(value[index + 1]!)) {
      plain += value[index + 1];
      index += 2;
      continue;
    }
    const marker = value.startsWith("**", index) ? "**"
      : value.startsWith("__", index) ? "__"
        : value[index] === "`" ? "`"
          : value[index] === "*" ? "*"
            : undefined;
    if (!marker) {
      plain += value[index];
      index += 1;
      continue;
    }
    const close = value.indexOf(marker, index + marker.length);
    if (close <= index + marker.length) {
      plain += marker;
      index += marker.length;
      continue;
    }
    flush();
    const content = value.slice(index + marker.length, close);
    rendered += marker === "`"
      ? theme.value(content)
      : marker === "*"
        ? theme.italic(content)
        : theme.bold(content);
    index = close + marker.length;
  }
  flush();
  return rendered;
}

function terminalOutputChunks(
  value: string,
  visibleLimit = DEFAULT_TRANSCRIPT_STREAM_VISIBLE_CHARS,
): string[] {
  const tokens = value.match(/\u001b\[[0-?]*[ -/]*[@-~]|[\s\S]/gu) ?? [];
  const chunks: string[] = [];
  let current = "";
  let visible = 0;
  for (const token of tokens) {
    current += token;
    if (!token.startsWith("\u001b[")) visible += 1;
    if (visible >= visibleLimit) {
      chunks.push(current);
      current = "";
      visible = 0;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function meaningfulContext(context: string[] | undefined): string[] {
  return (context ?? []).map((line) => transcriptText(line)).filter((line, index, lines) =>
    line.trim() || (index > 0 && index < lines.length - 1));
}

function permissionQuestion(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => transcriptText(line).trim())
    .find(Boolean) ?? "Review this exact permission.";
}

function isModelQuestion(title: string | undefined, context: string[] | undefined): boolean {
  const heading = title ?? context?.[0] ?? "";
  return /^(?:ANSWER ONE BUSINESS QUESTION|(?:SET|CONFIRM) (?:PROPOSAL RANGE|PROPOSAL FIELDS|ACTION TARGET|PROPOSAL EFFECT|CONFLICT AND RETRY GUARD)|CLARIFY ONE REVIEWED NAME|MODEL QUESTION|DESCRIBE THE AUTO-APPROVAL RULE)/iu
    .test(heading.trim());
}

function contextValue(context: string[] | undefined, prefix: string): string | undefined {
  const line = context?.find((candidate) => candidate.trimStart().startsWith(prefix));
  return line?.trimStart().slice(prefix.length).trim() || undefined;
}

function modelQuestionTurn(
  prompt: string,
  title: string | undefined,
  context: string[] | undefined,
): string[] {
  const target = contextValue(context, "Action:") ?? contextValue(context, "Target:");
  const heading = title?.trim() ?? "";
  const purpose = /PROPOSAL RANGE$/iu.test(heading)
    ? target
      ? [`This is the hard proposal range for ${target}.`, "Auto-approval can be narrower."]
      : ["This is the hard proposal range. Auto-approval can be narrower."]
    : /PROPOSAL FIELDS$/iu.test(heading)
      ? ["Only these business fields may come from the agent.", "Trusted scope stays with Runner."]
      : /ACTION TARGET$/iu.test(heading)
        ? ["This selects one reviewed table; it grants no authority."]
        : /PROPOSAL EFFECT$/iu.test(heading)
          ? ["This selects a proposal effect; it does not execute the change."]
          : /CONFLICT AND RETRY GUARD$/iu.test(heading)
            ? ["This guard rejects duplicate or stale proposals before approval."]
            : undefined;
  return [prompt.replace(/:\s*$/u, ""), ...(purpose ?? [])];
}

function compactRoutineCheckpoint(
  title: string,
  lines: string[],
): { title: string; lines: string[] } | undefined {
  if (title === "READ REVIEW COMPLETE - NOT ACTIVE") {
    const boundary = contextValue(lines, "Read Boundary:") ?? contextValue(lines, "Boundary:");
    return {
      title: "Read draft saved",
      lines: [
        [boundary, "not active", "source unchanged"].filter(Boolean).join(" · "),
        "Next: Action Boundary",
      ],
    };
  }
  if (title === "READ CANDIDATE READY") {
    return {
      title: "Read draft ready",
      lines: [
        lines[0] ?? "The requested Read plans passed exact review.",
        "Agent access off · source unchanged · /details shows the exact candidate",
      ],
    };
  }
  if (title === "MAPPING CATALOG READY") {
    const exclusions = lines.filter((line) => /(?:outside mapping|manual scope review|shared-reference)/iu.test(line));
    return {
      title: "Mapping catalog ready",
      lines: [
        lines[0] ?? "Reviewed structure is available for this job.",
        ...exclusions.slice(0, 2),
        "Agent authority off · source unchanged",
      ],
    };
  }
  if (title === "PROPOSAL ACTION DRAFT SAVED") {
    const action = contextValue(lines, "Action:");
    const rehearsal = contextValue(lines, "Rehearsal:");
    const approval = contextValue(lines, "Approval:");
    return {
      title: "Action draft saved",
      lines: [
        [action, rehearsal].filter(Boolean).join(" · "),
        `${approval ? `Approval ${approval.toLowerCase()} · ` : ""}proposal off · apply off · source unchanged`,
      ],
    };
  }
  if (title === "NEXT AUTHORITY REVIEW - READ BOUNDARY") {
    const actionDependency = lines.find((line) => /Action Boundary|rehearsed Action/iu.test(line));
    return {
      title: actionDependency
        ? "Action draft saved; Read dependency needs review"
        : "Read draft ready for activation review",
      lines: [
        contextValue(lines, "Read Boundary:") ?? "The exact Read draft is ready.",
        ...(actionDependency
          ? ["The rehearsed Action draft depends on this exact Read revision. Read and Action activation remain separate decisions."]
          : []),
      ],
    };
  }
  if (title === "NEXT AUTHORITY REVIEW - ACTION BOUNDARY") {
    return {
      title: "Action draft ready for activation review",
      lines: [contextValue(lines, "Action:") ?? "The exact proposal action is ready."],
    };
  }
  if (title === "Model choice unchanged") {
    return { title, lines: lines.slice(0, 1) };
  }
  return undefined;
}

function isPermissionPrompt(prompt: string, context: string[] | undefined): boolean {
  const value = `${context?.[0] ?? ""} ${prompt}`;
  return /(?:\bSEND\b|EGRESS|ACTIVATE|GRANT|APPROV|APPLY|MUTATE|WRITE|TRUSTED SCOPE)/iu.test(value);
}

function choiceSummary(choice: BoundaryPromptChoice | undefined): string {
  return choice?.label.replace(/\s+\[(?:recommended|ready[^\]]*|configure|detected|available)[^\]]*\]/giu, "").trim()
    ?? "Back";
}

export function createBoundaryAuthoringChat(input: {
  modelLabel?: string;
  io?: AnalyticsShellIo;
  color?: boolean;
  streamLineDelayMs?: number;
} = {}): BoundaryAuthoringChat {
  const io = input.io ?? createTerminalAnalyticsShellIo({
    slashCommands: true,
    slashSuggestions: AUTHORING_SLASH_SUGGESTIONS,
  });
  const color = input.color ?? (io.isTerminal?.() === true && !("NO_COLOR" in process.env));
  const theme = terminalTheme(color, { brand: true });
  const streamLineDelayMs = input.streamLineDelayMs
    ?? (input.io ? 0 : io.isTerminal?.() === true ? DEFAULT_TRANSCRIPT_STREAM_DELAY_MS : 0);
  let modelLabel = input.modelLabel;
  let closed = false;
  let streamedCharacters = 0;
  let lastProviderStatusCharacters = 0;
  let latestDetails: { title: string; lines: string[] } | undefined;
  let permissionGuide: BoundaryAuthoringPermissionGuide | undefined;
  const transcriptIndent = io.isTerminal?.() === true ? "  " : "";
  const transcriptWidth = () => Math.min(116, Math.max(24, io.columns()));

  const role = (speaker: BoundaryAuthoringSpeaker): string => speaker === "model"
    ? theme.scope("model>")
    : theme.key("runner>");
  const roleContent = (
    speaker: BoundaryAuthoringSpeaker,
    line: string,
    index: number,
    firstStyle?: (value: string) => string,
  ): string => {
    const safe = transcriptText(line);
    let content = speaker === "model" ? renderInlineModelMarkdown(safe, theme) : safe;
    if (speaker === "model") {
      const heading = safe.match(/^\s*#{1,3}\s+(.+)$/u);
      const bullet = safe.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/u);
      if (heading) {
        content = theme.bold(renderInlineModelMarkdown(heading[1]!, theme));
      } else if (bullet) {
        content = `${bullet[1]}${theme.key(bullet[2]!)} ${renderInlineModelMarkdown(bullet[3]!, theme)}`;
      } else if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(safe)) {
        content = theme.dim(safe);
      }
    }
    if (index === 0 && firstStyle) content = firstStyle(content);
    if (speaker === "model") {
      const interpreted = safe.match(/^I interpreted that as\s+([^:]+):\s*(.+)\.$/iu);
      if (interpreted) {
        content = `I interpreted that as ${theme.scope(interpreted[1]!.trim())}: `
          + `${theme.success(interpreted[2]!.trim())}.`;
      }
    }
    if (speaker === "runner" && index > 0) {
      const interpreted = safe.match(/^Runner-validated interpretation:\s*([^:]+):\s*(.+)$/iu);
      if (interpreted) {
        content = `${theme.dim("Runner-validated interpretation:")} `
          + `${theme.scope(interpreted[1]!.trim())}: ${theme.success(interpreted[2]!.trim())}`;
      } else {
        const emphasized = [
          "Boundary:",
          "Action:",
          "Target:",
          "Reviewed proposal field:",
          "Where used:",
          "You said:",
          "Operator answer:",
          "Validated decision:",
        ].find((prefix) => safe.trimStart().startsWith(prefix));
        if (emphasized) {
          const offset = safe.indexOf(emphasized);
          const value = safe.slice(offset + emphasized.length).trimStart();
          content = `${theme.dim(emphasized)} ${theme.value(value)}`;
        }
      }
    }
    return content;
  };
  const roleLines = (
    speaker: BoundaryAuthoringSpeaker,
    line: string,
    index: number,
    firstStyle?: (value: string) => string,
  ): string[] => {
    const firstPrefix = index === 0
      ? `${transcriptIndent}${role(speaker)}`
      : `${transcriptIndent}${" ".repeat(speaker === "model" ? 6 : 7)}`;
    const prefix = `${firstPrefix} `;
    const prefixWidth = Array.from(stripTerminalAnsi(prefix)).length;
    const continuation = " ".repeat(prefixWidth);
    const available = Math.max(12, transcriptWidth() - prefixWidth);
    return wrapStyledTerminalLine(
      roleContent(speaker, line, index, firstStyle),
      available,
    ).map((wrapped, wrappedIndex) =>
      `${wrappedIndex === 0 ? prefix : continuation}${wrapped}`);
  };
  const writeTranscript = (value: string) => {
    if (io.writeChunk) io.writeChunk(value);
    else io.write(value);
  };
  const checkpoint = (
    title: string,
    lines: string[] = [],
    tone: BoundaryAuthoringTone = "success",
  ) => {
    const marker = tone === "success" ? "✓" : tone === "warning" ? "!" : tone === "danger" ? "×" : "·";
    const style = tone === "success"
      ? theme.success
      : tone === "warning"
        ? theme.warning
        : tone === "danger"
          ? theme.danger
          : theme.key;
    const facts = meaningfulContext(lines);
    const rendered = [
      `${transcriptIndent}${style(`${marker} ${transcriptText(title)}`)}`,
      ...facts.map((line, index) => `${transcriptIndent}  ${index === 0 ? theme.value(line) : theme.dim(line)}`),
      "",
    ].flatMap((line) => wrapStyledTerminalLine(line, transcriptWidth()));
    writeTranscript(rendered.join("\n"));
  };
  const writeRole = (
    speaker: BoundaryAuthoringSpeaker,
    lines: string[],
    firstStyle?: (value: string) => string,
  ) => {
    if (!lines.length) return;
    writeTranscript(`${lines.flatMap((line, index) =>
      roleLines(speaker, line, index, firstStyle)).join("\n")}\n`);
  };
  const runner = (
    title: string,
    lines: string[] = [],
    tone: BoundaryAuthoringTone = "normal",
  ) => {
    const routine = compactRoutineCheckpoint(title, lines);
    if (routine) {
      rememberDetails(title, lines);
      return;
    }
    const titleStyle = tone === "success"
      ? theme.success
      : tone === "warning"
        ? theme.warning
        : tone === "danger"
          ? theme.danger
          : theme.bold;
    writeRole("runner", [title, ...lines], titleStyle);
  };
  const model = (lines: string[]) => writeRole("model", lines);
  const rememberDetails = (title: string, lines: string[]) => {
    const facts = meaningfulContext(lines);
    if (!facts.length) return;
    latestDetails = {
      title: transcriptText(title),
      lines: facts,
    };
  };
  const showDetails = () => {
    if (!latestDetails) {
      runner("No Runner details yet", [
        "Details appear after Runner validates a model draft or prepares an exact authority decision.",
      ], "warning");
      return;
    }
    const detailLines = latestDetails.lines.map((line) => {
      const safe = transcriptText(line);
      if (!safe.trim()) return "";
      if (/^[A-Z][A-Z0-9 /+_-]{2,}:?$/u.test(safe.trim())) {
        return theme.title(safe.trim().replace(/:$/u, ""));
      }
      if (/^[+|`-]/u.test(safe.trimStart())) return safe;
      const fact = safe.match(/^([^:]{1,40}):\s+(.+)$/u);
      if (fact) return `${theme.dim(`${fact[1]!.trim()}:`)} ${theme.value(fact[2]!.trim())}`;
      if (/^[-*]\s+/u.test(safe.trimStart())) {
        return `  ${theme.key("-")} ${safe.trimStart().replace(/^[-*]\s+/u, "")}`;
      }
      return `  ${safe}`;
    });
    const rendered = [
      "",
      theme.title("RUNNER DETAILS"),
      theme.scope(latestDetails.title),
      ...detailLines,
      "",
      theme.dim("No model request, authority change, source query, or source write occurred."),
      "",
    ].flatMap((line) => wrapStyledTerminalLine(line, transcriptWidth()));
    writeTranscript(rendered.join("\n"));
  };
  const showDiff = () => {
    if (!latestDetails) {
      runner("No reviewed change yet", [
        "A diff appears after Runner validates a draft or prepares an exact authority decision.",
      ], "warning");
      return;
    }
    const selected = latestDetails.lines.filter((line) =>
      /^(?:Boundary|Action|Target|Read plans?|Action suggestions?|Runner-validated interpretation|Validated decision|Agent supplies|Runner supplies|Approval|Authority|Writeback|Rehearsal|Source database changed|Agent access|Model-facing fields|Privacy|Usage limits):/iu.test(line.trim())
      || /\b(?:added|removed|changed|kept out|remains disabled|remains off|source unchanged)\b/iu.test(line));
    const facts = (selected.length ? selected : latestDetails.lines).slice(0, 18);
    const rendered = [
      "",
      theme.title("LATEST REVIEWED CHANGE"),
      theme.scope(latestDetails.title),
      ...facts.map((line) => `  ${transcriptText(line)}`),
      "",
      theme.dim("Use /exact for the complete Runner record. No model request or authority change occurred."),
      "",
    ].flatMap((line) => wrapStyledTerminalLine(line, transcriptWidth()));
    writeTranscript(rendered.join("\n"));
  };
  const showHelp = () => {
    const rendered = [
      "",
      theme.title("BOUNDARY AUTHORING COMMANDS"),
      `${theme.key("/details")}  ${theme.dim("Show the latest exact Runner validation or permission record")}`,
      `${theme.key("/diff")}     ${theme.dim("Show the latest concise reviewed change")}`,
      `${theme.key("/exact")}    ${theme.dim("Show the complete latest Runner record")}`,
      `${theme.key("/help")}     ${theme.dim("Show these commands")}`,
      `${theme.key("Esc")}       ${theme.dim("Pause safely at an input prompt")}`,
      "",
      theme.dim("Press Tab after / to complete a command. Manual editors remain available from the Boundary screen."),
      "",
    ].flatMap((line) => wrapStyledTerminalLine(line, transcriptWidth()));
    writeTranscript(rendered.join("\n"));
  };
  const waitForNextStreamChunk = () => streamLineDelayMs > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, streamLineDelayMs))
    : Promise.resolve();
  const streamRole = async (
    speaker: BoundaryAuthoringSpeaker,
    lines: string[],
    firstStyle?: (value: string) => string,
  ) => {
    if (!lines.length) return;
    io.clearStatus?.();
    if (streamLineDelayMs <= 0 || io.isTerminal?.() !== true) {
      writeRole(speaker, lines, firstStyle);
      return;
    }
    for (const [lineIndex, line] of lines.entries()) {
      const physicalLines = roleLines(speaker, line, lineIndex, firstStyle);
      for (const [physicalIndex, physicalLine] of physicalLines.entries()) {
        const chunks = terminalOutputChunks(physicalLine);
        for (const [chunkIndex, chunk] of chunks.entries()) {
          writeTranscript(chunk);
          const finalChunk = lineIndex === lines.length - 1
            && physicalIndex === physicalLines.length - 1
            && chunkIndex === chunks.length - 1;
          if (!finalChunk) await waitForNextStreamChunk();
        }
        writeTranscript("\n");
      }
    }
  };
  const streamRunner = async (
    title: string,
    lines: string[] = [],
    tone: BoundaryAuthoringTone = "normal",
  ) => {
    const routine = compactRoutineCheckpoint(title, lines);
    if (routine) {
      rememberDetails(title, lines);
      if (/^NEXT AUTHORITY REVIEW - /u.test(title)) {
        checkpoint(routine.title, routine.lines, "normal");
      }
      return;
    }
    const titleStyle = tone === "success"
      ? theme.success
      : tone === "warning"
        ? theme.warning
        : tone === "danger"
          ? theme.danger
          : theme.bold;
    await streamRole("runner", [title, ...lines], titleStyle);
  };
  const streamCheckpoint = async (
    title: string,
    lines: string[] = [],
    tone: BoundaryAuthoringTone = "success",
  ) => {
    io.clearStatus?.();
    checkpoint(title, lines, tone);
  };
  const streamModel = (lines: string[]) => streamRole("model", lines);
  const writeContext = async (context: string[] | undefined, speaker: BoundaryAuthoringSpeaker = "runner") => {
    const lines = meaningfulContext(context);
    if (!lines.length) return;
    if (speaker === "model") {
      await streamModel(lines);
      return;
    }
    const modelLines = lines
      .filter((line) => /^(?:Model rationale|Model question|Model suggestion):/iu.test(line))
      .map((line) => line.replace(/^Model (?:rationale|question|suggestion):\s*/iu, ""));
    const runnerLines = lines.filter((line) =>
      !/^(?:Model rationale|Model question|Model suggestion):/iu.test(line));
    if (modelLines.length) await streamModel(modelLines);
    if (modelLines.length && runnerLines.length) {
      checkpoint(runnerLines[0]!, runnerLines.slice(1));
    } else if (runnerLines.length) {
      await streamRunner(runnerLines[0]!, runnerLines.slice(1));
    }
  };
  const read = async (prompt: string, speaker: BoundaryAuthoringSpeaker = "runner") => {
    writeRole(speaker, [prompt]);
    return readAnswer();
  };
  const readAnswer = async (defaultValue?: string) => {
    const defaultHint = defaultValue ? `${theme.dim(`[${defaultValue}]`)} ` : "";
    while (true) {
      const prompt = `${theme.focus("you>")} ${defaultHint}`;
      const answer = io.readConversation
        ? await io.readConversation(prompt)
        : io.readWithEscape
          ? await io.readWithEscape(prompt)
          : await io.read(prompt);
      let command = answer?.trim().toLowerCase();
      if (command?.startsWith("/") && !AUTHORING_SLASH_SUGGESTIONS.some((item) => item.completion === command)) {
        const matches = AUTHORING_SLASH_SUGGESTIONS.flatMap((item) =>
          item.completion?.startsWith(command!) ? [item.completion] : []);
        if (matches.length === 1) {
          command = matches[0]!;
        } else {
          runner(matches.length
            ? `Incomplete command: ${command}`
            : `Unknown command: ${command}`, [
            ...(matches.length
              ? [`Matches: ${matches.join(", ")}`]
              : ["Type /help to list Boundary-authoring commands."]),
            "The pending question and disabled draft are unchanged.",
          ], "warning");
          continue;
        }
      }
      if (command === "/details") {
        showDetails();
        continue;
      }
      if (command === "/diff") {
        showDiff();
        continue;
      }
      if (command === "/exact") {
        showDetails();
        continue;
      }
      if (command === "/help") {
        showHelp();
        continue;
      }
      if (command?.startsWith("/")) {
        runner(`Unknown command: ${command}`, [
          "Type /help to list Boundary-authoring commands.",
          "The pending question and disabled draft are unchanged.",
        ], "warning");
        continue;
      }
      return answer;
    }
  };
  const choose = async (choice: ChoiceInput): Promise<string | undefined> => {
    const available = choice.options.filter((option) => !option.disabled);
    if (!available.length) return undefined;
    const unavailable = choice.options.filter((option) => option.disabled);
    if (unavailable.length) {
      runner("Unavailable here", unavailable.map((option) => `${option.label}: ${option.detail ?? "not available"}`), "warning");
    }
    const selected = io.choose
      ? await io.choose({
          title: choice.title,
          message: choice.message,
          showSelectedDetail: true,
          ...(choice.initialValue ? { initialValue: choice.initialValue } : {}),
          options: available.map((option) => ({
            value: option.value,
            label: option.label,
            ...(option.detail ? { detail: option.detail } : {}),
          })),
        })
      : undefined;
    if (selected !== undefined) {
      const selectedChoice = available.find((option) => option.value === selected);
      io.write(`${theme.focus("you>")} ${theme.value(safeTerminalText(choiceSummary(selectedChoice)))}\n`);
      return selected;
    }
    if (io.choose) return undefined;
    runner(choice.title, [choice.message, ...available.map((option, index) =>
      `${index + 1}. ${option.label}${option.detail ? ` - ${option.detail}` : ""}`)]);
    const answer = await read(`Choose 1-${available.length}, or press Esc to go back.`);
    if (answer === undefined) return undefined;
    const index = Number(answer.trim()) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= available.length) return undefined;
    return available[index]!.value;
  };
  const askModelChoiceValue = "__ask_boundary_model__";
  const viewRunnerDetailsChoiceValue = "__view_runner_details__";
  const choosePermission = async (
    choice: ChoiceInput,
    context: string[] = [],
  ): Promise<string | undefined> => {
    const exactChoices = choice.options.filter((option) => !option.disabled);
    const request = {
      title: choice.title,
      prompt: choice.message,
      context: meaningfulContext(context),
      choices: exactChoices.map(({ value, label, detail }) => ({
        value,
        label: transcriptText(label),
        ...(detail ? { detail: transcriptText(detail) } : {}),
      })),
    } satisfies BoundaryAuthoringPermissionGuideInput;
    let explanationShown = false;
    const hasExactDetailsChoice = choice.options.some((option) =>
      /\b(?:details|inspect exact|view exact)\b/iu.test(`${option.label} ${option.detail ?? ""}`));

    const explain = async (operatorQuestion?: string): Promise<void> => {
      if (!permissionGuide) return;
      const answer = await permissionGuide({
        ...request,
        ...(operatorQuestion ? { operatorQuestion } : {}),
      });
      if (answer?.trim()) {
        await streamModel(answer.trim().split(/\r?\n/u));
        explanationShown = true;
        return;
      }
      // The automatic narration is optional. Its failure must not look like a
      // failed authority operation or obscure the exact Runner confirmation.
      // Surface the outage only after the operator explicitly asks the model.
      if (operatorQuestion) {
        checkpoint("Model explanation unavailable", [
          "The exact Runner permission is unchanged. Use /details, decide now, or try again later.",
        ], "warning");
      }
    };

    await explain();
    while (true) {
      const selected = await choose({
        ...choice,
        options: [
          ...choice.options.slice(0, 1),
          ...(permissionGuide
            ? [{
                value: askModelChoiceValue,
                label: "Ask the model before deciding",
                detail: "Ask why this permission is needed or have the model break it down.",
              }]
            : []),
          ...(!hasExactDetailsChoice
            ? [{
                value: viewRunnerDetailsChoiceValue,
                label: "View exact Runner details",
                detail: "Inspect the deterministic record without changing authority.",
              }]
            : []),
          ...choice.options.slice(1),
        ],
      });
      if (selected === viewRunnerDetailsChoiceValue) {
        showDetails();
        continue;
      }
      if (selected !== askModelChoiceValue) return selected;

      const operatorQuestion = await readAnswer();
      if (operatorQuestion === undefined || !operatorQuestion.trim()) continue;
      await explain(operatorQuestion.trim());
      if (!explanationShown) continue;
    }
  };
  const confirm = async (
    prompt: string,
    options: { context?: string[]; defaultValue?: boolean } = {},
    kind: "decision" | "permission" = isPermissionPrompt(prompt, options.context) ? "permission" : "decision",
  ): Promise<boolean | undefined> => {
    const permission = kind === "permission";
    if (permission) {
      rememberDetails("PERMISSION REQUEST", [...meaningfulContext(options.context), prompt]);
    } else await writeContext(options.context);
    const yesLabel = permission ? "Allow this exact step" : "Yes, continue";
    const noLabel = permission ? "Not now; keep authority unchanged" : "No; go back";
    const permissionContext = meaningfulContext(options.context);
    const choice = {
      title: permission ? "PERMISSION REQUIRED" : "CONFIRM REVIEWED DECISION",
      message: permission
        ? permissionQuestion(prompt)
        : prompt,
      initialValue: options.defaultValue === true ? "yes" : "no",
      options: [
        {
          value: "yes",
          label: yesLabel,
          detail: permission
            ? "Only the exact operation described above is permitted."
            : "Continue with the exact value shown above.",
        },
        {
          value: "no",
          label: noLabel,
          detail: "No source data or active authority changes.",
        },
      ],
    } satisfies ChoiceInput;
    const selected = permission
      ? await choosePermission(choice, permissionContext)
      : await choose(choice);
    return selected === undefined ? undefined : selected === "yes";
  };

  const session: BoundaryReviewInteractiveSession = {
    presentationMode: "conversation",
    present: runner,
    rememberDetails,
    chooseResource: async () => undefined,
    editFieldTiers: async () => undefined,
    promptText: async (prompt, options) => {
      const firstJobPrompt = prompt.trim() === "What job are you giving this agent?"
        && options?.context?.some((line) => line.trim() === "SET UP ONE AGENT JOB");
      if (firstJobPrompt) {
        rememberDetails("SET UP ONE AGENT JOB", options?.context ?? []);
        return readAnswer();
      }
      const speaker = isModelQuestion(undefined, options?.context) ? "model" : "runner";
      if (speaker === "model") {
        await streamModel(modelQuestionTurn(prompt, options?.context?.[0], options?.context));
        return readAnswer();
      }
      await writeContext(options?.context);
      return read(prompt.replace(/:\s*$/u, ""), speaker);
    },
    chooseOption: async (title, choices, options) => {
      const permission = /^(?:ACTIVATE|APPROVE|APPLY|GRANT)\b/iu.test(title.trim());
      if (permission) {
        rememberDetails("PERMISSION REQUEST", [...meaningfulContext(options?.context), title]);
      } else if (options?.context?.length) {
        const hasModelContext = options.context.some((line) =>
          /^(?:Model rationale|Model question|Model suggestion):/iu.test(line.trim()));
        if (hasModelContext) await writeContext(options.context);
        else rememberDetails(title, options.context);
      }
      const choice = {
        title: permission ? "PERMISSION REQUIRED" : title,
        message: permission
          ? permissionQuestion(title)
          : "Choose one path. The highlighted choice is not applied until you press Enter.",
        options: choices,
        ...(options?.initialValue ? { initialValue: options.initialValue } : {}),
      } satisfies ChoiceInput;
      return permission
        ? choosePermission(choice, options?.context)
        : choose(choice);
    },
    confirm: (prompt, options) => confirm(prompt, options),
    confirmActivation: (prompt, options) => confirm(prompt, {
      ...options,
      defaultValue: false,
    }, "permission"),
    confirmReviewedDisabled: (prompt, options) => confirm(prompt, {
      ...options,
      defaultValue: true,
    }, "decision"),
  };

  const actionPrompter: ActionControlPrompter = {
    rememberDetails,
    choose: async (title, choices, context, initialValue) => {
      const permission = /^(?:ACTIVATE|APPROVE|APPLY)\b/iu.test(title.trim());
      if (permission) {
        rememberDetails("PERMISSION REQUEST", [...meaningfulContext(context), title]);
      } else if (context?.length) {
        rememberDetails(title, context);
      }
      const safePermissionChoice = permission
        ? choices.find((choice) => !choice.disabled && /^(?:back|no|cancel|decline|disabled|leave)$/iu.test(choice.value))
        : undefined;
      const choice = {
        title: permission ? "PERMISSION REQUIRED" : title,
        message: permission
          ? permissionQuestion(title)
          : "Review the exact choices, then select one.",
        options: choices,
        ...(safePermissionChoice
          ? { initialValue: safePermissionChoice.value }
          : initialValue
            ? { initialValue }
            : {}),
      } satisfies ChoiceInput;
      return permission
        ? choosePermission(choice, context)
        : choose(choice);
    },
    text: async (label, options) => {
      if (options?.context?.length) {
        rememberDetails(options.title ?? "Latest Runner validation", options.context);
      }
      if (options?.conversation) {
        await streamModel(options.conversation.modelLines);
        if (options.conversation.checkpoint) {
          checkpoint(
            options.conversation.checkpoint.title,
            options.conversation.checkpoint.lines,
            options.conversation.checkpoint.tone,
          );
        }
        const answer = await readAnswer(options.defaultValue);
        return answer === "" && options.defaultValue ? options.defaultValue : answer;
      }
      await writeContext(options?.context);
      if (options?.title) runner(options.title);
      const suffix = options?.defaultValue ? ` [${options.defaultValue}]` : "";
      const answer = await read(`${label}${suffix}`, "runner");
      return answer === "" && options?.defaultValue ? options.defaultValue : answer;
    },
    confirm: (label, defaultValue) => confirm(label, { defaultValue }),
    message: async (title, lines) => {
      rememberDetails(title, lines);
      const modelRationale = lines.find((line) => /^Model rationale:/iu.test(line));
      const runnerLines = modelRationale ? lines.filter((line) => line !== modelRationale) : lines;
      if (modelRationale) await streamModel([modelRationale.replace(/^Model rationale:\s*/iu, "")]);
      if (modelRationale) checkpoint(title, runnerLines);
      else await streamRunner(title, runnerLines);
    },
    syntax: async (title, source, language, metadata = []) => {
      rememberDetails(title, [...metadata, "", ...source.trimEnd().split("\n")]);
      const rendered = language === "synapsor-dsl"
        ? renderTerminalSynapsorDslFrame(source, {
            title,
            metadata,
            color,
            columns: transcriptWidth(),
          })
        : source;
      writeTranscript(`${rendered}\n\n`);
    },
  };

  const intro = [
    `${theme.title("Boundary drafting")}${modelLabel ? theme.dim(` · ${modelLabel}`) : ""}`,
    "",
  ].flatMap((line) => wrapStyledTerminalLine(line, transcriptWidth()));
  writeTranscript(intro.join("\n"));

  return {
    session,
    actionPrompter,
    setModel: (label) => {
      modelLabel = label;
    },
    setPermissionGuide: (guide) => {
      permissionGuide = guide;
    },
    runner,
    model,
    checkpoint,
    streamRunner,
    streamCheckpoint,
    streamModel,
    rememberDetails,
    showDetails,
    providerStream: (event) => {
      if (event.phase === "started") {
        streamedCharacters = 0;
        lastProviderStatusCharacters = 0;
        io.setStatus?.(`${modelLabel ?? "Selected model"} is drafting...`);
        return;
      }
      if (event.phase === "tool_started") {
        io.setStatus?.(`${modelLabel ?? "Selected model"} is building a structured draft for Runner validation...`);
        return;
      }
      if (event.phase === "text_delta" || event.phase === "tool_delta") {
        streamedCharacters += event.characters ?? 0;
        if (streamedCharacters - lastProviderStatusCharacters < 48) return;
        lastProviderStatusCharacters = streamedCharacters;
        io.setStatus?.(
          `${modelLabel ?? "Selected model"} is responding... ${streamedCharacters.toLocaleString("en-US")} characters received; Runner has not accepted them`,
        );
        return;
      }
      io.setStatus?.("Runner is validating the complete streamed draft...");
    },
    progress: async <T>(message: string, operation: () => Promise<T>) => {
      io.setStatus?.(message);
      try {
        const result = await operation();
        io.clearStatus?.();
        return result;
      } catch (error) {
        io.clearStatus?.();
        throw error;
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      io.close();
    },
  };
}

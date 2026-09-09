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
import { AskError, type AskProviderStreamEvent } from "./model-ask.js";
import {
  wrapStyledTerminalLine,
} from "./terminal-layout.js";
import { renderTerminalSynapsorDslFrame } from "./terminal-syntax.js";
import { createTerminalModelStream } from "./terminal-model-stream.js";
import { reflowTerminalProse } from "./terminal-prose.js";
import { authoringExplanationFailure, type AuthoringExplanationFailure } from "./authoring-explanation-failure.js";
import type { ReviewSection } from "./read-boundary-review-view.js";

export type BoundaryAuthoringSpeaker = "runner" | "model";
type BoundaryAuthoringTone = "normal" | "success" | "warning" | "danger";

export type BoundaryAuthoringPermissionGuideInput = {
  title: string;
  prompt: string;
  context: string[];
  explanationContext?: string[];
  choices: Array<Pick<BoundaryPromptChoice, "value" | "label" | "detail">>;
  operatorQuestion?: string;
  onFailure?: (failure: AuthoringExplanationFailure) => void;
};

export type BoundaryAuthoringPermissionGuide = (
  input: BoundaryAuthoringPermissionGuideInput,
) => Promise<string | undefined>;

export type BoundaryAuthoringChat = {
  readonly signal?: AbortSignal;
  session: BoundaryReviewInteractiveSession;
  actionPrompter: ActionControlPrompter;
  setModel(label: string): void;
  setPermissionGuide?(guide: BoundaryAuthoringPermissionGuide | undefined): void;
  setSourceCommandHandler?(handler: (command: string, argument: string) => Promise<boolean>, hasDraft?: () => boolean): void;
  setSourceAnswerRecorder?(recorder: (answer: string) => Promise<void>): void;
  readLiteral?(prompt: string): Promise<string | undefined>;
  runner(title: string, lines?: string[], tone?: BoundaryAuthoringTone): void;
  model(lines: string[]): void;
  checkpoint(title: string, lines?: string[], tone?: BoundaryAuthoringTone): void;
  streamRunner(title: string, lines?: string[], tone?: BoundaryAuthoringTone): Promise<void>;
  streamCheckpoint(title: string, lines?: string[], tone?: BoundaryAuthoringTone): Promise<void>;
  streamModel(lines: string[]): Promise<void>;
  readOperator?(defaultValue?: string): Promise<string | undefined>;
  rememberDetails(title: string, lines: string[]): void;
  showDetails(): void;
  providerStream(event: AskProviderStreamEvent): void;
  progress<T>(message: string, operation: () => Promise<T>): Promise<T>;
  close(): void;
};

export type BoundaryAuthoringChatFactory = (input: {
  modelLabel?: string;
  modelSelectionOrigin?: "current session" | "only configured provider detected";
}) => BoundaryAuthoringChat;

type ChoiceInput = {
  title: string;
  message: string;
  options: BoundaryPromptChoice[];
  initialValue?: string;
  exactDetails?: { title: string; lines: string[]; summaryTitle?: string; sections?: ReviewSection[] };
  explainOnRequest?: boolean;
  explanationContext?: string[];
};

const DEFAULT_TRANSCRIPT_STREAM_DELAY_MS = 32;
const DEFAULT_TRANSCRIPT_STREAM_VISIBLE_CHARS = 14;
const AUTHORING_SLASH_SUGGESTIONS: SlashCommandSuggestion[] = [
  { label: "/attach", completion: "/attach", description: "Attach or replace complete .txt rules; preview and approve model transfer", argumentHint: "Enter opens transfer review; preview the text there before allowing it" },
  { label: "/rules", completion: "/rules", description: "View, paste, replace or remove this job's rules snapshot" },
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
  // Providers sometimes prefix a question with a decorative question-mark
  // glyph. A few terminal fonts render those glyphs as one or two literal
  // question marks, so normalize both forms before applying inline styles.
  value = value.replace(/(?:[\u2047-\u2049\u2753\u2754]\ufe0f?)+\s*/gu, "");
  value = value.replace(
    /(^|\s)\?+\s*(?=(?:\*\*)?(?:what|which|who|when|where|why|how|should|does|do|is|are|can|could|will|would|may)\b)/giu,
    "$1",
  );
  value = value.replace(
    /(^|\s)\?+\s*(?=(?:\*\*)?\p{Lu}[^?\n]*\?)/gu,
    "$1",
  );
  value = value.replace(/\?+\*\*([^*\n]+\?)\*\*/gu, "**$1**");
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

function normalizeModelDisplayLines(lines: string[]): string[] {
  return reflowTerminalProse(lines.join("\n")
    // Some providers flatten a multi-line question into question-mark
    // separators. Restore only the known candidate/answer labels so prose
    // questions and business punctuation retain their original meaning.
    .replace(
      /(\?)\?+(?=(?:Candidate\s+\d+\s*:|Answer\s+with\b))/giu,
      "$1\n",
    )
    .replace(
      /(\])\?+(?=Candidate\s+\d+\s*:)/giu,
      "$1\n",
    )
    .replace(
      /([\p{L}\p{N}_)])\?+(?=Answer\s+with\b)/giu,
      "$1\n",
    )
  ).split("\n");
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
    const actionDependency = Number(contextValue(lines, "Dependent Action drafts:")) > 0;
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
  modelSelectionOrigin?: "current session" | "only configured provider detected";
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
  let progressMessage: string | undefined;
  const providerStatus = (message: string) => io.setStatus?.(progressMessage ? `${progressMessage} · ${message}` : message);
  const cancellation = new AbortController();
  const assertNotCancelled = () => {
    if (cancellation.signal.aborted) throw new AskError("ASK_CANCELLED", "Boundary conversation paused.", 499);
  };
  const removeInterrupt = io.onInterrupt(() => {
    if (closed || cancellation.signal.aborted) return;
    cancellation.abort();
    io.setStatus?.("Cancelling; waiting for current work to stop...");
  });
  let streamedCharacters = 0;
  let lastProviderStatusCharacters = 0;
  let latestDetails: { title: string; lines: string[] } | undefined;
  let permissionGuide: BoundaryAuthoringPermissionGuide | undefined;
  let lastTranscriptTurn: BoundaryAuthoringSpeaker | "operator" | "checkpoint" | undefined;
  let pendingConversationQuestion: {
    speaker: BoundaryAuthoringSpeaker;
    lines: string[];
  } | undefined;
  let liveRenderer: ReturnType<typeof createTerminalModelStream> | undefined;
  let liveText = "";
  let livePending = Promise.resolve();
  const liveResponses: string[] = [];
  const responseKey = (text: string) => transcriptText(text).trim().replace(/\s+/gu, " ");
  const transcriptIndent = io.isTerminal?.() === true ? "  " : "";
  const transcriptWidth = () => Math.max(24, io.columns());

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
    continueTurn = false,
  ): string[] => {
    const firstPrefix = index === 0 && !continueTurn
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
  const finishLiveResponse = () => {
    if (!liveRenderer) return;
    liveRenderer.finish();
    liveRenderer = undefined;
    liveResponses.push(responseKey(liveText));
    if (liveResponses.length > 12) liveResponses.shift();
    rememberPendingQuestion("model", liveText.split(/\r?\n/u));
    liveText = "";
  };
  const appendLiveText = (text: string) => {
    if (!liveRenderer) {
      const continuation = `${transcriptIndent}${" ".repeat(7)}`;
      liveRenderer = createTerminalModelStream({
        width: transcriptWidth,
        prefix: lastTranscriptTurn === "model" ? continuation : `${transcriptIndent}${role("model")} `,
        continuation,
        bold: theme.bold, code: theme.value,
        write: (chunk) => {
          livePending = livePending.then(async () => {
            if (cancellation.signal.aborted) return;
            io.clearStatus?.();
            writeTranscript(chunk);
            if (io.isTerminal?.() === true && streamLineDelayMs > 0) {
              const visible = Array.from(stripTerminalAnsi(chunk)).length;
              await new Promise<void>((resolve) => setTimeout(resolve, streamLineDelayMs * Math.min(1, visible / 14)));
            }
          });
        },
      });
    }
    liveText += text;
    liveRenderer.push(text);
    lastTranscriptTurn = "model";
  };
  const checkpoint = (
    title: string,
    lines: string[] = [],
    tone: BoundaryAuthoringTone = "success",
  ) => {
    lastTranscriptTurn = "checkpoint";
    const marker = tone === "success" ? "✓" : tone === "warning" ? "!" : tone === "danger" ? "×" : "·";
    const style = tone === "success"
      ? theme.success
      : tone === "warning"
        ? theme.warning
        : tone === "danger"
          ? theme.danger
          : theme.key;
    const facts = meaningfulContext(lines);
    const factStyle = (line: string, index: number) => {
      if (["READ REVIEW SUMMARY", "ACTION REVIEW", "Verified Action Boundary active"].includes(title)) {
        const label = line.match(/^(\S.{0,38}?)( {2,}|:)(.*)$/u);
        if (label) return `${/^(?:Privacy|UNMET)/u.test(label[1]!) ? theme.warning(label[1]!) : theme.key(label[1]!)}${label[2]}${theme.value(label[3]!)}`;
        return theme.value(line);
      }
      if (/^\|\s*DECISION\s*\|/u.test(line)) return theme.bold(line);
      if (/^\|\s*(?:Privacy decision|UNMET REQUEST|Automatic completion)\s*\|/u.test(line)) return theme.warning(line);
      if (/^\|/u.test(line)) return line;
      if (/^\+-/u.test(line)) return theme.dim(line);
      return index === 0 ? theme.value(line) : theme.dim(line);
    };
    const rendered = [
      `${transcriptIndent}${style(`${marker} ${transcriptText(title)}`)}`,
      ...facts.map((line, index) => `${transcriptIndent}  ${factStyle(line, index)}`),
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
    const continueTurn = speaker === "model" && lastTranscriptTurn === "model";
    writeTranscript(`${lines.flatMap((line, index) =>
      roleLines(speaker, line, index, firstStyle, continueTurn)).join("\n")}\n`);
    lastTranscriptTurn = speaker;
  };
  const rememberPendingQuestion = (
    speaker: BoundaryAuthoringSpeaker,
    lines: string[],
  ) => {
    const normalized = meaningfulContext(lines);
    let questionIndex = -1;
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      if (normalized[index]!.includes("?")) {
        questionIndex = index;
        break;
      }
    }
    pendingConversationQuestion = questionIndex < 0
      ? undefined
      : { speaker, lines: [normalized[questionIndex]!] };
  };
  const restorePendingQuestion = () => {
    if (!pendingConversationQuestion) return;
    lastTranscriptTurn = "checkpoint";
    const label = `${transcriptIndent}${theme.key("Pending:")} `;
    const labelWidth = Array.from(stripTerminalAnsi(label)).length;
    const content = pendingConversationQuestion.speaker === "model"
      ? renderInlineModelMarkdown(pendingConversationQuestion.lines[0]!, theme)
      : pendingConversationQuestion.lines[0]!;
    const wrapped = wrapStyledTerminalLine(
      content,
      Math.max(12, transcriptWidth() - labelWidth),
    ).map((line, index) => `${index === 0 ? label : " ".repeat(labelWidth)}${line}`);
    writeTranscript(`${wrapped.join("\n")}\n`);
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
  const model = (lines: string[]) => {
    const normalized = normalizeModelDisplayLines(lines);
    writeRole("model", normalized);
    rememberPendingQuestion("model", normalized);
  };
  const rememberDetails = (title: string, lines: string[]) => {
    const facts = meaningfulContext(lines);
    const normalizedTitle = transcriptText(title).trim().replace(/:$/u, "");
    while (facts.length && facts[0]!.trim().replace(/:$/u, "") === normalizedTitle) {
      facts.shift();
    }
    if (!facts.length) return;
    latestDetails = {
      title: normalizedTitle,
      lines: facts,
    };
  };
  const renderedDetails = (record: { title: string; lines: string[] }, wrap = true) => {
    const detailLines = record.lines.map((line) => {
      const safe = transcriptText(line);
      if (!safe.trim()) return "";
      if (/^\s*\|/u.test(safe)) return safe
        .replace(/\bModel \+ Runner\b/gu, (value) => theme.visible(value))
        .replace(/\bRunner only\b/gu, (value) => theme.runnerOnly(value))
        .replace(/\bKept out\b/gu, (value) => theme.keptOut(value));
      if (/^REVIEW BEFORE ACTIVATION:/u.test(safe)) return theme.warning(safe);
      if (/^[A-Z][A-Z0-9 /+_-]{2,}:?$/u.test(safe.trim())) return theme.title(safe.trim().replace(/:$/u, ""));
      const fact = safe.match(/^([^:]{1,40}):\s+(.+)$/u);
      if (fact && !/^\s*["{\[|]/u.test(safe)) {
        const value = fact[2]!.trim();
        const style = fact[1] === "Raw access" ? value === "RUNNER ONLY" ? theme.runnerOnly
          : value === "KEPT OUT" ? theme.keptOut : value === "MODEL RAW" ? theme.visible : theme.dim : theme.value;
        return `${theme.dim(`${fact[1]!.trim()}:`)} ${style(value)}`;
      }
      return safe;
    });
    return [theme.scope(record.title), ...detailLines, "",
      theme.dim("No model request, authority change, source query, or source write occurred.")]
      .flatMap((line) => wrap ? wrapStyledTerminalLine(line, transcriptWidth()) : [line]);
  };
  const showDetails = () => {
    lastTranscriptTurn = "checkpoint";
    if (!latestDetails) {
      runner("No Runner details yet", [
        "Details appear after Runner validates a model draft or prepares an exact authority decision.",
      ], "warning");
      return;
    }
    const rendered = [
      "",
      theme.title("RUNNER DETAILS"),
      ...renderedDetails(latestDetails),
      "",
    ].flatMap((line) => wrapStyledTerminalLine(line, transcriptWidth()));
    writeTranscript(rendered.join("\n"));
  };
  const showReviewDetails = async (title: string, lines: string[], returnTo?: string) => {
    finishLiveResponse();
    await livePending;
    rememberDetails(title, lines);
    lastTranscriptTurn = "checkpoint";
    // The pager owns wrapping so it can reflow both narrower and wider resizes.
    if (io.review && latestDetails) await io.review("EXACT REVIEW - READ ONLY", renderedDetails(latestDetails, false), returnTo);
    else showDetails();
  };
  const browseReviewSections = async (title: string, sections: ReviewSection[]): Promise<void> => {
    if (!io.choose) {
      const flatten = (items: ReviewSection[]): string[] => items.flatMap((section) =>
        [section.title, ...section.lines, ...flatten(section.children ?? [])]);
      await showReviewDetails(title, flatten(sections));
      return;
    }
    let initialValue: string | undefined;
    while (true) {
      const selected = await io.choose({ title, message: "Local review only. Select a section; Esc returns without changing the pending revision.",
        ...(initialValue ? { initialValue } : {}),
        options: [...sections.map((section, index) => ({ value: `section:${index}`, label: section.title })),
          { value: "back", label: "Return" }],
      });
      if (!selected || selected === "back") return;
      const section = sections[Number(selected.slice("section:".length))];
      if (!section) continue;
      initialValue = selected;
      if (section.children?.length) {
        await browseReviewSections(section.title, [{ id: "overview", title: "Overview", lines: section.lines }, ...section.children]);
      } else await showReviewDetails(section.title, section.lines, `${title} menu`);
    }
  };
  const showDiff = () => {
    lastTranscriptTurn = "checkpoint";
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
    lastTranscriptTurn = "checkpoint";
    const rendered = [
      "",
      theme.title("BOUNDARY AUTHORING COMMANDS"),
      `${theme.key("/attach ./rules.txt")}  ${theme.dim("Preview complete text and approve its model destination")}`,
      `${theme.key("/rules")}    ${theme.dim("View, paste, replace or remove retained rules")}`,
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
    const continueTurn = speaker === "model" && lastTranscriptTurn === "model";
    for (const [lineIndex, line] of lines.entries()) {
      const physicalLines = roleLines(speaker, line, lineIndex, firstStyle, continueTurn);
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
    lastTranscriptTurn = speaker;
  };
  const streamRunner = async (
    title: string,
    lines: string[] = [],
    tone: BoundaryAuthoringTone = "normal",
  ) => {
    finishLiveResponse();
    await livePending;
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
  const streamModel = async (lines: string[]) => {
    finishLiveResponse();
    await livePending;
    const streamed = liveResponses.indexOf(responseKey(lines.join("\n")));
    if (streamed >= 0) {
      liveResponses.splice(streamed, 1);
      rememberPendingQuestion("model", lines);
      return;
    }
    const normalized = normalizeModelDisplayLines(lines);
    await streamRole("model", normalized);
    rememberPendingQuestion("model", normalized);
  };
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
    pendingConversationQuestion = { speaker, lines: [prompt] };
    return readAnswer();
  };
  let sourceCommandHandler: ((command: string, argument: string) => Promise<boolean>) | undefined;
  let sourceHasDraft: (() => boolean) | undefined;
  let sourceAnswerRecorder: ((answer: string) => Promise<void>) | undefined;
  const readAnswer = async (defaultValue?: string, recordPolicyAnswer = true) => {
    finishLiveResponse();
    await livePending;
    io.clearStatus?.();
    let sourceChanged = false;
    while (true) {
      assertNotCancelled();
      const prompt = `${theme.focus("you>")} ${defaultValue && !sourceChanged ? `${theme.dim(`[${defaultValue}]`)} ` : ""}`;
      const answer = io.readConversation
        ? await io.readConversation(prompt)
        : io.readWithEscape
          ? await io.readWithEscape(prompt)
          : await io.read(prompt);
      lastTranscriptTurn = "operator";
      const trimmed = answer?.trim();
      let command = trimmed?.startsWith("/") ? trimmed.split(/\s+/u)[0]!.toLowerCase() : trimmed?.toLowerCase();
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
          restorePendingQuestion();
          continue;
        }
      }
      if (command === "/attach" || command === "/rules") {
        if (!sourceCommandHandler) checkpoint("Rules attachment unavailable here", ["Open model-guided Boundary setup; the pending decision is unchanged."], "warning");
        else {
          try {
            const changed = await sourceCommandHandler(command, trimmed!.slice(trimmed!.split(/\s+/u)[0]!.length).trim());
            sourceChanged ||= changed;
            if (changed) checkpoint("Rules context changed", [sourceHasDraft?.() || defaultValue
              ? "Describe how to use these rules for this same draft. Enter alone will not accept the old decision."
              : "What should the agent do using these rules? No Boundary has been drafted yet."], "normal");
          } catch (error) { checkpoint("Rules not changed", [safeTerminalText(error instanceof Error ? error.message : String(error))], "warning"); }
        }
        restorePendingQuestion();
        continue;
      }
      if (command === "/details") {
        showDetails();
        restorePendingQuestion();
        continue;
      }
      if (command === "/diff") {
        showDiff();
        restorePendingQuestion();
        continue;
      }
      if (command === "/exact") {
        showDetails();
        restorePendingQuestion();
        continue;
      }
      if (command === "/help") {
        showHelp();
        restorePendingQuestion();
        continue;
      }
      if (command?.startsWith("/")) {
        runner(`Unknown command: ${command}`, [
          "Type /help to list Boundary-authoring commands.",
          "The pending question and disabled draft are unchanged.",
        ], "warning");
        restorePendingQuestion();
        continue;
      }
      pendingConversationQuestion = undefined;
      if (answer?.trim() && sourceAnswerRecorder && (recordPolicyAnswer || sourceChanged)) {
        try { await sourceAnswerRecorder(answer); }
        catch (error) { checkpoint("Answer not sent", [safeTerminalText(error instanceof Error ? error.message : String(error))], "warning"); continue; }
      }
      if (sourceChanged && answer !== undefined) {
        const revising = sourceHasDraft?.() || defaultValue;
        if (!answer.trim()) { checkpoint("A decision is still needed", [revising
          ? "Describe how the changed rules should affect this draft, or press Esc to pause."
          : "Describe the agent's job using these rules, or press Esc to pause."], "normal"); continue; }
        return revising ? `Use the updated attached-rules context for this same draft. Operator instruction: ${answer}` : answer;
      }
      return answer;
    }
  };
  const choose = async (choice: ChoiceInput): Promise<string | undefined> => {
    finishLiveResponse();
    await livePending;
    assertNotCancelled();
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
      lastTranscriptTurn = "operator";
      return selected;
    }
    if (io.choose) {
      lastTranscriptTurn = "operator";
      return undefined;
    }
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
    verifiedCheckpointTitle?: string,
  ): Promise<string | undefined> => {
    const exactChoices = choice.options.filter((option) => !option.disabled);
    const request = {
      title: choice.title,
      prompt: choice.message,
      context: meaningfulContext(context),
      ...(choice.explanationContext ? { explanationContext: choice.explanationContext.map(transcriptText) } : {}),
      choices: exactChoices.map(({ value, label, detail }) => ({
        value,
        label: transcriptText(label),
        ...(detail ? { detail: transcriptText(detail) } : {}),
      })),
    } satisfies BoundaryAuthoringPermissionGuideInput;
    let explanationShown = false;
    let failure: AuthoringExplanationFailure | undefined;
    let lastQuestion: string | undefined;
    const exact: ChoiceInput["exactDetails"] = choice.exactDetails ? structuredClone(choice.exactDetails) : latestDetails ? structuredClone(latestDetails) : undefined;
    const retainExact = () => {
      if (exact) rememberDetails(exact.title, [...exact.lines, ...(failure ? ["", "EXPLANATION DIAGNOSTICS",
        `Category: ${failure.category}`, `Code: ${failure.code}`, `Retry possible: ${failure.retryable ? "yes" : "after correcting the reported issue"}`,
        failure.guidance, ...(failure.mismatch ? [`Mismatch: ${failure.mismatch}`] : []), "Pending authority revision unchanged."] : [])]);
    };
    retainExact();
    const hasExactDetailsChoice = choice.options.some((option) =>
      /\b(?:details|inspect exact|view exact)\b/iu.test(`${option.label} ${option.detail ?? ""}`));

    const explain = async (operatorQuestion?: string): Promise<void> => {
      if (!permissionGuide) return;
      lastQuestion = operatorQuestion;
      failure = undefined;
      let answer: string | undefined;
      try {
        answer = await permissionGuide({
          ...request,
          ...(operatorQuestion ? { operatorQuestion } : {}),
          onFailure: (diagnostic) => { failure = diagnostic; },
        });
      } catch (error) { failure = authoringExplanationFailure(error); }
      if (answer?.trim()) {
        await streamModel(answer.trim().split(/\r?\n/u));
        explanationShown = true;
        return;
      }
      failure ??= authoringExplanationFailure();
      retainExact();
      // The automatic narration is optional. Its failure must not look like a
      // failed authority operation or obscure the exact Runner confirmation.
      // Surface the outage only after the operator explicitly asks the model.
      if (operatorQuestion) {
        checkpoint("Model explanation unavailable", [
          `${failure.category}. ${failure.guidance}`,
          "The pending revision is unchanged. Exact details work without the model; diagnostics are included there.",
        ], "warning");
        retainExact();
        if (choice.exactDetails && !choice.exactDetails.sections) checkpoint("LOCAL REVIEW SUMMARY", request.context, "normal");
      }
    };

    if (!choice.explainOnRequest) await explain();
    if (failure && choice.exactDetails?.sections) {
      checkpoint("Showing Runner's verified review", ["Only the model explanation is unavailable. Retry or inspect diagnostics if needed; the draft is still available."], "normal");
    }
    if (choice.exactDetails) checkpoint(choice.exactDetails.summaryTitle ?? "READ REVIEW SUMMARY", request.context, "normal");
    retainExact();
    if (verifiedCheckpointTitle && request.context.length && !choice.exactDetails) {
      checkpoint(verifiedCheckpointTitle, request.context, "normal");
    }
    while (true) {
      const selected = await choose({
        ...choice,
        options: [
          ...choice.options.slice(0, 1),
          ...(failure?.retryable ? [{ value: "__retry_boundary_explanation__", label: "Retry model explanation",
            detail: "Retry only the explanation; keep the same pending authority revision." }] : []),
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
      if (selected === "__retry_boundary_explanation__") { await explain(lastQuestion); continue; }
      if (selected === "privacy_details" && exact?.sections) {
        const section = exact.sections.find((entry) => entry.id === "privacy_findings");
        if (section) await showReviewDetails(section.title, section.lines);
        retainExact();
        continue;
      }
      if ((selected === "details" && choice.exactDetails) || selected === viewRunnerDetailsChoiceValue) {
        retainExact();
        if (exact?.sections) {
          await browseReviewSections(exact.title, [...exact.sections, {
            id: "diagnostics", title: "Explanation diagnostics", lines: failure
              ? [`Category: ${failure.category}`, `Code: ${failure.code}`, `Retry possible: ${failure.retryable ? "yes" : "no"}`, failure.guidance,
                ...(failure.mismatch ? [`Mismatch: ${failure.mismatch}`] : []),
                "No correction was applied to authority. Explanation retry is optional; local details remain available."]
              : ["No explanation failure recorded for this pending review."],
          }]);
        } else if (latestDetails) await showReviewDetails(latestDetails.title, latestDetails.lines);
        continue;
      }
      if (selected !== askModelChoiceValue) return selected;

      // Inspection belongs in conversation history, not in governing policy.
      // A changed attachment still invalidates the prior review as usual.
      const operatorQuestion = await readAnswer(undefined, false);
      if (operatorQuestion === undefined || !operatorQuestion.trim()) continue;
      await explain(operatorQuestion.trim());
      if (!explanationShown) continue;
    }
  };
  const chooseReviewedDecision = async (choice: ChoiceInput): Promise<string | undefined> => {
    if (!latestDetails) return choose(choice);
    while (true) {
      const selected = await choose({
        ...choice,
        options: [
          ...choice.options.slice(0, 1),
          {
            value: viewRunnerDetailsChoiceValue,
            label: "View exact Runner details",
            detail: "Inspect the deterministic record without changing the disabled draft.",
          },
          ...choice.options.slice(1),
        ],
      });
      if (selected !== viewRunnerDetailsChoiceValue) return selected;
      showDetails();
    }
  };
  const confirm = async (
    prompt: string,
    options: NonNullable<Parameters<BoundaryReviewInteractiveSession["confirm"]>[1]> = {},
    kind: "decision" | "permission" = isPermissionPrompt(prompt, options.context) ? "permission" : "decision",
  ): Promise<boolean | undefined> => {
    const permission = kind === "permission";
    if (permission) {
      if (options.exactDetails) rememberDetails(options.exactDetails.title, options.exactDetails.lines);
      else rememberDetails("PERMISSION REQUEST", [...meaningfulContext(options.context), prompt]);
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
      ...(options.exactDetails ? { exactDetails: options.exactDetails } : {}),
      ...(/^Activate verified Action Boundary\b/u.test(prompt) ? { explainOnRequest: true } : {}),
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
      ? await choosePermission(choice, permissionContext, /^Activate verified Action Boundary\b/u.test(prompt) ? "ACTION REVIEW" : undefined)
      : await chooseReviewedDecision(choice);
    return selected === undefined ? undefined : selected === "yes";
  };

  const session: BoundaryReviewInteractiveSession = {
    get terminalColumns() { return io.columns(); },
    presentationMode: "conversation",
    present: runner,
    rememberDetails,
    showRememberedDetails: showDetails,
    showReviewDetails,
    showReviewSections: browseReviewSections,
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
      const permission = Boolean(options?.exactDetails) || /^(?:ACTIVATE|APPROVE|APPLY|GRANT)\b/iu.test(title.trim());
      if (permission) {
        if (options?.exactDetails) rememberDetails(options.exactDetails.title, options.exactDetails.lines);
        else rememberDetails("PERMISSION REQUEST", [...meaningfulContext(options?.context), title]);
      } else if (options?.context?.length) {
        const hasModelContext = options.context.some((line) =>
          /^(?:Model rationale|Model question|Model suggestion):/iu.test(line.trim()));
        if (hasModelContext) await writeContext(options.context);
        else rememberDetails(title, options.context);
      }
      const choice = {
        title: permission && !options?.reviewOnly ? "PERMISSION REQUIRED" : title,
        message: permission && !options?.reviewOnly
          ? permissionQuestion(title)
          : options?.displayContext && options.context?.length ? meaningfulContext(options.context).join(" ")
          : "Choose one path. The highlighted choice is not applied until you press Enter.",
        options: choices,
        ...(options?.initialValue ? { initialValue: options.initialValue } : {}),
        ...(options?.exactDetails ? { exactDetails: options.exactDetails } : {}),
        ...(options?.explainOnRequest ? { explainOnRequest: true } : {}),
        ...(options?.explanationContext ? { explanationContext: options.explanationContext } : {}),
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
      const actionActivation = /^ACTIVATE PROPOSAL ACTION$/iu.test(title.trim());
      if (permission && !actionActivation) {
        rememberDetails("PERMISSION REQUEST", [...meaningfulContext(context), title]);
      } else if (context?.length) {
        if (!actionActivation) rememberDetails(title, context);
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
        ? choosePermission(
            choice,
            context,
            actionActivation ? "RUNNER-VERIFIED ACTION AUTHORITY" : undefined,
          )
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
    `${theme.title("Boundary drafting")}${modelLabel ? theme.dim(` · ${modelLabel}${input.modelSelectionOrigin ? ` (${input.modelSelectionOrigin})` : ""}`) : ""}`,
    "",
  ].flatMap((line) => wrapStyledTerminalLine(line, transcriptWidth()));
  writeTranscript(intro.join("\n"));

  return {
    signal: cancellation.signal,
    session,
    actionPrompter,
    setModel: (label) => {
      modelLabel = label;
    },
    setPermissionGuide: (guide) => {
      permissionGuide = guide;
    },
    setSourceCommandHandler: (handler, hasDraft) => { sourceCommandHandler = handler; sourceHasDraft = hasDraft; },
    setSourceAnswerRecorder: (recorder) => { sourceAnswerRecorder = recorder; },
    readLiteral: async (prompt) => {
      finishLiveResponse(); await livePending; io.clearStatus?.();
      return io.readConversation ? io.readConversation(prompt, { literal: true }) : io.read(prompt);
    },
    runner,
    model,
    checkpoint,
    streamRunner,
    streamCheckpoint,
    streamModel,
    readOperator: readAnswer,
    rememberDetails,
    showDetails,
    providerStream: (event) => {
      if (cancellation.signal.aborted) return;
      if (event.operator_text && event.phase === "text_delta" && event.text) {
        appendLiveText(event.text);
        return;
      }
      if (event.operator_text && event.phase === "completed") {
        finishLiveResponse();
        return;
      }
      if (event.phase === "started") {
        streamedCharacters = 0;
        lastProviderStatusCharacters = 0;
        providerStatus(`${modelLabel ?? "Selected model"} is drafting...`);
        return;
      }
      if (event.phase === "tool_started") {
        providerStatus(`${modelLabel ?? "Selected model"} is building a structured draft for Runner validation...`);
        return;
      }
      if (event.phase === "text_delta" || event.phase === "tool_delta") {
        streamedCharacters += event.characters ?? 0;
        if (streamedCharacters - lastProviderStatusCharacters < 48) return;
        lastProviderStatusCharacters = streamedCharacters;
        providerStatus(
          `${modelLabel ?? "Selected model"} is responding... ${streamedCharacters.toLocaleString("en-US")} characters received; Runner has not accepted them`,
        );
        return;
      }
      providerStatus("Runner is validating the complete streamed draft...");
    },
    progress: async <T>(message: string, operation: () => Promise<T>) => {
      assertNotCancelled();
      const previousMessage = progressMessage;
      progressMessage = message;
      io.setStatus?.(message);
      try {
        const result = await operation();
        assertNotCancelled();
        finishLiveResponse();
        await livePending;
        assertNotCancelled();
        return result;
      } catch (error) {
        finishLiveResponse();
        await livePending;
        assertNotCancelled();
        throw error;
      } finally {
        progressMessage = previousMessage;
        if (previousMessage && !cancellation.signal.aborted) io.setStatus?.(previousMessage);
        else io.clearStatus?.();
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      removeInterrupt();
      cancellation.abort();
      io.close();
    },
  };
}

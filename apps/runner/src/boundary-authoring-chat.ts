import process from "node:process";
import type { ActionControlPrompter } from "./action-tui.js";
import {
  createTerminalAnalyticsShellIo,
  type AnalyticsShellIo,
} from "./analytics-shell.js";
import { safeTerminalText } from "./analytics-shell-render.js";
import {
  terminalTheme,
  type BoundaryPromptChoice,
  type BoundaryReviewInteractiveSession,
} from "./boundary-cli-picker.js";
import type { AskProviderStreamEvent } from "./model-ask.js";

export type BoundaryAuthoringSpeaker = "runner" | "model";

export type BoundaryAuthoringChat = {
  session: BoundaryReviewInteractiveSession;
  actionPrompter: ActionControlPrompter;
  setModel(label: string): void;
  runner(title: string, lines?: string[], tone?: "normal" | "success" | "warning" | "danger"): void;
  model(lines: string[]): void;
  streamRunner(title: string, lines?: string[], tone?: "normal" | "success" | "warning" | "danger"): Promise<void>;
  streamModel(lines: string[]): Promise<void>;
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

function stripTerminalAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function transcriptText(value: string): string {
  return safeTerminalText(stripTerminalAnsi(value));
}

function terminalOutputChunks(value: string, visibleLimit = 24): string[] {
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

function isModelQuestion(title: string | undefined, context: string[] | undefined): boolean {
  const heading = title ?? context?.[0] ?? "";
  return /^(?:ANSWER ONE BUSINESS QUESTION|SET (?:PROPOSAL RANGE|PROPOSAL FIELDS|ACTION TARGET|PROPOSAL EFFECT|CONFLICT AND RETRY GUARD)|CLARIFY ONE REVIEWED NAME|MODEL QUESTION|DESCRIBE THE AUTO-APPROVAL RULE)/iu
    .test(heading.trim());
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
  const io = input.io ?? createTerminalAnalyticsShellIo({ slashCommands: false });
  const color = input.color ?? (io.isTerminal?.() === true && !("NO_COLOR" in process.env));
  const theme = terminalTheme(color, { brand: true });
  const streamLineDelayMs = input.streamLineDelayMs
    ?? (input.io ? 0 : io.isTerminal?.() === true ? 28 : 0);
  let modelLabel = input.modelLabel;
  let closed = false;
  let streamedCharacters = 0;
  const transcriptIndent = io.isTerminal?.() === true ? "  " : "";

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
    let content = index === 0 && firstStyle ? firstStyle(safe) : safe;
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
  const roleLine = (
    speaker: BoundaryAuthoringSpeaker,
    line: string,
    index: number,
    firstStyle?: (value: string) => string,
  ): string => {
    const prefix = index === 0
      ? `${transcriptIndent}${role(speaker)}`
      : `${transcriptIndent}${" ".repeat(speaker === "model" ? 6 : 7)}`;
    return `${prefix} ${roleContent(speaker, line, index, firstStyle)}`;
  };
  const writeTranscript = (value: string) => {
    if (io.writeChunk) io.writeChunk(value);
    else io.write(value);
  };
  const writeRole = (
    speaker: BoundaryAuthoringSpeaker,
    lines: string[],
    firstStyle?: (value: string) => string,
  ) => {
    if (!lines.length) return;
    writeTranscript(`${lines.map((line, index) => roleLine(speaker, line, index, firstStyle)).join("\n")}\n`);
  };
  const runner = (
    title: string,
    lines: string[] = [],
    tone: "normal" | "success" | "warning" | "danger" = "normal",
  ) => {
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
      const chunks = terminalOutputChunks(roleLine(speaker, line, lineIndex, firstStyle));
      for (const [chunkIndex, chunk] of chunks.entries()) {
        writeTranscript(chunk);
        const finalChunk = lineIndex === lines.length - 1 && chunkIndex === chunks.length - 1;
        if (!finalChunk) await waitForNextStreamChunk();
      }
      writeTranscript("\n");
    }
  };
  const streamRunner = async (
    title: string,
    lines: string[] = [],
    tone: "normal" | "success" | "warning" | "danger" = "normal",
  ) => {
    const titleStyle = tone === "success"
      ? theme.success
      : tone === "warning"
        ? theme.warning
        : tone === "danger"
          ? theme.danger
          : theme.bold;
    await streamRole("runner", [title, ...lines], titleStyle);
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
    if (runnerLines.length) await streamRunner(runnerLines[0]!, runnerLines.slice(1));
    if (modelLines.length) await streamModel(modelLines);
  };
  const read = async (prompt: string, speaker: BoundaryAuthoringSpeaker = "runner") => {
    writeRole(speaker, [prompt]);
    return io.readWithEscape
      ? io.readWithEscape(`${theme.focus("you>")} `)
      : io.read(`${theme.focus("you>")} `);
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
  const confirm = async (
    prompt: string,
    options: { context?: string[]; defaultValue?: boolean } = {},
    kind: "decision" | "permission" = isPermissionPrompt(prompt, options.context) ? "permission" : "decision",
  ): Promise<boolean | undefined> => {
    await writeContext(options.context);
    const permission = kind === "permission";
    if (permission) {
      runner("Permission request", [prompt]);
    }
    const yesLabel = permission ? "Allow this exact step" : "Yes, continue";
    const noLabel = permission ? "Not now; keep authority unchanged" : "No; go back";
    const selected = await choose({
      title: permission ? "PERMISSION REQUIRED" : "CONFIRM REVIEWED DECISION",
      message: permission ? "Allow the exact step described above?" : prompt,
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
    });
    return selected === undefined ? undefined : selected === "yes";
  };

  const session: BoundaryReviewInteractiveSession = {
    presentationMode: "conversation",
    present: runner,
    chooseResource: async () => undefined,
    editFieldTiers: async () => undefined,
    promptText: async (prompt, options) => {
      const speaker = isModelQuestion(undefined, options?.context) ? "model" : "runner";
      await writeContext(options?.context, speaker === "model" ? "runner" : "runner");
      return read(prompt.replace(/:\s*$/u, ""), speaker);
    },
    chooseOption: async (title, choices, options) => {
      await writeContext(options?.context);
      const permission = /^(?:ACTIVATE|APPROVE|APPLY|GRANT)\b/iu.test(title.trim());
      if (permission) runner("Permission request", [title]);
      return choose({
        title: permission ? "PERMISSION REQUIRED" : title,
        message: permission
          ? "Choose the exact authority change. The safe choice is highlighted."
          : "Choose one path. The highlighted choice is not applied until you press Enter.",
        options: choices,
        ...(options?.initialValue ? { initialValue: options.initialValue } : {}),
      });
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
    choose: async (title, choices, context, initialValue) => {
      await writeContext(context);
      const permission = /^(?:ACTIVATE|APPROVE|APPLY)\b/iu.test(title.trim());
      const safePermissionChoice = permission
        ? choices.find((choice) => !choice.disabled && /^(?:back|no|cancel|decline|disabled|leave)$/iu.test(choice.value))
        : undefined;
      return choose({
        title: permission ? "PERMISSION REQUIRED" : title,
        message: permission
          ? `${title}. Only the exact selected authority may change.`
          : "Review the exact choices, then select one.",
        options: choices,
        ...(safePermissionChoice
          ? { initialValue: safePermissionChoice.value }
          : initialValue
            ? { initialValue }
            : {}),
      });
    },
    text: async (label, options) => {
      const speaker = isModelQuestion(options?.title, options?.context) ? "model" : "runner";
      await writeContext(options?.context);
      if (options?.title) runner(options.title);
      const suffix = options?.defaultValue ? ` [${options.defaultValue}]` : "";
      const answer = await read(`${label}${suffix}`, speaker);
      return answer === "" && options?.defaultValue ? options.defaultValue : answer;
    },
    confirm: (label, defaultValue) => confirm(label, { defaultValue }),
    message: async (title, lines) => {
      const modelRationale = lines.find((line) => /^Model rationale:/iu.test(line));
      const runnerLines = modelRationale ? lines.filter((line) => line !== modelRationale) : lines;
      await streamRunner(title, runnerLines);
      if (modelRationale) await streamModel([modelRationale.replace(/^Model rationale:\s*/iu, "")]);
    },
  };

  runner("BOUNDARY AUTHORING", [
    `${modelLabel ? `Drafting model: ${modelLabel}. ` : ""}State one agent job, then answer only the business questions Runner cannot prove from schema structure.`,
    "Model suggestions are untrusted. Runner validates exact structure and asks separately before Read or Action authority is activated.",
    "Esc pauses safely. Manual editors remain available without discarding saved disabled drafts.",
  ]);

  return {
    session,
    actionPrompter,
    setModel: (label) => {
      modelLabel = label;
      runner("Drafting model selected", [label]);
    },
    runner,
    model,
    streamRunner,
    streamModel,
    providerStream: (event) => {
      if (event.phase === "started") {
        streamedCharacters = 0;
        io.setStatus?.(`${modelLabel ?? "Selected model"} is drafting...`);
        return;
      }
      if (event.phase === "tool_started") {
        io.setStatus?.(`${modelLabel ?? "Selected model"} is building a structured draft for Runner validation...`);
        return;
      }
      if (event.phase === "text_delta" || event.phase === "tool_delta") {
        streamedCharacters += event.characters ?? 0;
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

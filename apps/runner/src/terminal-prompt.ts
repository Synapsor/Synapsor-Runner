import readline from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import {
  padTerminalBlock,
  padTerminalLine,
  terminalContentWidth,
  wrapStyledTerminalLine,
} from "./terminal-layout.js";
import { safeTerminalText } from "./terminal-syntax.js";

export type TerminalKeypress = {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
};

type PromptKey = TerminalKeypress;

export type InPlaceTerminalRenderer = {
  render(lines: string[]): void;
  clear(): void;
};

type InPlaceTerminalRendererOptions = {
  maxRows?: () => number | undefined;
  bodyScrollOffset?: () => number;
};

export function fitTerminalFrameToRows(
  lines: string[],
  maxRows: number | undefined,
  bodyScrollOffset = 0,
): string[] {
  if (maxRows === undefined || !Number.isFinite(maxRows)) return lines;
  const limit = Math.max(1, Math.floor(maxRows));
  if (lines.length <= limit) return lines;
  if (limit === 1) return [lines[focusedTerminalFrameLine(lines) ?? 0] ?? ""];
  if (limit < 7) {
    const focus = focusedTerminalFrameLine(lines);
    const essential = [
      lines[0]!,
      ...(focus !== undefined && focus > 0 && focus < lines.length - 1 ? [lines[focus]!] : []),
      terminalFrameOmission(lines.length - limit),
      lines.at(-1)!,
    ];
    return essential.slice(0, limit);
  }

  const headerRows = Math.min(limit >= 18 ? 3 : 1, lines.length);
  const footerRows = Math.min(
    limit >= 10 ? 5 : limit >= 6 ? 3 : 2,
    lines.length - headerRows,
  );
  const bodyStartBoundary = headerRows;
  const bodyEndBoundary = lines.length - footerRows;
  const bodyBudget = Math.max(1, limit - headerRows - footerRows - 2);
  const focus = focusedTerminalFrameLine(lines);
  const desiredStart = focus !== undefined && focus >= bodyStartBoundary && focus < bodyEndBoundary
    ? focus - Math.floor(bodyBudget / 4)
    : bodyStartBoundary;
  const automaticBodyStart = Math.max(
    bodyStartBoundary,
    Math.min(desiredStart, Math.max(bodyStartBoundary, bodyEndBoundary - bodyBudget)),
  );
  let bodyStart = Math.max(
    bodyStartBoundary,
    Math.min(
      automaticBodyStart + Math.trunc(bodyScrollOffset),
      Math.max(bodyStartBoundary, bodyEndBoundary - bodyBudget),
    ),
  );
  let bodyEnd = Math.min(bodyEndBoundary, bodyStart + bodyBudget);

  const build = () => {
    const result = lines.slice(0, headerRows);
    if (bodyStart > bodyStartBoundary) {
      result.push(terminalFrameOmission(bodyStart - bodyStartBoundary));
    }
    result.push(...lines.slice(bodyStart, bodyEnd));
    if (bodyEnd < bodyEndBoundary) {
      result.push(terminalFrameOmission(bodyEndBoundary - bodyEnd));
    }
    result.push(...lines.slice(bodyEndBoundary));
    return result;
  };

  let fitted = build();
  while (fitted.length < limit && bodyEnd < bodyEndBoundary) {
    bodyEnd += 1;
    fitted = build();
  }
  while (fitted.length < limit && bodyStart > bodyStartBoundary) {
    bodyStart -= 1;
    fitted = build();
  }
  while (fitted.length > limit && bodyEnd - bodyStart > 1) {
    if (focus !== undefined && bodyStart < focus) bodyStart += 1;
    else bodyEnd -= 1;
    fitted = build();
  }
  return fitted.slice(0, limit);
}

function focusedTerminalFrameLine(lines: string[]): number | undefined {
  const index = lines.findIndex((line) =>
    /^\s*>\s/u.test(line.replace(/\u001b\[[0-9;]*m/gu, "")));
  return index >= 0 ? index : undefined;
}

function terminalFrameOmission(count: number): string {
  return `  ... ${count} ${count === 1 ? "row" : "rows"} hidden ...`;
}

/**
 * Redraws a terminal frame without writing a newline after its last row.
 * A trailing newline at the bottom of a terminal scrolls the viewport on every
 * keypress, even when the following redraw moves the cursor back up.
 */
export function createInPlaceTerminalRenderer(
  output: Pick<WriteStream, "write">,
  options: InPlaceTerminalRendererOptions = {},
): InPlaceTerminalRenderer {
  let renderedLines = 0;

  const moveToFrameStart = () => {
    if (renderedLines > 1) {
      output.write(`\u001b[${renderedLines - 1}F`);
    } else {
      output.write("\r");
    }
  };

  return {
    render(lines) {
      const maxRows = options.maxRows?.();
      if (maxRows !== undefined && renderedLines > Math.max(1, Math.floor(maxRows))) {
        output.write("\u001b[2J\u001b[H");
        renderedLines = 0;
      }
      const visibleLines = fitTerminalFrameToRows(
        lines,
        maxRows,
        options.bodyScrollOffset?.() ?? 0,
      );
      const targetLines = Math.max(renderedLines, visibleLines.length);
      if (!targetLines) return;
      if (renderedLines) moveToFrameStart();
      else output.write("\r");

      for (let index = 0; index < targetLines; index += 1) {
        output.write(`\u001b[2K${visibleLines[index] ?? ""}`);
        if (index < targetLines - 1) output.write("\r\n");
      }
      renderedLines = targetLines;
    },
    clear() {
      if (!renderedLines) return;
      moveToFrameStart();
      output.write("\u001b[0J");
      renderedLines = 0;
    },
  };
}

export async function withAlternateTerminalScreen<T>(
  output: WriteStream,
  operation: () => Promise<T>,
): Promise<T> {
  if (!output.isTTY) return operation();
  output.write("\u001b[?1049h\u001b[H\u001b[2J");
  try {
    return await operation();
  } finally {
    output.write("\u001b[0m\u001b[?25h\u001b[?1049l");
  }
}

export async function withTerminalProgress<T>(
  output: WriteStream,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  const safeMessage = safeTerminalText(message).replace(/\s+/gu, " ").trim();
  if (!output.isTTY) {
    output.write(`${safeMessage}...\n`);
    return operation();
  }

  const frames = ["|", "/", "-", "\\"] as const;
  let frame = 0;
  const render = () => {
    output.write(`\r\u001b[2K${frames[frame % frames.length]} ${safeMessage}`);
    frame += 1;
  };
  output.write("\u001b[?25l");
  render();
  const timer = setInterval(render, 90);
  timer.unref();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
    output.write("\r\u001b[2K\u001b[?25h");
  }
}

export async function readTerminalTextWithEscape(
  prompt: string,
  input: ReadStream,
  output: WriteStream,
): Promise<string | undefined> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive text input requires a real terminal.");
  }
  const promptLines = padTerminalBlock(prompt).split("\n");
  const questionPrompt = promptLines.pop() ?? "";
  if (promptLines.length) output.write(`${promptLines.join("\n")}\n`);
  const rl = readline.createInterface({ input, output, terminal: true });
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      input.off("keypress", onKeypress);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onError);
      rl.close();
      resolve(value);
    };
    const onEnd = () => finish(undefined);
    const onError = () => finish(undefined);
    const onKeypress = (_text: string, key: PromptKey) => {
      if (key.name !== "escape" && key.sequence !== "\u001b") return;
      output.write("\n");
      finish(undefined);
    };
    input.on("keypress", onKeypress);
    input.once("end", onEnd);
    input.once("close", onEnd);
    input.once("error", onError);
    rl.question(questionPrompt, (value) => finish(value.trim()));
  });
}

/**
 * Owns raw terminal input and an in-place rendered screen for one interaction.
 * Returning from the operation removes every listener and restores the prior
 * terminal mode before a caller opens any readline prompt.
 */
export async function withRawTerminalScreen<T>(
  input: ReadStream,
  output: WriteStream,
  operation: (
    nextKey: () => Promise<TerminalKeypress>,
    render: (lines: string[]) => void,
  ) => Promise<T>,
): Promise<T> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive terminal navigation requires a real terminal.");
  }
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  let bodyScrollOffset = 0;
  const renderer = createInPlaceTerminalRenderer(output, {
    maxRows: () => output.rows,
    bodyScrollOffset: () => bodyScrollOffset,
  });
  let latestLines: string[] = [];
  const queuedKeys: TerminalKeypress[] = [];
  const keyWaiters: Array<(key: TerminalKeypress) => void> = [];
  let terminalClosed = false;
  const closedKey: TerminalKeypress = { name: "escape", sequence: "\u001b" };
  const keyHandler = (_text: string, key: TerminalKeypress) => {
    const waiter = keyWaiters.shift();
    if (waiter) waiter(key);
    else queuedKeys.push(key);
  };
  const closeHandler = () => {
    terminalClosed = true;
    for (const waiter of keyWaiters.splice(0)) waiter(closedKey);
  };
  readline.emitKeypressEvents(input);
  input.on("keypress", keyHandler);
  input.once("end", closeHandler);
  input.once("close", closeHandler);
  input.once("error", closeHandler);
  input.setRawMode(true);
  input.resume();
  output.write("\u001b[?25l");
  const paintLatestFrame = () => renderer.render(latestLines);
  const render = (lines: string[]) => {
    const width = terminalContentWidth(output.columns);
    const normalized = lines.flatMap((line) =>
      wrapStyledTerminalLine(line, width).map((wrapped) => padTerminalLine(wrapped)));
    const maxRows = output.rows;
    latestLines = maxRows !== undefined && normalized.length > maxRows
      ? [...normalized, padTerminalLine("  PgUp/PgDn Scroll hidden details")]
      : normalized;
    paintLatestFrame();
  };
  const readNextKey = () => {
    const queued = queuedKeys.shift();
    if (queued) return Promise.resolve(queued);
    if (terminalClosed) return Promise.resolve(closedKey);
    return new Promise<TerminalKeypress>((resolve) => keyWaiters.push(resolve));
  };
  const nextKey = async (): Promise<TerminalKeypress> => {
    while (true) {
      const key = await readNextKey();
      if (key.name === "pageup" || key.name === "pagedown") {
        const pageRows = Math.max(1, (output.rows ?? 24) - 8);
        const candidateOffset = bodyScrollOffset
          + (key.name === "pageup" ? -pageRows : pageRows);
        const currentPage = fitTerminalFrameToRows(
          latestLines,
          output.rows,
          bodyScrollOffset,
        ).join("\n");
        const candidatePage = fitTerminalFrameToRows(
          latestLines,
          output.rows,
          candidateOffset,
        ).join("\n");
        if (candidatePage !== currentPage) bodyScrollOffset = candidateOffset;
        paintLatestFrame();
        continue;
      }
      bodyScrollOffset = 0;
      return key;
    }
  };
  try {
    return await operation(nextKey, render);
  } finally {
    input.off("keypress", keyHandler);
    input.off("end", closeHandler);
    input.off("close", closeHandler);
    input.off("error", closeHandler);
    renderer.clear();
    output.write("\u001b[?25h");
    input.setRawMode(wasRaw);
    if (!wasFlowing) input.pause();
  }
}

export async function readTerminalActivationConfirmation(
  prompt: string,
  input: ReadStream,
  output: WriteStream,
): Promise<boolean | undefined> {
  return readTerminalBooleanConfirmation(
    `${prompt} [y/N] [Esc Back]: `,
    input,
    output,
    {
      defaultValue: false,
      requireExplicitYes: true,
      enterNotice: "Press Y to activate, or N/Esc to cancel. Enter alone does not activate.",
    },
  );
}

export async function readTerminalBooleanConfirmation(
  prompt: string,
  input: ReadStream,
  output: WriteStream,
  options: {
    defaultValue?: boolean;
    requireExplicitYes?: boolean;
    enterNotice?: string;
  } = {},
): Promise<boolean | undefined> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive confirmation requires a real terminal.");
  }
  const promptLines = padTerminalBlock(prompt).split("\n");
  let notice = "";
  return withRawTerminalScreen(input, output, async (nextKey, render) => {
    while (true) {
      render([
        ...promptLines,
        ...(notice ? ["", `  ${notice}`] : []),
        "",
        "  Y Yes   N No   Esc Back",
      ]);
      const key = await nextKey();
      const value = (key.sequence ?? "").toLowerCase();
      if (key.name === "y" || value === "y") {
        return true;
      }
      if (key.name === "n" || value === "n") {
        return false;
      }
      if (key.name === "escape" || key.sequence === "\u001b"
        || (key.ctrl && ["c", "d"].includes(key.name ?? ""))) {
        return undefined;
      }
      if (key.name === "return" || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n") {
        if (!options.requireExplicitYes) return options.defaultValue === true;
        notice = options.enterNotice
          ?? "Press Y to confirm, or N/Esc to cancel. Enter alone does not confirm.";
      }
    }
  });
}

import readline from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import {
  padTerminalBlock,
  padTerminalLine,
  terminalContentWidth,
  wrapStyledTerminalLine,
} from "./terminal-layout.js";

export type TerminalKeypress = {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
};

type PromptKey = TerminalKeypress;

export async function withAlternateTerminalScreen<T>(
  output: WriteStream,
  operation: () => Promise<T>,
): Promise<T> {
  if (!output.isTTY) return operation();
  output.write("\u001b[?1049h\u001b[H\u001b[2J");
  try {
    return await operation();
  } finally {
    output.write("\u001b[?25h\u001b[?1049l");
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
    rl.question(padTerminalBlock(prompt), (value) => finish(value.trim()));
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
  const wasPaused = input.isPaused();
  let renderedLines = 0;
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
  const render = (lines: string[]) => {
    if (renderedLines) output.write(`\u001b[${renderedLines}F`);
    const width = Math.max(36, Math.min(terminalContentWidth(output.columns), 116));
    const normalized = lines.flatMap((line) =>
      wrapStyledTerminalLine(line, width).map((wrapped) => padTerminalLine(wrapped)));
    const targetLines = Math.max(renderedLines, normalized.length);
    for (let index = 0; index < targetLines; index += 1) {
      output.write(`\u001b[2K${normalized[index] ?? ""}\n`);
    }
    renderedLines = targetLines;
  };
  const nextKey = () => {
    const queued = queuedKeys.shift();
    if (queued) return Promise.resolve(queued);
    if (terminalClosed) return Promise.resolve(closedKey);
    return new Promise<TerminalKeypress>((resolve) => keyWaiters.push(resolve));
  };
  try {
    return await operation(nextKey, render);
  } finally {
    input.off("keypress", keyHandler);
    input.off("end", closeHandler);
    input.off("close", closeHandler);
    input.off("error", closeHandler);
    if (renderedLines) output.write(`\u001b[${renderedLines}F\u001b[0J`);
    output.write("\u001b[?25h");
    input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
  }
}

export async function readTerminalActivationConfirmation(
  prompt: string,
  input: ReadStream,
  output: WriteStream,
): Promise<boolean | undefined> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive activation confirmation requires a real terminal.");
  }
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write(padTerminalBlock(`${prompt} [y/N] [Esc Back]: `));

  return new Promise<boolean | undefined>((resolve) => {
    let settled = false;
    const finish = (value: boolean | undefined) => {
      if (settled) return;
      settled = true;
      input.off("keypress", onKeypress);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onError);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      resolve(value);
    };
    const onEnd = () => {
      output.write("\nActivation was not confirmed. No authority changed.\n");
      finish(undefined);
    };
    const onError = () => onEnd();
    const onKeypress = (_text: string, key: PromptKey & { ctrl?: boolean }) => {
      const value = (key.sequence ?? "").toLowerCase();
      if (key.name === "y" || value === "y") {
        output.write("y\n");
        finish(true);
        return;
      }
      if (key.name === "n" || value === "n") {
        output.write("n\n");
        finish(false);
        return;
      }
      if (key.name === "escape" || key.sequence === "\u001b" || (key.ctrl && key.name === "d")) {
        output.write("\nActivation cancelled. No authority changed.\n");
        finish(undefined);
        return;
      }
      if (key.name === "return" || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n") {
        output.write("\nPress Y to activate, or N/Esc to cancel. Enter alone does not activate.\n");
        output.write(padTerminalBlock(`${prompt} [y/N] [Esc Back]: `));
      }
    };

    input.on("keypress", onKeypress);
    input.once("end", onEnd);
    input.once("close", onEnd);
    input.once("error", onError);
  });
}

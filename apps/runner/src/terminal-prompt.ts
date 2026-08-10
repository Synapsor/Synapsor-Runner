import readline from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import { padTerminalBlock } from "./terminal-layout.js";

type PromptKey = {
  name?: string;
  sequence?: string;
};

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

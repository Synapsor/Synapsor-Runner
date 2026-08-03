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
      rl.close();
      resolve(value);
    };
    const onKeypress = (_text: string, key: PromptKey) => {
      if (key.name !== "escape" && key.sequence !== "\u001b") return;
      output.write("\n");
      finish(undefined);
    };
    input.on("keypress", onKeypress);
    rl.question(padTerminalBlock(prompt), (value) => finish(value.trim()));
  });
}

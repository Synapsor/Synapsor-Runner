import process from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import { padTerminalBlock } from "./terminal-layout.js";

const MAX_SECRET_BYTES = 4_096;

export class ProviderCredentialInputCancelledError extends Error {
  constructor() {
    super("Provider credential input cancelled.");
    this.name = "ProviderCredentialInputCancelledError";
  }
}

export async function readHiddenSecret(
  prompt: string,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Hidden provider credential input requires an interactive terminal.");
  }
  output.write(padTerminalBlock(prompt));
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  let value = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        input.off("data", onData);
        output.write("\n");
        if (error) reject(error);
        else resolve(validateSecret(value));
      };
      const onData = (chunk: string | Buffer) => {
        for (const character of String(chunk)) {
          if (character === "\u0003") {
            finish(new ProviderCredentialInputCancelledError());
            return;
          }
          if (character === "\u001b") {
            finish(new ProviderCredentialInputCancelledError());
            return;
          }
          if (character === "\r" || character === "\n") {
            finish();
            return;
          }
          if (character === "\u007f" || character === "\b") {
            value = [...value].slice(0, -1).join("");
            continue;
          }
          if (/[\u0000-\u001f]/.test(character)) continue;
          value += character;
          if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
            finish(new Error("Provider credential exceeds the safe input limit."));
            return;
          }
        }
      };
      input.on("data", onData);
    });
  } finally {
    input.setRawMode(wasRaw);
    if (!wasFlowing) input.pause();
  }
}

function validateSecret(value: string): string {
  const secret = value.trim();
  if (secret.length < 8 || Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) {
    throw new Error("Provider credential is missing or outside the safe input limit.");
  }
  if (/[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error("Provider credential contains a control character.");
  }
  return secret;
}

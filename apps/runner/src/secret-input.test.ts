import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { describe, expect, it } from "vitest";
import {
  ProviderCredentialInputCancelledError,
  readHiddenSecret,
} from "./secret-input.js";

describe("hidden provider credential input", () => {
  it("treats Escape as a safe cancellation without retaining partial input", async () => {
    const { input, output } = fakeTerminal();
    const secret = readHiddenSecret(
      "OpenAI API key (hidden, memory only) [Esc Back]: ",
      input,
      output,
    );
    input.write("partial-secret\u001b");
    await expect(secret).rejects.toBeInstanceOf(ProviderCredentialInputCancelledError);
    const rendered = output.read()?.toString() ?? "";
    expect(rendered).toContain("[Esc Back]");
    expect(rendered).not.toContain("partial-secret");
  });

  it("still accepts a valid hidden credential with Enter", async () => {
    const { input, output } = fakeTerminal();
    const secret = readHiddenSecret("Provider key: ", input, output);
    input.write("owner-secret-value\n");
    await expect(secret).resolves.toBe("owner-secret-value");
  });
});

function fakeTerminal(): {
  input: ReadStream & PassThrough;
  output: WriteStream & PassThrough;
} {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(value: boolean): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value: boolean) => {
    input.isRaw = value;
  };
  const output = new PassThrough() as WriteStream & PassThrough;
  Object.assign(output, { isTTY: true });
  return {
    input: input as unknown as ReadStream & PassThrough,
    output,
  };
}

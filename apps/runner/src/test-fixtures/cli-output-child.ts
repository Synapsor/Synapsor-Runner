import process from "node:process";
import fs from "node:fs/promises";
import { runCliEntrypoint } from "../cli-output.js";

const mode = process.argv[2];
runCliEntrypoint(async () => {
  // Deliberately retain a handle to exercise the entrypoint's explicit exit.
  setInterval(() => undefined, 60_000);
  if (mode === "ndjson") {
    for (let index = 0; index < 768; index += 1) {
      process.stdout.write(`${JSON.stringify({ index, value: "café 漢字 🧪 ".repeat(96) })}\n`);
    }
    process.stdout.write(`${JSON.stringify({ tail: "TAIL-終わり" })}\n`);
    return 0;
  }
  const output = `${"DERIVED café 漢字 🧪\n".repeat(32_768)}TAIL-終わり\n`;
  if (mode === "stderr") process.stderr.write(output);
  else process.stdout.write(output);
  if (mode === "pending-write-error") {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fs.writeFile(process.argv[3]!, "pending command completed\n");
  }
  return mode === "stderr" ? 7 : 0;
});

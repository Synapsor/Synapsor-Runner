/** Actual terminal presenter and public Resume route. The preparation supplied
 * fictional metadata; no provider response is needed or allowed in these rounds. */
import fs from "node:fs/promises";
import path from "node:path";
import { boundaryReviewCommand } from "../boundary-commands.js";
import { createBoundaryReviewInteractiveSession } from "../boundary-cli-picker.js";
import { createBoundaryAuthoringChat } from "../boundary-authoring-chat.js";
import { ownedProgramInspection } from "./owned-authoring-program.js";

const [root, capture] = process.argv.slice(2);
if (!root || !capture || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Owned project, capture and real terminal required.");
process.env.OWNED_READ_PROCESS_URL = "postgresql://fixture.invalid/never-opened";
globalThis.fetch = async () => { throw new Error("External transport forbidden."); };
let requests = 0;
const record = async (name: string, value: unknown) => fs.writeFile(path.join(capture, name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
await record("child.json", { pid: process.pid, terminal: { input: process.stdin.isTTY, output: process.stdout.isTTY } });
for (let round = 1; round <= 2; round++) {
  const code = await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], async () => ownedProgramInspection(),
    createBoundaryReviewInteractiveSession(process.stdin, process.stdout), undefined, {
      startWithAgentJob: true, exitAfterAgentJob: true, actionProjectInspector: async () => ownedProgramInspection(),
      modelAuthoringSession: { provider: "openai", model: "owned-read-offline", apiKey: "inert-offline-key",
        dependencies: { requestJson: async () => { requests++; throw new Error("Cancelled/declined Read needs no model call."); } } },
      // Omit IO: the ordinary terminal shell owns input, default choices and display.
      boundaryAuthoringChatFactory: selection => createBoundaryAuthoringChat({ ...selection, color: false, streamLineDelayMs: 0 }),
    });
  const resume = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
  await record(`round-${round}.json`, { code, requests, resume });
  process.stdout.write(`\nREAD_PTY_DONE=${round}\n`);
}
process.stdout.write(`\nREAD_PTY_CLOSED=${process.pid}\n`);

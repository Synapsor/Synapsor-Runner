/** Genuine producer-created saved question is prepared by the shared public
 * process fixture. This child uses only the production terminal and public Resume. */
import fs from "node:fs/promises";
import path from "node:path";
import { boundaryReviewCommand } from "../boundary-commands.js";
import { createBoundaryReviewInteractiveSession } from "../boundary-cli-picker.js";
import { createBoundaryAuthoringChat } from "../boundary-authoring-chat.js";
import { actionPublicProcessInspection, ACTION_PUBLIC_PROCESS_FACTS as facts } from "./source-action-public-process-contract.js";
const [root, capture] = process.argv.slice(2);
if (!root || !capture || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Owned project, capture and real terminal required.");
process.env.OWNED_ACTION_PUBLIC_PROCESS_URL = "postgresql://fixture.invalid/never-opened";
globalThis.fetch = async () => { throw new Error("External transport forbidden."); };
let requests = 0;
const record = async (name: string, value: unknown) => fs.writeFile(path.join(capture, name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
await record("child.json", { pid: process.pid, terminal: { input: process.stdin.isTTY, output: process.stdout.isTTY } });
for (let round = 1; round <= 5; round++) {
  const code = await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], async () => actionPublicProcessInspection(),
    createBoundaryReviewInteractiveSession(process.stdin, process.stdout), undefined, {
      startWithAgentJob: true, exitAfterAgentJob: true, actionProjectInspector: async () => actionPublicProcessInspection(),
      modelAuthoringSession: { provider: "openai", model: facts.model, apiKey: "inert-offline-key",
        dependencies: { requestJson: async () => { requests++; throw new Error("Pending Action needs no model call."); } } },
      boundaryAuthoringChatFactory: selection => createBoundaryAuthoringChat({ ...selection, color: false, streamLineDelayMs: 0 }),
    });
  const resume = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
  await record(`round-${round}.json`, { code, requests, resume });
  process.stdout.write(`\nACTION_PTY_DONE=${round}\n`);
}
process.stdout.write(`\nACTION_PTY_CLOSED=${process.pid}\n`);

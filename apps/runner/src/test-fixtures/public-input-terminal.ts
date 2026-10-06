/** Real public terminal entry. Only metadata and local model transport are
 * fictional; the default presenter, Resume, controller and disk writers run. */
import fs from "node:fs/promises";
import path from "node:path";
import { boundaryReviewCommand } from "../boundary-commands.js";
import { createBoundaryReviewInteractiveSession } from "../boundary-cli-picker.js";
import { createBoundaryAuthoringChat } from "../boundary-authoring-chat.js";
import { ownedProgramInspection } from "./owned-authoring-program.js";
import { modelVisibleUserText } from "./model-visible-frame.js";
import { PUBLIC_INPUT_FACTS } from "./public-input-resume-variant-facts.js";

const [root, capture] = process.argv.slice(2);
if (!root || !capture || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Owned project, capture and real terminal required.");
const inspection = JSON.parse(JSON.stringify(ownedProgramInspection()).replaceAll("studio", "dispatch_lab"));
process.env.OWNED_POLICY_WAIT_READ_URL = "postgresql://fixture.invalid/never-opened";
globalThis.fetch = async () => { throw new Error("External network forbidden in the terminal control."); };
let requests = 0;
const record = async (name: string, value: unknown) => fs.writeFile(path.join(capture, name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
await record("child.json", { pid: process.pid, terminal: { input: process.stdin.isTTY, output: process.stdout.isTTY } });
const options = {
  startWithAgentJob: true, exitAfterAgentJob: true,
  modelAuthoringSession: { provider: "openai" as const, model: "owned-policy-wait-offline", apiKey: "owned-offline-fixture",
    dependencies: { requestJson: async (request: { body: unknown }) => {
      if (++requests > 1) throw new Error("Only one answered Input mapping is declared.");
      const body = request.body as { tools?: { name?: string }[] }, text = modelVisibleUserText(body);
      const line = text.split("\n").find(value => value.startsWith("Current question: "));
      if (!line || !body.tools?.some(tool => tool.name === "runner__propose_operator_decision")) throw new Error("Expected actual Input decision contract.");
      const current = JSON.parse(line.slice("Current question: ".length));
      if (current.kind !== "input_bounds" || current.raw_answer !== PUBLIC_INPUT_FACTS.rawAnswer
        || JSON.stringify(current.target.outcomes) !== JSON.stringify(PUBLIC_INPUT_FACTS.outcomes)
        || typeof current.question_id !== "string" || typeof current.answer_id !== "string" || typeof current.revision !== "number") {
        throw new Error("Transmitted Input question does not match declared operator facts.");
      }
      const args = { question_id: current.question_id, revision: current.revision, answer_id: current.answer_id,
        status: "proposal", disposition: "proposed", value: { kind: "input_bounds", requirements: [{ outcomes: current.target.outcomes,
          input: PUBLIC_INPUT_FACTS.input, min_length: PUBLIC_INPUT_FACTS.minimum, max_length: PUBLIC_INPUT_FACTS.maximum }] } };
      const reply = { status: 200, body: { output: [{ type: "function_call", call_id: `terminal-input-${process.pid}-${requests}`,
        name: "runner__propose_operator_decision", arguments: JSON.stringify(args) }] } };
      await record(`model-${requests}.json`, { body, reply });
      return reply;
    } },
  },
  actionProjectInspector: async () => structuredClone(inspection),
  // Deliberately omit IO: production TerminalAnalyticsShellIo owns all input.
  boundaryAuthoringChatFactory: (selection: Parameters<typeof createBoundaryAuthoringChat>[0]) =>
    createBoundaryAuthoringChat({ ...selection, color: false, streamLineDelayMs: 0 }),
};
for (let round = 1; round <= 3; round++) {
  process.stdout.write(`\nINPUT_PTY_ROUND=${round}\n`);
  const code = await boundaryReviewCommand(["--project-root", root, "--access", "--job-first"], async () => structuredClone(inspection),
    createBoundaryReviewInteractiveSession(process.stdin, process.stdout), undefined, options);
  const resume = JSON.parse(await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8"));
  await record(`round-${round}.json`, { code, requests, resume });
  process.stdout.write(`\nINPUT_PTY_DONE=${round}\n`);
}
process.stdout.write(`\nINPUT_PTY_CLOSED=${process.pid}\n`);

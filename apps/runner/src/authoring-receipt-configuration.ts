import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readSemanticSupervisedExecutionState, SEMANTIC_ACTION_RUNTIME_CONFIG } from "./semantic-action-deployment.js";

/** Authoring evidence only: no credential values or permission to execute.
 * The existing governed execution reader validates the config binding. */
export async function authoringReceiptConfiguration(projectRoot: string, sources: readonly string[], env?: NodeJS.ProcessEnv) {
  const file = path.join(projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG);
  let text: string;
  try { text = await fs.readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" as const, digest: canonicalJsonDigest(null), modes: [] };
    return { status: "unavailable" as const, digest: canonicalJsonDigest("unavailable"), modes: [] };
  }
  const digest = canonicalJsonDigest(text);
  try {
    await readSemanticSupervisedExecutionState({ projectRoot, env });
    if (await fs.readFile(file, "utf8") !== text) throw new Error("Configuration changed");
    const config = JSON.parse(text);
    const modes = [...new Set(sources)].sort().map(source => {
      const record = config.sources?.[source];
      if (!record) throw new Error("Source configuration missing");
      const authority = record.receipts?.authority ?? "runner_ledger";
      if (authority !== "runner_ledger" && authority !== "source_db") throw new Error("Unknown receipt authority");
      return { source, authority, explicitly_configured: record.receipts?.authority !== undefined };
    });
    return { status: "current" as const, digest, modes };
  } catch { return { status: "unavailable" as const, digest, modes: [] }; }
}

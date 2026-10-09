import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readSemanticSupervisedExecutionState, SEMANTIC_ACTION_RUNTIME_CONFIG } from "./semantic-execution-state.js";

/** Authoring evidence only: no credential values or permission to execute.
 * The existing governed execution reader validates the config binding. */
async function executionReceiptConfiguration(projectRoot: string, sources: readonly string[], env?: NodeJS.ProcessEnv) {
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
    // Opaque metadata identities only; source receipt rows and relation names
    // are not authoring inputs. An unqualified destination is unresolved (its
    // runtime search path must not be guessed by the review projection).
    const source_receipt_destinations = modes.filter(mode => mode.authority === "source_db").map(mode => {
      const receipts = config.sources[mode.source].receipts;
      return { source: mode.source, relation_digest: typeof receipts.schema === "string" && receipts.schema.length
        && typeof receipts.table === "string" && receipts.table.length
        ? canonicalJsonDigest({ schema: receipts.schema, table: receipts.table }) : null };
    });
    return { status: "current" as const, digest, modes, source_receipt_destinations };
  } catch { return { status: "unavailable" as const, digest, modes: [] }; }
}


export async function authoringReceiptConfiguration(projectRoot: string, sources: readonly string[], env?: NodeJS.ProcessEnv) {
  const captured = [...sources];
  return withProjectAuthorityMutation(projectRoot, held => receiptConfigurationHeld(held.projectRoot, captured, held, env));
}
export async function authoringReceiptConfigurationHeld(projectRoot: string, sources: readonly string[],
  permit: ProjectAuthorityMutationPermit, env?: NodeJS.ProcessEnv) {
  const captured = [...sources];
  return withHeldProjectAuthorityAccess(projectRoot, permit, held => receiptConfigurationHeld(held.projectRoot, captured, held, env));
}
async function receiptConfigurationHeld(projectRoot: string, sources: readonly string[], permit: ProjectAuthorityMutationPermit, env?: NodeJS.ProcessEnv) {
  const configuration = await executionReceiptConfiguration(projectRoot, sources, env);
  const { authoringSemanticReceiptIntentHeld } = await import("./semantic-receipt-setup.js");
  let intent;
  try { intent = await authoringSemanticReceiptIntentHeld(projectRoot, sources, permit, env); }
  catch { intent = { phase: "disabled_authoring" as const, status: "unavailable" as const, verified: false as const, outcomes: [] }; }
  return intent ? { ...configuration, digest: canonicalJsonDigest({ configuration: configuration.digest, intent }), reviewed_intent: intent } : configuration;
}

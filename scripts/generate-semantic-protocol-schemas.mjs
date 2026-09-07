import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as protocol from "../packages/protocol/dist/index.js";

// Reuse the repository's pinned converter. These public artifacts describe
// wire structure, not hash equality, current authority, or execution approval.
const require = createRequire(new URL("../packages/mcp-server/package.json", import.meta.url));
const { zodToJsonSchema } = require("zod-to-json-schema");
const definitions = [
  ["delegation-proof.v1", protocol.delegationProofV1Schema],
  ["eligibility-proof.v1", protocol.eligibilityProofV1Schema],
  ["semantic-authority.v1", protocol.semanticAuthorityV1Schema],
  ["change-set.v4", protocol.changeSetV4Schema],
  ["writeback-job.v5", protocol.writebackJobV5Schema],
  ["execution-receipt.v5", protocol.executionReceiptV5Schema],
];
for (const [name, validator] of definitions) {
  const schema = zodToJsonSchema(validator, { target: "jsonSchema7", $refStrategy: "root", effectStrategy: "input", pipeStrategy: "input" });
  const content = JSON.stringify({ ...schema, $id: `https://schemas.synapsor.ai/synapsor.${name}.schema.json`,
    $comment: "Generated from executable protocol validators. Structural validation is necessary but not sufficient: Runner must also verify canonical digests, cross-field consistency, current authority, trusted scope and one-use execution admission." }, null, 2) + "\n";
  const path = fileURLToPath(new URL(`../schemas/${name}.schema.json`, import.meta.url));
  if (process.argv.includes("--check")) {
    if (await fs.readFile(path, "utf8") !== content) throw new Error(`Stale public semantic schema: ${name}. Run pnpm build, then this script without --check.`);
  } else await fs.writeFile(path, content);
}
process.stdout.write(`Semantic protocol schemas ${process.argv.includes("--check") ? "verified" : "generated"} (${definitions.length}).\n`);

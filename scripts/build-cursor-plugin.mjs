import { buildCursorPlugin } from "./cursor-plugin-package.mjs";

const result = await buildCursorPlugin();
process.stdout.write(`${JSON.stringify({
  ok: result.ok,
  plugin: "synapsor",
  version: result.version,
  output: result.output,
  package_manifest: result.package_manifest,
  package_digest: result.package_digest,
  files: result.files.length,
}, null, 2)}\n`);

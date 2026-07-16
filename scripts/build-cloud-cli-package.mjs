import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = resolve(root, "apps/cloud-cli");
const outfile = resolve(packageRoot, "dist/cli.js");
const aliases = new Map([
  ["@synapsor/spec", "packages/spec/src/index.ts"],
  ["@synapsor/dsl", "packages/dsl/src/index.ts"],
  ["@synapsor-runner/protocol", "packages/protocol/src/index.ts"],
  ["@synapsor-runner/control-plane-client", "packages/control-plane-client/src/index.ts"],
]);

await mkdir(resolve(packageRoot, "dist"), { recursive: true });
await rm(outfile, { force: true });
await build({
  entryPoints: [resolve(packageRoot, "src/cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.5",
  plugins: [{
    name: "synapsor-cloud-cli-workspace-aliases",
    setup(context) {
      context.onResolve({ filter: /^@synapsor(?:-runner)?\// }, (args) => {
        const target = aliases.get(args.path);
        return target ? { path: resolve(root, target) } : undefined;
      });
    },
  }],
  logLevel: "info",
});
await chmod(outfile, 0o755);
await copyFile(resolve(root, "LICENSE"), resolve(packageRoot, "LICENSE"));
await copyFile(resolve(root, "NOTICE"), resolve(packageRoot, "NOTICE"));

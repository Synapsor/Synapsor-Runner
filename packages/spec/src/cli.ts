#!/usr/bin/env node
import fs from "node:fs/promises";
import { normalizeContract, validateContract } from "./index.js";

async function main(argv: string[]): Promise<number> {
  const [command, target, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  if (command !== "validate" && command !== "normalize") {
    process.stderr.write(`Unknown command: synapsor-spec ${command}\n\n`);
    usage();
    return 2;
  }
  if (!target) {
    process.stderr.write(`synapsor-spec ${command} requires <contract.json>\n`);
    return 2;
  }
  const parsed = JSON.parse(await fs.readFile(target, "utf8"));
  if (command === "validate") {
    const result = validateContract(parsed);
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.ok) {
      process.stdout.write(`contract valid: ${target}\n`);
      for (const warning of result.warnings) process.stdout.write(`warning ${warning.path} ${warning.code}: ${warning.message}\n`);
    } else {
      process.stdout.write(`contract invalid: ${target}\n`);
      for (const error of result.errors) process.stdout.write(`error ${error.path} ${error.code}: ${error.message}\n`);
    }
    return result.ok ? 0 : 1;
  }
  const normalized = normalizeContract(parsed);
  const output = option(rest, "--out");
  const text = `${JSON.stringify(normalized, null, 2)}\n`;
  if (output) {
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote normalized contract: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function usage(): void {
  process.stdout.write(`Synapsor Spec

Usage:
  synapsor-spec validate ./synapsor.contract.json
  synapsor-spec normalize ./synapsor.contract.json --out ./synapsor.contract.normalized.json
`);
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

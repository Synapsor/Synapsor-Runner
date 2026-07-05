#!/usr/bin/env node
import fs from "node:fs/promises";
import { compileAgentDsl, validateAgentDsl } from "./index.js";

async function main(argv: string[]): Promise<number> {
  const [command, target, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  if (command !== "compile" && command !== "validate") {
    process.stderr.write(`Unknown command: synapsor-dsl ${command}\n\n`);
    usage();
    return 2;
  }
  if (!target) {
    process.stderr.write(`synapsor-dsl ${command} requires <contract.synapsor>\n`);
    return 2;
  }
  const source = await fs.readFile(target, "utf8");
  if (command === "validate") {
    const result = validateAgentDsl(source);
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.ok) process.stdout.write(`dsl valid: ${target}\n`);
    else {
      process.stdout.write(`dsl invalid: ${target}\n`);
      for (const error of result.errors) process.stdout.write(`error ${error.line}:${error.column} ${error.code}: ${error.message}\n`);
    }
    return result.ok ? 0 : 1;
  }
  const contract = compileAgentDsl(source);
  const text = `${JSON.stringify(contract, null, 2)}\n`;
  const output = option(rest, "--out") ?? option(rest, "--output");
  if (output) {
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote contract: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function usage(): void {
  process.stdout.write(`Synapsor DSL

Usage:
  synapsor-dsl validate ./contract.synapsor
  synapsor-dsl compile ./contract.synapsor --out ./synapsor.contract.json
`);
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

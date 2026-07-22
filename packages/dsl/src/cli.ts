#!/usr/bin/env node
import fs from "node:fs/promises";
import { compileAgentDslWithWarnings, validateAgentDsl } from "./index.js";

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
    process.stderr.write(`synapsor-dsl ${command} requires a DSL source file such as contract.synapsor.sql or contract.synapsor\n`);
    return 2;
  }
  const source = await fs.readFile(target, "utf8");
  const strict = rest.includes("--strict");
  const validationTarget = option(rest, "--target") ?? "canonical";
  if (validationTarget !== "canonical" && validationTarget !== "runner") {
    process.stderr.write("--target must be canonical or runner\n");
    return 2;
  }
  if (command === "validate") {
    const result = validateAgentDsl(source, { target: validationTarget });
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.ok) {
      process.stdout.write(`dsl valid: ${target}\n`);
      for (const warning of result.warnings) process.stdout.write(`warning ${warning.line}:${warning.column} ${warning.code}: ${warning.message}\n`);
    }
    else {
      process.stdout.write(`dsl invalid: ${target}\n`);
      for (const error of result.errors) process.stdout.write(`error ${error.line}:${error.column} ${error.code}: ${error.message}\n`);
    }
    return result.ok && (!strict || result.warnings.length === 0) ? 0 : 1;
  }
  const validation = validateAgentDsl(source, { target: validationTarget });
  if (!validation.ok) {
    process.stdout.write(`dsl invalid for ${validationTarget}: ${target}\n`);
    for (const error of validation.errors) process.stdout.write(`error ${error.line}:${error.column} ${error.code}: ${error.message}\n`);
    return 1;
  }
  const result = compileAgentDslWithWarnings(source);
  if (strict && result.warnings.length > 0) {
    process.stdout.write(`dsl warnings treated as errors: ${target}\n`);
    for (const warning of result.warnings) process.stdout.write(`warning ${warning.line}:${warning.column} ${warning.code}: ${warning.message}\n`);
    return 1;
  }
  const contract = result.contract;
  const text = `${JSON.stringify(contract, null, 2)}\n`;
  const output = option(rest, "--out") ?? option(rest, "--output");
  if (output) {
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote contract: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  for (const warning of result.warnings) process.stderr.write(`warning ${warning.line}:${warning.column} ${warning.code}: ${warning.message}\n`);
  return 0;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function usage(): void {
  process.stdout.write(`Synapsor DSL

Usage:
  synapsor-dsl validate ./contract.synapsor.sql [--strict] [--target canonical|runner]
  synapsor-dsl compile ./contract.synapsor.sql --out ./synapsor.contract.json [--strict] [--target canonical|runner]

Both .synapsor.sql and legacy .synapsor source files are supported.
Canonical is the default target. Runner rejects FROM SESSION because it has no
generic web-session trust provider; Cloud/C++ may assign it verified semantics.
`);
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import fs from "node:fs/promises";
import process from "node:process";
import runnerPackage from "../package.json" with { type: "json" };


export function isHelpRequest(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}


export function isKnownTopLevelCommand(command: string): boolean {
  return new Set([
    "help",
    "init",
    "inspect",
    "config",
    "contract",
    "effect",
    "report",
    "policy",
    "dsl",
    "language-server",
    "doctor",
    "validate",
    "apply",
    "revert",
    "propose",
    "audit",
    "start",
    "boundary",
    "action",
    "up",
    "runner",
    "cloud",
    "mcp",
    "smoke",
    "tools",
    "writeback",
    "handler",
    "onboard",
    "try",
    "explore",
    "demo",
    "recipes",
    "benchmark",
    "proposals",
    "lifecycle",
    "replay",
    "evidence",
    "query-audit",
    "receipts",
    "activity",
    "events",
    "metrics",
    "activation",
    "attention",
    "notifications",
    "worker",
    "store",
    "shadow",
    "ui",
  ]).has(command);
}


export function cliCommandName(): string {
  if (process.env.SYNAPSOR_RUNNER_COMMAND_NAME) return process.env.SYNAPSOR_RUNNER_COMMAND_NAME;
  return "synapsor-runner";
}


export async function runnerPackageVersion(): Promise<string> {
  if (typeof runnerPackage.version === "string" && runnerPackage.version.trim()) {
    return runnerPackage.version.trim();
  }
  const packageUrl = new URL("../package.json", import.meta.url);
  try {
    const parsed = JSON.parse(await fs.readFile(packageUrl, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
  } catch {
    // Keep --version best-effort for unusual bundled launch paths.
  }
  return "unknown";
}

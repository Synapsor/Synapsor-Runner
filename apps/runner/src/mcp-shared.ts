import { type ResultFormat } from "@synapsor-runner/mcp-server";
import { cliCommandName } from "./cli-command-meta.js";
import { isRecord, stringField } from "./cli-format.js";
import { optionalArg } from "./cli-options.js";


export function resultFormatOption(args: string[]): ResultFormat | undefined {
  const requested = optionalArg(args, "--result-format");
  if (!requested) return undefined;
  if (requested === "1" || requested === "v1") return 1;
  if (requested === "2" || requested === "v2") return 2;
  throw new Error("--result-format must be v1, 1, v2, or 2");
}


export function normalizeResultFormatAnswer(value: string): "default" | "v1" | "v2" {
  if (value === "1" || value === "v1") return "v1";
  if (value === "2" || value === "v2") return "v2";
  if (value === "default") return "default";
  throw new Error("--result-format must be default, v1, 1, v2, or 2");
}


export function formatSmokeCallResult(
  toolName: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  topology: {
    configPath: string;
    storePath: string;
    storeAuthority: "local_sqlite" | "shared_postgres";
    sharedPostgresSchema: string;
  },
): string {
  const proposal = isRecord(result.proposal) ? result.proposal : undefined;
  const evidence = isRecord(result.evidence) ? result.evidence : undefined;
  const error = isRecord(result.error) ? result.error : undefined;
  const evidenceId = stringField(result, "evidence_bundle_id") ?? (evidence ? stringField(evidence, "bundle_id") : undefined);
  const proposalId = stringField(result, "proposal_id") ?? (proposal ? stringField(proposal, "id") : undefined);
  const replayResource = stringField(result, "replay_resource");
  const sourceChanged = result.source_database_changed === true || result.source_database_mutated === true;
  const ok = result.ok !== false;
  const storeLines = topology.storeAuthority === "shared_postgres"
    ? [
      "Authoritative ledger:",
      `shared Postgres (${topology.sharedPostgresSchema})`,
      "",
      "Local --store path:",
      `${topology.storePath} (compatibility path only; no authoritative smoke records are written here)`,
      "",
    ]
    : ["Local ledger:", topology.storePath, ""];
  const lines = [
    `Synapsor smoke call: ${ok ? "ok" : "failed"}`,
    "",
    "Tool:",
    toolName,
    "",
    "Input:",
    JSON.stringify(input, null, 2),
    "",
    "Source DB changed:",
    sourceChanged ? "yes" : "no",
    "",
    "Evidence:",
    evidenceId || "(not returned)",
    "",
    ...storeLines,
  ];
  if (!ok) {
    lines.push("Error:", error ? stringField(error, "code") ?? "UNCLASSIFIED" : "UNCLASSIFIED");
    if (error?.retryable === true) {
      lines.push("Retryable:", "yes");
      const retryAfter = error.retry_after_ms;
      if (typeof retryAfter === "number") lines.push("Retry after:", `${retryAfter} ms`);
    }
    return `${lines.join("\n")}\n`;
  }
  if (proposalId) {
    lines.push("Proposal:", proposalId, "", "Replay:", replayResource || `synapsor://replay/replay_${proposalId}`, "");
  }
  const storeSuffix = topology.storeAuthority === "shared_postgres"
    ? ` --config ${topology.configPath} --store ${topology.storePath}`
    : ` --store ${topology.storePath}`;
  lines.push("Next:");
  if (evidenceId) lines.push(`  ${cliCommandName()} evidence show ${evidenceId}${storeSuffix}`);
  if (proposalId) {
    lines.push(`  ${cliCommandName()} proposals show ${proposalId}${storeSuffix}`);
    lines.push(`  ${cliCommandName()} proposals approve ${proposalId}${storeSuffix}`);
    lines.push(`  ${cliCommandName()} apply ${proposalId}${storeSuffix}`);
    lines.push(`  ${cliCommandName()} replay show --proposal ${proposalId}${storeSuffix}`);
  } else if (evidenceId) {
    lines.push(`  ${cliCommandName()} query-audit list --evidence ${evidenceId}${storeSuffix}`);
  }
  return `${lines.join("\n")}\n`;
}

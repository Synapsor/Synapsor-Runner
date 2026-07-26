import {
  ProposalStore,
  type ShadowAgentResult,
  type ShadowEffect,
  type ShadowOutcomeDisposition,
  type ShadowStudyReport
} from "@synapsor-runner/proposal-store";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { formatShadowComparison } from "./activity-formatting.js";
import { isRecord } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { optionalArg, outputArg, positional, repeatedArgs } from "./cli-options.js";
import { localStorePath, openLocalStore } from "./cli-project.js";
import { formatProposalSummary } from "./proposal-formatting.js";


export async function shadow(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return shadowList(rest);
  if (subcommand === "record-human-action") return shadowRecordHumanAction(rest);
  if (subcommand === "compare") return shadowCompare(rest);
  if (subcommand === "report") return shadowReport(rest);
  if (subcommand === "study") return shadowStudy(rest);
  if (subcommand === "case") return shadowCase(rest);
  if (subcommand === "outcome") return shadowOutcome(rest);
  usage(["shadow"]);
  return 2;
}


async function shadowList(args: string[]): Promise<number> {
  const store = await openLocalStore(args);
  try {
    const proposals = store.listProposals().filter((proposal) => proposal.change_set.mode === "shadow");
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ proposals }, null, 2)}\n`);
    } else if (proposals.length === 0) {
      process.stdout.write("No shadow proposals found.\n");
    } else {
      for (const proposal of proposals) process.stdout.write(formatProposalSummary(proposal));
    }
    return 0;
  } finally {
    store.close();
  }
}


async function shadowRecordHumanAction(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("shadow record-human-action requires <proposal_id>");
  const patchPath = optionalArg(args, "--patch");
  if (!patchPath) throw new Error("shadow record-human-action requires --patch <human-action.json>");
  const patch = JSON.parse(await fs.readFile(patchPath, "utf8"));
  if (!isRecord(patch)) throw new Error("shadow human-action patch must be a JSON object");
  const store = await openLocalStore(args);
  try {
    const action = store.recordShadowHumanAction(proposalId, {
      actor: optionalArg(args, "--actor") ?? process.env.USER ?? "human_operator",
      patch,
      notes: optionalArg(args, "--notes"),
    });
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(action, null, 2)}\n`);
    } else {
      process.stdout.write(`recorded human action ${action.action_id} for ${proposalId}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}


async function shadowCompare(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("shadow compare requires <proposal_id>");
  const store = await openLocalStore(args);
  try {
    const comparison = store.compareShadowProposal(proposalId);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
    } else {
      process.stdout.write(formatShadowComparison(comparison));
    }
    return 0;
  } finally {
    store.close();
  }
}


async function shadowReport(args: string[]): Promise<number> {
  const store = await openLocalStore(args);
  try {
    const studyId = optionalArg(args, "--study");
    if (studyId) {
      const report = store.shadowStudyReport(studyId);
      const serialized = `${JSON.stringify(report, null, 2)}\n`;
      const output = outputArg(args);
      if (output) {
        await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
        await fs.writeFile(output, serialized, { encoding: "utf8", mode: 0o600 });
      }
      if (args.includes("--json")) process.stdout.write(serialized);
      else {
        process.stdout.write(formatShadowStudyReport(report));
        if (output) process.stdout.write(`JSON report: ${path.resolve(output)}\n`);
      }
      return 0;
    }
    const report = store.shadowReport();
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write([
        "Shadow mode report",
        `total shadow proposals: ${report.total_shadow_proposals}`,
        `with human action: ${report.with_human_action}`,
        `exact matches: ${report.exact_matches}`,
        `partial matches: ${report.partial_matches}`,
        `mismatches: ${report.mismatches}`,
        `no human action: ${report.no_human_action}`,
        "",
      ].join("\n"));
      for (const comparison of report.comparisons) process.stdout.write(formatShadowComparison(comparison));
    }
    return 0;
  } finally {
    store.close();
  }
}


async function shadowStudy(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "create") return shadowStudyCreate(rest);
  if (subcommand === "list") return shadowStudyList(rest);
  if (subcommand === "show") return shadowStudyShow(rest);
  if (subcommand === "close") return shadowStudyClose(rest);
  if (subcommand === "sync") return shadowStudySync(rest);
  if (subcommand === "add-proposal") return shadowStudyAddProposal(rest);
  usage(["shadow"]);
  return 2;
}


async function shadowStudyCreate(args: string[]): Promise<number> {
  const name = optionalArg(args, "--name");
  if (!name) throw new Error("shadow study create requires --name <text>");
  const capabilities = repeatedArgs(args, "--capability")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const storePath = localStorePath(args);
  if (storePath !== ":memory:") await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
  const store = new ProposalStore(storePath);
  try {
    const study = store.createShadowStudy({
      study_id: optionalArg(args, "--id"),
      name,
      description: optionalArg(args, "--description"),
      selected_capabilities: capabilities,
      starts_at: optionalArg(args, "--starts-at"),
      ends_at: optionalArg(args, "--ends-at"),
    });
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify({ study }, null, 2)}\n`
      : `created shadow study ${study.study_id} (${study.name})\n`);
    return 0;
  } finally {
    store.close();
  }
}


async function shadowStudyList(args: string[]): Promise<number> {
  const store = await openLocalStore(args);
  try {
    const studies = store.listShadowStudies();
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ studies }, null, 2)}\n`);
    else if (studies.length === 0) process.stdout.write("No shadow studies found.\n");
    else {
      for (const study of studies) {
        process.stdout.write(`${study.status.toUpperCase()} ${study.study_id} ${study.name} capabilities=${study.selected_capabilities.join(",") || "all"}\n`);
      }
    }
    return 0;
  } finally {
    store.close();
  }
}


async function shadowStudyShow(args: string[]): Promise<number> {
  const studyId = positional(args, 0);
  if (!studyId) throw new Error("shadow study show requires <study_id>");
  const store = await openLocalStore(args);
  try {
    const study = store.getShadowStudy(studyId);
    if (!study) throw new Error(`shadow study not found: ${studyId}`);
    const payload = {
      study,
      cases: store.shadowCases(studyId),
      outcomes: store.shadowOutcomes(studyId),
    };
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `${formatShadowStudyReport(store.shadowStudyReport(studyId))}`);
    return 0;
  } finally {
    store.close();
  }
}


async function shadowStudyClose(args: string[]): Promise<number> {
  const studyId = positional(args, 0);
  if (!studyId) throw new Error("shadow study close requires <study_id>");
  const store = await openLocalStore(args);
  try {
    const study = store.closeShadowStudy(studyId, optionalArg(args, "--ends-at"));
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify({ study }, null, 2)}\n`
      : `closed shadow study ${study.study_id} at ${study.ends_at}\n`);
    return 0;
  } finally {
    store.close();
  }
}


async function shadowStudySync(args: string[]): Promise<number> {
  const studyId = positional(args, 0);
  if (!studyId) throw new Error("shadow study sync requires <study_id>");
  const store = await openLocalStore(args);
  try {
    const result = store.syncShadowStudy(studyId);
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify({ study_id: studyId, ...result }, null, 2)}\n`
      : `shadow study ${studyId}: attached ${result.attached}; ${result.total} total cases\n`);
    return 0;
  } finally {
    store.close();
  }
}


async function shadowStudyAddProposal(args: string[]): Promise<number> {
  const studyId = positional(args, 0);
  const proposalId = positional(args, 1);
  if (!studyId || !proposalId) throw new Error("shadow study add-proposal requires <study_id> <proposal_id>");
  const store = await openLocalStore(args);
  try {
    const shadowCase = store.addShadowProposalToStudy(studyId, proposalId, optionalArg(args, "--request-id"));
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify({ case: shadowCase }, null, 2)}\n`
      : `attached ${proposalId} as ${shadowCase.case_id} to ${studyId}\n`);
    return 0;
  } finally {
    store.close();
  }
}


async function shadowCase(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "record") return shadowCaseRecord(rest, false);
  if (subcommand === "import") return shadowCaseRecord(rest, true);
  usage(["shadow"]);
  return 2;
}


async function shadowCaseRecord(args: string[], multiple: boolean): Promise<number> {
  const studyId = optionalArg(args, "--study");
  if (!studyId) throw new Error(`shadow case ${multiple ? "import" : "record"} requires --study <study_id>`);
  const input = optionalArg(args, "--input") ?? optionalArg(args, "--file");
  if (!input) throw new Error(`shadow case ${multiple ? "import" : "record"} requires --input <file>`);
  const records = await readShadowImport(input, multiple);
  const store = await openLocalStore(args);
  try {
    const cases = records.map((record, index) => {
      const item = shadowCaseInput(record, studyId, index + 1);
      return store.recordShadowCase(item);
    });
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify({ imported: cases.length, cases }, null, 2)}\n`
      : `recorded ${cases.length} shadow case${cases.length === 1 ? "" : "s"} in ${studyId}\n`);
    return 0;
  } finally {
    store.close();
  }
}


async function shadowOutcome(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "record") return shadowOutcomeRecord(rest, false);
  if (subcommand === "import") return shadowOutcomeRecord(rest, true);
  usage(["shadow"]);
  return 2;
}


async function shadowOutcomeRecord(args: string[], multiple: boolean): Promise<number> {
  const studyId = optionalArg(args, "--study");
  if (!studyId) throw new Error(`shadow outcome ${multiple ? "import" : "record"} requires --study <study_id>`);
  const input = optionalArg(args, "--input") ?? optionalArg(args, "--file");
  if (!input) throw new Error(`shadow outcome ${multiple ? "import" : "record"} requires --input <file>`);
  const records = await readShadowImport(input, multiple);
  const store = await openLocalStore(args);
  try {
    const outcomes = records.map((record, index) => {
      const item = shadowOutcomeInput(record, studyId, index + 1);
      return store.recordShadowOutcome(item);
    });
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify({ imported: outcomes.length, outcomes }, null, 2)}\n`
      : `recorded ${outcomes.length} authoritative outcome${outcomes.length === 1 ? "" : "s"} in ${studyId}\n`);
    return 0;
  } finally {
    store.close();
  }
}


const shadowImportMaxBytes = 2 * 1024 * 1024;

const shadowImportMaxRecords = 10_000;


async function readShadowImport(inputPath: string, multiple: boolean): Promise<Record<string, unknown>[]> {
  const resolved = path.resolve(inputPath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`shadow import is not a file: ${resolved}`);
  if (stat.size > shadowImportMaxBytes) throw new Error(`shadow import exceeds ${shadowImportMaxBytes} bytes`);
  const source = await fs.readFile(resolved, "utf8");
  let values: unknown[];
  if (!multiple) {
    values = [JSON.parse(source) as unknown];
  } else if (source.trimStart().startsWith("[")) {
    const parsed = JSON.parse(source) as unknown;
    if (!Array.isArray(parsed)) throw new Error("shadow import JSON must be an array");
    values = parsed;
  } else {
    values = source.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          throw new Error(`shadow import line ${index + 1} is not valid JSON`);
        }
      });
  }
  if (values.length === 0) throw new Error("shadow import contains no records");
  if (values.length > shadowImportMaxRecords) throw new Error(`shadow import exceeds ${shadowImportMaxRecords} records`);
  return values.map((value, index) => {
    if (!isRecord(value)) throw new Error(`shadow import record ${index + 1} must be a JSON object`);
    return value;
  });
}


function shadowCaseInput(record: Record<string, unknown>, studyId: string, index: number): {
  study_id: string;
  request_id: string;
  proposal_id?: string;
  tenant_id: string;
  principal?: string;
  capability: string;
  business_object: string;
  object_id: string;
  evidence_bundle_id?: string;
  proposed_effect?: ShadowEffect;
  agent_result: ShadowAgentResult;
  decision_reason?: string;
  risk_score?: number;
  amount_value?: number;
  created_at?: string;
} {
  return {
    study_id: studyId,
    request_id: requiredShadowImportString(record.request_id, index, "request_id"),
    proposal_id: optionalShadowImportString(record.proposal_id, index, "proposal_id"),
    tenant_id: requiredShadowImportString(record.tenant_id, index, "tenant_id"),
    principal: optionalShadowImportString(record.principal, index, "principal"),
    capability: requiredShadowImportString(record.capability, index, "capability"),
    business_object: requiredShadowImportString(record.business_object, index, "business_object"),
    object_id: requiredShadowImportString(record.object_id, index, "object_id"),
    evidence_bundle_id: optionalShadowImportString(record.evidence_bundle_id, index, "evidence_bundle_id"),
    proposed_effect: record.proposed_effect as ShadowEffect | undefined,
    agent_result: requiredShadowImportString(record.agent_result, index, "agent_result") as ShadowAgentResult,
    decision_reason: optionalShadowImportString(record.decision_reason, index, "decision_reason"),
    risk_score: optionalShadowImportNumber(record.risk_score, index, "risk_score"),
    amount_value: optionalShadowImportNumber(record.amount_value, index, "amount_value"),
    created_at: optionalShadowImportString(record.created_at, index, "created_at"),
  };
}


function shadowOutcomeInput(record: Record<string, unknown>, studyId: string, index: number): {
  study_id: string;
  request_id: string;
  proposal_id?: string;
  tenant_id: string;
  business_object: string;
  object_id: string;
  actor: string;
  disposition: ShadowOutcomeDisposition;
  actual_effect?: ShadowEffect;
  occurred_at?: string;
  source: string;
  reference?: string;
  reason?: string;
} {
  return {
    study_id: studyId,
    request_id: requiredShadowImportString(record.request_id, index, "request_id"),
    proposal_id: optionalShadowImportString(record.proposal_id, index, "proposal_id"),
    tenant_id: requiredShadowImportString(record.tenant_id, index, "tenant_id"),
    business_object: requiredShadowImportString(record.business_object, index, "business_object"),
    object_id: requiredShadowImportString(record.object_id, index, "object_id"),
    actor: requiredShadowImportString(record.actor, index, "actor"),
    disposition: requiredShadowImportString(record.disposition, index, "disposition") as ShadowOutcomeDisposition,
    actual_effect: record.actual_effect as ShadowEffect | undefined,
    occurred_at: optionalShadowImportString(record.occurred_at, index, "occurred_at"),
    source: requiredShadowImportString(record.source, index, "source"),
    reference: optionalShadowImportString(record.reference, index, "reference"),
    reason: optionalShadowImportString(record.reason, index, "reason"),
  };
}


function requiredShadowImportString(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`shadow import record ${index} requires ${field}`);
  return value;
}


function optionalShadowImportString(value: unknown, index: number, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`shadow import record ${index} field ${field} must be a string`);
  return value;
}


function optionalShadowImportNumber(value: unknown, index: number, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`shadow import record ${index} field ${field} must be a finite number`);
  return value;
}


function formatShadowStudyReport(report: ShadowStudyReport): string {
  const percent = report.exact_agreement_rate === null ? "n/a" : `${(report.exact_agreement_rate * 100).toFixed(1)}%`;
  const values = report.amount_value_distribution;
  const lines = [
    `Shadow study: ${report.study.name} (${report.study.study_id})`,
    `status: ${report.study.status}`,
    `tasks observed: ${report.total_tasks_observed}`,
    `authoritative outcomes: ${report.tasks_with_authoritative_outcomes}`,
    `comparable tasks: ${report.comparable_tasks}`,
    `exact agreement: ${report.exact_agreements} (${percent})`,
    `partial agreement: ${report.partial_agreements}`,
    `disagreement: ${report.disagreements}`,
    `human rejected / no action: ${report.human_rejections_no_action}`,
    `policy denied: ${report.policy_denials}`,
    `stale / conflict: ${report.stale_conflicts}`,
    `unmatched: ${report.unmatched_cases}`,
    `invalid / unsafe scope attempts: ${report.invalid_or_unsafe_scope_attempts}`,
    `trust stage: ${report.trust_progression.current_stage.replaceAll("_", " ")}`,
    `sample readiness: ${report.trust_progression.insufficient_sample_size ? `insufficient (minimum ${report.trust_progression.minimum_policy_sample_size} exact numeric examples)` : "eligible for a human-reviewed bounded-policy suggestion"}`,
    values ? `amount/value: min=${values.minimum} median=${values.median} p95=${values.p95} max=${values.maximum} total=${values.total}` : "amount/value: n/a",
    "",
    "Trust progression:",
    ...report.trust_progression.stages.map((item) => `  ${item.status.toUpperCase()} ${item.name}: ${item.detail}`),
    "",
    "By capability:",
    ...Object.entries(report.by_capability).map(([capability, counts]) =>
      `  ${capability}: ${Object.entries(counts).filter(([, count]) => count > 0).map(([status, count]) => `${status}=${count}`).join(" ")}`
    ),
    "",
    "Highest-risk disagreements:",
    ...(report.highest_risk_disagreements.length === 0
      ? ["  none"]
      : report.highest_risk_disagreements.map((item) =>
        `  ${item.case_id} ${item.status} risk=${item.risk_score ?? "n/a"} ${item.business_object}:${item.object_id}`
      )),
    "",
    "Policy suggestions (inactive):",
    ...(report.suggested_policies.length === 0
      ? ["  none"]
      : report.suggested_policies.map((item) =>
        `  ${item.capability}: ${item.suggestion} sample=${item.sample_size} active=false`
      )),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

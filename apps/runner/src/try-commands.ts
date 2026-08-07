import {
  ProposalStore
} from "@synapsor-runner/proposal-store";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { cliCommandName } from "./cli-command-meta.js";
import {
  resolveAskAccessGuidance,
  type AskAccessGuidance,
} from "./ask-access-summary.js";
import { usage } from "./cli-help.js";
import { assertKnownOptions, firstPositional, optionalArg, repeatedArgs } from "./cli-options.js";
import { activeProjectResolutionState, prepareReferenceDemo } from "./cli-project.js";
import { buildFriendlyAggregatePlan } from "./explore-cli.js";
import {
  updateGuidedOnboardingState
} from "./guided-project.js";
import { start } from "./guided-start.js";
import {
  startLocalUiServer
} from "./local-ui.js";
import { executeRuntimeToolCall, inspectMcpToolBoundary } from "./mcp-runtime.js";
import {
  assertQualifiedCapabilityName,
  createProtectedQueryDraft,
  describeProtectableAnalysis,
  listProtectableQueries,
  suggestProtectedCapabilityName,
} from "./protect-query.js";
import {
  bindProtectedPlansToAnswer,
  ScopedExploreError,
  type ExplorePlan,
  type InspectDatabaseFn,
} from "./scoped-explore.js";
import {
  createScopedExploreBoundarySetRuntime,
  resolveActiveExploreTarget,
} from "./scoped-explore-boundary-set.js";
import { runTryExperience, type TryExperienceResult, type TryReviewContext } from "./try-experience.js";
import { tryAsk } from "./try-ask.js";
import { resolveReadableTryStateRoot } from "./try-state.js";
import {
  renderTerminalJson,
  terminalSyntaxColorEnabled,
} from "./terminal-syntax.js";
import { openBrowser } from "./ui-command.js";


export async function demo(args: string[]): Promise<number> {
  const [subcommand] = args;
  if (subcommand === "inspect") return demoInspect(args.slice(1));
  if (subcommand && !subcommand.startsWith("-") && subcommand !== "reference-support-billing") {
    usage(["demo"]);
    return 2;
  }
  if (args.includes("--quick")) return quickDemo(args);
  return prepareReferenceDemo(args);
}


async function quickDemo(args: string[]): Promise<number> {
  const allowed = new Set(["--quick", "--guided", "--no-interactive", "--details", "--json", "--yes", "--no-open", "--no-color", "--prove", "--state-dir"]);
  assertKnownOptions(args, allowed, "demo --quick");
  const stateDir = optionalArg(args, "--state-dir");
  const delegated = [
    ...(args.includes("--details") || args.includes("--prove") ? ["--prove"] : []),
    ...(args.includes("--json") ? ["--json"] : []),
    ...(args.includes("--no-color") ? ["--no-color"] : []),
    ...(args.includes("--no-open") || args.includes("--no-interactive") || !process.stdout.isTTY ? ["--no-open"] : []),
    ...(args.includes("--yes") || args.includes("--no-interactive") || args.includes("--json") || !process.stdout.isTTY ? ["--yes"] : []),
    ...(stateDir ? ["--state-dir", stateDir] : []),
  ];
  return tryCommand(delegated);
}


export async function tryCommand(
  args: string[],
  dependencies: {
    inspectDatabaseFn?: InspectDatabaseFn;
    createScopedExploreBoundarySetRuntimeFn?: typeof createScopedExploreBoundarySetRuntime;
  } = {},
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "call") return tryOwnDataCall(rest);
  if (subcommand === "explore") return tryScopedExplore(rest, dependencies);
  if (subcommand === "ask") return tryAsk(rest);
  if (subcommand === "protect") return tryProtectLatest(rest, dependencies);
  if (optionalArg(args, "--from-env")) return tryOwnData(args);
  const allowed = new Set(["--prove", "--yes", "--no-open", "--json", "--no-color", "--state-dir"]);
  assertKnownOptions(args, allowed, "try");
  const json = args.includes("--json");
  const yes = args.includes("--yes");
  const noOpen = args.includes("--no-open");
  if (json && !yes) throw new Error("try --json requires --yes because JSON mode cannot wait for an interactive review");
  if (!yes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("try requires an interactive terminal. Use --yes --no-open only for this isolated demo or CI.");
  }
  if (!json) {
    process.stdout.write([
      "Synapsor isolated commit-safety proof",
      "This command uses a synthetic embedded source. It does not connect to your project database.",
      "Without --no-open, proposal review opens in a separate local demo review screen.",
      `For your active project's natural-language terminal: ${cliCommandName()} try ask --provider openai --model <model>`,
      "",
    ].join("\n"));
  }

  const result = await runTryExperience({
    root_dir: optionalArg(args, "--state-dir"),
    prove: args.includes("--prove"),
    review: async (context) => reviewTryProposal(context, { yes, noOpen, json }),
    on_stage: json
      ? (stage, detail) => process.stderr.write(`[synapsor try] ${stage}: ${JSON.stringify(detail)}\n`)
      : undefined,
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(formatTryResult(result));
  }
  return result.ok ? 0 : 1;
}


async function tryOwnDataCall(args: string[]): Promise<number> {
  if (args.includes("--list") || !firstPositional(args)) {
    const boundary = await inspectMcpToolBoundary(args.filter((arg) => arg !== "--list"));
    const payload = {
      ok: boundary.ok,
      active_tools: boundary.names,
      model_can_activate: false,
      model_can_approve: false,
      model_can_apply: false,
      next_action: boundary.names.length
        ? `${cliCommandName()} try call ${boundary.names[0]} --sample`
        : "Activate a reviewed named capability or the local Scoped Explore boundary.",
    };
    if (args.includes("--format") && optionalArg(args, "--format") === "json") {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write([
        "Active Synapsor tools",
        "",
        ...(boundary.names.length ? boundary.names.map((name) => `- ${name}`) : ["(none)"]),
        "",
        "Approval/apply exposed to the model: no",
        `Next: ${payload.next_action}`,
        "",
      ].join("\n"));
    }
    return boundary.ok ? 0 : 1;
  }

  const call = await executeRuntimeToolCall(args);
  const sourceChanged = call.result.source_database_changed === true
    || call.result.source_database_mutated === true;
  const payload = {
    ok: call.ok,
    message: call.ok ? "Your first safe tool is working." : "The reviewed tool refused the call.",
    tool: call.tool,
    kind: call.capability?.kind ?? "cloud",
    reviewed_visible_fields: call.capability?.visible_columns ?? [],
    trusted_tenant_scope: call.capability?.target?.tenant_key ?? "configured outside model arguments",
    trusted_principal_scope: call.capability?.target?.principal_scope_key ?? "configured outside model arguments when required",
    source_database_changed: sourceChanged,
    input: call.input,
    result: call.result,
    next_action: call.capability?.kind === "proposal"
      ? "Review this proposal outside the model."
      : "Ask a bounded aggregate question or connect your MCP client.",
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write([
      payload.message,
      "",
      `Tool: ${payload.tool}`,
      `Call type: ${payload.kind}`,
      `Agent can see: ${payload.reviewed_visible_fields.join(", ") || "only the reviewed result shape"}`,
      "Agent cannot see: source fields absent from the reviewed contract",
      `Tenant scope: ${payload.trusted_tenant_scope}`,
      `Principal scope: ${payload.trusted_principal_scope}`,
      `Source database changed: ${sourceChanged ? "yes" : "no"}`,
      "",
      renderTerminalJson(call.result, terminalSyntaxColorEnabled()),
      "",
      `Next: ${payload.next_action}`,
      "",
    ].join("\n"));
  }
  return call.ok ? 0 : 1;
}


async function tryScopedExplore(
  args: string[],
  dependencies: {
    createScopedExploreBoundarySetRuntimeFn?: typeof createScopedExploreBoundarySetRuntime;
  } = {},
): Promise<number> {
  assertKnownOptions(
    args,
    new Set([
      "--project-root",
      "--describe",
      "--resource",
      "--boundary",
      "--cursor",
      "--limit",
      "--plan",
      "--input",
      "--suggested",
      "--count",
      "--count-distinct",
      "--sum",
      "--avg",
      "--group-by",
      "--time-bucket",
      "--compare",
      "--period",
      "--vs-period",
      "--change",
      "--where",
      "--top",
      "--json",
    ]),
    "try explore",
  );
  const projectRoot = resolvedSynapsorProjectRoot(args);
  const runtime = await (dependencies.createScopedExploreBoundarySetRuntimeFn
    ?? createScopedExploreBoundarySetRuntime)({
    projectRoot,
    transport: "stdio",
    env: process.env,
  });
  try {
    const inline = optionalArg(args, "--plan");
    const inputPath = optionalArg(args, "--input");
    if (inline && inputPath) throw new Error("try explore accepts only one of --plan or --input.");
    const friendly = args.includes("--suggested")
      || args.includes("--count")
      || repeatedArgs(args, "--count-distinct").length > 0
      || repeatedArgs(args, "--sum").length > 0
      || repeatedArgs(args, "--avg").length > 0
      || repeatedArgs(args, "--group-by").length > 0
      || repeatedArgs(args, "--where").length > 0
      || Boolean(optionalArg(args, "--time-bucket"))
      || Boolean(optionalArg(args, "--compare"))
      || Boolean(optionalArg(args, "--period"))
      || Boolean(optionalArg(args, "--vs-period"))
      || Boolean(optionalArg(args, "--change"))
      || Boolean(optionalArg(args, "--top"));
    if (!inline && !inputPath && !friendly) {
      const cursor = optionalArg(args, "--cursor");
      const limit = optionalArg(args, "--limit");
      const description = await runtime.describe({
        ...(optionalArg(args, "--boundary") ? { boundary: optionalArg(args, "--boundary") } : {}),
        ...(optionalArg(args, "--resource") ? { resource: optionalArg(args, "--resource") } : {}),
        ...(cursor ? { cursor: Number(cursor) } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      });
      const payload = {
        ok: true,
        authoring_only: true,
        source_database_changed: false,
        description,
        next_action: `${cliCommandName()} try explore --suggested`,
      };
      process.stdout.write(args.includes("--json")
        ? `${JSON.stringify(payload, null, 2)}\n`
        : formatTryExploreDescription(payload));
      return 0;
    }
    if ((inline || inputPath) && friendly) {
      throw new Error("Use either --plan/--input or the friendly Explore flags, not both.");
    }
    let friendlyTarget: ReturnType<typeof resolveActiveExploreTarget> | undefined;
    const parsed: unknown = inline || inputPath
      ? JSON.parse(inline ?? await fs.readFile(path.resolve(inputPath!), "utf8"))
      : (() => {
          friendlyTarget = resolveActiveExploreTarget(
            runtime.boundaries,
            optionalArg(args, "--boundary"),
            optionalArg(args, "--resource"),
          );
          return buildFriendlyAggregatePlan(friendlyTarget.boundary, {
            ...(friendlyTarget.resource ? { resource: friendlyTarget.resource.id } : {}),
            suggested: args.includes("--suggested"),
            count: args.includes("--count"),
            countDistinct: repeatedArgs(args, "--count-distinct"),
            sums: repeatedArgs(args, "--sum"),
            averages: repeatedArgs(args, "--avg"),
            groupBy: repeatedArgs(args, "--group-by"),
            timeBucket: optionalArg(args, "--time-bucket"),
            compareField: optionalArg(args, "--compare"),
            period: optionalArg(args, "--period"),
            versusPeriod: optionalArg(args, "--vs-period"),
            ...(optionalArg(args, "--change")
              ? { comparisonChange: comparisonChangeArg(optionalArg(args, "--change")!) }
              : {}),
            filters: repeatedArgs(args, "--where"),
            ...(optionalArg(args, "--top") ? { top: Number(optionalArg(args, "--top")) } : {}),
          });
        })();
    let result: Record<string, unknown>;
    try {
      result = await runtime.explore(
        parsed as ExplorePlan,
        friendlyTarget?.boundary.pack.name ?? optionalArg(args, "--boundary"),
      );
    } catch (error) {
      if (!(error instanceof ScopedExploreError) || args.includes("--json")) throw error;
      const selectedBoundary = optionalArg(args, "--boundary");
      const guidance = await resolveAskAccessGuidance({
        projectRoot,
        question: "",
        toolCalls: [{
          call_id: "cli_try_explore",
          tool: "app.explore_data",
          provider_tool: "app_explore_data",
          status: "refused",
          error_code: error.code,
          arguments: {
            ...(selectedBoundary ? { boundary: selectedBoundary } : {}),
            plan: parsed as Record<string, unknown>,
          },
          result: {
            error_code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        }],
      });
      if (!guidance) throw error;
      process.stderr.write(formatTryExploreRefusal(error, guidance));
      return 1;
    }
    const protectToken = (result.protect as { token?: unknown } | undefined)?.token;
    if (typeof protectToken === "string") {
      await bindProtectedPlansToAnswer({
        projectRoot,
        tokens: [protectToken],
        answerId: `ans_${crypto.randomBytes(12).toString("hex")}`,
      });
    }
    await updateGuidedOnboardingState({
      projectRoot,
      status: (parsed as { kind?: unknown }).kind === "aggregate" ? "protect" : "first_value",
      completedSteps: (parsed as { kind?: unknown }).kind === "aggregate"
        ? ["first_safe_read", "aggregate_complete"]
        : ["first_safe_read"],
      authorityActive: true,
      recommendedNextAction: (parsed as { kind?: unknown }).kind === "aggregate"
        ? "Ask another bounded question; protect an analysis only when it should become a reusable named capability."
        : "Ask a bounded aggregate question.",
    }).catch(() => undefined);
    const payload = {
      ok: true,
      authoring_only: true,
      source_database_changed: false,
      result,
      next_action: `Ask another bounded question, or run ${cliCommandName()} try protect --from <analysis-reference> --name analytics.protected_analysis`,
    };
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(payload, null, 2)}\n`
      : formatTryExploreResult(payload));
    return 0;
  } finally {
    await runtime.close();
  }
}

export function formatTryExploreRefusal(
  error: Pick<ScopedExploreError, "code" | "message">,
  guidance: AskAccessGuidance,
): string {
  return [
    "Runner refused this analysis",
    `${error.code} - ${error.message}`,
    "",
    guidance.title,
    guidance.message,
    `Source query executed: ${guidance.source_query_executed === true
      ? "yes; Runner discarded the result before release"
      : "no"}`,
    "",
    `Next: ${guidance.next_action}`,
    "",
  ].join("\n");
}

function comparisonChangeArg(value: string): "absolute" | "percentage" {
  if (value === "absolute" || value === "percentage") return value;
  throw new Error("--change must be absolute or percentage.");
}


async function tryProtectLatest(
  args: string[],
  dependencies: { inspectDatabaseFn?: InspectDatabaseFn },
): Promise<number> {
  assertKnownOptions(
    args,
    new Set([
      "--project-root",
      "--from",
      "--last",
      "--name",
      "--description",
      "--returns",
      "--actor",
      "--cohort-confirmation",
      "--json",
    ]),
    "try protect",
  );
  const projectRoot = resolvedSynapsorProjectRoot(args);
  const requestedCapabilityName = optionalArg(args, "--name");
  if (requestedCapabilityName) assertQualifiedCapabilityName(requestedCapabilityName);
  const available = await listProtectableQueries({ projectRoot });
  const requestedReference = optionalArg(args, "--from");
  if (requestedReference && args.includes("--last")) {
    throw new Error("try protect accepts either --from <analysis-reference> or --last, not both.");
  }
  let selected = requestedReference
    ? available.find((item) => item.token === requestedReference)
    : undefined;
  if (!requestedReference) {
    const latest = available[0];
    const latestAnswer = latest?.answer_id;
    const candidates = latestAnswer
      ? available.filter((item) => item.answer_id === latestAnswer)
      : latest
        ? [latest]
        : [];
    if (candidates.length === 1) {
      selected = candidates[0];
    } else if (candidates.length > 1) {
      throw new Error([
        "The latest answer contains multiple protectable analyses. Choose one explicitly:",
        ...candidates.map((item) =>
          `  ${item.token}  ${describeProtectableAnalysis(item.normalized_plan)}`),
        `Run ${cliCommandName()} try protect --from <analysis-reference> --name <capability-name>.`,
      ].join("\n"));
    }
  }
  if (!selected) {
    if (requestedReference) {
      throw new Error(
        "The requested analysis reference is unknown, expired, or belongs to a superseded boundary. Run try ask or try explore again.",
      );
    }
    throw new Error("No unexpired successful exploration is available. Run one bounded try explore plan, then protect it.");
  }
  const capabilityName = requestedCapabilityName
    ?? suggestProtectedCapabilityName(selected.normalized_plan);
  let minimumCohortActor = optionalArg(args, "--actor")?.trim();
  let minimumCohortConfirmation = optionalArg(args, "--cohort-confirmation")?.trim();
  if (selected.minimum_cohort_override
    && (!minimumCohortActor || !minimumCohortConfirmation)
    && process.stdin.isTTY
    && process.stdout.isTTY
    && !args.includes("--json")) {
    process.stdout.write([
      `This analysis uses an explicit owner override: minimum cohort ${selected.minimum_cohort_override.minimum_cohort_size}.`,
      ...(selected.minimum_cohort_override.minimum_cohort_size === 1
        ? ["A value of 1 disables small-group suppression; groups of one can identify individuals."]
        : []),
      "",
    ].join("\n"));
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      minimumCohortActor ||= (await rl.question("Human reviewer: ")).trim();
      minimumCohortConfirmation ||= (await rl.question(
        `Type ${selected.minimum_cohort_override.confirmation}: `,
      )).trim();
    } finally {
      rl.close();
    }
  }
  const created = await createProtectedQueryDraft({
    projectRoot,
    token: selected.token,
    capabilityName,
    description: optionalArg(args, "--description") ?? "Answer one reviewed bounded analysis.",
    returnsHint: optionalArg(args, "--returns") ?? "Returns only the reviewed bounded result shape.",
    ...(minimumCohortActor ? { minimumCohortActor } : {}),
    ...(minimumCohortConfirmation ? { minimumCohortConfirmation } : {}),
    ...(dependencies.inspectDatabaseFn
      ? { inspectDatabaseFn: dependencies.inspectDatabaseFn }
      : {}),
  });
  const payload = {
    ok: true,
    state: "disabled",
    capability: capabilityName,
    analysis_reference: selected.token,
    contract_digest: created.draft.contract_digest,
    dsl_path: created.draft.dsl_path,
    contract_path: created.draft.contract_path,
    tests_path: created.draft.tests_path,
    source_database_changed: false,
    model_can_activate: false,
    next_action: "Open the local Workbench, review this exact generated capability, and activate its digest as a human.",
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write([
      "Protected capability draft created.",
      "",
      `Capability: ${payload.capability}`,
      `DSL: ${payload.dsl_path}`,
      `Canonical contract: ${payload.contract_path}`,
      `Tests: ${payload.tests_path}`,
      `Digest: ${payload.contract_digest}`,
      "State: disabled",
      "The model cannot activate this capability.",
      "",
      `Next: ${payload.next_action}`,
      "",
    ].join("\n"));
  }
  return 0;
}

function resolvedSynapsorProjectRoot(args: string[]): string {
  return path.resolve(
    optionalArg(args, "--project-root")
      ?? activeProjectResolutionState.current?.project_root
      ?? process.cwd(),
  );
}


function formatTryExploreDescription(payload: {
  description: Record<string, unknown>;
  next_action: string;
}, color = terminalSyntaxColorEnabled()): string {
  return [
    "Reviewed local data boundary",
    "",
    renderTerminalJson(payload.description, color),
    "",
    "Source database changed: no",
    `Next: ${payload.next_action}`,
    "",
  ].join("\n");
}


function formatTryExploreResult(payload: {
  result: Record<string, unknown>;
  next_action: string;
}, color = terminalSyntaxColorEnabled()): string {
  return [
    "Your first safe exploration is working.",
    "",
    renderTerminalJson(payload.result, color),
    "",
    "Source database changed: no",
    `Next: ${payload.next_action}`,
    "",
  ].join("\n");
}


async function tryOwnData(args: string[]): Promise<number> {
  if (args.includes("--state-dir")) throw new Error("try --from-env uses the project .synapsor store; --state-dir is only for the isolated synthetic proof");
  if (args.includes("--json")) throw new Error("try --from-env does not support --json during reviewed own-data onboarding");
  const delegated = args.filter((arg) => !new Set(["--prove", "--no-open", "--no-color"]).has(arg));
  if (!optionalArg(delegated, "--mode")) delegated.push("--mode", "read_only");
  process.stdout.write([
    "Synapsor Runner own-data proof",
    "This path inspects the selected staging database. It will not use or fall back to synthetic demo data.",
    `Mode: ${optionalArg(delegated, "--mode")}. The source is not mutated during onboarding, MCP preview, or read-only validation.`,
    "A proposal-capable review mode still keeps approval and apply outside MCP.",
    "",
  ].join("\n"));
  return start(delegated);
}


async function reviewTryProposal(
  context: TryReviewContext,
  options: { yes: boolean; noOpen: boolean; json: boolean },
): Promise<"approve" | "reject" | "already_reviewed"> {
  if (!options.json) process.stdout.write(formatTryReview(context));
  if (options.yes) {
    if (!options.json) process.stdout.write("Review: approved by trusted demo operator automation (--yes).\n\n");
    return "approve";
  }
  if (options.noOpen) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("Approve this exact effect? Type APPROVE or REJECT: ")).trim().toUpperCase();
      if (answer === "APPROVE") return "approve";
      if (answer === "REJECT") return "reject";
      throw new Error("review requires the exact word APPROVE or REJECT");
    } finally {
      rl.close();
    }
  }

  const server = await startLocalUiServer({
    configPath: context.config_path,
    storePath: context.store_path,
    host: "127.0.0.1",
    port: 0,
    tour: true,
  });
  try {
    process.stdout.write(`Local review UI: ${server.url}\n`);
    process.stdout.write("The URL bootstrap token is removed after the first browser request.\n");
    process.stdout.write("Approve or reject the proposal in the browser. Press Ctrl+C to stop.\n\n");
    openBrowser(server.url);
    await waitForTryReview(context.store_path, context.proposal.proposal_id);
    return "already_reviewed";
  } finally {
    await server.close();
  }
}


async function waitForTryReview(storePath: string, proposalId: string): Promise<void> {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const store = new ProposalStore(storePath);
    try {
      const proposal = store.getProposal(proposalId);
      if (!proposal) throw new Error(`proposal not found while waiting for review: ${proposalId}`);
      if (proposal.state !== "pending_review") return;
    } finally {
      store.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("local review timed out after 15 minutes; rerun synapsor-runner try");
}


function formatTryReview(context: TryReviewContext): string {
  return [
    "Synapsor Runner try",
    "",
    "Actor:",
    "  deterministic simulated agent (no LLM call)",
    "",
    "Model-facing tools:",
    "  billing.inspect_invoice",
    "  billing.propose_late_fee_waiver",
    "  No execute_sql, approve, apply, or commit tool",
    "",
    "Trusted context (not model-controlled):",
    "  tenant: acme",
    "  principal: support-agent-demo",
    "",
    "Request:",
    `  ${context.request}`,
    "",
    "Evidence:",
    `  Support ticket ${context.evidence.support_ticket}`,
    `  ${context.evidence.summary}`,
    "",
    "Proposed effect:",
    `  ${context.proposed_effect.field}: ${context.proposed_effect.before} -> ${context.proposed_effect.after}`,
    "",
    "Source changed:",
    "  No",
    "",
  ].join("\n");
}


function formatTryResult(result: TryExperienceResult): string {
  const receipt = result.receipt;
  return [
    "",
    result.proposal.state === "rejected" ? "Proposal rejected. Source remains unchanged." : "Guarded commit complete.",
    "",
    `Proposal: ${result.proposal.proposal_id}`,
    `Operation: ${result.proposal.operation_id}`,
    `Evidence: ${result.evidence.evidence_bundle_id}`,
    `Approval state: ${result.proposal.state}`,
    `Source late_fee_cents: ${result.source_after.late_fee_cents}`,
    ...(receipt ? [
      `Receipt status: ${receipt.status}`,
      `Rows affected: ${receipt.rows_affected}`,
      `Receipt hash: ${receipt.receipt_hash}`,
    ] : []),
    `Replay: replay_${result.proposal.proposal_id}`,
    ...(result.proof ? [
      "",
      "Extended proof:",
      `  restart-safe retry: ${yesNo(result.proof.restart_safe_retry)}`,
      `  duplicate mutations: ${result.proof.duplicate_mutations}`,
      `  changed-intent operation reuse rejected: ${yesNo(result.proof.changed_intent_rejected)}`,
      `  stale apply refused: ${yesNo(result.proof.stale_apply_rejected)}`,
      `  replay changed source: ${yesNo(result.proof.replay_mutated_source)}`,
      `  UNKNOWN auto-retried: ${yesNo(result.proof.unknown_auto_retried)}`,
    ] : []),
    "",
    "Inspect:",
    `  ${cliCommandName()} replay show ${result.proposal.proposal_id} --store ${result.paths.ledger}`,
    "",
    "Connect a staging database next:",
    `  ${result.next}`,
    "",
  ].join("\n");
}


function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}


async function demoInspect(args: string[]): Promise<number> {
  const allowed = new Set(["--npx", "--json", "--state-dir"]);
  assertKnownOptions(args, allowed, "demo inspect");
  const stateDir = await resolveReadableTryStateRoot(optionalArg(args, "--state-dir"));
  const storePath = path.join(stateDir, "ledger.db");
  try {
    await fs.access(storePath);
  } catch {
    throw new Error(`Synapsor try state was not found at ${storePath}. Run '${cliCommandName()} try --yes --no-open' first.`);
  }
  const store = new ProposalStore(storePath);
  let proposal: ReturnType<ProposalStore["getProposal"]>;
  try {
    proposal = store.getProposal("wrp_try_INV_3001") ?? store.listProposals()[0];
  } finally {
    store.close();
  }
  if (!proposal) throw new Error(`No proposals were found in ${storePath}. Run '${cliCommandName()} try --yes --no-open' first.`);
  const commands = tryInspectCommands(args.includes("--npx"), storePath, proposal.proposal_id, proposal.change_set.evidence.bundle_id);
  const summary = {
    mode: "embedded_demo",
    store: storePath,
    proposal_id: proposal.proposal_id,
    proposal_state: proposal.state,
    evidence_bundle_id: proposal.change_set.evidence.bundle_id,
    replay_id: `replay_${proposal.proposal_id}`,
    model_tool: proposal.capability,
    business_object: "invoice:INV-3001",
    proposed_change: { late_fee_cents: { before: 5500, after: 0 } },
    approval_and_apply: "outside MCP",
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...summary, commands }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(formatTryInspect(commands, storePath));
  return 0;
}


function tryInspectCommands(
  useNpx: boolean,
  storePath: string,
  proposalId: string,
  evidenceId: string,
): Array<{ label: string; command: string; description: string }> {
  const cmd = useNpx ? "npx -y @synapsor/runner" : cliCommandName();
  return [
    {
      label: "Proposal summary",
      description: "See the exact reviewed business effect.",
      command: `${cmd} proposals show ${proposalId} --store ${storePath}`,
    },
    {
      label: "Evidence",
      description: "Inspect the scoped, allowlisted evidence captured for the proposal.",
      command: `${cmd} evidence show ${evidenceId} --store ${storePath}`,
    },
    {
      label: "Activity search",
      description: "Find ledger records for invoice INV-3001.",
      command: `${cmd} activity search --object invoice:INV-3001 --store ${storePath}`,
    },
    {
      label: "Replay",
      description: "Reconstruct the request, evidence, review, writeback, and receipt without reapplying.",
      command: `${cmd} replay show ${proposalId} --store ${storePath}`,
    },
    {
      label: "Extended proof",
      description: "Prove restart-safe retry, idempotency collision, stale conflict, and replay behavior.",
      command: `${cmd} try --prove --yes --no-open`,
    },
    {
      label: "Audit risky MCP database tools",
      description: "Review common dangerous MCP tool shapes.",
      command: `${cmd} audit --example dangerous-db-mcp`,
    },
  ];
}


function formatTryInspect(
  commands: Array<{ label: string; command: string; description: string }>,
  storePath: string,
): string {
  return [
    "Synapsor try inspection",
    "",
    "Local ledger:",
    storePath,
    "",
    ...commands.flatMap((item, index) => [
      `${index + 1}. ${item.label}`,
      `   ${item.description}`,
      `   ${item.command}`,
      "",
    ]),
  ].join("\n");
}

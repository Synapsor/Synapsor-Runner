import {
  inspectDatabase,
  summarizeInspection,
  type InspectEngine,
  type SchemaInspection
} from "@synapsor-runner/schema-inspector";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import runnerPackage from "../package.json" with { type: "json" };
import { recordOwnDataActivationTiming } from "./activation-report.js";
import {
  buildAutoBoundary,
  compareGenerationLock,
  loadStructuredProjectEvidence,
  writeAutoBoundaryArtifacts,
  type GenerationLock
} from "./auto-boundary.js";
import { boundaryActivateCommand, boundaryReviewCommand, loadBoundaryReviewContext, preferredDetectedDatabaseEnv, startSafeAction } from "./boundary-commands.js";
import { cliCommandName } from "./cli-command-meta.js";
import { fileExists, readJsonFileWithLocation } from "./cli-files.js";
import { isRecord, shellQuote } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { redactCliErrorMessage } from "./cli-logging.js";
import { assertKnownOptions, envValue, optionalArg, outputArg } from "./cli-options.js";
import { configValidate } from "./contract-commands.js";
import { doctor } from "./first-run-doctor.js";
import {
  initializeGuidedProject,
  preflightGuidedProjectInitialization,
  readGuidedOnboardingState,
  resetGuidedOnboardingForBoundaryReview
} from "./guided-project.js";
import {
  discoverProjectEnvFiles,
  readDatabaseUrlFromProjectEnv,
  readHiddenDatabaseUrl,
  sessionDatabaseInput,
  type InstantDatabaseInput,
} from "./instant-onboarding.js";
import { mcpSmoke } from "./mcp-runtime.js";
import { displayPath, init, isScriptedOnboardingArgs, runInitWizard } from "./onboarding.js";
import { detectProjectContext, formatProjectDetection } from "./project-detection.js";
import { startWorker } from "./runtime-commands.js";
import { ui } from "./ui-command.js";


export async function start(args: string[] = []): Promise<number> {
  if (args.includes("--action")) return startSafeAction(args);
  if (await shouldEnterAutoBoundary(args)) return startAutoBoundary(args);
  if (args.includes("--from-env") || args.includes("--schema") || args.includes("--mode") || args.includes("--engine")) {
    if (args.length > 0) {
      if (!process.stdin.isTTY && !isScriptedOnboardingArgs(args)) {
        const sourceEnv = optionalArg(args, "--from-env") ?? "DATABASE_URL";
        throw new Error(
          `Fresh Auto Boundary onboarding requires an interactive terminal. ` +
          `For automation, use --from-env ${sourceEnv} with --table <table> and --yes, ` +
          `or pass --answers <answers.json>.`,
        );
      }
      const openWorkbench = process.stdin.isTTY && process.stdout.isTTY && !args.includes("--no-open") && !args.includes("--dry-run");
      return onboard(["db", ...args, ...(openWorkbench && !args.includes("--open-ui") ? ["--open-ui"] : [])]);
    }
  }
  if (args.length === 0) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Guided start needs an interactive terminal. For automation, pass --from-env DATABASE_URL with an established selector such as --table or --answers.");
    }
    const project = await detectProjectContext(process.cwd());
    const guided = await readGuidedOnboardingState(project.root);
    const databaseEnv = preferredDetectedDatabaseEnv(project.database_env_names, process.env);
    const establishedManualProject = !guided && (
      await fileExists(path.join(project.root, "synapsor.runner.json"))
      || await fileExists(path.join(project.root, "synapsor.contract.json"))
    );
    if (establishedManualProject) {
      if (!databaseEnv) {
        throw new Error("No exported database URL environment variable was detected for the existing manual project. Run the same established command with --from-env <ENV_NAME>.");
      }
      process.stdout.write(`Using exported ${databaseEnv}; its value will not be printed or written to generated files.\n`);
      return onboard(["db", "--from-env", databaseEnv, "--open-ui"]);
    }
    if (databaseEnv) {
      process.stdout.write(`Using exported ${databaseEnv}; its value will not be printed or written to generated files.\n`);
      return startAutoBoundary(["--from-env", databaseEnv]);
    }
    const input = await promptForInstantDatabaseInput(project.root);
    const previous = process.env[input.environmentVariable];
    process.env[input.environmentVariable] = input.value;
    process.stdout.write(`Using ${input.environmentVariable} from ${input.sourceLabel} for this Runner process only; its value will not be printed or written to generated files.\n`);
    try {
      return await startAutoBoundary(["--from-env", input.environmentVariable]);
    } finally {
      if (previous === undefined) delete process.env[input.environmentVariable];
      else process.env[input.environmentVariable] = previous;
    }
  }
  return startWorker(args);
}


async function promptForInstantDatabaseInput(projectRoot: string): Promise<InstantDatabaseInput> {
  const files = await discoverProjectEnvFiles(projectRoot);
  if (files.length) {
    const selected = files[0]!;
    const relative = path.relative(projectRoot, selected) || path.basename(selected);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let useFile = false;
    try {
      const answer = (await rl.question(`Use a read database URL from ${relative} for this Runner process only? [Y/n] `)).trim().toLowerCase();
      useFile = answer === "" || answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
    if (useFile) {
      try {
        return await readDatabaseUrlFromProjectEnv(selected);
      } catch (error) {
        process.stderr.write(`${redactCliErrorMessage(error instanceof Error ? error.message : String(error))}\n`);
        process.stderr.write("Paste a read-only database URL instead. It will be hidden and held only by this Runner process.\n");
      }
    }
  }
  return sessionDatabaseInput(await readHiddenDatabaseUrl(
    "Paste a read-only Postgres/MySQL URL (input hidden): ",
  ));
}


async function shouldEnterAutoBoundary(args: string[]): Promise<boolean> {
  if (!optionalArg(args, "--from-env")) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const establishedRoutingFlags = [
    "--table",
    "--answers",
    "--mode",
    "--yes",
    "--non-interactive",
    "--dry-run",
    "--json",
    "--inspection-json",
    "--spec",
    "--starter",
    "--output",
    "--out",
    "-o",
    "--action",
    "--writeback",
    "--single-tenant-dev",
    "--tenant-key",
  ];
  if (establishedRoutingFlags.some((flag) => args.includes(flag))) return false;
  if (await fileExists(path.resolve(".synapsor/guided-onboarding.json"))) return true;
  if (await fileExists(path.resolve("synapsor.runner.json"))) return false;
  if (await fileExists(path.resolve("synapsor.contract.json"))) return false;
  return true;
}


async function startAutoBoundary(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--from-env", "--engine", "--schema", "--no-open", "--open-ui", "--force", "--rescan", "--no-graduation-tip"]), "start --from-env Auto Boundary");
  const sourceEnv = optionalArg(args, "--from-env");
  if (!sourceEnv) throw new Error("Auto Boundary requires --from-env <DATABASE_URL_ENV_NAME>.");
  const project = await detectProjectContext(process.cwd());
  process.stdout.write(formatProjectDetection(project));
  const existingJourney = await readGuidedOnboardingState(project.root);
  const shouldRescan = args.includes("--rescan") || args.includes("--force");
  if (shouldRescan && !existingJourney) {
    throw new Error("There is no guided Synapsor project to rescan. Start without --rescan or --force.");
  }
  if (existingJourney && !shouldRescan) {
    if (existingJourney.source.environment_variable !== sourceEnv) {
      throw new Error(
        `This guided project uses ${existingJourney.source.environment_variable}, not ${sourceEnv}. ` +
        `Resume with --from-env ${existingJourney.source.environment_variable}, or choose an explicit rescan.`,
      );
    }
    const boundaryRoot = path.join(project.root, existingJourney.artifacts.boundary_root);
    process.stdout.write([
      "Existing Synapsor guided project found.",
      `Completed: ${existingJourney.completed_steps.join(", ")}`,
      `Agent authority active: ${existingJourney.authority_active ? "yes" : "no"}`,
      "Source database changed: no",
      "No schema inspection, digest change, or file rewrite was performed.",
      `Next: ${existingJourney.recommended_next_action}`,
      "",
    ].join("\n"));
    if (args.includes("--no-open")) return 0;
    return ui([
      "--open",
      "--boundary-root",
      boundaryRoot,
      "--config",
      path.join(project.root, existingJourney.artifacts.runner_config),
      "--store",
      path.join(project.root, existingJourney.artifacts.local_store),
      ...(existingJourney.instant_onboarding ? ["--instant-onboarding"] : []),
      ...(existingJourney.graduation_tip_suppressed ? ["--no-graduation-tip"] : []),
    ]);
  }
  await preflightGuidedProjectInitialization(project.root);
  process.stdout.write("Inspecting the whole selected schema in an enforced read-only metadata transaction. No source rows are sampled.\n");
  let inspection: SchemaInspection;
  try {
    inspection = await inspectDatabase({
      engine: (optionalArg(args, "--engine") ?? "auto") as InspectEngine,
      databaseUrlEnv: sourceEnv,
      schema: optionalArg(args, "--schema"),
      env: process.env,
    });
  } catch (error) {
    const cause = redactCliErrorMessage(error instanceof Error ? error.message : String(error));
    throw new Error([
      "Database connection or metadata inspection failed.",
      "Why it matters: Runner cannot draft authority from an unverified schema and database-role posture.",
      "State preserved: existing project/review files were not replaced and no source row was changed.",
      `Next: verify the exported ${sourceEnv} network/credential posture without printing it, then rerun ${cliCommandName()} start --from-env ${sourceEnv}.`,
      `Cause: ${cause}`,
    ].join("\n"));
  }
  process.stdout.write(summarizeInspection(inspection));
  const evidence = await loadStructuredProjectEvidence(project);
  const build = buildAutoBoundary({
    inspection,
    project,
    parsedEvidence: evidence.parsed,
    existingContracts: evidence.existingContracts,
    sourceEnv,
    inspectedSchema: optionalArg(args, "--schema"),
  });
  let result: Awaited<ReturnType<typeof writeAutoBoundaryArtifacts>> | undefined;
  let guided: Awaited<ReturnType<typeof initializeGuidedProject>>;
  try {
    result = await writeAutoBoundaryArtifacts({
      projectRoot: project.root,
      build,
      force: shouldRescan,
    });
    guided = await initializeGuidedProject({
      projectRoot: project.root,
      build,
      runnerVersion: runnerPackage.version,
      instantOnboarding: true,
      suppressGraduationTip: args.includes("--no-graduation-tip"),
    });
    if (existingJourney) {
      await resetGuidedOnboardingForBoundaryReview({
        projectRoot: project.root,
        schemaFingerprint: build.lock.schema_fingerprint,
        rolePostureFingerprint: build.lock.role_posture_fingerprint,
      });
    }
  } catch (error) {
    if (!existingJourney && result) await rollbackFreshAutoBoundaryWrite(project.root, result);
    throw error;
  }
  process.stdout.write([
    "",
    "Database connected.",
    `  objects inspected: ${build.review.summary.objects}`,
    `  exact-row read drafts: ${result.draft_reads}`,
    `  blocked objects: ${result.blocked_objects}`,
    `  sensitive fields kept out by suggestion: ${build.review.summary.sensitive_fields_kept_out}`,
    `  RLS policies found: ${build.review.summary.rls_policies}`,
    `  candidate contract: ${displayPath(path.join(result.root, "synapsor.candidate.contract.json"))}`,
    `  valid Runner config: ${displayPath(guided.config_path)}`,
    `  local ledger: ${displayPath(guided.store_path)}`,
    "  state: disabled and unreviewed; active Runner tools are unchanged",
    "  source database changed: no",
    "",
    "Next: Review what the agent can see.",
    "Scoped Explore is never registered on production, shared HTTP, or Streamable HTTP.",
    "",
  ].join("\n"));
  if (evidence.warnings.length) {
    process.stdout.write(`Static evidence warnings:\n${evidence.warnings.map((warning) => `  - ${warning}`).join("\n")}\n`);
  }
  if (args.includes("--no-open")) return 0;
  return ui([
    "--open",
    "--boundary-root",
    result.root,
    "--config",
    guided.config_path,
    "--store",
    guided.store_path,
    "--instant-onboarding",
    ...(args.includes("--no-graduation-tip") ? ["--no-graduation-tip"] : []),
  ]);
}


async function rollbackFreshAutoBoundaryWrite(
  projectRoot: string,
  result: Awaited<ReturnType<typeof writeAutoBoundaryArtifacts>>,
): Promise<void> {
  const outputRoot = path.resolve(result.root);
  await fs.rm(outputRoot, { recursive: true, force: true });
  for (const file of result.files) {
    const resolved = path.resolve(file);
    if (resolved === outputRoot || resolved.startsWith(`${outputRoot}${path.sep}`)) continue;
    await fs.rm(resolved, { force: true });
  }
  await fs.rmdir(path.dirname(outputRoot)).catch(() => undefined);
  await fs.rmdir(path.join(path.resolve(projectRoot), ".synapsor")).catch(() => undefined);
}


export async function boundaryCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "review") return boundaryReviewCommand(rest);
  if (subcommand === "activate") return boundaryActivateCommand(rest);
  if (subcommand === "draft") {
    assertKnownOptions(rest, new Set(["--from-env", "--engine", "--schema", "--project-root", "--force", "--json"]), "boundary draft");
    const sourceEnv = optionalArg(rest, "--from-env")
      ?? (envValue(process.env, "DATABASE_URL") ? "DATABASE_URL" : undefined);
    if (!sourceEnv) throw new Error("boundary draft requires an exported DATABASE_URL or --from-env <DATABASE_URL_ENV_NAME>.");
    const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
    const project = await detectProjectContext(projectRoot);
    const inspection = await inspectDatabase({
      engine: (optionalArg(rest, "--engine") ?? "auto") as InspectEngine,
      databaseUrlEnv: sourceEnv,
      schema: optionalArg(rest, "--schema"),
      env: process.env,
    });
    const evidence = await loadStructuredProjectEvidence(project);
    const build = buildAutoBoundary({
      inspection,
      project,
      parsedEvidence: evidence.parsed,
      existingContracts: evidence.existingContracts,
      sourceEnv,
      inspectedSchema: optionalArg(rest, "--schema"),
    });
    const result = await writeAutoBoundaryArtifacts({ projectRoot, build, force: rest.includes("--force") });
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ok: true, activation: "disabled_unreviewed", ...result }, null, 2)}\n`);
    } else {
      process.stdout.write(`Generated disabled Auto Boundary draft at ${displayPath(result.root)}.\nReview it in the local Workbench; active Runner tools are unchanged.\n`);
    }
    return 0;
  }
  if (subcommand === "diff") {
    assertKnownOptions(rest, new Set(["--project-root", "--engine", "--schema", "--json"]), "boundary diff");
    const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
    const lockPath = path.join(projectRoot, ".synapsor/generation-lock.json");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as GenerationLock;
    const inspection = await inspectDatabase({
      engine: (optionalArg(rest, "--engine") ?? lock.engine) as InspectEngine,
      databaseUrlEnv: lock.source_env,
      schema: optionalArg(rest, "--schema") ?? lock.inspected_schema,
      env: process.env,
    });
    const comparison = compareGenerationLock(lock, inspection);
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: comparison.current, ...comparison }, null, 2)}\n`);
    else process.stdout.write(comparison.current
      ? "Generation lock matches the current schema and database-role posture.\n"
      : `Generation lock is stale:\n${comparison.changes.map((change) => `  - ${change}`).join("\n")}\n`);
    return comparison.current ? 0 : 1;
  }
  if (subcommand === "status") {
    assertKnownOptions(rest, new Set(["--project-root", "--json"]), "boundary status");
    const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
    const context = await loadBoundaryReviewContext(projectRoot);
    const activePath = path.join(projectRoot, ".synapsor/exploration-boundary.active.json");
    const active = await fileExists(activePath)
      ? await readJsonFileWithLocation<Record<string, unknown>>(activePath, "active exploration boundary")
      : undefined;
    const payload = {
      ok: true,
      activation: active ? "active" : "disabled_unreviewed",
      candidate_digest: context.bundle.candidate_digest,
      active_digest: active && isRecord(active.activation) ? active.activation.digest : undefined,
      decisions_confirmed: context.bundle.decisions.length - context.bundle.outstanding_decision_ids.length,
      decisions_total: context.bundle.decisions.length,
      outstanding_decision_ids: context.bundle.outstanding_decision_ids,
      schema_fingerprint: context.lock.schema_fingerprint,
      role_posture_fingerprint: context.lock.role_posture_fingerprint,
      protected_authority: context.lock.protected_authority,
      source_database_changed: false,
    };
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write([
      `Auto Boundary state: ${payload.activation}`,
      `Candidate digest: ${payload.candidate_digest}`,
      `Review decisions: ${payload.decisions_confirmed}/${payload.decisions_total}`,
      `Generated resources: ${payload.protected_authority.length}`,
      active
        ? "The exact reviewed local authoring boundary is active."
        : `Next: ${cliCommandName()} boundary review --project-root ${shellQuote(projectRoot)}`,
      "Source database changed: no.",
      "",
    ].join("\n"));
    return 0;
  }
  usage(["boundary"]);
  return 2;
}


export async function onboard(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "db") {
    usage(["onboard"]);
    return 2;
  }
  process.stdout.write("Synapsor Runner own-database onboarding\n");
  process.stdout.write("You will inspect metadata, choose one table/view, confirm safety rules, and generate semantic MCP tools without writing JSON by hand.\n\n");
  const startedAt = new Date().toISOString();
  const openWorkbench = rest.includes("--open-ui");
  const initArgs = rest.filter((value) => value !== "--open-ui" && value !== "--no-open");
  const outputPath = outputArg(initArgs) ?? "synapsor.runner.json";
  const storePath = optionalArg(initArgs, "--store") ?? "./.synapsor/local.db";
  const scripted = isScriptedOnboardingArgs(initArgs);
  const result = scripted ? await init(["--non-interactive", ...initArgs]) : await runInitWizard(["--wizard", ...initArgs]);
  if (result !== 0) return result;
  if (rest.includes("--dry-run")) return 0;
  process.stdout.write("\nValidation:\n");
  const configCode = await configValidate(["--config", outputPath]);
  const smokeCode = await mcpSmoke(["--config", outputPath, "--store", storePath]);
  process.stdout.write("Doctor:\n");
  const doctorCode = await doctor(["--config", outputPath]);
  if (doctorCode !== 0) {
    process.stdout.write("Doctor reported setup attention. This is expected if trusted context or writeback env vars are not set yet.\n");
  }
  process.stdout.write("\nNext commands:\n");
  process.stdout.write(`1. Serve MCP:\n   ${cliCommandName()} mcp serve --config ${outputPath} --store ${storePath}\n`);
  process.stdout.write(`2. Open local UI:\n   ${cliCommandName()} ui --open --tour --config ${outputPath} --store ${storePath}\n`);
  process.stdout.write("3. Approve/apply only after setting a trusted write credential and reviewing the proposal.\n");
  const ready = configCode === 0 && smokeCode === 0;
  if (ready) {
    await recordOwnDataActivationTiming({
      manifestPath: path.join(path.dirname(path.resolve(outputPath)), ".synapsor/onboarding.json"),
      startedAt,
    });
  }
  if (!ready) return 1;
  if (openWorkbench) {
    process.stdout.write("\nOpening the local first-safe-action workbench. Approval and apply remain outside MCP.\n");
    return ui(["--open", "--tour", "--config", outputPath, "--store", storePath]);
  }
  return 0;
}

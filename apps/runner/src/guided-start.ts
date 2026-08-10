import {
  inspectDatabase,
  type InspectEngine,
  type SchemaInspection
} from "@synapsor-runner/schema-inspector";
import { loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import runnerPackage from "../package.json" with { type: "json" };
import { recordOwnDataActivationTiming } from "./activation-report.js";
import {
  buildAutoBoundary,
  compareGenerationLock,
  generationLockRemediation,
  generationLockRemediationCommand,
  loadActivatedExplorationBoundary,
  loadStructuredProjectEvidence,
  seedConfiguredPrincipalBindingReview,
  writeAutoBoundaryArtifacts,
  type ExplorationBudgets,
  type GenerationLock
} from "./auto-boundary.js";
import {
  boundaryActivateCommand,
  boundaryDeleteCommand,
  boundaryDisableCommand,
  boundaryRenameCommand,
  boundaryReviewCommand,
  loadBoundaryReviewContext,
  preferredDetectedDatabaseEnv,
  startSafeAction,
  type BoundaryActivationHandoff,
} from "./boundary-commands.js";
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
  recordGuidedBoundaryRescan,
  readGuidedOnboardingState,
  resetGuidedOnboardingForBoundaryReview
} from "./guided-project.js";
import {
  commitBoundaryRescan,
  formatBoundaryRescanReport,
  prepareBoundaryRescan,
} from "./boundary-rescan.js";
import {
  discoverProjectEnvFiles,
  readDatabaseUrlFromProjectEnv,
  readHiddenDatabaseUrl,
  sessionDatabaseInput,
  type InstantDatabaseInput,
} from "./instant-onboarding.js";
import { buildInstantFirstValue } from "./instant-first-value.js";
import {
  instantLocalBoundaryCandidate,
  recommendedBoundaryReviewCandidate,
} from "./boundary-candidate.js";
import {
  activateInstantCliBoundary,
  type InstantCliBoundaryActivationInput,
  type InstantCliBoundaryActivationResult,
} from "./instant-cli-boundary.js";
import { createBoundaryReviewInteractiveSession, terminalTheme } from "./boundary-cli-picker.js";
import { mcpSmoke } from "./mcp-runtime.js";
import { resolveAskRequestTimeoutSeconds } from "./model-ask.js";
import { displayPath, init, isScriptedOnboardingArgs, runInitWizard } from "./onboarding.js";
import { detectProjectContext, formatProjectDetection } from "./project-detection.js";
import {
  runPostActivationAskHandoff,
  type PostActivationAskSelection,
} from "./post-activation-ask.js";
import { resolveSynapsorProject } from "./project-resolution.js";
import { startWorker } from "./runtime-commands.js";
import { listProtectedPlans } from "./scoped-explore.js";
import { ui } from "./ui-command.js";
import { padTerminalBlock } from "./terminal-layout.js";


export type GuidedStartDependencies = {
  schemaInspector?: typeof inspectDatabase;
  runInstantCliBoundary?: (
    input: Omit<InstantCliBoundaryActivationInput, "session">,
  ) => Promise<InstantCliBoundaryActivationResult>;
  runBoundaryReview?: (
    args: string[],
    schemaInspector: typeof inspectDatabase,
    activationHandoff: BoundaryActivationHandoff,
  ) => Promise<number>;
  runPostActivationHandoff?: (input: {
    projectRoot: string;
    autoStartConfiguredProvider?: boolean;
    consentOnFirstQuestion?: boolean;
    requestTimeoutSeconds?: number;
    selection?: PostActivationAskSelection;
  }) => Promise<number>;
  openWorkbench?: (args: string[]) => Promise<number>;
  interactive?: boolean;
};


export async function start(
  args: string[] = [],
  dependencies: GuidedStartDependencies = {},
): Promise<number> {
  if (args.includes("--action")) return startSafeAction(args);
  if (args.includes("--timeout") && !args.includes("--cli")) {
    throw new Error("start --timeout configures the terminal model session and requires --cli. Workbench has its own model request timeout setting.");
  }
  const interactive = dependencies.interactive
    ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (args.includes("--cli")) {
    if (!interactive) {
      throw new Error(
        "start --cli requires an interactive terminal. " +
        "Use --no-open for noninteractive initialization without prompts.",
      );
    }
    if (args.includes("--no-open") || args.includes("--open-ui")) {
      throw new Error("start --cli cannot be combined with --no-open or --open-ui.");
    }
    if (!optionalArg(args, "--from-env")) {
      const project = await detectProjectContext(process.cwd());
      const databaseEnv = preferredDetectedDatabaseEnv(project.database_env_names, process.env);
      if (!databaseEnv) {
        throw new Error(
          "start --cli needs --from-env <DATABASE_URL_ENV_NAME> or an exported DATABASE_URL.",
        );
      }
      process.stdout.write(
        `Using exported ${databaseEnv}; its value will not be printed or written to generated files.\n`,
      );
      return startAutoBoundary(
        ["--from-env", databaseEnv, ...args],
        dependencies,
      );
    }
    return startAutoBoundary(args, dependencies);
  }
  if (await shouldEnterAutoBoundary(args, interactive)) {
    return startAutoBoundary(args, dependencies);
  }
  if (args.includes("--from-env") || args.includes("--schema") || args.includes("--mode") || args.includes("--engine")) {
    if (args.length > 0) {
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
      return startAutoBoundary(["--from-env", databaseEnv], dependencies);
    }
    const input = await promptForInstantDatabaseInput(project.root);
    const previous = process.env[input.environmentVariable];
    process.env[input.environmentVariable] = input.value;
    process.stdout.write(`Using ${input.environmentVariable} from ${input.sourceLabel} for this Runner process only; its value will not be printed or written to generated files.\n`);
    try {
      return await startAutoBoundary(
        ["--from-env", input.environmentVariable],
        dependencies,
      );
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


async function shouldEnterAutoBoundary(
  args: string[],
  interactive = process.stdin.isTTY === true && process.stdout.isTTY === true,
): Promise<boolean> {
  if (!optionalArg(args, "--from-env")) return false;
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
  if (args.includes("--no-open")) return true;
  if (!interactive) return false;
  if (await fileExists(path.resolve(".synapsor/guided-onboarding.json"))) return true;
  if (await fileExists(path.resolve("synapsor.runner.json"))) return false;
  if (await fileExists(path.resolve("synapsor.contract.json"))) return false;
  return true;
}


async function startAutoBoundary(
  args: string[],
  dependencies: GuidedStartDependencies = {},
): Promise<number> {
  assertKnownOptions(args, new Set(["--from-env", "--engine", "--schema", "--no-open", "--open-ui", "--cli", "--force", "--rescan", "--no-graduation-tip", "--verbose", "--single-tenant", "--organization-id", "--timeout"]), "start --from-env Auto Boundary");
  const cliMode = args.includes("--cli");
  const rawRequestTimeout = optionalArg(args, "--timeout");
  const requestTimeoutSeconds = rawRequestTimeout === undefined
    ? undefined
    : resolveAskRequestTimeoutSeconds(Number(rawRequestTimeout), "official_remote");
  const writeGuidedOutput = (value: string) => process.stdout.write(
    cliMode && process.stdout.isTTY === true ? padTerminalBlock(value) : value,
  );
  const schemaInspector = dependencies.schemaInspector ?? inspectDatabase;
    const runPostActivationHandoff = dependencies.runPostActivationHandoff
    ?? ((input: {
      projectRoot: string;
      autoStartConfiguredProvider?: boolean;
      consentOnFirstQuestion?: boolean;
      requestTimeoutSeconds?: number;
      selection?: PostActivationAskSelection;
    }) => runPostActivationAskHandoff(input));
  const activationHandoff: BoundaryActivationHandoff = (input) =>
    runPostActivationHandoff({
      projectRoot: input.projectRoot,
      ...(requestTimeoutSeconds === undefined ? {} : { requestTimeoutSeconds }),
    });
  const runBoundaryReview = dependencies.runBoundaryReview
    ?? ((reviewArgs, inspector, handoff) =>
      boundaryReviewCommand(reviewArgs, inspector, undefined, handoff));
  const runInstantCliBoundary = dependencies.runInstantCliBoundary
    ?? ((input: Omit<InstantCliBoundaryActivationInput, "session">) =>
      activateInstantCliBoundary({
        ...input,
        session: createBoundaryReviewInteractiveSession(),
      }));
  const openWorkbench = dependencies.openWorkbench ?? ui;
  const sourceEnv = optionalArg(args, "--from-env");
  if (!sourceEnv) throw new Error("Auto Boundary requires --from-env <DATABASE_URL_ENV_NAME>.");
  let singleOrganization = args.includes("--single-tenant");
  let organizationId = optionalArg(args, "--organization-id");
  if (singleOrganization !== Boolean(organizationId)) {
    throw new Error("Single-organization Explore requires both --single-tenant and --organization-id <stable-org-id>.");
  }
  const project = await detectProjectContext(process.cwd());
  const regenerateInstantBoundary: NonNullable<InstantCliBoundaryActivationInput["regenerateBoundary"]> =
    async ({ inspection }) => {
      const journey = await readGuidedOnboardingState(project.root);
      const boundaryRoot = path.join(
        project.root,
        journey?.artifacts.boundary_root ?? "synapsor/generated",
      );
      const prepared = await prepareBoundaryRescan({
        projectRoot: project.root,
        boundaryRoot,
        inspection,
      });
      await commitBoundaryRescan(prepared);
      const activeBoundaryExists = await guidedActiveBoundaryExists(project.root);
      await recordGuidedBoundaryRescan({
        projectRoot: project.root,
        schemaFingerprint: prepared.selectedBuild.lock.schema_fingerprint,
        rolePostureFingerprint: prepared.selectedBuild.lock.role_posture_fingerprint,
        pendingReview: prepared.report.changed,
        authorityActive: activeBoundaryExists,
      });
      return {
        draft: prepared.selectedBuild.exploration_boundary,
        lock: prepared.selectedBuild.lock,
        inspection,
      };
    };
  const verbose = args.includes("--verbose");
  if (verbose) writeGuidedOutput(formatProjectDetection(project));
  const existingJourney = await readGuidedOnboardingState(project.root);
  const shouldRescan = args.includes("--rescan") || args.includes("--force");
  if (existingJourney && shouldRescan && !singleOrganization) {
    const existingBoundary = await loadBoundaryReviewContext(project.root);
    if (existingBoundary.draft.organization_scope) {
      singleOrganization = true;
      organizationId = existingBoundary.draft.organization_scope.organization_id;
    }
  }
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
    const activeBoundaryExists = await guidedActiveBoundaryExists(project.root);
    writeGuidedOutput([
      "Existing Synapsor guided project found.",
      `Completed: ${existingJourney.completed_steps.join(", ")}`,
      `Agent authority active: ${activeBoundaryExists ? "yes" : "no"}`,
      "Source database changed: no",
      "No schema inspection, digest change, or file rewrite was performed.",
      ...(cliMode
        ? [
          activeBoundaryExists
            ? "Continuing to model or MCP-client selection in this terminal."
            : "Continuing the saved boundary review in this terminal.",
        ]
        : [`Next: ${existingJourney.recommended_next_action}`]),
      "",
    ].join("\n"));
    if (cliMode) {
      if (activeBoundaryExists) {
        return runPostActivationHandoff({
          projectRoot: project.root,
          ...(requestTimeoutSeconds === undefined ? {} : { requestTimeoutSeconds }),
        });
      }
      const context = await loadBoundaryReviewContext(project.root);
      if (!context.progress && existingJourney.status === "review_boundary") {
        const instant = await runInstantCliBoundary({
          projectRoot: project.root,
          draft: context.draft,
          lock: context.lock,
          schemaInspector,
          regenerateBoundary: regenerateInstantBoundary,
        });
        if (instant.accepted) {
          return runPostActivationHandoff({
            projectRoot: project.root,
            ...(requestTimeoutSeconds === undefined ? {} : { requestTimeoutSeconds }),
            selection: instant.askSelection,
            consentOnFirstQuestion: true,
          });
        }
        if (instant.reason === "operator_cancelled") return 0;
      }
      return runBoundaryReview(
        ["--project-root", project.root, "--access"],
        schemaInspector,
        activationHandoff,
      );
    }
    if (args.includes("--no-open")) return 0;
    return openWorkbench([
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
  if (existingJourney && shouldRescan) {
    if (existingJourney.source.environment_variable !== sourceEnv) {
      throw new Error(
        `This guided project uses ${existingJourney.source.environment_variable}, not ${sourceEnv}. `
        + `Rescan with --from-env ${existingJourney.source.environment_variable}.`,
      );
    }
    const boundaryRoot = path.join(project.root, existingJourney.artifacts.boundary_root);
    writeGuidedOutput("Connecting and reconciling current schema metadata with every saved boundary...\n");
    const prepared = await prepareBoundaryRescan({
      projectRoot: project.root,
      boundaryRoot,
      schemaInspector,
    });
    await commitBoundaryRescan(prepared);
    const activeBoundaryExists = await guidedActiveBoundaryExists(project.root);
    await recordGuidedBoundaryRescan({
      projectRoot: project.root,
      schemaFingerprint: prepared.selectedBuild.lock.schema_fingerprint,
      rolePostureFingerprint: prepared.selectedBuild.lock.role_posture_fingerprint,
      pendingReview: prepared.report.changed,
      authorityActive: activeBoundaryExists,
    });
    writeGuidedOutput(`${formatBoundaryRescanReport(prepared.report)}\n\n`);
    if (cliMode) {
      if (!prepared.report.changed && activeBoundaryExists) {
        return runPostActivationHandoff({
          projectRoot: project.root,
          ...(requestTimeoutSeconds === undefined ? {} : { requestTimeoutSeconds }),
        });
      }
      return runBoundaryReview(
        ["--project-root", project.root, "--access"],
        schemaInspector,
        activationHandoff,
      );
    }
    if (args.includes("--no-open")) return 0;
    return openWorkbench([
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
  if (verbose) {
    writeGuidedOutput("Inspecting the whole selected schema in an enforced read-only metadata transaction. No source rows are sampled.\n");
  } else {
    writeGuidedOutput("Connecting and inspecting schema metadata...\n");
  }
  let inspection: SchemaInspection;
  try {
    inspection = await schemaInspector({
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
  const evidence = await loadStructuredProjectEvidence(project);
  const build = buildAutoBoundary({
    inspection,
    project,
    parsedEvidence: evidence.parsed,
    existingContracts: evidence.existingContracts,
    sourceEnv,
    inspectedSchema: optionalArg(args, "--schema"),
    ...(singleOrganization ? { singleOrganization: { organizationId: organizationId! } } : {}),
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
  writeGuidedOutput(formatGuidedBoundaryReady(
    build,
    result,
    cliMode ? "terminal" : args.includes("--no-open") ? "deferred" : "workbench",
    verbose,
  ));
  if (evidence.warnings.length) {
    writeGuidedOutput(`Static evidence warnings:\n${evidence.warnings.map((warning) => `  - ${warning}`).join("\n")}\n`);
  }
  if (cliMode) {
    const instant = await runInstantCliBoundary({
      projectRoot: project.root,
      draft: build.exploration_boundary,
      lock: build.lock,
      schemaInspector,
      initialInspection: inspection,
      regenerateBoundary: regenerateInstantBoundary,
    });
    if (instant.accepted) {
      return runPostActivationHandoff({
        projectRoot: project.root,
        ...(requestTimeoutSeconds === undefined ? {} : { requestTimeoutSeconds }),
        selection: instant.askSelection,
        consentOnFirstQuestion: true,
      });
    }
    if (instant.reason === "operator_cancelled") return 0;
    return runBoundaryReview(
      ["--project-root", project.root, "--access"],
      schemaInspector,
      activationHandoff,
    );
  }
  if (args.includes("--no-open")) return 0;
  return openWorkbench([
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

async function guidedActiveBoundaryExists(projectRoot: string): Promise<boolean> {
  return await fileExists(path.join(projectRoot, ".synapsor/exploration-boundaries.active.json"))
    || await fileExists(path.join(projectRoot, ".synapsor/exploration-boundary.active.json"));
}


function formatGuidedBoundaryReady(
  build: ReturnType<typeof buildAutoBoundary>,
  result: Awaited<ReturnType<typeof writeAutoBoundaryArtifacts>>,
  reviewSurface: "workbench" | "terminal" | "deferred" = "workbench",
  verbose = false,
): string {
  const candidate = reviewSurface === "deferred"
    ? recommendedBoundaryReviewCandidate(build.exploration_boundary)
    : instantLocalBoundaryCandidate(build.exploration_boundary);
  const inspectedLabel = build.review.resources.some((resource) => resource.type === "view")
    ? "tables and views"
    : "tables";
  const theme = terminalTheme(process.stdout.isTTY === true && !("NO_COLOR" in process.env));
  const lines = [
    "",
    theme.success("✓ Connected"),
    theme.success(`✓ Inspected ${build.review.summary.objects} ${inspectedLabel}`) + theme.dim(" (metadata only; no rows read)"),
    "",
  ];
  if (!verbose && (reviewSurface === "terminal" || reviewSurface === "workbench")) {
    return lines.join("\n");
  }
  if (candidate.pack.resources.length === 0) {
    return [
      ...lines,
      "Safe starting boundary needs one human decision",
      "",
      `  ${build.review.summary.objects} ${inspectedLabel} inspected`,
      `  ${result.blocked_objects} remain blocked`,
      `  ${build.review.summary.sensitive_fields_kept_out} sensitive fields kept out`,
      "",
      "Nothing is active.",
      reviewSurface === "terminal"
        ? "Quick Start review begins now."
        : reviewSurface === "workbench"
          ? "Next: Resolve the first boundary exception in Workbench."
          : `Next: ${cliCommandName()} boundary review`,
      "",
    ].join("\n");
  }
  const first = buildInstantFirstValue(candidate);
  const resource = candidate.pack.resources[0]!;
  const includedResources = candidate.pack.resources.length;
  const resourceName = friendlyIdentifier(resource.table);
  const visible = [...first.agent_can_see_labels, "count"]
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" · ");
  const tenantScope = candidate.organization_scope
    ? `whole reviewed organization (${candidate.organization_scope.organization_id}); no tenant filter`
    : candidate.trusted_context.database_role_tenant
      ? "tenant fixed by the read-only database login"
      : "tenant from your application";
  const scope = first.principal_scope.startsWith("not required")
    ? tenantScope
    : `${tenantScope}; principal from your application`;
  return [
    ...lines,
    "Safe starting boundary",
    "",
    `  Boundary     ${candidate.pack.name}`,
    `  Included     ${includedResources} of ${build.review.summary.objects} ${inspectedLabel}`,
    `  First query  ${resourceName} (${first.resource})`,
    "",
    `  AI can       ${visible || "reviewed aggregate count"} for this first query`,
    `  scoped by    ${scope}`,
    `  kept out     ${Math.max(0, build.review.summary.objects - includedResources)} ${inspectedLabel} · ${build.review.summary.sensitive_fields_kept_out} sensitive fields`,
    "",
    "  TRY AFTER ACTIVATION",
    `  "${first.question}"`,
    "",
    "Nothing is active.",
    reviewSurface === "terminal"
      ? "Quick Start review begins now."
      : reviewSurface === "workbench"
        ? "Next: Review this exact boundary in Workbench."
        : `Next: ${cliCommandName()} boundary review`,
    "",
  ].join("\n");
}


function friendlyIdentifier(value: string): string {
  return value
    .split(".")
    .at(-1)!
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function boundaryRescanFollowUp(input: {
  projectRoot: string;
  sourceEnv: string;
  deploymentProfile: "development" | "staging" | "production";
}): {
  editor: string;
  guided: string;
  lines: string[];
} {
  const displayedProjectRoot = displayPath(input.projectRoot);
  const projectRoot = shellQuote(displayedProjectRoot);
  const editor = `${cliCommandName()} boundary review --project-root ${projectRoot} --access`;
  const start = `${cliCommandName()} start --from-env ${input.sourceEnv} --cli`;
  const guided = displayedProjectRoot === "."
    ? start
    : `cd ${projectRoot} && ${start}`;
  return {
    editor,
    guided,
    lines: [
      "NEXT",
      "Review and activate in the focused access editor (no second rescan):",
      `  ${editor}`,
      "  --access opens the same table, column, and path editor as /access in the Ask shell.",
      input.deploymentProfile === "production"
        ? "Or resume the guided review and production HTTP setup (no second rescan):"
        : "Or resume guided review, activate, and continue to Ask (no second rescan):",
      `  ${guided}`,
      "Use start --rescan only when you want to inspect the database again.",
    ],
  };
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


export async function boundaryCommand(
  args: string[],
  schemaInspector: typeof inspectDatabase = inspectDatabase,
): Promise<number> {
  const [subcommand, ...rest] = args;
  const activationHandoff = (input: { projectRoot: string }) =>
    runPostActivationAskHandoff(input);
  if (subcommand === "review") {
    return boundaryReviewCommand(rest, schemaInspector, undefined, activationHandoff);
  }
  if (subcommand === "activate") {
    return boundaryActivateCommand(rest, schemaInspector, undefined, activationHandoff);
  }
  if (subcommand === "rename") return boundaryRenameCommand(rest);
  if (subcommand === "delete") return boundaryDeleteCommand(rest);
  if (subcommand === "disable") return boundaryDisableCommand(rest);
  if (subcommand === "rescan") {
    assertKnownOptions(rest, new Set(["--from-env", "--project-root", "--json"]), "boundary rescan");
    const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
    const journey = await readGuidedOnboardingState(projectRoot);
    const boundaryRoot = path.join(
      projectRoot,
      journey?.artifacts.boundary_root ?? "synapsor/generated",
    );
    const prepared = await prepareBoundaryRescan({
      projectRoot,
      boundaryRoot,
      schemaInspector,
    });
    const requestedSourceEnv = optionalArg(rest, "--from-env");
    if (requestedSourceEnv && requestedSourceEnv !== prepared.report.source_env) {
      throw new Error(
        `This reviewed project uses ${prepared.report.source_env}, not ${requestedSourceEnv}. `
        + `Run boundary rescan --from-env ${prepared.report.source_env}.`,
      );
    }
    await commitBoundaryRescan(prepared);
    if (journey) {
      const activeBoundaryExists = await guidedActiveBoundaryExists(projectRoot);
      await recordGuidedBoundaryRescan({
        projectRoot,
        schemaFingerprint: prepared.selectedBuild.lock.schema_fingerprint,
        rolePostureFingerprint: prepared.selectedBuild.lock.role_posture_fingerprint,
        pendingReview: prepared.report.changed,
        authorityActive: activeBoundaryExists,
      });
    }
    const followUp = boundaryRescanFollowUp({
      projectRoot,
      sourceEnv: prepared.report.source_env,
      deploymentProfile: prepared.selectedProgress.candidate.deployment_profile,
    });
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        reconciled: true,
        report: prepared.report,
        ...(prepared.report.changed
          ? {
              next: followUp.editor,
              next_guided: followUp.guided,
              access_editor: "Same focused editor as /access; does not rescan.",
            }
          : {}),
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatBoundaryRescanReport(prepared.report)}\n`);
      if (prepared.report.changed) {
        process.stdout.write(`\n${followUp.lines.join("\n")}\n`);
      }
    }
    return 0;
  }
  if (subcommand === "draft") {
    assertKnownOptions(rest, new Set([
      "--from-env", "--engine", "--schema", "--project-root", "--force", "--json",
      "--profile", "--tenant-claim", "--principal-claim", "--single-tenant", "--organization-id",
    ]), "boundary draft");
    const sourceEnv = optionalArg(rest, "--from-env")
      ?? (envValue(process.env, "DATABASE_URL") ? "DATABASE_URL" : undefined);
    if (!sourceEnv) throw new Error("boundary draft requires an exported DATABASE_URL or --from-env <DATABASE_URL_ENV_NAME>.");
    const deploymentProfile = optionalArg(rest, "--profile") ?? "staging";
    if (deploymentProfile !== "development" && deploymentProfile !== "staging" && deploymentProfile !== "production") {
      throw new Error("boundary draft --profile must be development, staging, or production.");
    }
    const tenantClaim = optionalArg(rest, "--tenant-claim");
    const principalClaim = optionalArg(rest, "--principal-claim");
    const singleOrganization = rest.includes("--single-tenant");
    const organizationId = optionalArg(rest, "--organization-id");
    if (singleOrganization !== Boolean(organizationId)) {
      throw new Error("Single-organization Explore requires both --single-tenant and --organization-id <stable-org-id>.");
    }
    if (deploymentProfile === "production") {
      if (!principalClaim || (!singleOrganization && !tenantClaim)) {
        throw new Error(singleOrganization
          ? "Single-organization production Explore requires --principal-claim <claim>; its organization identity comes from --organization-id."
          : "A production Explore boundary requires --tenant-claim <claim> and --principal-claim <claim> from verified HTTP JWTs.");
      }
      if ((tenantClaim && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tenantClaim)) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(principalClaim)) {
        throw new Error("Production Explore tenant and principal claims must be safe top-level JWT claim names.");
      }
      if (singleOrganization && tenantClaim) {
        throw new Error("Single-organization production Explore must not set --tenant-claim; Runner uses the exact reviewed --organization-id for accounting and audit.");
      }
    } else if (tenantClaim || principalClaim) {
      throw new Error("--tenant-claim and --principal-claim are only valid with --profile production.");
    }
    const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
    const existingJourney = await readGuidedOnboardingState(projectRoot);
    const existingBoundaryRoot = path.join(
      projectRoot,
      existingJourney?.artifacts.boundary_root ?? "synapsor/generated",
    );
    if (await fileExists(path.join(existingBoundaryRoot, "exploration-boundary.draft.json"))) {
      const authorityChangingFlags = [
        "--engine",
        "--schema",
        "--tenant-claim",
        "--principal-claim",
        "--single-tenant",
        "--organization-id",
      ].filter((flag) => rest.includes(flag));
      if (authorityChangingFlags.length) {
        throw new Error(
          `An existing reviewed project cannot change ${authorityChangingFlags.join(", ")} through boundary draft. `
          + "Use /access to create or edit an independently reviewed boundary.",
        );
      }
      const prepared = await prepareBoundaryRescan({
        projectRoot,
        boundaryRoot: existingBoundaryRoot,
        schemaInspector,
      });
      if (sourceEnv !== prepared.report.source_env) {
        throw new Error(
          `This reviewed project uses ${prepared.report.source_env}, not ${sourceEnv}. `
          + `Run boundary rescan --from-env ${prepared.report.source_env}.`,
        );
      }
      if (rest.includes("--profile")
        && deploymentProfile !== prepared.selectedProgress.candidate.deployment_profile) {
        throw new Error(
          `The existing boundary uses profile ${prepared.selectedProgress.candidate.deployment_profile}. `
          + "Create a separate boundary to review a different deployment profile.",
        );
      }
      await commitBoundaryRescan(prepared);
      const followUp = boundaryRescanFollowUp({
        projectRoot,
        sourceEnv: prepared.report.source_env,
        deploymentProfile: prepared.selectedProgress.candidate.deployment_profile,
      });
      if (rest.includes("--json")) {
        process.stdout.write(`${JSON.stringify({
          ok: true,
          reconciled: true,
          destructive_regeneration: false,
          report: prepared.report,
          ...(prepared.report.changed
            ? {
                next: followUp.editor,
                next_guided: followUp.guided,
                access_editor: "Same focused editor as /access; does not rescan.",
              }
            : {}),
        }, null, 2)}\n`);
      } else {
        process.stdout.write([
          "An existing reviewed project was found; boundary draft used the reconciling rescan path.",
          "No curated review state was discarded, including when --force was supplied.",
          "",
          formatBoundaryRescanReport(prepared.report),
          ...(prepared.report.changed
            ? ["", ...followUp.lines]
            : []),
          "",
        ].join("\n"));
      }
      return 0;
    }
    const project = await detectProjectContext(projectRoot);
    const existingProject = await resolveSynapsorProject(projectRoot, process.env);
    const configuredPrincipal = existingProject?.config_path
      ? await configuredPrincipalBinding(existingProject.config_path, sourceEnv)
      : undefined;
    const inspection = await schemaInspector({
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
      ...(configuredPrincipal
        ? {
            overrides: seedConfiguredPrincipalBindingReview({
              inspection,
              principalBinding: configuredPrincipal.binding,
              actor: "runner-config",
              decidedAt: configuredPrincipal.decidedAt,
            }),
          }
        : {}),
      inspectedSchema: optionalArg(rest, "--schema"),
      deploymentProfile,
      ...(deploymentProfile === "production"
        ? { httpClaims: { ...(tenantClaim ? { tenantClaim } : {}), principalClaim: principalClaim! } }
        : {}),
      ...(singleOrganization ? { singleOrganization: { organizationId: organizationId! } } : {}),
    });
    const shouldInitializeProject = deploymentProfile !== "production"
      && !existingJourney
      && !existingProject?.config_path;
    if (shouldInitializeProject) {
      await preflightGuidedProjectInitialization(projectRoot);
    }
    let result: Awaited<ReturnType<typeof writeAutoBoundaryArtifacts>> | undefined;
    let guided: Awaited<ReturnType<typeof initializeGuidedProject>> | undefined;
    try {
      result = await writeAutoBoundaryArtifacts({
        projectRoot,
        build,
        force: rest.includes("--force"),
      });
      if (deploymentProfile !== "production" && (shouldInitializeProject || existingJourney)) {
        guided = await initializeGuidedProject({
          projectRoot,
          build,
          runnerVersion: runnerPackage.version,
          instantOnboarding: true,
        });
      }
      if (deploymentProfile !== "production" && existingJourney) {
        await resetGuidedOnboardingForBoundaryReview({
          projectRoot,
          schemaFingerprint: build.lock.schema_fingerprint,
          rolePostureFingerprint: build.lock.role_posture_fingerprint,
        });
      }
    } catch (error) {
      if (shouldInitializeProject && result) {
        await rollbackFreshAutoBoundaryWrite(projectRoot, result);
      }
      throw error;
    }
    const displayedProjectRoot = displayPath(projectRoot);
    const reviewCommand = displayedProjectRoot === "."
      ? `${cliCommandName()} boundary review`
      : `${cliCommandName()} boundary review --project-root ${shellQuote(displayedProjectRoot)}`;
    const configPath = guided?.config_path ?? existingProject?.config_path;
    const storePath = guided?.store_path ?? existingProject?.store_path;
    const workbenchCommand = [
      `${cliCommandName()} ui`,
      `--boundary-root ${shellQuote(displayPath(result.root))}`,
      ...(configPath ? [`--config ${shellQuote(displayPath(configPath))}`] : []),
      ...(storePath ? [`--store ${shellQuote(displayPath(storePath))}`] : []),
      "--open",
    ].join(" ");
    const productionConfigCommand = deploymentProfile === "production" && !configPath
      ? [
        `${cliCommandName()} config init --production-explore`,
        `--project-root ${shellQuote(displayedProjectRoot)}`,
        `--output ${shellQuote(displayPath(path.join(projectRoot, "synapsor.runner.json")))}`,
        "--issuer https://identity.example",
        "--audience https://runner.example/mcp",
        "--accounting-namespace your_org.analytics.production",
      ].join(" ")
      : undefined;
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        activation: "disabled_unreviewed",
        deployment_profile: deploymentProfile,
        ...result,
        guided_project_created: guided?.created ?? false,
        ...(configPath ? { config_path: configPath } : {}),
        ...(storePath ? { store_path: storePath } : {}),
        next_action: reviewCommand,
        ...(productionConfigCommand ? { runtime_config_next_action: productionConfigCommand } : {}),
        visual_alternative: workbenchCommand,
      }, null, 2)}\n`);
    } else {
      process.stdout.write([
        `Generated disabled Auto Boundary draft at ${displayPath(result.root)}.`,
        `Profile: ${deploymentProfile}.`,
        "State: disabled draft. Active Runner tools are unchanged.",
        ...(guided?.created
          ? [
            "Prepared the local Runner config, ledger, and MCP snippets automatically.",
            "No credential values were written to project files.",
          ]
          : []),
        "",
        "Next: review it in this terminal:",
        `  ${reviewCommand}`,
        ...(productionConfigCommand
          ? [
            "",
            "Then generate the secured production runtime config:",
            "  Replace the example issuer, audience, and accounting namespace with your deployment values.",
            `  ${productionConfigCommand}`,
            "  Runner reuses the reviewed source and JWT claim names from this draft; no secret values are written.",
          ]
          : []),
        "",
        "Visual alternative:",
        `  ${workbenchCommand}`,
        "",
      ].join("\n"));
    }
    return 0;
  }
  if (subcommand === "diff") {
    assertKnownOptions(rest, new Set(["--project-root", "--engine", "--schema", "--json"]), "boundary diff");
    const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
    const lockPath = path.join(projectRoot, ".synapsor/generation-lock.json");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as GenerationLock;
    const inspection = await schemaInspector({
      engine: (optionalArg(rest, "--engine") ?? lock.engine) as InspectEngine,
      databaseUrlEnv: lock.source_env,
      schema: optionalArg(rest, "--schema") ?? lock.inspected_schema,
      env: process.env,
    });
    const comparison = compareGenerationLock(lock, inspection);
    const remediationCommand = comparison.current
      ? undefined
      : generationLockRemediationCommand(lock);
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify({
      ok: comparison.current,
      ...comparison,
      ...(remediationCommand ? { remediation_command: remediationCommand } : {}),
    }, null, 2)}\n`);
    else process.stdout.write(comparison.current
      ? "Generation lock matches the current schema and database-role posture.\n"
      : [
        "Generation lock is stale:",
        comparison.changes.map((change) => `  - ${change}`).join("\n"),
        "",
        generationLockRemediation(lock),
        "",
      ].join("\n"));
    return comparison.current ? 0 : 1;
  }
  if (subcommand === "status") {
    assertKnownOptions(rest, new Set(["--project-root", "--json"]), "boundary status");
    const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
    const context = await loadBoundaryReviewContext(projectRoot);
    const active = await loadActivatedExplorationBoundary(projectRoot, {
      name: context.bundle.candidate.pack.name,
    }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    const operational = await boundaryOperationalStatus(projectRoot, context.bundle, active);
    const unresolvedResources = [...new Set(context.bundle.decisions
      .filter((decision) => context.bundle.outstanding_decision_ids.includes(decision.id))
      .map((decision) => decision.resource_id)
      .filter((resource): resource is string => Boolean(resource)))].sort();
    const payload = {
      ok: true,
      project: projectRoot,
      database_source: {
        engine: context.lock.engine,
        environment_reference: context.lock.source_env,
        schema: context.lock.inspected_schema ?? null,
        connection_value_returned: false,
      },
      config: operational.config,
      activation: active ? "active" : "disabled_unreviewed",
      candidate_boundary_name: context.bundle.candidate.pack.name,
      candidate_tables: context.bundle.candidate.pack.resources.map((resource) => resource.id),
      active_boundary_name: active && isRecord(active.pack)
        ? (typeof active.pack.name === "string" ? active.pack.name : null)
        : null,
      active_tables: active && isRecord(active.pack) && Array.isArray(active.pack.resources)
        ? active.pack.resources
          .filter(isRecord)
          .map((resource) => resource.id)
          .filter((resource): resource is string => typeof resource === "string")
        : [],
      candidate_digest: context.bundle.candidate_digest,
      active_digest: active && isRecord(active.activation) ? active.activation.digest : undefined,
      decisions_confirmed: context.bundle.decisions.length - context.bundle.outstanding_decision_ids.length,
      decisions_total: context.bundle.decisions.length,
      outstanding_decision_ids: context.bundle.outstanding_decision_ids,
      unresolved_resources: unresolvedResources,
      schema_fingerprint: context.lock.schema_fingerprint,
      role_posture_fingerprint: context.lock.role_posture_fingerprint,
      protected_authority: context.lock.protected_authority,
      explore_budget_state: operational.exploreBudgetState,
      recent_analysis_references: operational.recentAnalysisReferences,
      disabled_protected_drafts: operational.disabledProtectedDrafts,
      active_named_tools: operational.activeNamedTools,
      production_readiness: operational.productionReadiness,
      next_action: operational.nextAction,
      source_database_changed: false,
    };
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write([
      `Auto Boundary state: ${payload.activation}`,
      `Next boundary: ${payload.candidate_boundary_name} (${payload.candidate_tables.length} ${payload.candidate_tables.length === 1 ? "table" : "tables"})`,
      payload.active_boundary_name
        ? `Active boundary: ${payload.active_boundary_name} (${payload.active_tables.length} ${payload.active_tables.length === 1 ? "table" : "tables"})`
        : "Active boundary: none",
      `Candidate digest: ${payload.candidate_digest}`,
      `Review decisions: ${payload.decisions_confirmed}/${payload.decisions_total}`,
      `Generated resources: ${payload.protected_authority.length}`,
      `Runner config: ${payload.config.state}`,
      `Explore budget: ${payload.explore_budget_state
        ? `${payload.explore_budget_state.queries_used}/${payload.explore_budget_state.queries_limit} questions, ${payload.explore_budget_state.extracted_cells_used}/${payload.explore_budget_state.extracted_cells_limit} cells`
        : "no active-session usage"}`,
      `Protectable recent analyses: ${payload.recent_analysis_references.length}`,
      `Disabled protected drafts: ${payload.disabled_protected_drafts.length}`,
      `Active named tools: ${payload.active_named_tools.length}`,
      active
        ? "The exact reviewed local authoring boundary is active."
        : `Next: ${cliCommandName()} boundary review --project-root ${shellQuote(projectRoot)} ` +
          "(interactive), or use boundary review resource <table> with decision flags for scripts.",
      `Next action: ${payload.next_action}`,
      "Source database changed: no.",
      "",
    ].join("\n"));
    return 0;
  }
  usage(["boundary"]);
  return 2;
}

async function configuredPrincipalBinding(
  configPath: string,
  sourceEnv: string,
): Promise<{ binding: string; decidedAt: string } | undefined> {
  const config = loadRuntimeConfigFromFile(configPath);
  const sourceMatches = Object.values(config.sources ?? {}).some((source) =>
    source.read_url_env === sourceEnv);
  const context = config.trusted_context;
  const binding = context?.principal_binding?.trim();
  const hasTrustedPrincipal = context?.provider === "http_claims"
    || context?.provider === "cloud_session"
    || typeof context?.values?.principal_env === "string";
  if (!sourceMatches || !binding || !hasTrustedPrincipal) return undefined;
  const stat = await fs.stat(configPath);
  return { binding, decidedAt: stat.mtime.toISOString() };
}

async function boundaryOperationalStatus(
  projectRoot: string,
  bundle: {
    candidate: { budgets: ExplorationBudgets };
    outstanding_decision_ids: string[];
  },
  active?: Record<string, unknown>,
): Promise<{
  config: { state: "missing" | "valid" | "invalid"; path: string; error?: string };
  exploreBudgetState: Record<string, unknown> | null;
  recentAnalysisReferences: Array<Record<string, unknown>>;
  disabledProtectedDrafts: Array<Record<string, unknown>>;
  activeNamedTools: string[];
  productionReadiness: { ready: boolean; blockers: string[] };
  nextAction: string;
}> {
  const configPath = path.join(projectRoot, "synapsor.runner.json");
  let config: { state: "missing" | "valid" | "invalid"; path: string; error?: string } = {
    state: "missing",
    path: configPath,
  };
  let activeNamedTools: string[] = [];
  if (await fileExists(configPath)) {
    try {
      const runtime = loadRuntimeConfigFromFile(configPath);
      activeNamedTools = [...new Set((runtime.capabilities ?? []).map((capability) => capability.name))].sort();
      config = { state: "valid", path: configPath };
    } catch (error) {
      config = {
        state: "invalid",
        path: configPath,
        error: redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  const activeDigest = active && isRecord(active.activation) && typeof active.activation.digest === "string"
    ? active.activation.digest
    : undefined;
  const storePath = path.join(projectRoot, ".synapsor/local.db");
  let exploreBudgetState: Record<string, unknown> | null = null;
  if (activeDigest && await fileExists(storePath)) {
    const store = new ProposalStore(storePath);
    try {
      const records = store.listQueryAudit().filter((record) => {
        const payload = isRecord(record.payload) ? record.payload : {};
        return payload.scoped_explore_version === "synapsor.scoped-explore.v1"
          && payload.boundary_digest === activeDigest;
      });
      const latestSession = [...records].sort((left, right) => {
        const timestamp = (record: typeof left) => {
          const payload = isRecord(record.payload) ? record.payload : {};
          return Date.parse(typeof payload.recorded_at === "string" ? payload.recorded_at : String(record.created_at));
        };
        return timestamp(right) - timestamp(left);
      }).find((record) => {
        const payload = isRecord(record.payload) ? record.payload : {};
        return typeof payload.session_fingerprint === "string";
      });
      const latestPayload = latestSession && isRecord(latestSession.payload) ? latestSession.payload : {};
      const sessionRecords = typeof latestPayload.session_fingerprint === "string"
        ? records.filter((record) => {
          const payload = isRecord(record.payload) ? record.payload : {};
          return payload.session_fingerprint === latestPayload.session_fingerprint;
        })
        : [];
      const extractedCells = sessionRecords.reduce((sum, record) => {
        const payload = isRecord(record.payload) ? record.payload : {};
        return sum + (typeof payload.returned_cells === "number" ? payload.returned_cells : 0);
      }, 0);
      const minuteAgo = Date.now() - 60_000;
      const requestsLastMinute = sessionRecords.filter((record) => {
        const payload = isRecord(record.payload) ? record.payload : {};
        return Date.parse(typeof payload.recorded_at === "string" ? payload.recorded_at : String(record.created_at)) >= minuteAgo;
      }).length;
      const budgets = bundle.candidate.budgets;
      exploreBudgetState = {
        scope: "most_recent_local_trusted_session",
        queries_used: sessionRecords.length,
        queries_limit: budgets.max_queries_per_session,
        queries_remaining: Math.max(0, budgets.max_queries_per_session - sessionRecords.length),
        extracted_cells_used: extractedCells,
        extracted_cells_limit: budgets.max_extracted_cells_per_session,
        extracted_cells_remaining: Math.max(0, budgets.max_extracted_cells_per_session - extractedCells),
        requests_last_minute: requestsLastMinute,
        requests_per_minute_limit: budgets.rate_limit_per_minute,
        state_persists_across_tabs_processes_and_provider_sessions: true,
      };
    } finally {
      store.close();
    }
  }

  const recentAnalysisReferences = activeDigest
    ? await listProtectedPlans({ projectRoot }).then((items) => items
      .filter((item) => item.boundary_digest === activeDigest)
      .slice(-10)
      .reverse()
      .map((item) => ({
        reference: item.token,
        kind: item.plan.kind,
        resource: item.plan.resource,
        expires_at: item.expires_at,
        protectable: true,
      }))).catch(() => [])
    : [];
  const disabledProtectedDrafts = await readManagedProtectedDrafts(projectRoot);
  const blockers = [
    ...(config.state !== "valid" ? ["Runner config is not valid."] : []),
    ...(activeNamedTools.length === 0 ? ["No activated named capability is configured for production."] : []),
  ];
  const nextAction = bundle.outstanding_decision_ids.length
    ? `Review ${bundle.outstanding_decision_ids.length} remaining boundary decision(s).`
    : !activeDigest
      ? "Activate the exact reviewed local authoring boundary."
      : !exploreBudgetState || Number(exploreBudgetState.queries_used) === 0
        ? "Run the first bounded question."
        : "Ask another bounded question; Protect remains optional.";
  return {
    config,
    exploreBudgetState,
    recentAnalysisReferences,
    disabledProtectedDrafts,
    activeNamedTools,
    productionReadiness: { ready: blockers.length === 0, blockers },
    nextAction,
  };
}

async function readManagedProtectedDrafts(projectRoot: string): Promise<Array<Record<string, unknown>>> {
  const root = path.join(projectRoot, "synapsor/protected/drafts");
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const drafts: Array<Record<string, unknown>> = [];
  for (const entry of entries.sort()) {
    const draftPath = path.join(root, entry, "draft.json");
    if (!await fileExists(draftPath)) continue;
    const draft = await readJsonFileWithLocation<Record<string, unknown>>(draftPath, "protected query draft");
    if (draft.state !== "disabled") continue;
    drafts.push({
      capability: draft.capability,
      contract_digest: draft.contract_digest,
      mode: draft.mode,
      draft_path: draftPath,
    });
  }
  return drafts;
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
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && !scripted;
  if (!interactive) await assertCompleteNonInteractiveOnboardingInput(initArgs, outputPath);
  const result = interactive
    ? await runInitWizard(["--wizard", ...initArgs])
    : await init(["--non-interactive", ...initArgs]);
  if (result !== 0) return result;
  if (rest.includes("--dry-run")) return 0;
  process.stdout.write("\nValidation:\n");
  const configCode = await configValidate(["--config", outputPath]);
  const smokeCode = await mcpSmoke(["--config", outputPath, "--store", storePath]);
  process.stdout.write("Setup check:\n");
  const doctorCode = await doctor(["--config", outputPath, "--setup"]);
  process.stdout.write("\nNext commands:\n");
  process.stdout.write("1. Set any environment variables listed under Setup check from .env.example.\n");
  process.stdout.write(`2. Serve MCP:\n   ${cliCommandName()} mcp serve --config ${outputPath} --store ${storePath}\n`);
  process.stdout.write(`3. Open local UI:\n   ${cliCommandName()} ui --open --tour --config ${outputPath} --store ${storePath}\n`);
  process.stdout.write("4. Approve/apply only after setting a trusted write credential and reviewing the proposal.\n");
  const ready = configCode === 0 && smokeCode === 0 && doctorCode === 0;
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


async function assertCompleteNonInteractiveOnboardingInput(
  args: string[],
  outputPath: string,
): Promise<void> {
  if (optionalArg(args, "--answers") || optionalArg(args, "--spec")) return;
  const missing: string[] = [];
  const mode = optionalArg(args, "--mode");
  const operation = optionalArg(args, "--operation") ?? "update";
  const writeback = optionalArg(args, "--writeback") ?? "sql_update";
  if (!optionalArg(args, "--table")) missing.push("--table <schema.table>");
  if (!mode) missing.push("--mode read_only|shadow|review");
  if (!optionalArg(args, "--tenant-key")
    && !optionalArg(args, "--tenant-column")
    && !args.includes("--single-tenant-dev")) {
    missing.push("--tenant-key <column> or --single-tenant-dev");
  }
  const hasPatch = ["--patch", "--patch-fixed", "--patch-from-arg"]
    .some((flag) => optionalArg(args, flag) !== undefined);
  if (mode && mode !== "read_only" && operation !== "delete" && !hasPatch) {
    missing.push("--patch <column=arg:name|fixed:value> for shadow/review writes");
  }
  if (mode && mode !== "read_only" && (operation === "update" || operation === "delete")
    && !optionalArg(args, "--conflict-column")) {
    missing.push(`--conflict-column <column> for ${operation.toUpperCase()}`);
  }
  if (mode && mode !== "read_only" && operation === "insert" && !optionalArg(args, "--dedup")) {
    missing.push("--dedup <column=proposal_id,...> for INSERT");
  }
  if (mode === "review" && writeback === "sql_update" && !optionalArg(args, "--write-url-env")) {
    missing.push("--write-url-env <ENV_NAME> for direct SQL writeback");
  }
  if (mode === "review" && writeback === "http_handler" && !optionalArg(args, "--handler-url-env")) {
    missing.push("--handler-url-env <ENV_NAME> for HTTP handler writeback");
  }
  if (mode === "review" && writeback === "command_handler" && !optionalArg(args, "--handler-command-env")) {
    missing.push("--handler-command-env <ENV_NAME> for command handler writeback");
  }
  if (mode === "review" && writeback === "sql_update" && operation === "update"
    && optionalArg(args, "--receipt-mode") === "runner_ledger"
    && !optionalArg(args, "--version-advance")) {
    missing.push("--version-advance integer_increment|database_generated for runner-ledger UPDATE");
  }
  if (mode === "review" && !args.includes("--yes")) {
    missing.push("--yes after reviewing the generated write authority");
  }
  if (!args.includes("--dry-run")
    && !args.includes("--force")
    && await fileExists(path.resolve(outputPath))) {
    missing.push(`--force to replace the existing ${displayPath(path.resolve(outputPath))}`);
  }
  if (missing.length === 0) return;
  const sourceEnv = optionalArg(args, "--from-env") ?? "DATABASE_URL";
  const canonicalWriteOperation = operation === "insert" || operation === "delete"
    ? operation
    : "update";
  const canonicalWriteRecipe = canonicalReviewAutomationRecipe(sourceEnv, canonicalWriteOperation);
  throw new Error([
    "Non-interactive own-database setup needs all review decisions in one command.",
    "Missing:",
    ...missing.map((item) => `  - ${item}`),
    "",
    "Run from an interactive terminal without --yes/--non-interactive to be prompted instead.",
    mode && mode !== "read_only"
      ? `Canonical review-mode ${canonicalWriteOperation.toUpperCase()} automation:`
      : "Canonical read-only automation:",
    mode && mode !== "read_only"
      ? `  ${canonicalWriteRecipe}`
      : `  ${cliCommandName()} onboard db --from-env ${sourceEnv} --table public.orders --mode read_only --tenant-key tenant_id --yes --no-open`,
    "Use --force only after reviewing the generated files that would be replaced.",
  ].join("\n"));
}


function canonicalReviewAutomationRecipe(
  sourceEnv: string,
  operation: "update" | "insert" | "delete",
): string {
  const common = `${cliCommandName()} onboard db --from-env ${sourceEnv} --table public.orders --mode review --operation ${operation} --tenant-key tenant_id`;
  if (operation === "insert") {
    return `${common} --patch status=arg:status --dedup request_id=proposal_id,tenant_id=trusted_tenant --write-url-env SYNAPSOR_DATABASE_WRITE_URL --yes --no-open`;
  }
  if (operation === "delete") {
    return `${common} --conflict-column version --write-url-env SYNAPSOR_DATABASE_WRITE_URL --yes --no-open`;
  }
  return `${common} --conflict-column version --patch status=arg:status --write-url-env SYNAPSOR_DATABASE_WRITE_URL --yes --no-open`;
}
